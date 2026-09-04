'use strict';
// 撤销/重做栈上限测试(纯状态层):
//  - 超过 _canvasHistoryMax(50) 后最旧快照被 shift(上限生效)
//  - 满栈后可继续撤销 50 步且状态正确
//  - 混合操作链(建节点/改标题/移动/删除)可逐级撤销到初始
// 已迁移至统一台架 test/helpers/launch.js
const { launchBrowser, openApp, sleep } = require('./helpers/launch.js');
let failures = 0;
const ok = (cond, msg) => { console.log((cond ? '✅ ' : '❌ ') + msg); if (!cond) failures++; };

(async () => {
  const { browser, cleanup } = await launchBrowser(false);
  try {
    const { page } = await openApp(browser);

    // ── 1) 清空 + 干净基线 ──
    await page.evaluate(() => {
      App.canvasState.nodes = [];
      App.canvasState.connections = [];
      App.canvasState.regions = [];
      App.canvasState.history = [];
      App.canvasHistoryIndex = -1;
      App.saveCanvasSnapshot();  // 初始空态入栈
    });
    await sleep(200);
    const cap = await page.evaluate(() => App._canvasHistoryMax);
    ok(cap === 50, '历史上限常量为 50 (got ' + cap + ')');

    // ── 2) 连做 60 次快照 → 栈应封顶 50 ──
    await page.evaluate(() => {
      for (let i = 0; i < 60; i++) {
        const n = App.canvasState.nodes.length;
        App.canvasState.nodes.push({ id: 'n' + i, label: 'N' + i, desc: '', color: 'blue', x: i * 10, y: i * 10, mirrored: false, w: 170, h: 80 });
        App._nodeZOrder = App.canvasState.nodes.map(x => x.id);
        App.saveCanvasSnapshot();
      }
    });
    await sleep(300);
    const stack = await page.evaluate(() => ({ len: App.canvasState.history.length, idx: App.canvasHistoryIndex }));
    console.log('60 次快照后:', JSON.stringify(stack));
    ok(stack.len <= 50, '快照栈封顶 50 (实际 ' + stack.len + ')');
    ok(stack.idx === stack.len - 1, '栈指针在末尾 (idx=' + stack.idx + ')');

    // ── 3) 撤销 50 次 → 应回到第 10 个节点(60-50)的基线,不越界 ──
    const undone = await page.evaluate(() => {
      let steps = 0;
      while (App.canvasHistoryIndex > 0) { App.canvasUndo(); steps++; }
      return { steps, nodes: App.canvasState.nodes.length };
    });
    console.log('可撤销步数:', JSON.stringify(undone));
    ok(undone.steps === 49, '恰好可撤销 49 步(栈含初始基线,60操作shift后剩11..60, idx 49→0) 实际 ' + undone.steps);
    ok(undone.nodes === 11, '撤销到底回到最早保留的操作 11 基线 (nodes=' + undone.nodes + ', 期望 11)');

    // ── 4) 重做 50 次 → 恢复全部 60 节点 ──
    const redone = await page.evaluate(() => {
      let steps = 0;
      while (App.canvasHistoryIndex < App.canvasState.history.length - 1) { App.canvasRedo(); steps++; }
      return { steps, nodes: App.canvasState.nodes.length };
    });
    console.log('可重做步数:', JSON.stringify(redone));
    ok(redone.steps === 49 && redone.nodes === 60, '重做 49 步恢复 60 节点 (steps=' + redone.steps + ', nodes=' + redone.nodes + ')');

    // ── 5) 混合操作链: 改标题 → 移动 → 删除, 逐级撤销 ──
    const mix = await page.evaluate(() => {
      // 重置为单节点基线
      App.canvasState.nodes = [{ id: 'm0', label: '初始', desc: '', color: 'blue', x: 0, y: 0, mirrored: false, w: 170, h: 80 }];
      App.canvasState.connections = [];
      App.canvasState.history = [];
      App.canvasHistoryIndex = -1;
      App.saveCanvasSnapshot();
      // 操作1: 改标题
      const n = App.canvasState.nodes[0];
      n.label = '改后';
      App.saveCanvasSnapshot();
      // 操作2: 移动
      n.x = 500; n.y = 300;
      App.saveCanvasSnapshot();
      // 操作3: 删除(经 removeNode 正规路径)
      App.removeNode('m0');
      return { nodes: App.canvasState.nodes.length };
    });
    await sleep(300);
    console.log('混合链末态:', JSON.stringify(mix));
    const back1 = await page.evaluate(() => { App.canvasUndo(); return { nodes: App.canvasState.nodes.length, label: App.canvasState.nodes[0] ? App.canvasState.nodes[0].label : null }; });
    ok(back1.nodes === 1 && back1.label === '改后', '撤销1(删除)→ 节点恢复且标题为改后 (label=' + back1.label + ')');
    const back2 = await page.evaluate(() => { App.canvasUndo(); return { x: App.canvasState.nodes[0].x, y: App.canvasState.nodes[0].y }; });
    ok(back2.x === 0 && back2.y === 0, '撤销2(移动)→ 位置回 0,0 (got ' + back2.x + ',' + back2.y + ')');
    const back3 = await page.evaluate(() => { App.canvasUndo(); return { label: App.canvasState.nodes[0].label }; });
    ok(back3.label === '初始', '撤销3(标题)→ 标题回初始 (label=' + back3.label + ')');
    const back4 = await page.evaluate(() => {
      const before = App.canvasHistoryIndex;
      App.canvasUndo();
      return { moved: App.canvasHistoryIndex === before, idx: App.canvasHistoryIndex };
    });
    ok(back4.moved === true, '撤销到底后不再移动 (idx=' + back4.idx + ')');
  } finally {
    await cleanup();
  }
  console.log(failures === 0 ? '\n✅ 撤销上限测试全部通过' : '\n❌ ' + failures + ' 项失败');
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });