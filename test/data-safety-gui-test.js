'use strict';
// 数据安全专项 GUI 回归：导入原子性、只读入口、文本编辑快捷键与持久化失败。
// 这些断言刻意针对“失败后不得留下半替换状态”和“用户输入不得被原地改写”的契约。
// 失败会被汇总为断言，不通过 page.evaluate 抛出浏览器异常。
const { launchBrowser, openApp } = require('./helpers/launch.js');

let failures = 0;
const ok = (cond, msg) => {
  console.log((cond ? '✅ ' : '❌ ') + msg);
  if (!cond) failures++;
};
const detail = value => {
  try { return JSON.stringify(value); } catch (_) { return String(value); }
};

async function installImportFixture(page) {
  await page.evaluate(() => {
    window.__dsSentinel = window.__dsSentinel || {};
    window.__dsInstallFixture = function () {
      App._nodeElMap.forEach(el => App._cancelSnapAnim(el));
      App.readOnly = false;
      App.canvasState.nodes = [{
        id: 'keep_n', label: '保留节点', desc: '保留描述', color: 'green',
        x: 20, y: 40, mirrored: false, w: 170, h: 80
      }];
      App.canvasState.connections = [{
        id: 'keep_c', from: 'keep_n', to: 'keep_n', label: '保留连线', mirrored: false
      }];
      App.canvasState.regions = [{
        id: 'keep_r', label: '保留分区', color: 'orange', x: 0, y: 0,
        w: 400, h: 300, nodeIds: ['keep_n'], parentId: null
      }];
      const first = structuredClone(App.canvasState.nodes);
      first[0].x = 0;
      first[0].y = 0;
      App.canvasState.history = [
        { nodes: first, connections: [], regions: [] },
        {
          nodes: structuredClone(App.canvasState.nodes),
          connections: structuredClone(App.canvasState.connections),
          regions: structuredClone(App.canvasState.regions)
        }
      ];
      App.canvasHistoryIndex = 1;
      App.panX = 31;
      App.panY = 47;
      App.scale = 1.25;
      App.selectedNodeIds = new Set(['keep_n']);
      App.selectedConnIds = new Set(['keep_c']);
      App.selectedRegionId = 'keep_r';
      App._regionResizeId = null;
      App._frameMoveRegionId = null;
      App._regionModeActive = false;
      App._nodeZOrder = ['keep_n'];
      App._connOffsCache = null;
      App._nodeByIdCache = null;
      App._collapseDerived = null;
      App.renderCanvas({ center: false });
      App.applyViewTransform();
      window.__dsSentinel.conn = window.__dsSentinel.conn || new Map();
      window.__dsSentinel.node = window.__dsSentinel.node || new Map();
      window.__dsSentinel.collapse = window.__dsSentinel.collapse || { hiddenIds: new Set(), avail: new Map() };
      App._connOffsCache = window.__dsSentinel.conn;
      App._nodeByIdCache = window.__dsSentinel.node;
      App._collapseDerived = window.__dsSentinel.collapse;
      localStorage.setItem('flow_data', JSON.stringify({ sentinel: 'must-stay' }));
      document.getElementById('toastContainer').textContent = '';
      const baseline = {
        nodes: App.canvasState.nodes,
        connections: App.canvasState.connections,
        regions: App.canvasState.regions,
        history: App.canvasState.history,
        selectedNodeIds: App.selectedNodeIds,
        selectedConnIds: App.selectedConnIds
      };
      return function snapshot() {
        const json = value => JSON.stringify(value);
        return {
          state: {
            nodes: json(App.canvasState.nodes),
            connections: json(App.canvasState.connections),
            regions: json(App.canvasState.regions),
            history: json(App.canvasState.history),
            historyIndex: App.canvasHistoryIndex,
            selectedNodes: [...App.selectedNodeIds].sort(),
            selectedConnections: [...App.selectedConnIds].sort(),
            selectedRegion: App.selectedRegionId,
            panX: App.panX,
            panY: App.panY,
            scale: App.scale,
            flowData: localStorage.getItem('flow_data')
          },
          refs: {
            nodes: App.canvasState.nodes === baseline.nodes,
            connections: App.canvasState.connections === baseline.connections,
            regions: App.canvasState.regions === baseline.regions,
            history: App.canvasState.history === baseline.history,
            selectedNodes: App.selectedNodeIds === baseline.selectedNodeIds,
            selectedConnections: App.selectedConnIds === baseline.selectedConnIds,
            connCache: App._connOffsCache === window.__dsSentinel.conn,
            nodeCache: App._nodeByIdCache === window.__dsSentinel.node,
            collapseCache: App._collapseDerived === window.__dsSentinel.collapse
          }
        };
      };
    };
  });
}

