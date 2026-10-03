'use strict';
// 节点拖拽 + 网格吸附动画/历史专项 GUI 回归。
// 覆盖动画最终提交、renderCanvas 中断冻结、无操作不入栈、多节点整组单历史，
// 以及 undo/redo 与 localStorage 的一致性。等待动画集合/时钟归零，不依赖固定 sleep。
// 用法: node test/node-drag-snap-test.js [--headed]
const { launchBrowser, openApp, dblClick, assertions } = require('./helpers/launch.js');

const tally = assertions();
const ok = tally.ok;
const detail = value => {
  try { return JSON.stringify(value); } catch (_) { return String(value); }
};
const near = (a, b, epsilon = 0.001) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= epsilon;

async function nextFrames(page, count = 2) {
  await page.evaluate(async n => {
    for (let i = 0; i < n; i++) await new Promise(resolve => requestAnimationFrame(resolve));
  }, count);
}

async function waitForAnimEnd(page) {
  await page.waitForFunction(
    () => App._activeSnapAnims.size === 0 && App._snapDataInterval === null && App._snapRenderRaf === null,
    { timeout: 5000 }
  );
  await nextFrames(page);
}

async function waitForPersistedNode(page, id) {
  try {
    await page.waitForFunction(nodeId => {
      const raw = localStorage.getItem('flow_data');
      if (!raw) return false;
      const data = JSON.parse(raw);
      const stored = data.nodes && data.nodes.find(n => n.id === nodeId);
      const live = App._getNodeById(nodeId);
      return !!stored && !!live && Math.abs(stored.x * 20 - live.x) < 0.001 && Math.abs(stored.y * 20 - live.y) < 0.001;
    }, { timeout: 3000 }, id);
    return true;
  } catch (_) {
    return false;
  }
}

async function resetFixture(page, { nodes, snap, selected = [] }) {
  await page.evaluate(({ nodes, snap, selected }) => {
    App._nodeElMap.forEach(el => App._cancelSnapAnim(el));
    App.canvasState.nodes = nodes;
    App.canvasState.connections = [];
    App.canvasState.regions = [];
    App.canvasState.history = [];
    App.canvasHistoryIndex = -1;
    App.panX = 0;
    App.panY = 0;
    App.scale = 1;
    App._snapNodes = snap;
    App._snapSize = false;
    App.selectedNodeIds = new Set(selected);
    App.selectedConnIds = new Set();
    App.selectedRegionId = null;
    App._nodeZOrder = nodes.map(n => n.id);
    App._connOffsCache = null;
    App._nodeByIdCache = null;
    App._collapseDerived = null;
    App.saveCanvasSnapshot();
    App.renderCanvas({ center: false });
    App.applyViewTransform();
  }, { nodes, snap, selected });
  await page.waitForFunction(ids => ids.every(id => {
    const el = App._nodeElMap.get(id);
    return !!el && /translate\(/.test(el.style.transform || '');
  }), { timeout: 5000 }, nodes.map(n => n.id));
}

const mkNode = (id, x, y) => ({
  id, label: id, desc: '', color: 'blue', x, y, mirrored: false, w: 170, h: 80
});

async function nodePoint(page, id) {
  return page.evaluate(nodeId => {
    const el = App._nodeElMap.get(nodeId);
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, id);
}

async function dragNode(page, id, dx, dy, steps = 10) {
  const point = await nodePoint(page, id);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + dx, point.y + dy, { steps });
  await page.mouse.up();
}

async function state(page, id) {
  return page.evaluate(nodeId => {
    const node = App._getNodeById(nodeId);
    const el = App._nodeElMap.get(nodeId);
    const match = el && (el.style.transform || '').match(/translate\(([^,]+)px,\s*([^)]+)px\)/);
    const top = App.canvasState.history[App.canvasHistoryIndex];
    const topNode = top && top.nodes.find(n => n.id === nodeId);
    let storedNode = null;
    try {
      const raw = localStorage.getItem('flow_data');
      const parsed = raw && JSON.parse(raw);
      storedNode = parsed && parsed.nodes && parsed.nodes.find(n => n.id === nodeId);
    } catch (_) {}
    return {
      node: node ? { x: node.x, y: node.y } : null,
      top: topNode ? { x: topNode.x, y: topNode.y } : null,
      dom: match ? { x: parseFloat(match[1]), y: parseFloat(match[2]) } : null,
      stored: storedNode ? { x: storedNode.x * 20, y: storedNode.y * 20 } : null,
      historyLength: App.canvasState.history.length,
      historyIndex: App.canvasHistoryIndex,
      anims: App._activeSnapAnims.size,
      dataInterval: App._snapDataInterval,
      renderRaf: App._snapRenderRaf,
      dragState: !!App.dragState,
      isDragging: App.isDragging
    };
  }, id);
}

async function runSnapOffHistoryTest(page) {
  await resetFixture(page, { nodes: [mkNode('off', 0, 0)], snap: false });
  await dragNode(page, 'off', 53, 41);
  await nextFrames(page);
  const moved = await state(page, 'off');
  ok(moved.node && near(moved.node.x, 53) && near(moved.node.y, 41),
    '吸附关精确整数拖动落在目标像素: ' + detail(moved.node));
  ok(moved.historyLength === 2 && moved.historyIndex === 1,
    '吸附关整数拖动新增且只新增一项历史: ' + detail({ length: moved.historyLength, index: moved.historyIndex }));
  ok(moved.top && near(moved.top.x, 53) && near(moved.top.y, 41),
    '吸附关历史栈顶等于最终位置: ' + detail(moved.top));
  ok(moved.stored && near(moved.stored.x, moved.node.x) && near(moved.stored.y, moved.node.y),
    '吸附关 localStorage 与当前状态一致: ' + detail({ stored: moved.stored, node: moved.node }));

  await page.evaluate(() => App.canvasUndo());
  await nextFrames(page);
  const undone = await state(page, 'off');
  ok(undone.node && near(undone.node.x, 0) && near(undone.node.y, 0),
    '吸附关 Undo 恢复拖动前位置: ' + detail(undone.node));
  await page.evaluate(() => App.canvasRedo());
  await nextFrames(page);
  const redone = await state(page, 'off');
  ok(redone.node && near(redone.node.x, 53) && near(redone.node.y, 41),
    '吸附关 Redo 恢复最终位置: ' + detail(redone.node));
  ok(redone.historyLength === 2 && redone.historyIndex === 1,
    '吸附关 Undo/Redo 不额外制造历史: ' + detail({ length: redone.historyLength, index: redone.historyIndex }));

  const beforeMouseMove = redone.node;
  await page.mouse.move(1100, 650, { steps: 5 });
  await nextFrames(page);
  const afterMouseMove = (await state(page, 'off')).node;
  ok(near(afterMouseMove.x, beforeMouseMove.x) && near(afterMouseMove.y, beforeMouseMove.y),
    '吸附关松手后 mousemove 不再跟随节点');
}

async function runSnapOnCompletionTest(page) {
  await resetFixture(page, { nodes: [mkNode('on', 0, 0)], snap: true });
  await dragNode(page, 'on', 37, 23);
  await waitForAnimEnd(page);
  const done = await state(page, 'on');
  ok(done.node && near(done.node.x, 40) && near(done.node.y, 20),
    '吸附开动画完成后节点为最终网格坐标: ' + detail(done.node));
  ok(done.top && near(done.top.x, 40) && near(done.top.y, 20),
    '吸附开历史栈顶已提交最终网格坐标: ' + detail(done.top));
  ok(done.stored && near(done.stored.x, 40) && near(done.stored.y, 20),
    '吸附开 localStorage 已提交最终网格坐标: ' + detail(done.stored));
  ok(done.dom && done.node && near(done.dom.x, done.node.x) && near(done.dom.y, done.node.y),
    '吸附开最终 DOM 与数据一致: ' + detail({ dom: done.dom, node: done.node }));
  ok(done.anims === 0 && done.dataInterval === null && done.renderRaf === null &&
    !done.dragState && !done.isDragging, '吸附动画引擎与拖拽状态全部自停');

  await page.evaluate(() => App.canvasUndo());
  await nextFrames(page);
  const undone = await state(page, 'on');
  ok(undone.node && near(undone.node.x, 0) && near(undone.node.y, 0),
    '吸附开 Undo 恢复拖动前网格: ' + detail(undone.node));
  ok(await waitForPersistedNode(page, 'on'), '吸附开 Undo 后 localStorage 跟随当前状态');
  await page.evaluate(() => App.canvasRedo());
  await nextFrames(page);
  const redone = await state(page, 'on');
  ok(redone.node && near(redone.node.x, 40) && near(redone.node.y, 20),
    '吸附开 Redo 恢复最终网格: ' + detail(redone.node));
  ok(await waitForPersistedNode(page, 'on'), '吸附开 Redo 后 localStorage 跟随当前状态');

  const before = redone.node;
  await page.mouse.move(1100, 650, { steps: 5 });
  await nextFrames(page);
  const after = (await state(page, 'on')).node;
  ok(near(after.x, before.x) && near(after.y, before.y), '吸附动画结束后 mousemove 不再跟随节点');
}

async function runSameCellNoopTest(page) {
  await resetFixture(page, { nodes: [mkNode('same', 0, 0)], snap: true });
  await dragNode(page, 'same', 7, 3);
  await waitForAnimEnd(page);
  const result = await state(page, 'same');
  ok(result.node && near(result.node.x, 0) && near(result.node.y, 0),
    '同格移动最终回到原格: ' + detail(result.node));
  ok(result.historyLength === 1 && result.historyIndex === 0,
    '同格移动不产生虚假历史: ' + detail({ length: result.historyLength, index: result.historyIndex }));
  ok(result.stored && near(result.stored.x, 0) && near(result.stored.y, 0),
    '同格移动持久化仍为原格: ' + detail(result.stored));
}

async function runGroupAnimationHistoryTest(page) {
  await resetFixture(page, {
    nodes: [mkNode('group_a', 0, 0), mkNode('group_b', 3, 300)],
    snap: true,
    selected: ['group_a', 'group_b']
  });
  await dragNode(page, 'group_a', 40, 0);
  const activeAfterUp = await page.evaluate(() => App._activeSnapAnims.size);
  ok(activeAfterUp === 1, '多节点拖动仅一个节点需要动画: active=' + activeAfterUp);
  await waitForAnimEnd(page);
  const done = await page.evaluate(() => ({
    a: { ...App._getNodeById('group_a') },
    b: { ...App._getNodeById('group_b') },
    topA: App.canvasState.history[App.canvasHistoryIndex].nodes.find(n => n.id === 'group_a'),
    topB: App.canvasState.history[App.canvasHistoryIndex].nodes.find(n => n.id === 'group_b'),
    historyLength: App.canvasState.history.length,
    historyIndex: App.canvasHistoryIndex
  }));
  ok(done.historyLength === 2 && done.historyIndex === 1,
    '多节点整组拖动只增加一次历史: ' + detail({ length: done.historyLength, index: done.historyIndex }));
  ok(near(done.a.x, 40) && near(done.b.x, 40),
    '多节点动画完成后整组落在最终网格: ' + detail({ a: done.a.x, b: done.b.x }));
  ok(near(done.topA.x, 40) && near(done.topB.x, 40),
    '多节点唯一历史快照包含整组最终位置: ' + detail({ a: done.topA.x, b: done.topB.x }));

  await page.evaluate(() => App.canvasUndo());
  await nextFrames(page);
  const undone = await state(page, 'group_b');
  ok(near(undone.node.x, 3) && near(undone.node.y, 300),
    '多节点整组 Undo 恢复两节点原位: ' + detail(undone.node));
  ok(await waitForPersistedNode(page, 'group_b'), '多节点 Undo 后 localStorage 跟随当前状态');
  await page.evaluate(() => App.canvasRedo());
  await nextFrames(page);
  const redone = await page.evaluate(() => ({
    a: App._getNodeById('group_a').x,
    b: App._getNodeById('group_b').x,
    historyLength: App.canvasState.history.length,
    historyIndex: App.canvasHistoryIndex
  }));
  ok(near(redone.a, 40) && near(redone.b, 40) && redone.historyLength === 2 && redone.historyIndex === 1,
    '多节点整组 Redo 恢复最终位置且不增历史: ' + detail(redone));
  ok(await waitForPersistedNode(page, 'group_b'), '多节点 Redo 后 localStorage 跟随当前状态');
}

