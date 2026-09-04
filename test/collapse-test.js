'use strict';
// 收起/展开节点串功能测试 — puppeteer-core + 系统 Edge 无头。
// 覆盖：需求 1（点击收起/再点击展开）、需求 2（相对位置保存）、
//       需求 3（嵌套收起 & 多父冲突禁止）、需求 4（悬停 ± 徽标）、
//       需求 5（PNG 导出含收起呈现、无 ± 徽标）。
// 用法: node test/collapse-test.js [--headed]
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

// 浏览器可执行文件: 环境变量优先(CI), 缺省回退本机 Edge
const EDGE = process.env.WEAVE_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
// 应用地址: 相对定位仓库内文件(可移植)
const APP_URL = process.env.WEAVE_APP_URL || pathToFileURL(path.join(__dirname, '..', 'APPs', 'Weave.html')).href;
const SHOTS = path.join(__dirname, 'shots-collapse');
fs.mkdirSync(SHOTS, { recursive: true });
const HEADED = process.argv.includes('--headed');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let step = 0;
const shot = async (page, name) => {
  step++;
  const f = path.join(SHOTS, String(step).padStart(2, '0') + '_' + name + '.png');
  await page.screenshot({ path: f });
  console.log('shot: ' + name + ' -> ' + f);
  return f;
};

(async () => {
  // Sandbox note: spawn Edge manually with stdio ignore (pipe stdio is denied);
  // discover debug port from DevToolsActivePort, then puppeteer.connect.
  const { spawn } = require("child_process");
  const os = require("os");
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "weave-pup-"));
  const edgeProc = spawn(EDGE, [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--window-size=1280,800",
    "--remote-debugging-port=0",
    "--user-data-dir=" + userDataDir,
    "about:blank"
  ], { stdio: ["ignore", "ignore", "ignore"] });
  edgeProc.on("error", e => { console.log("edge spawn error: " + e.message); });
  const portFile = path.join(userDataDir, "DevToolsActivePort");
  const wsDeadline = Date.now() + 25000;
  let wsUrl = null;
  while (Date.now() < wsDeadline && !wsUrl) {
    if (fs.existsSync(portFile)) {
      const pl = fs.readFileSync(portFile, "utf8").split(/\r?\n/).filter(Boolean);
      if (pl.length >= 2) wsUrl = "ws://127.0.0.1:" + pl[0] + pl[1];
    }
    if (!wsUrl) await new Promise(r => setTimeout(r, 200));
  }
  if (!wsUrl) { console.log("FAIL: no DevTools ws url"); process.exit(1); }
  const browser = await puppeteer.connect({ browserWSEndpoint: wsUrl, defaultViewport: { width: 1280, height: 800 }, protocolTimeout: 120000 });
  const page = await browser.newPage();
  await page.goto(APP_URL, { waitUntil: "load" });
  await page.waitForFunction("'!!window.App && !!document.getElementById(\"canvasStage\") && document.getElementById(\"canvasStage\").clientWidth > 0'", { timeout: 15000 });
  await sleep(600);
  await page.keyboard.press("Escape");
  await sleep(200);
  const fail = (msg) => { throw new Error(msg); };

  // ── 布置：A → B → C 链 + D 旁支（B→D） ──
  await page.evaluate(() => {
    const mk = (label, x, y) => ({ id: 'x_' + label, label, desc: '', color: 'blue', x, y, mirrored: false, w: 170, h: 80 });
    App.canvasState.nodes = [mk('A', 0, 0), mk('B', 320, 0), mk('C', 640, 0), mk('D', 480, 220)];
    App.canvasState.connections = [
      { id: 'c_AB', from: 'x_A', to: 'x_B', label: '', mirrored: false },
      { id: 'c_BC', from: 'x_B', to: 'x_C', label: '', mirrored: false },
      { id: 'c_BD', from: 'x_B', to: 'x_D', label: '', mirrored: false }
    ];
    App._nodeZOrder = App.canvasState.nodes.map(n => n.id);
    App.saveCanvasSnapshot();
    App.renderCanvas();
  });
  await sleep(300);
  await page.evaluate(() => { App.centerCanvasOnNodes(); });
  await sleep(400);
  await shot(page, '00_initial');

  // ── 微调：未收起且未悬停 → 无徽标；socket 光标为系统默认 ──
  const st0 = await page.evaluate(() => {
    const el = App._nodeElMap.get('x_A');
    const sock = el.querySelector('.socket.out');
    const fold = el.querySelector('.socket-fold');
    const fcs = getComputedStyle(fold);
    return { foldDisplay: fcs.display, innerDisplay: getComputedStyle(el.querySelector('.socket.out .socket-inner')).display, cursor: getComputedStyle(sock).cursor };
  });
  console.log('micro-init:', JSON.stringify(st0));
  // 可收起的连接点：fold（−）常态显示、inner 圆点隐藏（fold 替换圆点）
  if (st0.foldDisplay === 'none') fail('微调1a: 可收起的连接点未悬停时也应显示 − 徽标, got ' + JSON.stringify(st0));
  if (st0.innerDisplay === 'block') fail('微调1a: 可收起的连接点 inner 圆点应隐藏（fold 替换）, got ' + JSON.stringify(st0));
  if (st0.cursor !== 'default') fail('微调3: socket 光标应为系统默认(default), got ' + st0.cursor);

  // 辅助：屏幕坐标
  const sck = async (id, side) => page.evaluate(([id, side]) => {
    const n = App._getNodeById(id);
    const a = Weave.Geom.getSocketAnchor(n, side);
    const { panX, panY, scale } = App;
    const c = document.getElementById('canvasStage').getBoundingClientRect();
    return { x: c.left + a.x * scale + panX, y: c.top + a.y * scale + panY };
  }, [id, side]);

  // ── 需求4a：悬停 A.out → 显示 − 徽标 ──
  const aOut = await sck('x_A', 'out');
  await page.mouse.move(aOut.x, aOut.y, { steps: 4 });
  await sleep(300);
  const hoverBadge = await page.evaluate(() => {
    const el = App._nodeElMap.get('x_A');
    const fold = el.querySelector('.socket-fold');
    const cs = getComputedStyle(fold);
    return { isPlus: fold.classList.contains('fold-plus'), display: getComputedStyle(fold).display, av: el.querySelector('.socket.out').className };
  });
  console.log('hoverA:', JSON.stringify(hoverBadge));
  if (hoverBadge.isPlus || hoverBadge.display === 'none') fail('需求4a: 未收起应显示 − 徽标: ' + JSON.stringify(hoverBadge));
  await shot(page, '01_hover_minus');

  // ── 需求1：点击（不拖拽）A.out → 收起 B、C、D ──
  await page.mouse.click(aOut.x, aOut.y);
  await sleep(400);
  const collapsed = await page.evaluate(() => ({
    root: !!App._getNodeById('x_A').collapse,
    rootHidden: App._getNodeById('x_A').collapse ? App._getNodeById('x_A').collapse.hidden.length : 0,
    bHidden: App._isCollapseHidden('x_B'),
    cHidden: App._isCollapseHidden('x_C'),
    dHidden: App._isCollapseHidden('x_D'),
    domB: (() => { const el = App._nodeElMap.get('x_B'); return el ? getComputedStyle(el).display : 'gone'; })(),
    domC: (() => { const el = App._nodeElMap.get('x_C'); return el ? getComputedStyle(el).display : 'gone'; })(),
    domD: (() => { const el = App._nodeElMap.get('x_D'); return el ? getComputedStyle(el).display : 'gone'; })(),
    visPaths: document.querySelectorAll('#linesSvg .lines path.line:not(.temp)').length
  }));
  console.log('collapse:', JSON.stringify(collapsed));
  if (!collapsed.root) fail('需求1: 点击后根节点未建立记录');
  if (!(collapsed.bHidden && collapsed.cHidden && collapsed.dHidden)) fail('需求1: B/C/D 未全部隐藏');
  if (collapsed.visPaths !== 0) fail('需求1: 收起后仍有连线: ' + collapsed.visPaths);
  const dragLeft = await page.evaluate("!!document.querySelector('.socket.dragging')");
  if (dragLeft) fail('需求1: 点击后残留 dragging 类');
  await shot(page, '02_collapsed');

  // ── 微调1b：已收起 → 常态显示 +（不依赖悬停） ──
  // 把鼠标移开（移到左上角安全区域）
  await page.mouse.move(30, 300, { steps: 2 });
  await sleep(250);
  const st1 = await page.evaluate(() => {
    const el = App._nodeElMap.get('x_A');
    const fold = el.querySelector('.socket-fold');
    const sockCls = el.querySelector('.socket.out').className;
    const cs = getComputedStyle(fold);
    return { isPlus: fold.classList.contains('fold-plus'), display: cs.display, cls: sockCls };
  });
  console.log('micro-collapsed:', JSON.stringify(st1));
  if (!st1.isPlus || st1.display === 'none') fail('微调1b: 收起后常态应显示 + 徽标, got ' + JSON.stringify(st1));
  if (!st1.cls.includes('fold-on')) fail('微调1b: socket 缺少 fold-on 类, got ' + st1.cls);

  // ── 需求4b：悬停 A.out → 显示 + 徽标 ──
  await page.mouse.move(aOut.x, aOut.y, { steps: 3 });
  await sleep(250);
  const plusBadge = await page.evaluate(() => {
    const el = App._nodeElMap.get('x_A');
    const fold = el.querySelector('.socket-fold');
    const cs = getComputedStyle(fold);
    return { isPlus: fold.classList.contains('fold-plus'), display: cs.display };
  });
  console.log('hoverA-plus:', JSON.stringify(plusBadge));
  if (!plusBadge.isPlus || plusBadge.display === 'none') fail('需求4b: 已收起应显示 + 徽标: ' + JSON.stringify(plusBadge));
  await shot(page, '03_hover_plus');

  // ── 需求2：移动根 A → 展开 → 相对位置保持 ──
  const beforeExpand = await page.evaluate(() => {
    const A = App._getNodeById('x_A'), B = App._getNodeById('x_B'), C = App._getNodeById('x_C'), D = App._getNodeById('x_D');
    return { abx: B.x - A.x, aby: B.y - A.y, acx: C.x - A.x, acy: C.y - A.y, adx: D.x - A.x, ady: D.y - A.y };
  });
  console.log('rel:', JSON.stringify(beforeExpand));
  const aHdr = await page.evaluate(() => {
    const el = App._nodeElMap.get('x_A').querySelector('.node-header').getBoundingClientRect();
    return { x: el.left + el.width / 2, y: el.top + el.height / 2 };
  });
  await page.mouse.move(aHdr.x, aHdr.y);
  await page.mouse.down();
  await page.mouse.move(aHdr.x + 150, aHdr.y + 60, { steps: 10 });
  await page.mouse.up();
  await sleep(300);
  await shot(page, '04_root_moved');

  // ── 微调回归：折叠态拖拽连接点 → 徽标必须隐藏（.dragging 特异性） ──
  const aOutNow = await sck('x_A', 'out');
  await page.mouse.move(aOutNow.x, aOutNow.y);
  await page.mouse.down();
  await page.mouse.move(aOutNow.x + 60, aOutNow.y + 30, { steps: 3 });
  await sleep(200);
  const dragBadge = await page.evaluate(() => {
    const el = App._nodeElMap.get('x_A');
    const fold = el.querySelector('.socket-fold');
    return {
      display: getComputedStyle(fold).display,
      dragging: !!document.querySelector('.socket.dragging')
    };
  });
  console.log('micro-drag:', JSON.stringify(dragBadge));
  if (!dragBadge.dragging) fail('微调回归: 拖拽态未建立');
  if (dragBadge.display !== 'none') fail('微调回归: 拖拽态下徽标应隐藏, got ' + dragBadge.display);
  await page.mouse.up();
  await sleep(250);

  const aOut2 = await sck('x_A', 'out');
  await page.mouse.click(aOut2.x, aOut2.y);
  await sleep(400);
  const afterExpand = await page.evaluate(() => {
    const A = App._getNodeById('x_A'), B = App._getNodeById('x_B'), C = App._getNodeById('x_C'), D = App._getNodeById('x_D');
    return {
      rootCollapse: !!A.collapse,
      abx: B.x - A.x, aby: B.y - A.y, acx: C.x - A.x, acy: C.y - A.y, adx: D.x - A.x, ady: D.y - A.y,
      bHidden: App._isCollapseHidden('x_B'), cHidden: App._isCollapseHidden('x_C'), dHidden: App._isCollapseHidden('x_D'),
      visPaths: document.querySelectorAll('#linesSvg .lines path.line:not(.temp)').length
    };
  });
  console.log('expanded:', JSON.stringify(afterExpand));
  if (afterExpand.rootCollapse) fail('需求1: 展开后不应残留记录');
  if (afterExpand.bHidden || afterExpand.cHidden || afterExpand.dHidden) fail('需求1: 展开后仍隐藏');
  const tol = 0.01;
  const chk = (n, v, e) => { if (Math.abs(v - e) > tol) fail('需求2: ' + n + ' 相对位置破坏 ' + v + ' != ' + e); };
  chk('B-A x', afterExpand.abx, beforeExpand.abx); chk('B-A y', afterExpand.aby, beforeExpand.aby);
  chk('C-A x', afterExpand.acx, beforeExpand.acx); chk('C-A y', afterExpand.acy, beforeExpand.acy);
  chk('D-A x', afterExpand.adx, beforeExpand.adx); chk('D-A y', afterExpand.ady, beforeExpand.ady);
  if (afterExpand.visPaths !== 3) fail('需求1: 展开后应有 3 条连线: ' + afterExpand.visPaths);
  await shot(page, '05_expanded');

  // ── 需求3：嵌套收起 ──
  await page.evaluate(() => { App.toggleCollapse('x_B'); }); await sleep(350);
  await page.evaluate(() => { App.toggleCollapse('x_A'); }); await sleep(350);
  const nested = await page.evaluate(() => ({
    aHas: !!App._getNodeById('x_A').collapse,
    bHas: !!App._getNodeById('x_B').collapse,
    bHidden: App._isCollapseHidden('x_B'), cHidden: App._isCollapseHidden('x_C'), dHidden: App._isCollapseHidden('x_D')
  }));
  console.log('nested:', JSON.stringify(nested));
  if (!(nested.aHas && nested.bHas)) fail('需求3a: 外层根记录未保留内层根记录');
  await page.evaluate(() => { App.toggleCollapse('x_A'); }); await sleep(350);
  const nested2 = await page.evaluate(() => ({
    bHidden: App._isCollapseHidden('x_B'), cHidden: App._isCollapseHidden('x_C'), dHidden: App._isCollapseHidden('x_D'),
    bHas: !!App._getNodeById('x_B').collapse
  }));
  console.log('outer-expanded:', JSON.stringify(nested2));
  if (nested2.bHidden) fail('需求3b: 展开外层后 B 应可见');
  if (!nested2.cHidden || !nested2.dHidden) fail('需求3b: 外层展开不应展开内层');
  await shot(page, '06_nested_outer_expanded');
  await page.evaluate(() => { App.toggleCollapse('x_B'); }); await sleep(350);
  const nested3 = await page.evaluate(() => ({
    bHidden: App._isCollapseHidden('x_B'), cHidden: App._isCollapseHidden('x_C'), dHidden: App._isCollapseHidden('x_D')
  }));
  console.log('inner-expanded:', JSON.stringify(nested3));
  if (nested3.cHidden || nested3.dHidden) fail('需求3b: 展开内层后 C/D 应可见');

  // ── 多父冲突：E→B 与 A→B 并存 → A/E 收起禁止 ──
  await page.evaluate(() => {
    const E = { id: 'x_E', label: 'E', desc: '', color: 'green', x: 160, y: 300, mirrored: false, w: 170, h: 80 };
    App.canvasState.nodes.push(E);
    App.canvasState.connections.push({ id: 'c_EB', from: 'x_E', to: 'x_B', label: '', mirrored: false });
    App._nodeZOrder.push('x_E');
    App.saveCanvasSnapshot();
    App.renderCanvas();
  });
  await sleep(300);
  await page.evaluate(() => { App.centerCanvasOnNodes(); });
  await sleep(300);
  const cf = await page.evaluate(() => ({
    canA: App._canToggleCollapse('x_A'),
    canB: App._canToggleCollapse('x_B'),
    canC: App._canToggleCollapse('x_C'),
    canE: App._canToggleCollapse('x_E'),
    collapsed: !!App._getNodeById('x_A').collapse
  }));
  console.log('multi-parent:', JSON.stringify(cf));
  if (cf.collapsed) fail('多父: A 不应已收起');
  if (cf.canA) fail('多父: A 与 E 均连 B → A 不应可收起');
  if (!cf.canB) fail('多父: B 自身可收起（C/D 无多父）');
  if (cf.canC) fail('多父: 叶子 C 不应可收起');
  if (cf.canE) fail('多父: E 连 B → E 不应可收起');
  await shot(page, '07_multi_parent');

  // ── 需求5a：B 收起 C、D → 导出 PNG ──
  await page.evaluate(() => { App.toggleCollapse('x_B'); }); await sleep(400);
  const bStates = await page.evaluate(() => ({
    bHas: !!App._getNodeById('x_B').collapse,
    cHidden: App._isCollapseHidden('x_C'),
    vis: document.querySelectorAll('#linesSvg .lines path.line:not(.temp)').length
  }));
  console.log('B collapsed:', JSON.stringify(bStates));
  await shot(page, '08_b_collapsed_for_export');

  await page.evaluate(() => {
    window.__dl = null;
    HTMLAnchorElement.prototype.click = function () { window.__dl = { href: this.href, name: this.download }; };
  });
  await page.evaluate(async () => { await App.exportPNG(); });
  await sleep(1800);
  const dl = await page.evaluate('window.__dl');
  console.log('export:', dl ? dl.name : '(none)');
  if (!dl || !dl.name.endsWith('.png')) fail('需求5: PNG 下载未触发');
  const b64 = dl.href.split(',')[1];
  const pngBuf = Buffer.from(b64, 'base64');
  const pngPath = path.join(SHOTS, 'export_collapsed.png');
  fs.writeFileSync(pngPath, pngBuf);
  console.log('PNG saved -> ' + pngPath + ' (' + pngBuf.length + ' bytes)');
  const snapCheck = await page.evaluate(() => {
    const snap = App._buildExportSnapshot();
    return {
      liveFolds: document.querySelectorAll('.socket-fold').length,
      snapBadges: snap.querySelectorAll('.socket.out.fold-avail .socket-fold, .socket.out.fold-on .socket-fold').length,
      snapInners: snap.querySelectorAll('.socket .socket-inner').length,
      liveHidden: document.querySelectorAll('.node.collapse-hidden').length,
      snapHidden: snap.querySelectorAll('.node.collapse-hidden').length
    };
  });
  console.log('snapshot check:', JSON.stringify(snapCheck));
  if (snapCheck.snapBadges !== 0) fail('需求5b: 导出快照不应含 ± 徽标: ' + JSON.stringify(snapCheck));
  if (snapCheck.snapInners === 0) fail('需求5c: 导出快照应保留连接点圆点');
  if (snapCheck.snapHidden !== 0) fail('需求5a: 导出快照不应含收起节点');

  // ── 需求4 补充：叶子 C 悬停无徽标 ──
  await page.evaluate(() => { App.toggleCollapse('x_B'); }); await sleep(350);
  const cOut = await sck('x_C', 'out');
  await page.mouse.move(cOut.x, cOut.y, { steps: 3 });
  await sleep(250);
  const leaf = await page.evaluate(() => {
    const el = App._nodeElMap.get('x_C');
    const fold = el.querySelector('.socket-fold');
    const inner = el.querySelector('.socket.out .socket-inner');
    const out = el.querySelector('.socket.out');
    const fcs = getComputedStyle(fold);
    const ics = getComputedStyle(inner);
    return { foldDisplay: fcs.display, innerDisplay: ics.display, avail: out.classList.contains('fold-avail'), on: out.classList.contains('fold-on') };
  });
  console.log('leaf hover:', JSON.stringify(leaf));
  //叶子节点：fold 隐藏（无 −/+ 徽标），inner 圆点可见（与输入连接点同构）
  if (leaf.avail || leaf.on) fail('需求4: 叶子节点不应显示 −/+ 徽标');
  if (leaf.foldDisplay === 'block') fail('需求4: 叶子节点 fold 应隐藏');
  if (leaf.innerDisplay === 'none') fail('需求4: 叶子节点应显示普通圆点');
  await shot(page, '09_leaf_no_badge');

  console.log('ALL PASSED');
  await browser.close();
  try { edgeProc.kill(); } catch (e) {}
  await sleep(300);
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