async function checkAtomicImport(page, name, payload) {
  const result = await page.evaluate(data => {
    const snapshot = window.__dsInstallFixture();
    const before = snapshot();
    const inputBefore = JSON.stringify(data);
    let returned;
    let threw = null;
    try { returned = App._loadFromData(data); }
    catch (err) { threw = err && err.message ? err.message : String(err); }
    const after = snapshot();
    return {
      returned,
      threw,
      inputUnchanged: JSON.stringify(data) === inputBefore,
      stateUnchanged: JSON.stringify(before.state) === JSON.stringify(after.state),
      refsUnchanged: Object.values(before.refs).every(Boolean) && Object.values(after.refs).every(Boolean),
      before,
      after
    };
  }, payload);
  ok(result.threw === null, name + '：入口应安全处理失败而非抛出异常' + (result.threw ? ' (' + result.threw + ')' : ''));
  ok(result.returned === false, name + '：明确返回 false');
  ok(result.stateUnchanged, name + '：三数组/历史/选区/视口/flow_data 保持不变');
  ok(result.refsUnchanged, name + '：三数组、历史、选区与三类缓存引用保持不变');
  ok(result.inputUnchanged, name + '：调用者输入未被坐标换算或校验过程改写');
  if (!result.stateUnchanged || !result.refsUnchanged) {
    console.log('   状态差异: ' + detail({ before: result.before, after: result.after }));
  }
}

