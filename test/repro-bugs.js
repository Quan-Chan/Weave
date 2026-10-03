'use strict';
// 实证复现脚本：验证三个疑似 bug 是否在当前代码中真实存在
// 1) P0-1: 嵌套收起 → 移动根 → 展开外层根，内层偏移读脏数据（错位）
// 2) P0-2: 导入数据 collapse.hidden 含 null → _restoreFromSerialized 崩溃
// 3) blur 误建线: socket 拖拽中 window blur → onUp(FocusEvent) 误建线
const { launchBrowser, openApp, sleep } = require('./helpers/launch');

(async () => {
  // 台架自带 launch 失败后的 spawn+connect 降级路径，无需在此重复实现。
  const { browser, cleanup } = await launchBrowser(false);
  const { page } = await openApp(browser);
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  // ══ 测试 1: P0-1 嵌套展开偏移脏读 ══
  const t1 = await page.evaluate(() => {
    const mk = (id, x, y) => ({ id, label: id, desc: '', color: 'blue', x, y, mirrored: false, w: 170, h: 80 });
    App.canvasState.nodes = [mk('R', 0, 0), mk('A', 320, 0), mk('B', 640, 0)];
    App.canvasState.connections = [
      { id: 'c1', from: 'R', to: 'A', label: '', mirrored: false },
      { id: 'c2', from: 'A', to: 'B', label: '', mirrored: false }
    ];
    App._nodeZOrder = App.canvasState.nodes.map(n => n.id);
    App.saveCanvasSnapshot();
    App.renderCanvas();
    // A 先收起 B（A 成为内层收起根）
    App.toggleCollapse('A');
    // R 再收起 A（闭包 = [A, B]，BFS 顺序 A 先于 B）
    App.toggleCollapse('R');
    const before = { rCollapse: App._getNodeById('R').collapse, aCollapse: App._getNodeById('A').collapse };
    // R 移动 540px
    const R = App._getNodeById('R');
    R.x += 540; R.y += 100;
    App.saveCanvasSnapshot();
    App.renderCanvas();
    // 展开 R
    App.toggleCollapse('R');
    const A2 = App._getNodeById('A'), B2 = App._getNodeById('B'), R2 = App._getNodeById('R');
    const aOff = [A2.x - R2.x, A2.y - R2.y];       // 期望 [320, 0]
    const bOff = [B2.x - R2.x, B2.y - R2.y];       // 期望 [640, 0]
    const aCollapseAfter = App._getNodeById('A').collapse;  // A 仍收起 B，偏移应 = B-A = [320, 0]
    return {
      before, aOff, bOff,
      aCollapseAfter,
      aHidden: App._isCollapseHidden('B')
    };
  });
  console.log('T1 nested expand:', JSON.stringify(t1));
  const t1ok = t1.aCollapseAfter &&
    Math.abs(t1.aCollapseAfter.hidden[0].dx - 320) < 0.5 &&
    Math.abs(t1.aCollapseAfter.hidden[0].dy - 0) < 0.5;
  console.log('T1 => ' + (t1ok ? 'PASS' : 'FAIL (P0-1 复现: 内层偏移错误)'));
  // 进一步验证: 展开 A 后 B 应落到 A+320
  const t1b = await page.evaluate(() => {
    App.toggleCollapse('A');
    const A = App._getNodeById('A'), B = App._getNodeById('B');
    return { bOff: [B.x - A.x, B.y - A.y] };
  });
  console.log('T1b expand A:', JSON.stringify(t1b), t1b.bOff[0] === 320 && t1b.bOff[1] === 0 ? 'PASS' : 'FAIL (展开A后B错位)');

  // ══ 测试 2: P0-2 导入崩溃 ══
  const t2 = await page.evaluate(() => {
    try {
      App._loadFromData({ nodes: [{ id: 'a', x: 0, y: 0, label: 'a', collapse: { hidden: [null] } }], connections: [] });
      return { crashed: false };
    } catch (e) {
      return { crashed: true, msg: e.message };
    }
  });
  console.log('T2 import null-hidden:', JSON.stringify(t2));
  console.log('T2 => ' + (t2.crashed ? 'FAIL (P0-2 复现: 导入崩溃)' : 'PASS (导入安全)'));

  // ══ 测试 3: blur 误建线 ══
  const t3 = await page.evaluate(() => {
    // 重置画布: A → B 两个节点
    const mk = (id, x, y) => ({ id, label: id, desc: '', color: 'blue', x, y, mirrored: false, w: 170, h: 80 });
    App.canvasState.nodes = [mk('A', 0, 0), mk('B', 320, 0)];
    App.canvasState.connections = [];
    App._nodeZOrder = App.canvasState.nodes.map(n => n.id);
    App.saveCanvasSnapshot();
    App.renderCanvas();
    return { conns: App.canvasState.connections.length };
  });
  const cdp = await page.createCDPSession();
  const pts = await page.evaluate(() => {
    const aOut = document.querySelector('.node[data-node-id="A"] .socket.out');
    const bIn = document.querySelector('.node[data-node-id="B"] .socket.in');
    const ar = aOut.getBoundingClientRect(), br = bIn.getBoundingClientRect();
    return { ax: ar.left + ar.width / 2, ay: ar.top + ar.height / 2, bx: br.left + br.width / 2, by: br.top + br.height / 2 };
  });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pts.ax, y: pts.ay });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pts.ax, y: pts.ay, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(50);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pts.bx, y: pts.by, button: 'left', buttons: 1 });
  await sleep(50);
  const beforeBlur = await page.evaluate(() => App.canvasState.connections.length);
  await page.evaluate(() => { window.dispatchEvent(new FocusEvent('blur')); });
  await sleep(200);
  const afterBlur = await page.evaluate(() => App.canvasState.connections.length);
  console.log('T3 blur:', JSON.stringify({ beforeBlur, afterBlur }));
  console.log('T3 => ' + (afterBlur > beforeBlur ? 'FAIL (blur 误建线复现)' : 'PASS (blur 未建线)'));

  console.log('--- page errors ---');
  errors.forEach(e => console.log(e));
  // 汇总: 期望全部 PASS(3 个疑似 bug 均不应在当前代码中复现)
  const t3ok = afterBlur <= beforeBlur;
  const t1bok = t1b.bOff[0] === 320 && t1b.bOff[1] === 0;
  const fails = [];
  if (!t1ok) fails.push('T1 嵌套偏移脏读复现');
  if (!t1bok) fails.push('T1b 展开A后B错位');
  if (t2.crashed) fails.push('T2 导入 null 崩溃复现');
  if (!t3ok) fails.push('T3 blur 误建线复现');
  if (errors.length) fails.push('页面 JS 错误 ' + errors.length + ' 条');
  await cleanup();
  if (fails.length) { console.log('❌ 复现项: ' + fails.join('; ')); process.exit(1); }
  console.log('✅ 三疑点均未复现(PASS)');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
