
'use strict';
// 【fold 渲染回归族 3/3 · 缩放渲染稳定】
// 验证: 快速滚轮缩放时 socket scale 不回落到 1(无抽搐闪烁)
const { launchBrowser, openApp, sleep } = require('./helpers/launch.js');
(async () => {
  const { browser, cleanup } = await launchBrowser(false);
  let exitCode = 1;   // try 外声明,供 finally 后退出
  try {
  const { page } = await openApp(browser);
  await page.evaluate(() => {
    const mk = (label, x, y) => ({ id: 'x_' + label, label, desc: '', color: 'blue', x, y, mirrored: false, w: 170, h: 80 });
    App.canvasState.nodes = [mk('A', 0, 0), mk('B', 320, 0)];
    App.canvasState.connections = [{ id: 'c_AB', from: 'x_A', to: 'x_B', label: '', mirrored: false }];
    App._nodeZOrder = App.canvasState.nodes.map(n => n.id);
    App.saveCanvasSnapshot();
    App.renderCanvas();
  });
  await sleep(300);
  await page.evaluate(() => { App.centerCanvasOnNodes(); });
  await sleep(400);
  const aOut = await page.evaluate(() => {
    const n = App._getNodeById('x_A');
    const a = Weave.Geom.getSocketAnchor(n, 'out');
    const { panX, panY, scale } = App;
    const c = document.getElementById('canvasStage').getBoundingClientRect();
    return { x: Math.round(c.left + a.x * scale + panX), y: Math.round(c.top + a.y * scale + panY) };
  });
  await page.mouse.move(aOut.x, aOut.y, { steps: 3 });
  await sleep(300);
  // 快速连续缩放（模拟真实滚轮），观察 socket scale 是否稳定在 1.35（无回落）
  const log = [];
  let minScale = 99, maxDip = 0;
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel({ deltaY: -120 });
    await sleep(60);  // 快速连续
    const s = await page.evaluate(() => {
      const el = App._nodeElMap.get('x_A').querySelector('.socket.out');
      const cs = getComputedStyle(el);
      return { scale: +new DOMMatrixReadOnly(cs.transform).a.toFixed(3), locked: el.classList.contains('hover-lock'), hover: el.matches(':hover') };
    });
    if (s.scale < minScale) minScale = s.scale;
    log.push(s.scale);
  }
  await sleep(400);  // 停止后稳定
  const finalS = await page.evaluate(() => {
    const el = App._nodeElMap.get('x_A').querySelector('.socket.out');
    const cs = getComputedStyle(el);
    return { scale: +new DOMMatrixReadOnly(cs.transform).a.toFixed(3), locked: el.classList.contains('hover-lock'), hover: el.matches(':hover') };
  });
  console.log('zoom seq scales:', JSON.stringify(log));
  console.log('min during zoom:', minScale);
  console.log('final:', JSON.stringify(finalS));
  // 判定：缩放期间 socket scale 从不回落到接近 1（抽搐时每次会回 1 再放大）
  const noDip = minScale > 1.2;
  const pass = noDip && finalS.hover && !finalS.locked;
  console.log(pass ? 'NO-TWITCH PASSED' : 'NO-TWITCH FAILED');
  exitCode = pass ? 0 : 1;
  } finally {
    await cleanup();
  }
  process.exit(exitCode);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
