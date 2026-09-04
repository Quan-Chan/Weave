// 节点拖拽 + 网格吸附动画专项 GUI 测试（防 totalMs 类回归）
// 背景：_animateNodeToGrid 曾因引用已删局部变量抛 ReferenceError，
// 导致 onUp 中断、document 级监听泄漏、节点"粘手"（永远跟随鼠标）。
// 此测试覆盖该路径：拖节点到非网格位置 → 松手 → 吸附动画 → 断言
//   1) 节点最终停在 20px 网格点
//   2) 动画引擎正常启停（_activeSnapAnims 清空、interval/rAF 自停）
//   3) 无监听泄漏：松手后再 mousemove，节点不跟随（dragState 已清）
// 用法: node test/node-drag-snap-test.js [--headed]
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

// 浏览器可执行文件: 环境变量优先(CI), 缺省回退本机 Edge
const EDGE = process.env.WEAVE_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
// 应用地址: 相对定位仓库内文件(可移植)
const APP_URL = process.env.WEAVE_APP_URL || pathToFileURL(path.join(__dirname, '..', 'APPs', 'Weave.html')).href;
const SHOTS = path.join(__dirname, 'shots-dragsnap');
fs.mkdirSync(SHOTS, { recursive: true });
const HEADED = process.argv.includes('--headed');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (cond, msg) => { console.log((cond ? '✅ ' : '❌ ') + msg); if (!cond) failures++; };

// 总超时保护：若回归导致页面挂起（如监听泄漏引发事件风暴），
// 60s 后强制失败退出，而非无限等待（CI 友好）。
const HARD_TIMEOUT_MS = 60000;
const hardTimer = setTimeout(() => {
  console.error('❌ 测试超时（60s）——疑似回归导致页面挂起/事件风暴');
  process.exit(1);
}, HARD_TIMEOUT_MS);
hardTimer.unref?.();

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: !HEADED,
    args: ['--no-first-run', '--no-sandbox', '--disable-gpu', '--window-size=1280,800'],
    defaultViewport: { width: 1280, height: 800 }
  });
  const page = await browser.newPage();
  await page.goto(APP_URL, { waitUntil: 'load' });
  await page.waitForFunction('!!window.App && !!document.getElementById("canvasStage") && document.getElementById("canvasStage").clientWidth > 0', { timeout: 15000 });
  await sleep(500);
  // 关闭首启设置弹窗
  await page.keyboard.press('Escape');
  await sleep(200);

  // 清空状态 + 确保网格吸附开启（默认）
  await page.evaluate(() => {
    localStorage.clear();
    location.reload();
  });
  await sleep(800);
  await page.waitForFunction('!!window.App && !!document.getElementById("canvasStage")', { timeout: 15000 });
  await page.keyboard.press('Escape');
  await sleep(200);

  // 造一个干净节点（位置在网格点 0,0）
  await page.evaluate(() => {
    App.canvasState.nodes = [{ id: 'n1', label: '拖我', desc: '', color: 'blue', x: 0, y: 0, mirrored: false, w: 170, h: 80 }];
    App.canvasState.connections = [];
    App.canvasState.regions = [];
    App.canvasState.history = [];
    App.canvasHistoryIndex = -1;
    App.panX = 0; App.panY = 0; App.scale = 1;
    App._snapNodes = true;
    App._snapSize = false;
    App.saveCanvasSnapshot();
    App.renderCanvas();
    App.applyViewTransform();
  });
  await sleep(400);

  // 节点中心（屏幕坐标）
  const nodePt = await page.evaluate(() => {
    const el = App._nodeElMap.get('n1');
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });

  // ── 1) 拖到非网格位置（+37,+23 → 世界非 20 倍数）→ 松手 → 吸附动画 → 落网格点 ──
  await page.mouse.move(nodePt.x, nodePt.y);
  await page.mouse.down();
  await page.mouse.move(nodePt.x + 37, nodePt.y + 23, { steps: 10 });
  await page.mouse.up();
  // 动画约 150ms，等待完成
  await sleep(500);
  const after1 = await page.evaluate(() => {
    const n = App.canvasState.nodes[0];
    const anims = App._activeSnapAnims ? App._activeSnapAnims.size : 'n/a';
    return { x: n.x, y: n.y, anims, dragState: !!App.dragState, isDragging: App.isDragging,
             dataInterval: App._snapDataInterval, renderRaf: App._snapRenderRaf };
  });
  ok(after1.x % 20 === 0 && after1.y % 20 === 0, '吸附开：拖后节点落 20px 网格点 (x=' + after1.x + ', y=' + after1.y + ')');
  ok(after1.anims === 0, '动画结束后 _activeSnapAnims 清空 (=' + after1.anims + ')');
  ok(after1.dragState === false && after1.isDragging === false, '松手后 dragState 清空（不粘手）');
  ok(after1.dataInterval === null && after1.renderRaf === null, '动画引擎自停（interval/rAF 已清理）');
  // 数据与视觉一致（防 totalMs 类：数据已设网格点但 DOM transform 未更新）
  const visual1 = await page.evaluate(() => {
    const el = App._nodeElMap.get('n1');
    const n = App.canvasState.nodes[0];
    const m = el.style.transform.match(/translate\(([^,]+)px,\s*([^)]+)px\)/);
    return { vx: m ? parseFloat(m[1]) : NaN, vy: m ? parseFloat(m[2]) : NaN, dx: n.x, dy: n.y };
  });
  ok(Math.abs(visual1.vx - visual1.dx) < 0.5 && Math.abs(visual1.vy - visual1.dy) < 0.5,
    '吸附后 DOM 与数据一致 (dom ' + visual1.vx + ',' + visual1.vy + ' vs data ' + visual1.dx + ',' + visual1.dy + ')');

  // ── 2) 松手后移动鼠标 → 节点不跟随（无监听泄漏）──
  const posBefore = await page.evaluate(() => ({ x: App.canvasState.nodes[0].x, y: App.canvasState.nodes[0].y }));
  await page.mouse.move(nodePt.x + 300, nodePt.y + 200, { steps: 5 });
  await sleep(200);
  const posAfter = await page.evaluate(() => ({ x: App.canvasState.nodes[0].x, y: App.canvasState.nodes[0].y }));
  ok(posAfter.x === posBefore.x && posAfter.y === posBefore.y,
    '松手后鼠标移动节点不跟随（x ' + posBefore.x + '→' + posAfter.x + '）');
  await page.screenshot({ path: path.join(SHOTS, '01_after_drag_snap.png') });

  // ── 3) 关吸附 → 拖到像素位 → 无动画直接落位 ──
  await page.evaluate(() => { App._snapNodes = false; });
  await sleep(100);
  const nodePt2 = await page.evaluate(() => {
    const el = App._nodeElMap.get('n1');
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(nodePt2.x, nodePt2.y);
  await page.mouse.down();
  await page.mouse.move(nodePt2.x + 53, nodePt2.y + 41, { steps: 8 });
  await page.mouse.up();
  await sleep(300);
  const after3 = await page.evaluate(() => {
    const n = App.canvasState.nodes[0];
    return { x: n.x, y: n.y, anims: App._activeSnapAnims ? App._activeSnapAnims.size : 'n/a' };
  });
  ok(after3.x % 20 !== 0 || after3.y % 20 !== 0, '吸附关：保留像素位 (x=' + after3.x + ', y=' + after3.y + ')');
  ok(after3.anims === 0, '吸附关无动画');
  await page.screenshot({ path: path.join(SHOTS, '02_snap_off.png') });

  // ── 4) 双击建节点仍正常（回归：节点路径未被破坏）──
  const cdp = await page.createCDPSession();
  const dblPt = await page.evaluate(() => {
    const s = document.getElementById('canvasStage').getBoundingClientRect();
    return { x: s.left + s.width - 150, y: s.top + 100 };
  });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dblPt.x, y: dblPt.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dblPt.x, y: dblPt.y, button: 'left', buttons: 1, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dblPt.x, y: dblPt.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(60);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dblPt.x, y: dblPt.y, button: 'left', buttons: 1, clickCount: 2 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dblPt.x, y: dblPt.y, button: 'left', buttons: 0, clickCount: 2 });
  await sleep(350);
  const nCount = await page.evaluate(() => App.canvasState.nodes.length);
  ok(nCount === 2, '双击建节点正常 (节点数=' + nCount + ')');

  console.log(failures === 0 ? '\n✅ 节点拖拽吸附测试全部通过' : '\n❌ ' + failures + ' 项失败');
  await browser.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });

