
'use strict';
// 【fold 渲染回归族 1/3 · 徽标点击/拖拽显隐】
// 验证: 点击(不拖拽)时 fold 徽标保持可见(不误触收起);真拖拽时徽标保持可见(socket 仅放大)
// 已迁移至统一台架 test/helpers/launch.js
const { launchBrowser, openApp, sleep } = require('./helpers/launch.js');
(async () => {
  const { browser, cleanup } = await launchBrowser(false);
  let exitCode = 1;   // try 外声明,finally 后退出用
  try {
  const { page } = await openApp(browser);
  await page.evaluate(() => {
    const mk = (label, x, y) => ({ id: 'x_' + label, label, desc: '', color: 'blue', x, y, mirrored: false, w: 170, h: 80 });
    App.canvasState.nodes = [mk('A', 0, 0), mk('B', 320, 0), mk('C', 640, 0)];
    App.canvasState.connections = [
      { id: 'c_AB', from: 'x_A', to: 'x_B', label: '', mirrored: false },
      { id: 'c_BC', from: 'x_B', to: 'x_C', label: '', mirrored: false }
    ];
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
  const snap = () => page.evaluate(() => {
    const out = App._nodeElMap.get('x_A').querySelector('.socket.out');
    const fold = App._nodeElMap.get('x_A').querySelector('.socket-fold');
    const sf = getComputedStyle(fold);
    const inner = App._nodeElMap.get('x_A').querySelector('.socket.out .socket-inner');
    return { dragging: out.classList.contains('dragging'), foldDisplay: sf.display, foldOp: sf.opacity, innerDisplay: getComputedStyle(inner).display, outScale: +new DOMMatrixReadOnly(getComputedStyle(out).transform).a.toFixed(3) };
  });
  let failures = 0;
  const ok = (cond, msg) => { console.log((cond ? '✅ ' : '❌ ') + msg); if (!cond) failures++; };
  console.log('hover:', JSON.stringify(await snap()));
  // 点击：mousedown（不移动）→ 观察
  await page.mouse.down();
  await sleep(50);
  const mdSnap = await snap();
  console.log('mousedown(no move):', JSON.stringify(mdSnap));
  // 断言 1: 未收起(悬停 −)时,点击(按下不移动)徽标保持可见 —— 点击不应误触收起
  ok(mdSnap.foldDisplay !== 'none' && !mdSnap.dragging,
    '点击(不拖拽)时 − 徽标保持可见且未进入拖拽态 (display=' + mdSnap.foldDisplay + ', dragging=' + mdSnap.dragging + ')');
  await page.mouse.up();
  await sleep(100);
  const acSnap = await snap();
  console.log('after click:', JSON.stringify(acSnap));
  ok(acSnap.foldDisplay !== 'none', '点击释放后徽标仍可见 (display=' + acSnap.foldDisplay + ')');
  // 展开后再测拖拽：mousedown + 移动
  await page.evaluate(() => { App.toggleCollapse('x_A'); });
  await sleep(300);
  await page.mouse.move(aOut.x, aOut.y, { steps: 2 });
  await sleep(200);
  await page.mouse.down();
  await page.mouse.move(aOut.x + 60, aOut.y + 30, { steps: 5 });
  await sleep(50);
  const dgSnap = await snap();
  console.log('drag move:', JSON.stringify(dgSnap));
  // 断言 2: 真拖拽时徽标保持可见(中心元素不消失),socket 放大到 1.6×
  ok(dgSnap.dragging && dgSnap.foldDisplay !== 'none',
    '拖拽态下 fold 徽标保持可见 (dragging=' + dgSnap.dragging + ', display=' + dgSnap.foldDisplay + ')');
  ok(Math.abs(dgSnap.outScale - 1.6) < 0.01,
    '拖拽态下 socket 放大 1.6× (scale=' + dgSnap.outScale + ')');
  await page.mouse.up();
  await sleep(100);
  const adSnap = await snap();
  console.log('after drag:', JSON.stringify(adSnap));
  console.log(failures === 0 ? '\n✅ fold 徽标点击/拖拽断言全部通过' : '\n❌ ' + failures + ' 项失败');
  exitCode = failures === 0 ? 0 : 1;
  } finally {
    await cleanup();
  }
  process.exit(exitCode);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
