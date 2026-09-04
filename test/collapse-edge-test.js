'use strict';
// 收起功能边缘场景：撤销/重做、删除收起根、JSON 序列化往返。
// 已迁移至统一台架 test/helpers/launch.js
const { launchBrowser, openApp, sleep, mkNode } = require('./helpers/launch.js');
const fail = msg => { throw new Error(msg); };

(async () => {
  const { browser, cleanup } = await launchBrowser(false);
  try {
  const { page } = await openApp(browser);

  // ── 布置：A → B → C ──
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

  // ── 1) 撤销/重做 ──
  await page.evaluate(() => { App.toggleCollapse('x_A'); }); await sleep(300);
  const s1 = await page.evaluate(() => ({ collapsed: !!App._getNodeById('x_A').collapse, cHidden: App._isCollapseHidden('x_C') }));
  console.log('step1 collapse:', JSON.stringify(s1));
  if (!s1.collapsed || !s1.cHidden) fail('撤销测试: 收起未生效');
  await page.evaluate(() => { App.canvasUndo(); }); await sleep(300);
  const s2 = await page.evaluate(() => ({ collapsed: !!App._getNodeById('x_A').collapse, cHidden: App._isCollapseHidden('x_C') }));
  console.log('step2 undo:', JSON.stringify(s2));
  if (s2.collapsed || s2.cHidden) fail('撤销测试: 撤销后应展开');
  await page.evaluate(() => { App.canvasRedo(); }); await sleep(300);
  const s3 = await page.evaluate(() => ({ collapsed: !!App._getNodeById('x_A').collapse, cHidden: App._isCollapseHidden('x_C') }));
  console.log('step3 redo:', JSON.stringify(s3));
  if (!s3.collapsed || !s3.cHidden) fail('撤销测试: 重做后应收起');

  // ── 2) 删除收起根 A → B、C 释放 ──
  await page.evaluate(() => { App.removeNode('x_A'); }); await sleep(300);
  const s4 = await page.evaluate(() => ({
    aGone: !App._getNodeById('x_A'),
    bHidden: App._isCollapseHidden('x_B'), cHidden: App._isCollapseHidden('x_C'),
    conns: App.canvasState.connections.length
  }));
  console.log('step4 delete root:', JSON.stringify(s4));
  if (!s4.aGone) fail('删除根: A 未删除');
  if (s4.bHidden || s4.cHidden) fail('删除根: B/C 应释放可见');
  if (s4.conns !== 1) fail('删除根: 应剩 1 条连线 (B-C), got ' + s4.conns);

  // ── 3) 序列化往返 ──
  await page.evaluate(() => {
    // 重建 A → B → C
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
  await page.evaluate(() => { App.toggleCollapse('x_A'); }); await sleep(300);
  // serialize → restore
  const round = await page.evaluate(() => {
    const data = App._serializeData();
    App._loadFromData(JSON.parse(JSON.stringify(data)));
    return {
      collapsed: !!App._getNodeById('x_A').collapse,
      bHidden: App._isCollapseHidden('x_B'),
      cHidden: App._isCollapseHidden('x_C'),
      hiddenLen: App._getNodeById('x_A').collapse ? App._getNodeById('x_A').collapse.hidden.length : 0
    };
  });
  console.log('step5 serialize roundtrip:', JSON.stringify(round));
  if (!round.collapsed || !round.bHidden || !round.cHidden || round.hiddenLen !== 2) fail('序列化: 往返后收起状态丢失');
  // 展开并对位
  const round2 = await page.evaluate(() => {
    App.toggleCollapse('x_A');
    const A = App._getNodeById('x_A'), B = App._getNodeById('x_B'), C = App._getNodeById('x_C');
    return { bd: [B.x - A.x, B.y - A.y], cd: [C.x - A.x, C.y - A.y] };
  });
  console.log('step6 expand after roundtrip:', JSON.stringify(round2));
  if (Math.abs(round2.bd[0] - 320) > 0.01 || Math.abs(round2.cd[0] - 640) > 0.01) fail('序列化: 展开相对位置错误');

  // ── 4) 坏存档清洗：collapse 引用不存在 id → 导入安全 ──
  const bad = await page.evaluate(() => {
    const A = App._getNodeById('x_A');
    A.collapse = { hidden: [{ id: 'nope_missing', dx: 123, dy: 45 }, { id: 'x_B', dx: 320, dy: 0 }] };
    const data = App._serializeData();
    App._loadFromData(JSON.parse(JSON.stringify(data)));
    const A2 = App._getNodeById('x_A');
    return { has: !!A2.collapse, len: A2.collapse ? A2.collapse.hidden.length : 0, ids: A2.collapse ? A2.collapse.hidden.map(h => h.id) : [] };
  });
  console.log('step7 bad archive cleanup:', JSON.stringify(bad));
  if (!bad.has || bad.len !== 1 || bad.ids[0] !== 'x_B') fail('坏存档: 应剔除缺失 id 引用');

  console.log('ALL EDGE PASSED');
  } finally {
    await cleanup();
  }
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