async function runImportTests(page) {
  await installImportFixture(page);

  const validNodes = () => ([
    { id: 'bad_n', label: '坏导入', desc: '', color: 'blue', x: 2, y: 3, mirrored: false, w: 8.5, h: 4 }
  ]);

  await checkAtomicImport(page, 'connections 为非数组', {
    nodes: validNodes(), connections: {}, regions: []
  });
  await checkAtomicImport(page, 'regions 为非数组', {
    nodes: validNodes(), connections: [], regions: 'bad'
  });
  await checkAtomicImport(page, 'nodes 为非数组', {
    nodes: {}, connections: [], regions: []
  });
  await checkAtomicImport(page, '顶层数据为 null', null);
  await checkAtomicImport(page, '顶层数据为数组', []);
  await checkAtomicImport(page, 'viewport 为非对象', {
    nodes: validNodes(), connections: [], regions: [], viewport: 7
  });

  // 明确导入策略：集合类型合法时，数组内 null/primitive 是可跳过条目，
  // 不得在“替换 canvasState 后”因访问 .from/.x 而崩溃。
  const sanitize = await page.evaluate(() => {
    const snapshot = window.__dsInstallFixture();
    const before = snapshot();
    const data = {
      nodes: [
        { id: 'ok_n1', label: 'N1', desc: '', color: 'blue', x: 0, y: 0, mirrored: false, w: 8.5, h: 4 },
        null, 7, 'primitive',
        { id: 'ok_n2', label: 'N2', desc: '', color: 'green', x: 12, y: 8, mirrored: false, w: 8.5, h: 4 }
      ],
      connections: [
        { id: 'ok_c', from: 'ok_n1', to: 'ok_n2', label: '', mirrored: false },
        null, 7, 'primitive'
      ],
      regions: [
        { id: 'ok_r', label: 'R', color: 'blue', x: 0, y: 0, w: 20, h: 15, nodeIds: ['ok_n1'] },
        null, 7, 'primitive'
      ],
      viewport: { panX: 19, panY: 23, scale: 0.75 }
    };
    const inputBefore = JSON.stringify(data);
    let returned;
    let threw = null;
    try { returned = App._loadFromData(data); }
    catch (err) { threw = err && err.message ? err.message : String(err); }
    return {
      threw,
      returned,
      inputUnchanged: JSON.stringify(data) === inputBefore,
      nodeIds: App.canvasState.nodes.map(n => n && n.id),
      connectionIds: App.canvasState.connections.map(c => c && c.id),
      regionIds: App.canvasState.regions.map(r => r && r.id),
      viewport: { panX: App.panX, panY: App.panY, scale: App.scale },
      historyLength: App.canvasState.history.length,
      historyIndex: App.canvasHistoryIndex,
      baselineStillPresent: App.canvasState.nodes.some(n => n && n.id === 'keep_n')
    };
  });
  ok(sanitize.threw === null, '混合对象数组跳过 null/primitive：不得抛异常' + (sanitize.threw ? ' (' + sanitize.threw + ')' : ''));
  ok(!sanitize.baselineStillPresent && JSON.stringify(sanitize.nodeIds) === JSON.stringify(['ok_n1', 'ok_n2']),
    '混合对象数组导入成功：仅保留合法 nodes');
  ok(JSON.stringify(sanitize.connectionIds) === JSON.stringify(['ok_c']) && JSON.stringify(sanitize.regionIds) === JSON.stringify(['ok_r']),
    '混合对象数组导入成功：仅保留合法 connections/regions');
  ok(sanitize.historyLength === 1 && sanitize.historyIndex === 0, '合法导入建立单一新历史基线');
  ok(sanitize.inputUnchanged, '成功导入也不得对调用者对象做 ×20 原地换算');

  // 精确覆盖 [null] / 全部 primitive：合法数组类型仍应跳过坏条目并成功导入，
  // 而不是把“数组类型合法”和“数组元素类型合法”混为一谈。
  const emptyEntries = await page.evaluate(() => {
    const run = data => {
      window.__dsInstallFixture();
      const before = JSON.stringify(data);
      let returned;
      let threw = null;
      try { returned = App._loadFromData(data); }
      catch (err) { threw = err && err.message ? err.message : String(err); }
      return {
        threw,
        returned,
        inputUnchanged: JSON.stringify(data) === before,
        nodes: App.canvasState.nodes.map(n => n && n.id),
        connections: App.canvasState.connections.map(c => c && c.id),
        regions: App.canvasState.regions.map(r => r && r.id),
        historyLength: App.canvasState.history.length
      };
    };
    return {
      nullCollections: run({
        nodes: [{ id: 'one', label: 'one', desc: '', color: 'blue', x: 1, y: 1, mirrored: false, w: 8.5, h: 4 }],
        connections: [null], regions: [null]
      }),
      primitiveNodes: run({ nodes: [null, 7, 'primitive', false], connections: [], regions: [] })
    };
  });
  for (const [name, result] of Object.entries(emptyEntries)) {
    ok(result.threw === null, name + '：null/primitive 集合条目应跳过而非抛异常' + (result.threw ? ' (' + result.threw + ')' : ''));
    ok(result.inputUnchanged, name + '：跳过坏条目不改写调用者对象');
    ok(result.connections.length === 0 && result.regions.length === 0 && result.historyLength === 1 &&
      (name === 'nullCollections' ? JSON.stringify(result.nodes) === JSON.stringify(['one']) : result.nodes.length === 0),
      name + '：成功导入并跳过 null/primitive');
  }

  // 对象字段按当前默认模型修复；collection 缺省为空；viewport 数值字段单独校验。
  const repair = await page.evaluate(() => {
    window.__dsInstallFixture();
    const data = {
      nodes: [
        { id: 'repair_n1', x: 'bad', y: null, w: NaN, h: -4, label: 9, desc: 42, color: 123, mirrored: 'yes', collapse: { hidden: 'bad' } },
        { id: 'repair_n2', x: 20, y: 40, w: 8.5, h: 4, label: 'N2', desc: '', color: 'green', mirrored: false }
      ],
      connections: [
        { id: 'repair_c', from: 'repair_n1', to: 'repair_n2', label: 88, cp1: null, mirrored: 'bad' }
      ],
      viewport: { panX: 19, panY: 'bad', scale: 0 }
    };
    const inputBefore = JSON.stringify(data);
    let threw = null;
    try { App._loadFromData(data); }
    catch (err) { threw = err && err.message ? err.message : String(err); }
    const n1 = App.canvasState.nodes.find(n => n && n.id === 'repair_n1');
    const c1 = App.canvasState.connections.find(c => c && c.id === 'repair_c');
    return {
      threw,
      inputUnchanged: JSON.stringify(data) === inputBefore,
      regionsIsArray: Array.isArray(App.canvasState.regions),
      regionCount: App.canvasState.regions.length,
      node: n1 && {
        id: n1.id, x: n1.x, y: n1.y, w: n1.w, h: n1.h,
        labelType: typeof n1.label, desc: n1.desc, color: n1.color,
        mirrored: n1.mirrored, hasCollapse: !!n1.collapse
      },
      connection: c1 && { label: c1.label, mirrored: c1.mirrored, hasCp1: Object.prototype.hasOwnProperty.call(c1, 'cp1') },
      viewport: { panX: App.panX, panY: App.panY, scale: App.scale }
    };
  });
  ok(repair.threw === null, '字段修复与混合 nodes 清洗：不得抛异常' + (repair.threw ? ' (' + repair.threw + ')' : ''));
  ok(repair.inputUnchanged, '字段修复不得污染调用者输入');
  ok(repair.regionsIsArray && repair.regionCount === 0, '缺省 regions 按空数组处理');
  ok(repair.node && repair.node.x === -300 && repair.node.y === -60 &&
    repair.node.w === 170 && repair.node.h === 60 && repair.node.labelType === 'string' && !repair.node.hasCollapse,
    '非法节点字段按当前默认/最小尺寸规则修复: ' + detail(repair.node));
  ok(repair.node && repair.node.desc === '' && repair.node.color === 'blue' && repair.node.mirrored === false,
    'desc/color/mirrored 非法值修复为当前默认模型: ' + detail(repair.node));
  ok(repair.connection && repair.connection.label === '' && repair.connection.mirrored === false && !repair.connection.hasCp1,
    '非法连线字段与控制点按默认模型修复: ' + detail(repair.connection));
  ok(repair.viewport.panX === 19 && repair.viewport.panY === 0 && repair.viewport.scale === 1,
    'viewport 局部非法字段修复且不使用 0 缩放: ' + detail(repair.viewport));
}