async function runRenderCancellationTest(page) {
  await resetFixture(page, { nodes: [mkNode('cancel', 0, 0)], snap: true });
  await dragNode(page, 'cancel', 37, 23);
  await page.waitForFunction(() => {
    if (App._activeSnapAnims.size === 0) return false;
    const n = App._getNodeById('cancel');
    const el = App._nodeElMap.get('cancel');
    const m = el && (el.style.transform || '').match(/translate\(([^,]+)px,\s*([^)]+)px\)/);
    const dx = m ? parseFloat(m[1]) : 0;
    const dy = m ? parseFloat(m[2]) : 0;
    return Math.abs(n.x) > 0.01 && Math.abs(n.y) > 0.01 && (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01);
  }, { timeout: 3000 });
  const frozen = await page.evaluate(() => {
    const el = App._nodeElMap.get('cancel');
    const parse = () => {
      const m = (el.style.transform || '').match(/translate\(([^,]+)px,\s*([^)]+)px\)/);
      return m ? { x: parseFloat(m[1]), y: parseFloat(m[2]) } : null;
    };
    const lastVisible = parse();
    const dataBeforeRender = { x: App._getNodeById('cancel').x, y: App._getNodeById('cancel').y };
    App.renderCanvas({ center: false });
    const domAfterRender = parse();
    const nodeAfterRender = { x: App._getNodeById('cancel').x, y: App._getNodeById('cancel').y };
    const top = App.canvasState.history[App.canvasHistoryIndex].nodes.find(n => n.id === 'cancel');
    return { lastVisible, dataBeforeRender, domAfterRender, nodeAfterRender, top: { x: top.x, y: top.y } };
  });
  ok(near(frozen.domAfterRender.x, frozen.lastVisible.x) && near(frozen.domAfterRender.y, frozen.lastVisible.y),
    'renderCanvas 取消动画时 DOM 冻结在最后可见位置: ' + detail({ visible: frozen.lastVisible, dom: frozen.domAfterRender }));
  ok(near(frozen.nodeAfterRender.x, frozen.domAfterRender.x) && near(frozen.nodeAfterRender.y, frozen.domAfterRender.y),
    'renderCanvas 取消动画后数据与 DOM 一致: ' + detail({ data: frozen.nodeAfterRender, dom: frozen.domAfterRender }));
  ok(near(frozen.top.x, frozen.lastVisible.x) && near(frozen.top.y, frozen.lastVisible.y),
    'renderCanvas 取消动画时历史栈顶为冻结位置: ' + detail({ top: frozen.top, visible: frozen.lastVisible }));
  await waitForAnimEnd(page);

  await page.evaluate(() => App.canvasUndo());
  await nextFrames(page);
  const undone = await state(page, 'cancel');
  ok(near(undone.node.x, 0) && near(undone.node.y, 0),
    '取消后的冻结位置可 Undo: ' + detail(undone.node));
  ok(await waitForPersistedNode(page, 'cancel'), '取消动画 Undo 后 localStorage 跟随当前状态');
  await page.evaluate(() => App.canvasRedo());
  await nextFrames(page);
  const redone = await state(page, 'cancel');
  ok(near(redone.node.x, frozen.lastVisible.x) && near(redone.node.y, frozen.lastVisible.y),
    '取消后的冻结位置可 Redo: ' + detail({ node: redone.node, frozen: frozen.lastVisible }));
  ok(near(redone.dom.x, redone.node.x) && near(redone.dom.y, redone.node.y),
    '取消动画 Undo/Redo 后 DOM 仍与数据一致: ' + detail({ dom: redone.dom, data: redone.node }));
  ok(await waitForPersistedNode(page, 'cancel'), '取消动画 Redo 后 localStorage 跟随当前状态');
}

async function runDoubleClickSmoke(page, cdp) {
  await resetFixture(page, { nodes: [mkNode('dbl_base', 0, 0)], snap: false });
  const point = await page.evaluate(() => {
    const stage = document.getElementById('canvasStage').getBoundingClientRect();
    return { x: stage.left + stage.width - 140, y: stage.top + 90 };
  });
  await dblClick(page, cdp, point.x, point.y, 0);
  await page.waitForFunction(() => App.canvasState.nodes.length === 2, { timeout: 3000 });
  ok(true, '节点拖拽改动后双击建节点主路径仍正常');
}

(async () => {
  const launched = await launchBrowser(process.argv.includes('--headed'));
  try {
    const { page, cdp } = await openApp(launched.browser, { clearStorage: true });
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(err && err.message ? err.message : String(err)));

    await runSnapOffHistoryTest(page);
    await runSnapOnCompletionTest(page);
    await runSameCellNoopTest(page);
    await runGroupAnimationHistoryTest(page);
    await runRenderCancellationTest(page);
    await runDoubleClickSmoke(page, cdp);

    ok(pageErrors.length === 0, '测试期间无未捕获页面异常' + (pageErrors.length ? ': ' + detail(pageErrors) : ''));
  } finally {
    await launched.cleanup();
  }

  console.log(tally.fails === 0 ? '\n✅ 节点拖拽吸附测试全部通过' : '\n❌ 节点拖拽吸附测试 ' + tally.fails + ' 项失败（当前实现上的回归证据）');
  process.exitCode = tally.fails === 0 ? 0 : 1;
})().catch(err => {
  console.error('测试异常:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
