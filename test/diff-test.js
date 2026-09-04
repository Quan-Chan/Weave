'use strict';
// 差分测试 — "最终效果与原版完全相同"的主验证手段。
// 同时驱动两个页面：A = 原版（git HEAD:APPs/Weave.html），B = 新版（工作区），
// 逐步执行相同的交互序列，每步比对：
//   1. App 状态快照（nodes/connections/viewport/选择集/设置，JSON 深比较）
//   2. 页面截图字节（Buffer.compare，同机同浏览器渲染应逐位一致）
//   3. 导出产物（JSON 存档文本 / PNG dataURL 字节）
// 用法: node test/diff-test.js
const puppeteer = require('puppeteer-core');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const EDGE = process.env.WEAVE_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const NEW_URL = pathToFileURL(path.join(__dirname, '..', 'APPs', 'Weave.html')).href;
const TMP_DIR = path.join(__dirname, 'tmp');
const ORIG_FILE = path.join(TMP_DIR, 'orig.html');
const SHOTS = path.join(__dirname, 'shots-diff');
fs.mkdirSync(TMP_DIR, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });

// 原版 = git HEAD 中的 Weave.html（工作区须未提交重构前运行才有效）
const orig = execFileSync('git', ['show', 'HEAD:APPs/Weave.html']);
fs.writeFileSync(ORIG_FILE, orig);
const ORIG_URL = pathToFileURL(ORIG_FILE).href;

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
let step = 0;

// 页面状态指纹（JSON 深比较用；运行时随机 id 归一化为 N0/C0 序列，其余原样）
const fpSrc = () => {
  const idMap = {};
  const nodes = App.canvasState.nodes.map(n => {
    const key = 'N' + Object.keys(idMap).length;
    idMap[n.id] = key;
    return { ...n, id: key };
  });
  const connMap = {};
  const conns = App.canvasState.connections.map((c, i) => {
    connMap[c.id] = 'C' + i;
    return { ...c, id: 'C' + i, from: idMap[c.from] || c.from, to: idMap[c.to] || c.to };
  });
  return JSON.stringify({
    nodes,
    conns,
    panX: App.panX, panY: App.panY, scale: App.scale,
    selNodes: [...App.selectedNodeIds].map(x => idMap[x] || x).sort(),
    selConns: [...App.selectedConnIds].map(x => connMap[x] || x).sort(),
    readOnly: App.readOnly, snapNodes: App._snapNodes, snapSize: App._snapSize,
    chromeHidden: App._chromeHidden, clipboard: (App._clipboard || []).length,
    domNodes: document.querySelectorAll('.node').length,
    domPaths: document.querySelectorAll('.lines path').length,
    domLabels: document.querySelectorAll('.labels text').length
  });
};

// 导出文本归一化：随机 id → 序号
function normalizeSerialized(text) {
  const d = JSON.parse(text);
  const idMap = {};
  let ni = 0;
  for (const n of d.nodes || []) idMap[n.id] = 'N' + ni++;
  const nodes = (d.nodes || []).map(n => ({ ...n, id: idMap[n.id] }));
  const conns = (d.connections || []).map((c, i) => ({
    ...c, id: 'C' + i,
    from: idMap[c.from] || c.from,
    to: idMap[c.to] || c.to
  }));
  return JSON.stringify({ nodes, connections: conns, viewport: d.viewport });
}

const INSTALL_CAPTURE = () => {
  window.__dl = null;
  window.__blobs = {};
  const origClick = HTMLAnchorElement.prototype.click;
  const origCreate = URL.createObjectURL;
  HTMLAnchorElement.prototype.click = function () {
    window.__dl = { href: this.href, name: this.download };
  };
  URL.createObjectURL = function (blob) {
    const u = origCreate.call(this, blob);
    window.__blobs[u] = blob;
    return u;
  };
  window.__restoreCapture = () => {
    HTMLAnchorElement.prototype.click = origClick;
    URL.createObjectURL = origCreate;
  };
};
const READ_CAPTURE = async () => {
  const dl = window.__dl;
  if (!dl) return { kind: 'none' };
  if (dl.href && dl.href.startsWith('blob:')) {
    const blob = window.__blobs[dl.href];
    const text = await blob.text();
    return { kind: 'json', name: dl.name, text };
  }
  if (dl.href && dl.href.startsWith('data:')) {
    return { kind: 'dataurl', name: dl.name, text: dl.href };
  }
  return { kind: 'other', name: dl.name, href: dl.href };
};

// 容差像素比较：在页面内解码两张 PNG，统计超出 ±2/通道 的差异像素数
const PIXEL_CMP = (page, aBuf, bBuf) => page.evaluate(async (a, b) => {
  const load = d => new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = 'data:image/png;base64,' + d;
  });
  const [ia, ib] = await Promise.all([load(a), load(b)]);
  const W = ia.width, H = ia.height;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.drawImage(ia, 0, 0);
  const da = ctx.getImageData(0, 0, W, H).data;
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(ib, 0, 0);
  const db = ctx.getImageData(0, 0, W, H).data;
  let diff = 0, maxD = 0;
  for (let i = 0; i < da.length; i += 4) {
    if (da[i] !== db[i] || da[i + 1] !== db[i + 1] || da[i + 2] !== db[i + 2] || da[i + 3] !== db[i + 3]) {
      const d = Math.max(
        Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2])
      );
      if (d > maxD) maxD = d;
      if (d > 2) diff++;
    }
  }
  return { diff, maxD, total: W * H };
}, aBuf.toString('base64'), bBuf.toString('base64'));

async function stepCompare(pageA, pageB, label, waitMs) {
  step++;
  await sleep(waitMs || 350);
  const fa = await pageA.evaluate(fpSrc);
  const fb = await pageB.evaluate(fpSrc);
  // toast 由 3s 定时器驱动，两页时序微差会导致淡出相位不同——对称隐藏后再截图
  const hideToast = () => {
    const c = document.getElementById('toastContainer');
    if (c) c.style.visibility = 'hidden';
  };
  const shotPair = async () => {
    await pageA.evaluate(hideToast);
    await pageB.evaluate(hideToast);
    const sa = await pageA.screenshot({ encoding: 'binary' });
    const sb = await pageB.screenshot({ encoding: 'binary' });
    return { sa, sb };
  };
  let { sa, sb } = await shotPair();
  let shotEq = Buffer.compare(sa, sb) === 0;
  let toleranceNote = '';
  if (!shotEq) {
    // 时序抖动（过渡动画等）重试一次：额外等待后重新截图
    await sleep(1500);
    const r2 = await shotPair();
    sa = r2.sa; sb = r2.sb;
    shotEq = Buffer.compare(sa, sb) === 0;
    if (!shotEq) {
      // GPU 光栅化在独立页面间可能有 ±1 抗锯齿抖动——做容差像素比较
      const pc = await PIXEL_CMP(pageA, sa, sb);
      if (pc.diff === 0) {
        shotEq = true;
        toleranceNote = '  （字节不同，容差±2内一致，最大偏差' + pc.maxD + '）';
      } else {
        toleranceNote = '  （字节不同，容差外差异像素 ' + pc.diff + '/' + pc.total + '，最大偏差 ' + pc.maxD + '）';
      }
    }
  }
  const stateEq = fa === fb;
  console.log((stateEq && shotEq ? '✅' : '❌') + ' [' + String(step).padStart(2, '0') + '] ' + label +
    (stateEq ? '' : '  状态不一致') + (shotEq ? '' : '  截图不一致') + toleranceNote);
  fs.writeFileSync(path.join(SHOTS, String(step).padStart(2, '0') + '_A_' + label + '.png'), sa);
  fs.writeFileSync(path.join(SHOTS, String(step).padStart(2, '0') + '_B_' + label + '.png'), sb);
  if (!stateEq) {
    console.log('   ── 状态 A ──'); console.log(fa);
    console.log('   ── 状态 B ──'); console.log(fb);
    failures++;
  }
  if (!shotEq) failures++;
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: true,
    args: ['--no-first-run', '--no-sandbox', '--disable-gpu', '--window-size=1280,800'],
    defaultViewport: { width: 1280, height: 800 }
  });
  const ctxA = await browser.createBrowserContext();
  const ctxB = await browser.createBrowserContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  // 双页一致地隔离 localStorage（file:// 共享源可能串扰）并禁用自动保存
  for (const p of [a, b]) {
    await p.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch (e) {} });
  }
  await a.goto(ORIG_URL, { waitUntil: 'load' });
  await b.goto(NEW_URL, { waitUntil: 'load' });
  for (const p of [a, b]) {
    await p.waitForFunction('!!window.App && !!document.getElementById("canvasStage") && document.getElementById("canvasStage").clientWidth > 0', { timeout: 15000 });
    await p.evaluate(() => { App.saveCanvas = () => {}; });
    // 关闭首次启动的设置弹窗（否则会拦截画布交互，步骤 01 起全部失效）
    await p.evaluate(() => {
      if (document.getElementById('settingsModal').classList.contains('on')) App.closeSettings();
    });
  }
  await sleep(600);
  console.log('✅ 双页加载完成（A=原版 B=新版）');

  // 画布中心（两页布局一致）
  const base = await a.evaluate(() => {
    const r = document.getElementById('canvasStage').getBoundingClientRect();
    return { left: r.left, top: r.top, w: r.width, h: r.height };
  });
  const cx = base.left + base.w / 2, cy = base.top + base.h / 2;

  // CDP 双击（clickCount 1→2 序列，headless 必需）
  const cdpA = await a.createCDPSession();
  const cdpB = await b.createCDPSession();
  const dbl = async (p, cdp, x, y) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(60);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 2 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 2 });
    await sleep(120);
  };
  const both = async (fn) => { await fn(a, cdpA); await fn(b, cdpB); };

  const socketPos = async (p) => p.evaluate(() => {
    const sp = {};
    App.canvasState.nodes.forEach((nd, i) => {
      const el = App._nodeElMap.get(nd.id);
      for (const side of ['out', 'in']) {
        const r = el.querySelector('.socket.' + side).getBoundingClientRect();
        sp[i + '_' + side] = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
    });
    return sp;
  });
  const ctxMenuItems = async (p) => p.evaluate(() =>
    Array.from(document.querySelectorAll('#ctx button')).map(bb => {
      const r = bb.getBoundingClientRect();
      return { text: bb.textContent.trim(), x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })
  );
  const nodePos = async (p, i, dx, dy) => p.evaluate((ii, dxx, dyy) => {
    const el = App._nodeElMap.get(App.canvasState.nodes[ii].id);
    const r = el.getBoundingClientRect();
    return { x: r.left + (dxx || 30), y: r.top + (dyy || 20) };
  }, i, dx, dy);

  // ── 步骤序列（两页逐一执行同一操作）──
  await both(async (p, cdp) => { await dbl(p, cdp, cx - 200, cy); });
  await both(async (p, cdp) => { await dbl(p, cdp, cx + 200, cy); });
  await stepCompare(a, b, '01 双击建 2 节点');

  // 拖拽节点 0（中途比对一次，防止拖拽过程性回归）
  const n0 = await nodePos(a, 0, 30, 20);
  await both(async (p) => {
    await p.mouse.move(n0.x, n0.y);
    await p.mouse.down();
    await p.mouse.move(n0.x + 60, n0.y + 40, { steps: 5 });
  });
  await stepCompare(a, b, '02a 拖拽中途');
  await both(async (p) => {
    await p.mouse.move(n0.x + 60, n0.y + 40, { steps: 5 });
    await p.mouse.up();
  });
  await stepCompare(a, b, '02 拖拽节点');

  // socket 连线 0_out → 1_in（中途比对临时线存在与几何）
  const s1 = await socketPos(a);
  await both(async (p) => {
    await p.mouse.move(s1['0_out'].x, s1['0_out'].y);
    await p.mouse.down();
    await p.mouse.move(s1['1_in'].x, s1['1_in'].y, { steps: 6 });
  });
  await stepCompare(a, b, '03a 拖线中途（临时线）');
  await both(async (p) => {
    await p.mouse.move(s1['1_in'].x, s1['1_in'].y, { steps: 6 });
    await p.mouse.up();
  });
  await stepCompare(a, b, '03 拖线连线');

  // 右键 → 镜像节点 0
  const n0b = await nodePos(a, 0, 30, 20);
  await both(async (p) => { await p.mouse.click(n0b.x, n0b.y, { button: 'right' }); await sleep(150); });
  const menu = await ctxMenuItems(a);
  const mir = menu.find(m => m.text.includes('镜像'));
  await both(async (p) => { await p.mouse.click(mir.x, mir.y); });
  await stepCompare(a, b, '04 右键镜像');

  // 平行第二条线
  const s2 = await socketPos(a);
  await both(async (p) => {
    await p.mouse.move(s2['0_out'].x, s2['0_out'].y);
    await p.mouse.down();
    await p.mouse.move(s2['1_in'].x, s2['1_in'].y, { steps: 12 });
    await p.mouse.up();
  });
  await stepCompare(a, b, '05 平行连线');

  // 框选（Shift + 拖拽覆盖两节点）
  await both(async (p) => {
    await p.keyboard.down('Shift');
    await p.mouse.move(cx - 260, cy - 60);
    await p.mouse.down();
    await p.mouse.move(cx + 260, cy + 60, { steps: 10 });
    await p.mouse.up();
    await p.keyboard.up('Shift');
  });
  await stepCompare(a, b, '06 框选');

  // 滚轮缩放（放大 3 档 / 缩小 3 档）——覆盖 scale 相关缓存路径
  await both(async (p, cdp2) => {
    await cdp2.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy });
    for (let i = 0; i < 3; i++) {
      await cdp2.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: -240 });
      await sleep(40);
    }
  });
  await sleep(200);
  await stepCompare(a, b, '06a 滚轮放大');
  await both(async (p, cdp2) => {
    await cdp2.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy });
    for (let i = 0; i < 3; i++) {
      await cdp2.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: 240 });
      await sleep(40);
    }
  });
  await sleep(200);
  await stepCompare(a, b, '06b 滚轮缩小');

  // 空白处拖拽平移画布
  await both(async (p) => {
    await p.mouse.move(cx + 300, cy + 200);
    await p.mouse.down();
    await p.mouse.move(cx + 380, cy + 260, { steps: 8 });
    await p.mouse.up();
  });
  await sleep(200);
  await stepCompare(a, b, '06c 平移画布');

  // 撤销 ×2 / 重做 ×1
  await both(async (p) => { await p.keyboard.down('Control'); await p.keyboard.press('z'); await p.keyboard.up('Control'); });
  await both(async (p) => { await p.keyboard.down('Control'); await p.keyboard.press('z'); await p.keyboard.up('Control'); });
  await stepCompare(a, b, '07 撤销×2');
  await both(async (p) => { await p.keyboard.down('Control'); await p.keyboard.press('y'); await p.keyboard.up('Control'); });
  await stepCompare(a, b, '08 重做×1');

  // 内联编辑标题
  const titlePos = await a.evaluate(() => {
    const el = App._nodeElMap.get(App.canvasState.nodes[0].id);
    const h = el.querySelector('.node-header').getBoundingClientRect();
    return { x: h.left + h.width / 2, y: h.top + h.height / 2 };
  });
  await both(async (p, cdp) => { await dbl(p, cdp, titlePos.x, titlePos.y); await sleep(200); });
  await both(async (p) => {
    await p.keyboard.down('Control'); await p.keyboard.press('a'); await p.keyboard.up('Control');
    await p.keyboard.type('差分测试标题');
  });
  await both(async (p) => { await p.mouse.click(cx, cy + 250); });
  await stepCompare(a, b, '09 内联编辑标题');

  // 设置弹窗：关闭吸附
  const gear = await a.evaluate(() => {
    const el = document.getElementById('btnShowSettings').getBoundingClientRect();
    return { x: el.left + el.width / 2, y: el.top + el.height / 2 };
  });
  await both(async (p) => { await p.mouse.click(gear.x, gear.y); await sleep(200); });
  await both(async (p) => {
    const on = await p.evaluate(`document.getElementById('settingsModal').classList.contains('on')`);
    if (!on) throw new Error('设置弹窗未打开');
    await p.evaluate(() => { document.getElementById('setSnapNodes').click(); });
    await p.keyboard.press('Escape');
  });
  await stepCompare(a, b, '10 设置吸附切换');

  // Ctrl+H 专注模式两次（隐藏/恢复）
  await both(async (p) => {
    await p.keyboard.down('Control'); await p.keyboard.press('h'); await p.keyboard.up('Control');
  });
  await stepCompare(a, b, '11 Ctrl+H 隐藏');
  await both(async (p) => {
    await p.keyboard.down('Control'); await p.keyboard.press('h'); await p.keyboard.up('Control');
  });
  await stepCompare(a, b, '12 Ctrl+H 恢复');

  // 只读模式切换两次
  const roBtn = await a.evaluate(() => {
    const el = document.getElementById('sidebarReadOnlyBtn').getBoundingClientRect();
    return { x: el.left + el.width / 2, y: el.top + el.height / 2 };
  });
  await both(async (p) => { await p.mouse.click(roBtn.x, roBtn.y); });
  await stepCompare(a, b, '13 只读开');
  await both(async (p) => { await p.mouse.click(roBtn.x, roBtn.y); });
  await stepCompare(a, b, '14 只读关');

  // 导出 JSON（拦截下载，比对归一化后的文本）
  for (const p of [a, b]) await p.evaluate(INSTALL_CAPTURE);
  await a.evaluate(() => App.doExport());
  await b.evaluate(() => App.doExport());
  const jA = await a.evaluate(READ_CAPTURE);
  const jB = await b.evaluate(READ_CAPTURE);
  const jsonEq = jA.kind === jB.kind && normalizeSerialized(jA.text) === normalizeSerialized(jB.text);
  step++;
  console.log((jsonEq ? '✅' : '❌') + ' [' + String(step).padStart(2, '0') + '] 导出 JSON（id 归一化后）一致');
  if (!jsonEq) { console.log('   A: ' + jA.text); console.log('   B: ' + jB.text); failures++; }
  for (const p of [a, b]) await p.evaluate(() => window.__restoreCapture());

  // 导出 PNG（比对 dataURL 字节）
  for (const p of [a, b]) await p.evaluate(INSTALL_CAPTURE);
  await a.evaluate(() => App.exportPNG());
  await b.evaluate(() => App.exportPNG());
  const pA = await a.evaluate(READ_CAPTURE);
  const pB = await b.evaluate(READ_CAPTURE);
  const pngEq = pA.kind === pB.kind && pA.text === pB.text && (pA.text || '').length > 100;
  step++;
  console.log((pngEq ? '✅' : '❌') + ' [' + String(step).padStart(2, '0') + '] 导出 PNG dataURL 一致' + (pngEq ? '' : '（长度 ' + (pA.text || '').length + ' vs ' + (pB.text || '').length + '）'));
  if (!pngEq) failures++;
  for (const p of [a, b]) await p.evaluate(() => window.__restoreCapture());

  // 全选 + 删除
  await both(async (p) => {
    await p.keyboard.down('Control'); await p.keyboard.press('a'); await p.keyboard.up('Control');
    await p.keyboard.press('Delete');
  });
  await stepCompare(a, b, '17 全选删除');

  // 最终截图
  await stepCompare(a, b, '18 最终状态', 600);

  console.log(failures === 0 ? '✅ 差分测试全部通过：新版与原版逐步骤完全一致' : '❌ 差分测试存在 ' + failures + ' 项不一致');
  await browser.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('❌ 差分测试异常:', e.message); process.exit(1); });