async function runSnapImportRace(page, pageErrors) {
  // 先清掉任何旧事务/时钟，保证本用例只观察下面这次真实鼠标拖拽。
  await page.evaluate(() => {
    if (App._nodeDragSnapBatch && typeof App._settleNodeDragSnapBatch === 'function') {
      App._settleNodeDragSnapBatch(false, true);
    }
    if (App._snapDataInterval !== null) clearInterval(App._snapDataInterval);
    if (App._snapRenderRaf !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(App._snapRenderRaf);
    App._snapDataInterval = null;
    App._snapRenderRaf = null;
    if (App._activeSnapAnims) {
      Array.from(App._activeSnapAnims).forEach(anim => {
        anim.cancelled = true;
        App._activeSnapAnims.delete(anim);
        if (anim.el) anim.el._snapAnim = null;
      });
    }
    window.__dsInstallFixture();
    App._snapNodes = true;
    App._snapSize = false;
    // 竞态用例随后要走真实 DOM 拖拽，不能保留导入原子性断言用的 sentinel Map。
    App._nodeByIdCache = null;
    App._connOffsCache = null;
    App._collapseDerived = null;
    App.panX = 0;
    App.panY = 0;
    App.scale = 1;
    App.applyViewTransform();
  });

  const point = await page.evaluate(() => {
    const el = App._nodeElMap.get('keep_n');
    const rect = el.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 37, point.y + 23, { steps: 10 });
  // 等待真实 mousemove 的 rAF 已写入非网格位置，再松手，避免 up 早于拖拽 rAF。
  await page.waitForFunction(() => {
    const n = App._getNodeById('keep_n');
    return !!App.dragState && !!n && (n.x !== 20 || n.y !== 40);
  }, { timeout: 3000 });
  await page.mouse.up();

  const replacement = {
    nodes: [{
      id: 'keep_n', label: '导入后的 keep_n', desc: '', color: 'blue',
      x: 10, y: 20, mirrored: false, w: 8.5, h: 4
    }],
    connections: [],
    regions: []
  };
  const errorStart = pageErrors.length;

  // 在页面内等待到旧 batch/动画已经建立但尚未完成，并在同一 JS task 中立即导入。
  // 这样不会因 Node -> CDP 往返而错过短暂的 150ms 动画窗口。
  const load = await page.evaluate(data => new Promise(resolve => {
    const started = performance.now();
    const read = () => {
      const node = App.canvasState.nodes.find(n => n && n.id === 'keep_n') || null;
      const el = App._nodeElMap.get('keep_n');
      const match = el && (el.style.transform || '').match(/translate\(([^,]+)px,\s*([^)]+)px\)/);
      const top = App.canvasState.history[App.canvasHistoryIndex];
      const topNodes = top && Array.isArray(top.nodes) ? top.nodes : [];
      const topNode = topNodes.find(n => n && n.id === 'keep_n') || null;
      let stored = null;
      try {
        const raw = localStorage.getItem('flow_data');
        const parsed = raw && JSON.parse(raw);
        const storedNode = parsed && parsed.nodes && parsed.nodes.find(n => n.id === 'keep_n');
        if (storedNode) {
          stored = {
            grid: { x: storedNode.x, y: storedNode.y },
            pixels: { x: storedNode.x * 20, y: storedNode.y * 20 }
          };
        }
      } catch (_) {}
      return {
        batchPresent: !!App._nodeDragSnapBatch,
        activeSize: App._activeSnapAnims.size,
        node,
        dom: match ? { x: parseFloat(match[1]), y: parseFloat(match[2]) } : null,
        historyLength: App.canvasState.history.length,
        historyIndex: App.canvasHistoryIndex,
        topNode,
        topNodeCount: topNodes.length,
        stored
      };
    };
    const check = () => {
      const active = App._activeSnapAnims;
      const anim = active.values().next().value;
      const elapsed = anim && anim.startTime !== null ? performance.now() - anim.startTime : 0;
      const total = anim && Number.isFinite(anim.totalMs) ? anim.totalMs : 150;
      const animationNotFinished = !!anim && !anim.cancelled &&
        (anim.startTime === null || elapsed < total - 5);
      if (active.size > 0 && App._nodeDragSnapBatch && animationNotFinished) {
        const pre = {
          ...read(),
          animationNotFinished,
          animationElapsed: elapsed,
          animationTotal: total
        };
        let returned;
        let threw = null;
        try { returned = App._loadFromData(data); }
        catch (err) { threw = err && err.message ? err.message : String(err); }
        resolve({ ready: true, pre, returned, threw, immediate: read() });
        return;
      }
      if (performance.now() - started > 1000) {
        resolve({ ready: false, pre: read(), returned: undefined, threw: null, immediate: null });
        return;
      }
      requestAnimationFrame(check);
    };
    check();
  }), replacement);

  ok(load.ready === true && load.pre && load.pre.activeSize > 0 && load.pre.batchPresent && load.pre.animationNotFinished,
    '竞态前置条件：真实拖拽已建立未结束的吸附 batch/动画 ' + detail(load.pre));
  ok(load.threw === null && load.returned === true,
    '同 ID 新存档导入返回 true 且不抛错 ' + detail({ returned: load.returned, threw: load.threw }));
  ok(load.immediate && !load.immediate.batchPresent && load.immediate.activeSize === 0,
    '导入提交立即清空旧 _nodeDragSnapBatch 与 _activeSnapAnims: ' + detail(load.immediate));

  let engineSettled = true;
  try {
    await page.waitForFunction(
      () => App._activeSnapAnims.size === 0 && App._snapDataInterval === null && App._snapRenderRaf === null,
      { timeout: 5000 }
    );
  } catch (_) {
    engineSettled = false;
  }
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const final = await page.evaluate(() => {
    const node = App.canvasState.nodes.find(n => n && n.id === 'keep_n') || null;
    const el = App._nodeElMap.get('keep_n');
    const match = el && (el.style.transform || '').match(/translate\(([^,]+)px,\s*([^)]+)px\)/);
    const top = App.canvasState.history[App.canvasHistoryIndex];
    const topNodes = top && Array.isArray(top.nodes) ? top.nodes : [];
    const topNode = topNodes.find(n => n && n.id === 'keep_n') || null;
    let stored = null;
    try {
      const raw = localStorage.getItem('flow_data');
      const parsed = raw && JSON.parse(raw);
      const storedNode = parsed && parsed.nodes && parsed.nodes.find(n => n.id === 'keep_n');
      if (storedNode) stored = { grid: { x: storedNode.x, y: storedNode.y }, pixels: { x: storedNode.x * 20, y: storedNode.y * 20 } };
    } catch (_) {}
    return {
      batchPresent: !!App._nodeDragSnapBatch,
      activeSize: App._activeSnapAnims.size,
      node,
      dom: match ? { x: parseFloat(match[1]), y: parseFloat(match[2]) } : null,
      historyLength: App.canvasState.history.length,
      historyIndex: App.canvasHistoryIndex,
      topNode,
      topNodeCount: topNodes.length,
      stored
    };
  });
  const exactExpected = pair => !!pair && pair.x === 200 && pair.y === 400;
  const finalNodeOk = exactExpected(final.node);
  const finalHistoryOk = final.historyLength === 1 && final.historyIndex === 0 &&
    final.topNodeCount === 1 && exactExpected(final.topNode);
  const finalStorageOk = !!final.stored && final.stored.grid.x === 10 && final.stored.grid.y === 20 &&
    exactExpected(final.stored.pixels);
  const finalDomOk = exactExpected(final.dom) && exactExpected(final.node) &&
    final.dom.x === final.node.x && final.dom.y === final.node.y;

  ok(engineSettled, '竞态测试结束前吸附动画引擎已归零');
  ok(!final.batchPresent && final.activeSize === 0, '竞态结束后 batch 与活动动画集合仍为空: ' + detail({
    batchPresent: final.batchPresent, activeSize: final.activeSize
  }));
  ok(finalNodeOk, '导入后唯一节点严格为像素 (200,400): ' + detail(final.node));
  ok(finalHistoryOk, '导入后唯一历史栈顶严格为像素 (200,400): ' + detail({
    historyLength: final.historyLength, historyIndex: final.historyIndex,
    topNodeCount: final.topNodeCount, topNode: final.topNode
  }));
  ok(finalStorageOk, '导入后 localStorage 解码坐标严格为像素 (200,400): ' + detail(final.stored));
  ok(finalDomOk, '导入后 DOM transform 与数据严格一致且为 (200,400): ' + detail({ dom: final.dom, node: final.node }));
  ok(pageErrors.length === errorStart, '竞态导入期间无 pageerror');

  const evidence = { expected: { x: 200, y: 400 }, pre: load.pre, immediate: load.immediate, final };
  if (!finalNodeOk || !finalHistoryOk || !finalStorageOk || !finalDomOk) {
    console.log('   竞态失败证据（预期新导入坐标 vs 旧动画回写）: ' + detail(evidence));
  }
}

async function runReadOnlyTests(page) {
  await installImportFixture(page);
  const result = await page.evaluate(() => {
    const directSnapshot = window.__dsInstallFixture();
    const directBefore = directSnapshot();
    const directData = {
      nodes: [{ id: 'ro_n', label: 'RO', desc: '', color: 'blue', x: 5, y: 6, mirrored: false, w: 8.5, h: 4 }],
      connections: [], regions: [], viewport: { panX: 7, panY: 8, scale: 1 }
    };
    const directInputBefore = JSON.stringify(directData);
    let directReturned;
    let directThrew = null;
    App.readOnly = true;
    try { directReturned = App._loadFromData(directData); }
    catch (err) { directThrew = err && err.message ? err.message : String(err); }
    const directAfter = directSnapshot();
    const directUnchanged = JSON.stringify(directBefore.state) === JSON.stringify(directAfter.state) &&
      Object.values(directBefore.refs).every(Boolean) && Object.values(directAfter.refs).every(Boolean);

    // 只读时 _readJsonFile 应在创建 FileReader 前短路。
    const NativeFileReader = window.FileReader;
    let readerCount = 0;
    window.FileReader = class { constructor() { readerCount++; } };
    let fileThrew = null;
    try { App._readJsonFile(new File(['{}'], 'blocked.json', { type: 'application/json' })); }
    catch (err) { fileThrew = err && err.message ? err.message : String(err); }
    const blockedReaderCount = readerCount;

    // 共享入口竞态：可编辑时开始异步读取，onload 前切换为只读。
    const raceSnapshot = window.__dsInstallFixture();
    const raceBefore = raceSnapshot();
    const readers = [];
    window.FileReader = class {
      constructor() { this.result = ''; readers.push(this); }
      readAsText(file) { this.result = JSON.stringify({
        nodes: [{ id: 'race_n', label: 'race', desc: '', color: 'blue', x: 1, y: 2, mirrored: false, w: 8.5, h: 4 }],
        connections: [], regions: [], viewport: { panX: 99, panY: 99, scale: 1 }
      }); }
    };
    const nativeClick = HTMLInputElement.prototype.click;
    let importThrew = null;
    try {
      HTMLInputElement.prototype.click = function () {
        if (this.type !== 'file') return nativeClick.call(this);
        Object.defineProperty(this, 'files', { configurable: true, value: [new File(['{}'], 'race.json')] });
        if (typeof this.onchange === 'function') this.onchange({ target: this });
      };
      App.readOnly = false;
      App.doImport();
      App.readOnly = true;
      if (readers[0] && typeof readers[0].onload === 'function') readers[0].onload();
      else throw new Error('共享导入入口未创建受控 FileReader');
    } catch (err) {
      importThrew = err && err.message ? err.message : String(err);
    } finally {
      HTMLInputElement.prototype.click = nativeClick;
      window.FileReader = NativeFileReader;
      App.readOnly = false;
    }
    const raceAfter = raceSnapshot();
    const raceUnchanged = JSON.stringify(raceBefore.state) === JSON.stringify(raceAfter.state) &&
      Object.values(raceBefore.refs).every(Boolean) && Object.values(raceAfter.refs).every(Boolean);

    return {
      directReturned, directThrew, directUnchanged,
      directInputUnchanged: JSON.stringify(directData) === directInputBefore,
      blockedReaderCount, fileThrew,
      raceThrew: importThrew, raceUnchanged, raceReaderCount: readers.length
    };
  });

  ok(result.directThrew === null && result.directUnchanged,
    '只读时直接 _loadFromData 不改变任何状态' + (result.directThrew ? ' (' + result.directThrew + ')' : ''));
  ok(result.directReturned === false, '只读直接导入明确返回 false');
  ok(result.directInputUnchanged, '只读拒绝导入不改写调用者对象');
  ok(result.fileThrew === null && result.blockedReaderCount === 0,
    '只读时 _readJsonFile 不创建 FileReader (count=' + result.blockedReaderCount + ')');
  ok(result.raceThrew === null && result.raceReaderCount === 1,
    '可编辑共享导入入口正常创建一次异步读取器');
  ok(result.raceUnchanged, '异步读取期间切换只读后，onload 不得替换画布');
}

async function runShortcutTests(page) {
  const results = await page.evaluate(() => {
    const editorBox = document.createElement('div');
    editorBox.id = '__ds_editor_box';
    editorBox.style.cssText = 'position:fixed;left:10px;top:10px;width:180px;height:60px;z-index:10000;opacity:0.01;';
    document.body.appendChild(editorBox);
    const input = document.createElement('input');
    input.type = 'text';
    const textarea = document.createElement('textarea');
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    editable.textContent = 'editable';
    editorBox.append(input, textarea, editable);

    const node = id => ({ id, label: id, desc: '', color: 'blue', x: 20, y: 40, mirrored: false, w: 170, h: 80 });
    const region = { id: 'r1', label: 'R', color: 'blue', x: 0, y: 0, w: 400, h: 300, nodeIds: ['n1'], parentId: null };
    const snapshot = () => JSON.stringify({
      nodes: App.canvasState.nodes,
      connections: App.canvasState.connections,
      regions: App.canvasState.regions,
      history: App.canvasState.history,
      historyIndex: App.canvasHistoryIndex,
      selectedNodes: [...App.selectedNodeIds].sort(),
      selectedConnections: [...App.selectedConnIds].sort(),
      selectedRegion: App.selectedRegionId,
      clipboard: App._clipboard,
      autoOpenModal: App._autoOpenModal,
      chromeHidden: App._chromeHidden,
      regionMode: App._regionModeActive,
      regionResize: App._regionResizeId,
      frameMove: App._frameMoveRegionId,
      inlineEdit: !!App._inlineEditTarget,
      descEdit: App._descEditNodeId,
      curveEdit: !!App._curveEditState,
      settingsOpen: document.getElementById('settingsModal').classList.contains('on'),
      modalOpen: document.getElementById('modal').classList.contains('on'),
      regionModalOpen: document.getElementById('regionModal').classList.contains('on')
    });

    const prepare = action => {
      App.readOnly = false;
      // 快捷键测试只验证状态/默认行为，屏蔽其 500ms 自动保存定时器，
      // 防止上一动作的 debounce 污染后续持久化错误用例。
      App.debouncedAutoSave = () => {};
      App.canvasState.nodes = [node('n1')];
      App.canvasState.connections = [];
      App.canvasState.regions = [region];
      App.canvasState.history = [
        { nodes: [], connections: [], regions: [] },
        { nodes: [node('n1')], connections: [], regions: [region] }
      ];
      App.canvasHistoryIndex = action === 'redo' ? 0 : 1;
      App.selectedNodeIds = new Set(['n1']);
      App.selectedConnIds = new Set();
      App.selectedRegionId = 'r1';
      App._clipboard = [{ ...node('clip') }];
      App._autoOpenModal = false;
      App._chromeHidden = false;
      App._regionModeActive = false;
      App._regionResizeId = null;
      App._frameMoveRegionId = null;
      App._inlineEditTarget = null;
      App._descEditNodeId = null;
      App._curveEditState = null;
      App._nodeByIdCache = null;
      App._connOffsCache = null;
      App._collapseDerived = null;
      document.getElementById('settingsModal').classList.remove('on');
      document.getElementById('modal').classList.remove('on');
      document.getElementById('regionModal').classList.remove('on');
    };

    const targets = [
      { name: 'input', el: input },
      { name: 'textarea', el: textarea },
      { name: 'contenteditable', el: editable }
    ];
    const actions = Object.keys(App._keybinds).filter(action => {
      const b = App._keybinds[action];
      return b && b.key && b.key !== 'any' && b.key.toLowerCase() !== 'escape';
    });
    const out = [];
    for (const target of targets) {
      for (const action of actions) {
        prepare(action);
        target.el.focus();
        const b = App._keybinds[action];
        const event = new KeyboardEvent('keydown', {
          key: b.key === 'delete' ? 'Delete' : b.key,
          code: b.key === 'delete' ? 'Delete' : undefined,
          ctrlKey: !!(b.anyMod || b.ctrl),
          metaKey: !!b.meta,
          altKey: !!b.alt,
          shiftKey: !!b.shift,
          bubbles: true,
          cancelable: true
        });
        const before = snapshot();
        const focused = document.activeElement === target.el;
        target.el.dispatchEvent(event);
        out.push({
          target: target.name,
          action,
          focused,
          prevented: event.defaultPrevented,
          stateUnchanged: before === snapshot()
        });
      }
    }

    // Escape 是唯一例外：仍应到达全局关闭流程。
    prepare('escape');
    input.focus();
    App._regionModeActive = true;
    document.getElementById('settingsModal').classList.add('on');
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    input.dispatchEvent(escape);
    const escapeResult = {
      focused: document.activeElement === input,
      regionClosed: App._regionModeActive === false,
      settingsClosed: !document.getElementById('settingsModal').classList.contains('on')
    };

    editorBox.remove();
    App._autoOpenModal = false;
    App._chromeHidden = false;
    App._regionModeActive = false;
    return { actions, results: out, escapeResult };
  });

  for (const result of results.results) {
    ok(result.focused && !result.prevented && result.stateUnchanged,
      result.target + ' 聚焦时 ' + result.action + ' 不 preventDefault 且不改 App 状态' +
      ' (focused=' + result.focused + ', prevented=' + result.prevented + ', state=' + (result.stateUnchanged ? 'same' : 'changed') + ')');
  }
  ok(results.escapeResult.focused && results.escapeResult.regionClosed && results.escapeResult.settingsClosed,
    '文本编辑聚焦时 Escape 仍执行全局关闭流程: ' + detail(results.escapeResult));
}

async function runPersistenceFailureTest(page) {
  const result = await page.evaluate(async () => {
    window.__dsInstallFixture();
    const container = document.getElementById('toastContainer');
    container.textContent = '';
    const originalSetItem = Storage.prototype.setItem;
    let flowWrites = 0;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'flow_data') {
        flowWrites++;
        throw new DOMException('simulated quota', 'QuotaExceededError');
      }
      return originalSetItem.call(this, key, value);
    };
    let saveThrew = null;
    try { App.saveCanvas(); }
    catch (err) { saveThrew = err && err.message ? err.message : String(err); }
    Storage.prototype.setItem = originalSetItem;
    // 允许实现以微任务/下一帧创建提示，但不依赖固定 sleep。
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const afterFailure = [...container.children].map(el => ({
      type: [...el.classList].find(c => c !== 'toast') || '',
      text: el.textContent.trim()
    }));

    const beforeRecoveryCount = container.children.length;
    App.saveCanvas();
    const afterRecovery = [...container.children].slice(beforeRecoveryCount).map(el => ({
      type: [...el.classList].find(c => c !== 'toast') || '',
      text: el.textContent.trim()
    }));
    return { flowWrites, saveThrew, afterFailure, afterRecovery };
  });

  ok(result.saveThrew === null, 'QuotaExceededError 被持久化层处理而非逃逸');
  ok(result.flowWrites === 1, 'flow_data 写失败路径实际被触发一次');
  ok(result.afterFailure.length === 1 && result.afterFailure[0].type === 'error' && result.afterFailure[0].text.length > 0,
    '写失败后出现一次明确错误 toast（不绑定 I18N 全文）: ' + detail(result.afterFailure));
  ok(result.afterRecovery.length === 0, '存储恢复后成功保存不重复提示错误');
}

(async () => {
  const launched = await launchBrowser(process.argv.includes('--headed'));
  try {
    const { page } = await openApp(launched.browser, { clearStorage: true });
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(err && err.message ? err.message : String(err)));

    await runImportTests(page);
    await runSnapImportRace(page, pageErrors);
    await runReadOnlyTests(page);
    await runShortcutTests(page);
    await runPersistenceFailureTest(page);

    ok(pageErrors.length === 0, '测试期间无未捕获页面异常' + (pageErrors.length ? ': ' + detail(pageErrors) : ''));
  } finally {
    await launched.cleanup();
  }

  console.log(failures === 0 ? '\n✅ 数据安全专项测试全部通过' : '\n❌ 数据安全专项测试 ' + failures + ' 项失败（当前实现上的回归证据）');
  process.exitCode = failures === 0 ? 0 : 1;
})().catch(err => {
  console.error('测试异常:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
