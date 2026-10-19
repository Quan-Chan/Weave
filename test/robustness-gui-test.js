'use strict';
// 攻击性错误处理专项 GUI 回归：恶意 ID 注入、破坏的导入文件、损坏的本地存档。
// 三组断言对应用户要求的三种攻击面：
//   A 组（任务 3a）：把选择器元字符 / 脚本标签 / 原型键名 / 超长串 / NUL 等塞进
//     节点、分区、连线的 id，走 导入 → 渲染 → 悬停/选中/编辑/弹窗 → 导出往返 →
//     落盘 → 切时序图再走一遍。要求：数据保真（id 原样往返）、不构成代码
//     （XSS canary 不触发、Object.prototype 不被污染）、任何路径都不抛异常。
//   B 组（任务 3b）：把导入文件破坏成各种错误结构（含原型污染载荷、分区父链
//     成环、时序档字段垃圾、超长 label、500 节点批量）。要求：要么明确拒绝，
//     要么清洗后可用；应用始终不崩、可继续建节点/存档。
//   C 组（任务 3c）：把浏览器本地数据（localStorage）写坏后重启。要求：启动
//     不崩、回退空文档、原有合法数据不受影响；清空重存后能正常加载。
// 与 data-safety-gui-test.js 的分工：那份守"结构非法即拒绝且状态不变"的原子性
// 契约；本文件守"恶意/畸形数据穿越完整应用生命周期"的生存性契约。
// 注意：导入文档的坐标一律用**格**单位（存档格式），与序列化输出同口径。
const { launchBrowser, openApp, dblClick, sleep, assertions } = require('./helpers/launch.js');

const tally = assertions();
const ok = tally.ok;
const detail = value => {
  try { return JSON.stringify(value); } catch (_) { return String(value); }
};

/* ── A 组：恶意 ID 注入 ─────────────────────────────────────────────── */

async function runHostileIdTests(page, cdp, pageErrors) {
  const errorStart = pageErrors.length;

  const report = await page.evaluate(async () => {
    const out = { errors: [], ids: null, dom: null, roundtrip: null, seq: null, proto: null };
    const frame = () => new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
    const rec = async (name, fn) => {
      try { out[name] = await fn(); } catch (e) { out.errors.push(name + ': ' + (e && e.message ? e.message : String(e))); }
    };

    //XSS canary：任何把 id/label 当 HTML 执行的路径都会把它置 true。
    window.__xss = false;
    App.readOnly = false;

    const IDS = [
      '<img src=x onerror="window.__xss=true">',
      '<script>window.__xss=true</script>',
      '"] .evil [',
      'a\'b"c',
      'a\\b',
      '__proto__',
      'constructor',
      'prototype',
      'hasOwnProperty',
      'toString',
      'x'.repeat(2048),
      'a\u0000b',
      '\u{1F600}_id',
      'a|b|c',
      'a,b',
      'a:b',
      'a#b',
      'a.b',
      'a(b)c',
      'a[b]c',
      'a=b*c',
      'a b',
      '中文 id',
      'plain_ok'
    ];
    const REGION_IDS = ['"] .evil [', "r'q\"uote", 'r\\back', '__proto__'];
    //c_proto 故意不带 mirrored：走"源节点镜像态"回退，专测 nodeMir 不用普通对象。
    const CONN_IDS = IDS.map((_, i) => 'c_' + i).concat(['c"] .evil [', "c'q\"uote", 'c\\back', 'c_proto']);

    await rec('ids', async () => {
      const doc = {
        nodes: IDS.map((id, i) => ({
          id, label: '<b>' + id + '</b>',
          desc: i === 0 ? '<script>window.__xss=true</script>' : '',
          color: 'blue', x: (i % 5) * 2.5, y: 3 + Math.floor(i / 5) * 11,
          mirrored: id === '__proto__' ? false : i % 2 === 0, w: 8.5, h: 4
        })),
        connections: CONN_IDS.map((id, i) => {
          const from = id === 'c_proto' ? '__proto__' : IDS[i % IDS.length];
          const c = { id, from, to: IDS[(i + 1) % IDS.length], label: '<i>' + id + '</i>' };
          if (id !== 'c_proto') c.mirrored = false;
          return c;
        }),
        regions: REGION_IDS.map((id, i) => ({
          id, label: '<u>' + id + '</u>', color: 'green',
          x: 1 + i * 31, y: 60 + i * 16, w: 25, h: 12,
          nodeIds: [IDS[0], IDS[1]], parentId: null
        })),
        viewport: { panX: 0, panY: 0, scale: 1 }
      };
      const before = JSON.stringify(doc);
      const ret = App._loadFromData(doc);
      await frame();   // 等 renderLines 的 rAF 把连线画出来
      const cProto = App.canvasState.connections.find(c => c.id === 'c_proto');
      return {
        ret,
        inputUnchanged: JSON.stringify(doc) === before,
        nodeIds: App.canvasState.nodes.map(n => n.id),
        connIds: App.canvasState.connections.map(c => c.id),
        regionIds: App.canvasState.regions.map(r => r.id),
        expectedIds: IDS, expectedConnIds: CONN_IDS, expectedRegionIds: REGION_IDS,
        cProtoMirrored: cProto ? cProto.mirrored : null,
        xss: window.__xss,
        protoPolluted: ({}).polluted !== undefined || ({}).evil !== undefined
      };
    });

    await rec('dom', async () => {
      const ids = out.ids;
      const nodes = ids.nodeIds.map(id => {
        const el = App._nodeElMap.get(id);
        return {
          id,
          hasEl: !!el,
          datasetOk: !!el && el.dataset.nodeId === id,
          headerText: el && el._hdr ? el._hdr.textContent : null,
          headerHtml: el && el._hdr ? el._hdr.innerHTML : null,
          injected: el ? !!el.querySelector('img,script') : null
        };
      });
      const labelEls = {};
      const labelBox = document.getElementById('regionLabels');
      for (const child of labelBox.children) labelEls[child.dataset.regionLabel] = child;
      const regions = ids.regionIds.map(id => {
        const el = labelEls[id];
        return { id, hasEl: !!el, text: el ? el.textContent : null };
      });
      const hitPaths = [...document.querySelectorAll('.hit-path')];
      return {
        nodes,
        regions,
        hitPathCount: hitPaths.length,
        hitKeys: hitPaths.map(el => el.dataset.connKey),
        expectedHitKeys: ids.connIds
      };
    });

    //应用方法路径：覆盖全部动态拼接选择器的修复点（区域标签双击重取、
    //_beginRegionLabelEdit、悬停镜像 querySelectorAll、_applyRegionTransform）。
    await rec('interact', async () => {
      const errors = [];
      const guard = (name, fn) => { try { fn(); } catch (e) { errors.push(name + ': ' + (e && e.message ? e.message : String(e))); } };
      const ids = out.ids;
      const labelBox = document.getElementById('regionLabels');
      const labelEls = {};
      for (const child of labelBox.children) labelEls[child.dataset.regionLabel] = child;
      const hitEls = {};
      for (const el of document.querySelectorAll('.hit-path')) hitEls[el.dataset.connKey] = el;

      for (const rid of ids.regionIds) {
        guard('applyRegionTransform ' + rid, () => App._applyRegionTransform(App._getRegionById(rid)));
        guard('beginRegionLabelEdit ' + rid, () => { App._beginRegionLabelEdit(rid); App._endRegionLabelEdit(true); });
        guard('labelDblClick ' + rid, () => {
          const el = labelEls[rid];
          if (!el) throw new Error('标签元素缺失');
          const r = el.getBoundingClientRect();
          const x = r.left + 8, y = r.top + 8;
          el.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: x, clientY: y, bubbles: true, cancelable: true }));
          el.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: x, clientY: y, bubbles: true, cancelable: true }));
          document.dispatchEvent(new MouseEvent('mouseup', { button: 0, clientX: x, clientY: y, bubbles: true }));
          App._endRegionLabelEdit(true);
        });
        guard('regionModal ' + rid, () => { App.openRegionModal(rid); App.saveRegionModal(); });
      }
      for (const cid of ids.connIds) {
        guard('connHover ' + cid, () => {
          const el = hitEls[cid];
          if (!el) throw new Error('命中路径缺失');
          el.dispatchEvent(new MouseEvent('mouseenter'));
          el.dispatchEvent(new MouseEvent('mouseleave'));
        });
        guard('inlineEditEdge ' + cid, () => { App.inlineEdit('edge', cid); App.closeInlineEdit(); });
        guard('connModal ' + cid, () => { App.openConnProps({ kind: 'conn', id: cid }); App.saveConnModal(); });
      }
      for (const nid of ids.nodeIds) {
        guard('nodeModal ' + nid, () => { App.openNodeModal(nid); App.saveModal(); });
        guard('resizeHandles ' + nid, () => { App._showResizeHandles(nid); App._hideResizeHandles(); });
      }
      guard('selectAll', () => App.selectAllNodes());
      guard('attrQuote', () => {
        if (typeof Weave.Util.attrQuote !== 'function') throw new Error('attrQuote 缺失');
        if (Weave.Util.attrQuote('a"b') !== '"a\\"b"') throw new Error('attrQuote 引号转义不符: ' + Weave.Util.attrQuote('a"b'));
      });
      return errors;
    });

    await rec('roundtrip', async () => {
      const out1 = App._serializeData();
      const parsed = JSON.parse(JSON.stringify(out1));
      const ret = App._loadFromData(parsed);
      App.saveCanvas();
      const stored = JSON.parse(localStorage.getItem('flow_data'));
      return {
        ret,
        nodeIds: App.canvasState.nodes.map(n => n.id),
        storedNodeIds: stored.nodes.map(n => n.id),
        expectedIds: out.ids.expectedIds,
        xss: window.__xss
      };
    });

    //时序图模式：同一批恶意 id 再走一遍（消息连线的 data-conn-key 悬停路径 +
    //可读格式导出往返）。originY=8 格保证 t=1 的消息不被"越界即剔"规则删掉。
    await rec('seq', async () => {
      const IDS = out.ids.expectedIds;
      const switched = App._setMode('sequence');
      const doc = {
        format: 'weave-sequence', mode: 'sequence', unit: 'grid', gridPx: 20,
        time: { originY: 8, step: 1, start: 1 },
        messageStyle: { colorSource: 'participant' },
        nodes: IDS.map((id, i) => ({
          id, label: 'S' + i, desc: '', color: 'blue',
          x: i * 3, y: 3, w: 8.5, h: 4, lifeline: { x: i * 3, y: 3, length: 12 }
        })),
        connections: IDS.map((id, i) => ({
          id: 'm_' + i, from: IDS[i], to: IDS[(i + 1) % IDS.length],
          t: 1 + (i % 10), line: i % 3 === 0 ? 'dashed' : 'solid'
        })),
        regions: [],
        viewport: { panX: 0, panY: 0, scale: 1 }
      };
      const ret = App._loadFromData(doc);
      await frame();
      const hitEls = [...document.querySelectorAll('.hit-path')];
      const hoverErrors = [];
      for (const el of hitEls) {
        try {
          el.dispatchEvent(new MouseEvent('mouseenter'));
          el.dispatchEvent(new MouseEvent('mouseleave'));
        } catch (e) { hoverErrors.push(el.dataset.connKey + ': ' + e.message); }
      }
      const first = App.canvasState.nodes[0];
      const msg = App.canvasState.connections[0];   // m_0（t=1 → originY 8 格 = 160px）
      const seqOut = App._serializeData();
      const ret2 = App._loadFromData(JSON.parse(JSON.stringify(seqOut)));
      const back = App._setMode('graph');
      return {
        switched, ret, ret2, back,
        expectedIds: IDS,
        life: first.life,
        msgY: msg.y,
        msgDashed: msg.dashed,
        hitPathCount: hitEls.length,
        hoverErrors,
        outFormat: seqOut.format,
        outHasVersion: Object.prototype.hasOwnProperty.call(seqOut, 'version'),
        outLife: seqOut.nodes[0].lifeline && seqOut.nodes[0].lifeline.length,
        outT0: seqOut.connections[0].t,
        outT1: seqOut.connections[1].t,
        outNodeIds: seqOut.nodes.map(n => n.id),
        outConnIds: seqOut.connections.map(c => c.id),
        xss: window.__xss
      };
    });

    await rec('proto', async () => ({
      polluted: ({}).polluted !== undefined || ({}).evil !== undefined || ({}).xss !== undefined,
      xss: window.__xss
    }));

    return out;
  });

  ok(report.errors.length === 0, 'A 组页面内各步骤无异常' + (report.errors.length ? ': ' + detail(report.errors) : ''));

  const ids = report.ids || {};
  ok(ids.ret === true, '恶意 id 文档导入成功（id 是数据不是代码）');
  ok(ids.inputUnchanged === true, '导入过程不改写调用者文档');
  ok(JSON.stringify(ids.nodeIds) === JSON.stringify(ids.expectedIds) &&
     JSON.stringify(ids.connIds) === JSON.stringify(ids.expectedConnIds) &&
     JSON.stringify(ids.regionIds) === JSON.stringify(ids.expectedRegionIds),
    '节点/连线/分区 id 全部原样保留（含选择器元字符与原型键名）');
  ok(ids.cProtoMirrored === false, 'from 为 __proto__ 的连线镜像回退为 false（nodeMir 不用普通对象）');
  ok(ids.xss === false && ids.protoPolluted === false, '导入后 XSS canary 未触发且原型未被污染');

  const dom = report.dom || {};
  ok(dom.nodes && dom.nodes.every(n => n.hasEl && n.datasetOk), '每个恶意 id 都有对应 DOM 且 dataset.nodeId 原样');
  const xssNode = dom.nodes && dom.nodes[0];
  ok(!!xssNode && xssNode.headerText === '<b><img src=x onerror="window.__xss=true"></b>' &&
     xssNode.headerHtml.indexOf('<img') === -1 && !xssNode.injected,
    '恶意 label 走 textContent：可读但不成 HTML ' + detail(xssNode && { text: xssNode.headerText, html: xssNode.headerHtml }));
  ok(dom.regions && dom.regions.every(r => r.hasEl && r.text === '<u>' + r.id + '</u>'),
    '恶意分区 id 的标签元素存在且文本原样');
  ok(dom.hitPathCount === (dom.expectedHitKeys || []).length &&
     JSON.stringify(dom.hitKeys) === JSON.stringify(dom.expectedHitKeys),
    '每条恶意连线都渲染出命中路径且 key 原样');

  ok(Array.isArray(report.interact) && report.interact.length === 0,
    '悬停/编辑/弹窗/分区拖动等方法路径对恶意 id 全部无异常' +
    (Array.isArray(report.interact) && report.interact.length ? ': ' + detail(report.interact) : ''));

  const rt = report.roundtrip || {};
  ok(rt.ret === true && JSON.stringify(rt.nodeIds) === JSON.stringify(rt.expectedIds) &&
     JSON.stringify(rt.storedNodeIds) === JSON.stringify(rt.expectedIds) && rt.xss === false,
    '导出往返与 localStorage 落盘都保留恶意 id 原样且无执行');

  const seq = report.seq || {};
  ok(seq.switched === true && seq.ret === true, '时序图模式导入恶意 id 文档成功');
  ok(seq.life === 240, 'lifeline.length=12 格 → life=240px: ' + detail(seq.life));
  ok(seq.msgY === 160 && seq.msgDashed === true,
    't=1 → y=160px（originY=8 格）且虚线（i=0 → line=dashed）: ' + detail({ msgY: seq.msgY, msgDashed: seq.msgDashed }));
  ok(seq.hitPathCount === (seq.outConnIds || []).length && (!seq.hoverErrors || seq.hoverErrors.length === 0),
    '时序消息命中路径齐全且悬停镜像无异常' + detail({ count: seq.hitPathCount, hoverErrors: seq.hoverErrors }));
  ok(seq.outFormat === 'weave-sequence' && seq.outHasVersion === false && seq.outLife === 12 &&
     seq.outT0 === 2 && seq.outT1 === 3,
    '时序导出为可读格式且不带 version 键（t 相对最顶时序线起点）: ' +
    detail({ format: seq.outFormat, hasVersion: seq.outHasVersion, life: seq.outLife, t0: seq.outT0, t1: seq.outT1 }));
  ok(seq.ret2 === true && seq.back === true && JSON.stringify(seq.outNodeIds) === JSON.stringify(seq.expectedIds),
    '时序存档 id 原样写出、再导入成功并切回节点图');

  const proto = report.proto || {};
  ok(proto.polluted === false && proto.xss === false, 'Object.prototype 未被污染');

  ok(pageErrors.length === errorStart, 'A 组方法路径期间无未捕获页面异常' + (pageErrors.length > errorStart ? ': ' + detail(pageErrors.slice(errorStart)) : ''));

  //真实指针交互：单击选中、双击标题编辑、单击分区、拖拽恶意 id 节点。
  //先导入一份只有两个节点（无连线）的干净文档，保证落点无歧义。
  const pointerStart = pageErrors.length;
  const pointer = await page.evaluate(() => {
    App._loadFromData({
      nodes: [
        { id: 'plain_ok', label: 'OK', desc: '', color: 'blue', x: 2, y: 3, mirrored: false, w: 8.5, h: 4 },
        { id: '<img src=x onerror="window.__xss=true">', label: 'H', desc: '', color: 'green', x: 16, y: 3, mirrored: false, w: 8.5, h: 4 }
      ],
      connections: [],
      regions: [{ id: '"] .evil [', label: 'R', color: 'orange', x: 1, y: 15, w: 35, h: 12, nodeIds: [], parentId: null }],
      viewport: { panX: 0, panY: 0, scale: 1 }
    });
    const r = App._nodeElMap.get('plain_ok').getBoundingClientRect();
    const hr = App._nodeElMap.get('<img src=x onerror="window.__xss=true">').getBoundingClientRect();
    const rl = document.getElementById('regionLabels').children[0].getBoundingClientRect();
    return {
      node: { x: r.left + r.width / 2, y: r.top + r.height / 2 },
      header: { x: r.left + r.width / 2, y: r.top + 12 },
      region: { x: rl.left + 6, y: rl.top + 6 },
      hostile: { x: hr.left + hr.width / 2, y: hr.top + hr.height / 2 },
      hostileId: '<img src=x onerror="window.__xss=true">',
      before: { x: 320, y: 60 }
    };
  });
  await page.mouse.move(pointer.node.x, pointer.node.y);
  await page.mouse.click(pointer.node.x, pointer.node.y);
  const selected = await page.evaluate(() => App.selectedNodeIds.has('plain_ok'));
  ok(selected, '真实单击选中普通 id 节点');

  await dblClick(page, cdp, pointer.header.x, pointer.header.y);
  await sleep(150);
  const editing = await page.evaluate(() => !!App._inlineEditTarget);
  ok(editing, '真实双击节点标题进入内联编辑');
  await page.evaluate(() => App.closeInlineEdit());

  await page.mouse.click(pointer.region.x, pointer.region.y);
  await sleep(120);
  const regionSelected = await page.evaluate(() => App.selectedRegionId === '"] .evil [');
  ok(regionSelected, '真实单击选中恶意 id 分区');

  await page.mouse.move(pointer.hostile.x, pointer.hostile.y);
  await page.mouse.down();
  await page.mouse.move(pointer.hostile.x + 40, pointer.hostile.y + 40, { steps: 8 });
  await page.mouse.up();
  let settled = true;
  try {
    await page.waitForFunction(() => App._activeSnapAnims.size === 0 && App._snapDataInterval === null, { timeout: 5000 });
  } catch (_) { settled = false; }
  const dragged = await page.evaluate(id => {
    const n = App._getNodeById(id);
    return { x: n.x, y: n.y };
  }, pointer.hostileId);
  ok(settled && dragged.x === 360 && dragged.y === 100,
    '恶意 id 节点真实拖拽正常位移（吸附到格）: ' + detail({ before: pointer.before, after: dragged, settled }));
  const canary = await page.evaluate(() => window.__xss);
  ok(canary === false, '全部交互后 XSS canary 仍为 false');
  ok(pageErrors.length === pointerStart, '真实指针交互期间无未捕获页面异常' +
    (pageErrors.length > pointerStart ? ': ' + detail(pageErrors.slice(pointerStart)) : ''));

  await page.evaluate(() => {
    App._loadFromData({ nodes: [], connections: [], regions: [] });
    App.saveCanvas();
  });
}

/* ── B 组：破坏的导入文件 ───────────────────────────────────────────── */

async function runBrokenImportTests(page, pageErrors) {
  const errorStart = pageErrors.length;

  const report = await page.evaluate(() => {
    const out = { cases: [], errors: [] };
    const baseline = () => ({
      nodes: [
        { id: 'base_a', label: 'A', desc: '', color: 'blue', x: 2, y: 3, mirrored: false, w: 8.5, h: 4 },
        { id: 'base_b', label: 'B', desc: '', color: 'green', x: 17, y: 3, mirrored: false, w: 8.5, h: 4 }
      ],
      connections: [{ id: 'base_c', from: 'base_a', to: 'base_b', label: '', mirrored: false }],
      regions: [{ id: 'base_r', label: 'R', color: 'orange', x: 0, y: 0, w: 30, h: 20, nodeIds: ['base_a'], parentId: null }]
    });
    //可复用节点工厂（格单位，与常规导入文件一致）。
    const nd = (id, extra) => Object.assign({ id, label: 'N', desc: '', color: 'blue', x: 2, y: 3, mirrored: false, w: 8.5, h: 4 }, extra);

    //用例跑完后应用必须可用：建节点、渲染、快照、落盘都不抛，且节点字段全部合法。
    const probe = name => {
      try {
        App.addNode();
        App.renderCanvas({ center: false });
        App.saveCanvasSnapshot();
        App.saveCanvas();
        const bad = App.canvasState.nodes.filter(n => !n || typeof n.id !== 'string' ||
          !Number.isFinite(n.x) || !Number.isFinite(n.y) || !Number.isFinite(n.w) || !Number.isFinite(n.h));
        if (bad.length) throw new Error('导入后节点字段仍非法: ' + JSON.stringify(bad.slice(0, 2)));
        return null;
      } catch (e) { return name + ': ' + (e && e.message ? e.message : String(e)); }
    };

    const run = (name, data, check) => {
      App._loadFromData(baseline());
      const before = JSON.stringify(data);
      let ret, threw = null;
      try { ret = App._loadFromData(data); }
      catch (e) { threw = e && e.message ? e.message : String(e); }
      //state 必须在 probe（会 addNode）之前采集，节点数预期才不被污染。
      const state = {
        ret,
        nodeIds: App.canvasState.nodes.map(n => n.id),
        connIds: App.canvasState.connections.map(c => c.id),
        regionIds: App.canvasState.regions.map(r => r.id),
        regionParents: App.canvasState.regions.map(r => (r.parentId === undefined ? 'undef' : r.parentId)),
        colors: App.canvasState.nodes.map(n => n.color),
        mirrored: App.canvasState.connections.map(c => c.mirrored),
        protoPolluted: ({}).polluted !== undefined || ({}).evil !== undefined,
        viewport: { panX: App.panX, panY: App.panY, scale: App.scale }
      };
      const probeErr = probe(name);
      let extra = null;
      try { extra = check ? check(state) : null; } catch (e) { extra = 'check 抛错: ' + e.message; }
      out.cases.push({
        name, threw, ret, probeErr,
        inputUnchanged: JSON.stringify(data) === before,
        state, extra
      });
    };

    //── 顶层结构 ──
    run('顶层为字符串', 'not a document', s => s.ret === false && s.nodeIds.length === 2);
    run('顶层为 null', null, s => s.ret === false);
    run('顶层为数组', [1, 2, 3], s => s.ret === false);
    run('顶层为数字', 42, s => s.ret === false);
    run('nodes 为字符串', { nodes: 'x' }, s => s.ret === false);
    run('nodes 为 null', { nodes: null }, s => s.ret === false);
    run('connections 为对象', { nodes: [nd('a')], connections: {} }, s => s.ret === false);
    run('regions 为数字', { nodes: [], regions: 5 }, s => s.ret === false);
    run('viewport 为数组', { nodes: [], viewport: [] }, s => s.ret === false);

    //── 集合条目清洗 ──
    run('混合 null/primitive 条目', {
      nodes: [nd('ok1'), null, 7, 'primitive', nd('ok2')],
      connections: [{ id: 'ok_c', from: 'ok1', to: 'ok2', label: '', mirrored: false }, null, 7],
      regions: [null, 7, { id: 'ok_r', label: 'R', color: 'blue', x: 0, y: 0, w: 1, h: 1, nodeIds: [] }]
    }, s => s.ret === true && JSON.stringify(s.nodeIds) === JSON.stringify(['ok1', 'ok2']) &&
         JSON.stringify(s.connIds) === JSON.stringify(['ok_c']) && JSON.stringify(s.regionIds) === JSON.stringify(['ok_r']));
    run('空 nodes 数组', { nodes: [], connections: [], regions: [] },
      s => s.ret === true && s.nodeIds.length === 0);

    //── 字段层修复 ──
    run('节点坐标/尺寸垃圾', {
      nodes: [{ id: 'a', x: '20', y: Infinity, w: NaN, h: -5, label: 9, desc: 42, color: 123, mirrored: 'yes' }]
    }, s => {
      const n = App.canvasState.nodes[0];
      return s.ret === true && n.x === -300 && n.y === -60 && n.w === 180 && n.h === 60 &&
        typeof n.label === 'string' && n.desc === '' && n.color === 'blue' && n.mirrored === false;
    });
    run('color 含注入样式', { nodes: [nd('a', { color: 'javascript:alert(1)' }), nd('b', { color: '#12ab56' })] },
      s => s.ret === true && s.colors[0] === 'blue' && s.colors[1] === '#12ab56');
    run('viewport 局部非法', { nodes: [nd('a')], viewport: { panX: 19, panY: 'bad', scale: -3 } },
      s => s.ret === true && s.viewport.panX === 19 && s.viewport.panY === 0 && s.viewport.scale === 1);
    run('viewport scale 巨大', { nodes: [nd('a')], viewport: { scale: 1e9 } },
      s => s.ret === true && s.viewport.scale === 5);
    run('超长 label', { nodes: [nd('a', { label: 'x'.repeat(50000) })] },
      s => s.ret === true && App.canvasState.nodes[0].label.length === 50000);
    run('连线 from/to 非字符串', { nodes: [nd('a')], connections: [{ id: 'c', from: 42, to: 'a' }] },
      s => s.ret === true && s.connIds.length === 0);
    run('连线引用幽灵节点', { nodes: [nd('a')], connections: [{ id: 'c', from: 'a', to: 'ghost' }] },
      s => s.ret === true && s.connIds.length === 0);
    run('重复节点 id', { nodes: [nd('dup'), nd('dup')] },
      s => s.ret === true && JSON.stringify(s.nodeIds) === JSON.stringify(['dup', 'dup_1']));
    run('id 空串与缺失', { nodes: [{ label: 'N', x: 0, y: 0, w: 8.5, h: 4 }, nd('')] },
      s => s.ret === true && s.nodeIds.length === 2 && s.nodeIds.every(id => typeof id === 'string' && id.length > 0));

    //── 分区结构 ──
    run('分区父链成环', {
      nodes: [], regions: [
        { id: 'r1', label: 'R1', color: 'blue', x: 0, y: 0, w: 5, h: 3, nodeIds: [], parentId: 'r2' },
        { id: 'r2', label: 'R2', color: 'blue', x: 6, y: 0, w: 5, h: 3, nodeIds: [], parentId: 'r1' }
      ]
    }, s => s.ret === true && s.regionIds.length === 2 && s.regionParents.filter(p => p === null).length >= 1);
    run('分区 parentId 自引用', {
      nodes: [], regions: [{ id: 'r1', label: 'R', color: 'blue', x: 0, y: 0, w: 5, h: 3, nodeIds: [], parentId: 'r1' }]
    }, s => s.ret === true && s.regionParents[0] === null);
    run('分区 nodeIds 幽灵引用', {
      nodes: [nd('a')], regions: [{ id: 'r', label: 'R', color: 'blue', x: 0, y: 0, w: 5, h: 3, nodeIds: ['ghost', 'a', 'a'] }]
    }, s => s.ret === true && JSON.stringify(App.canvasState.regions[0].nodeIds) === JSON.stringify(['a']));
    run('分区数值垃圾', {
      nodes: [], regions: [{ id: 'r', label: 'R', color: 'blue', x: 'x', y: 0, w: -5, h: 0, nodeIds: [] }]
    }, s => s.ret === true && s.regionIds.length === 0);

    //── 原型污染 ──
    run('JSON.parse 原型污染载荷（顶层）', JSON.parse('{"nodes":[],"connections":[],"__proto__":{"polluted":"yes"}}'),
      s => s.ret === true && s.protoPolluted === false);
    run('JSON.parse 原型污染载荷（节点内）', JSON.parse('{"nodes":[{"id":"n1","label":"L","x":0,"y":0,"w":8.5,"h":4,"color":"blue","__proto__":{"evil":1}}]}'),
      s => s.ret === true && s.protoPolluted === false && s.nodeIds.length === 1);
    run('id 为 __proto__ / constructor', {
      nodes: [nd('__proto__', { mirrored: false }), nd('constructor'), nd('plain')],
      connections: [{ id: 'c', from: '__proto__', to: 'plain' }]
    }, s => s.ret === true && s.protoPolluted === false && s.mirrored[0] === false &&
         JSON.stringify(s.nodeIds) === JSON.stringify(['__proto__', 'constructor', 'plain']));

    //── 收起记录 ──
    run('collapse.hidden 结构垃圾', {
      nodes: [nd('a', { collapse: { hidden: [null, { id: 'ghost', dx: 0, dy: 0 }, { id: 'a', dx: 0, dy: 0 }, { id: 'b', dx: 'x', dy: 0 }] } }), nd('b')]
    }, s => {
      const a = App.canvasState.nodes.find(n => n.id === 'a');
      return s.ret === true && (!a.collapse || a.collapse.hidden.length === 0);
    });

    //── 时序图存档字段垃圾 ──
    //time 为字符串 → 轴参数取缺省（start=1/step=1/originY=0）：t=10 → y=9 格=180px，
    //落在时序线（锚点 140px、长 240px）范围内，因此保留而不是被剔。
    run('时序档：time 为字符串', {
      format: 'weave-sequence', mode: 'sequence', time: 'bad',
      nodes: [{ id: 'a', label: 'A', color: 'blue', x: 0, y: 3, w: 8.5, h: 4, lifeline: { x: 0, y: 3, length: 12 } }],
      connections: [{ id: 'm1', from: 'a', to: 'a', t: 10, line: 'solid' }]
    }, s => {
      const c = App.canvasState.connections[0];
      return s.ret === true && App.canvasState.nodes[0].life === 240 && c.y === 180 && c.dashed === false;
    });
    run('时序档：lifeline 为数字/长度非法', {
      format: 'weave-sequence', mode: 'sequence',
      nodes: [{ id: 'a', label: 'A', color: 'blue', x: 0, y: 3, w: 8.5, h: 4, lifeline: 7 },
              { id: 'b', label: 'B', color: 'blue', x: 8, y: 3, w: 8.5, h: 4, lifeline: { length: 'x' } }]
    }, s => {
      const a = App.canvasState.nodes.find(n => n.id === 'a');
      const b = App.canvasState.nodes.find(n => n.id === 'b');
      return s.ret === true && !Number.isFinite(a.life) && !Number.isFinite(b.life) &&
        !('lifeline' in a) && !('lifeline' in b);
    });
    run('时序档：t 为字符串 / line 为 42', {
      format: 'weave-sequence', mode: 'sequence',
      nodes: [{ id: 'a', label: 'A', color: 'blue', x: 0, y: 3, w: 8.5, h: 4, lifeline: { x: 0, y: 3, length: 12 } }],
      connections: [{ id: 'm1', from: 'a', to: 'a', t: 'x', line: 42 }]
    }, s => {
      const c = App.canvasState.connections[0];
      return s.ret === true && c.dashed === false && !('t' in c) && !('line' in c) &&
        (!('y' in c) || Number.isFinite(c.y));
    });
    run('时序档：nodes 为 null', { format: 'weave-sequence', mode: 'sequence', nodes: null },
      s => s.ret === false);
    run('时序档：regions 为 null', { format: 'weave-sequence', mode: 'sequence', nodes: [], regions: null },
      s => s.ret === false);
    run('时序档：viewport 为字符串', { format: 'weave-sequence', mode: 'sequence', nodes: [], viewport: 'x' },
      s => s.ret === false);

    //── 批量 ──
    run('500 节点链', (() => {
      const nodes = [], connections = [];
      for (let i = 0; i < 500; i++) nodes.push(nd('bulk_' + i, { x: (i % 25) * 10, y: 3 + Math.floor(i / 25) * 8 }));
      for (let i = 0; i < 499; i++) connections.push({ id: 'bc_' + i, from: 'bulk_' + i, to: 'bulk_' + (i + 1), label: '', mirrored: false });
      return { nodes, connections, regions: [] };
    })(), s => s.ret === true && s.nodeIds.length === 500 && s.connIds.length === 499);

    //复位：直接清空当前文档（不切模式），落盘后离开本组。
    App.canvasState.nodes = [];
    App.canvasState.connections = [];
    App.canvasState.regions = [];
    App.canvasState.history = [];
    App.canvasHistoryIndex = -1;
    App.saveCanvasSnapshot();
    App.renderCanvas({ center: false });
    App.saveCanvas();
    return out;
  });

  for (const c of report.cases) {
    ok(c.threw === null, 'B 组「' + c.name + '」：_loadFromData 不抛异常' + (c.threw ? ' (' + c.threw + ')' : ''));
    ok(c.probeErr === null, 'B 组「' + c.name + '」：导入后应用可用（建节点/渲染/快照/落盘）' + (c.probeErr ? ' (' + c.probeErr + ')' : ''));
    ok(c.inputUnchanged, 'B 组「' + c.name + '」：调用者文档未被改写');
    ok(typeof c.ret === 'boolean', 'B 组「' + c.name + '」：返回值为布尔');
    if (c.extra !== null && c.extra !== undefined) {
      ok(c.extra === true, 'B 组「' + c.name + '」：用例预期' + (c.extra === true ? '' : ' → ' + detail(c.extra)));
    }
  }
  ok(report.cases.every(c => !c.state.protoPolluted), 'B 组全部用例后 Object.prototype 未被污染');
  ok(pageErrors.length === errorStart, 'B 组期间无未捕获页面异常' + (pageErrors.length > errorStart ? ': ' + detail(pageErrors.slice(errorStart)) : ''));
}

/* ── C 组：损坏的本地存档 ───────────────────────────────────────────── */

async function reloadApp(page) {
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction('!!window.App && !!document.getElementById("canvasStage") && document.getElementById("canvasStage").clientWidth > 0', { timeout: 25000 });
  await sleep(400);
  await page.keyboard.press('Escape');   // 首启弹窗（若还在）关掉
  await sleep(150);
}

//启动后探针：文档结构可用 + 报告当前模式与节点 id。addNode/saveCanvas 也走一遍，
//证明"损坏之后应用仍可操作并可再次落盘"。
//注意：先屏蔽 500ms 防抖自动保存——否则探针的 addNode 会在 Node 端植入损坏数据、
//发起 reload 之后才落盘，把植入的值覆盖回旧状态（reload 导航提交前旧页面仍在运行）。
async function probeAfterStart(page) {
  return page.evaluate(() => {
    App.debouncedAutoSave = () => {};
    const nodes = App.canvasState.nodes.map(n => n.id);
    const bad = App.canvasState.nodes.filter(n => !n || typeof n.id !== 'string' ||
      !Number.isFinite(n.x) || !Number.isFinite(n.y) || !Number.isFinite(n.w) || !Number.isFinite(n.h));
    let addErr = null, saveErr = null;
    try { App.addNode(); } catch (e) { addErr = e.message; }
    try { App.saveCanvas(); } catch (e) { saveErr = e.message; }
    return {
      mode: App._mode,
      nodeIds: nodes,
      badCount: bad.length,
      addErr, saveErr,
      xss: window.__xss === true,
      afterAdd: App.canvasState.nodes.length
    };
  });
}

async function runCorruptStorageTests(browser, pageErrors) {
  const { page } = await openApp(browser, { clearStorage: false });
  const errorStart = pageErrors.length;
  page.on('pageerror', err => pageErrors.push(err && err.message ? err.message : String(err)));

  //清干净开局，并让应用自己写一份合法存档作为对照组。
  await page.evaluate(() => localStorage.clear());
  await reloadApp(page);
  await page.evaluate(() => {
    App._loadFromData({
      nodes: [
        { id: 'keep_a', label: 'A', desc: '', color: 'blue', x: 2, y: 3, mirrored: false, w: 8.5, h: 4 },
        { id: 'keep_b', label: 'B', desc: '', color: 'green', x: 17, y: 3, mirrored: false, w: 8.5, h: 4 }
      ],
      connections: [{ id: 'keep_c', from: 'keep_a', to: 'keep_b', label: '', mirrored: false }],
      regions: []
    });
    App.saveCanvas();
  });
  const validFlow = await page.evaluate(() => localStorage.getItem('flow_data'));

  //对照组：合法存档重载后原样恢复。
  await reloadApp(page);
  const control = await probeAfterStart(page);
  ok(control.badCount === 0 && !control.addErr && !control.saveErr &&
     JSON.stringify(control.nodeIds) === JSON.stringify(['keep_a', 'keep_b']),
    'C 组对照组：合法存档重载后原样恢复且应用可用 ' + detail(control));

  const SCENARIOS = [
    { name: 'flow_data 为非 JSON 文本', seed: { flow_data: '这不是 JSON{' }, expectNodes: 0 },
    { name: 'flow_data 为空串', seed: { flow_data: '' }, expectNodes: 0 },
    { name: 'flow_data 为 null 字面量', seed: { flow_data: 'null' }, expectNodes: 0 },
    { name: 'flow_data 为数字', seed: { flow_data: '42' }, expectNodes: 0 },
    { name: 'flow_data 为 {}', seed: { flow_data: '{}' }, expectNodes: 0 },
    { name: 'flow_data.nodes 非数组', seed: { flow_data: '{"nodes":"oops"}' }, expectNodes: 0 },
    { name: 'flow_data.nodes 为 null', seed: { flow_data: '{"nodes":null}' }, expectNodes: 0 },
    {
      name: 'flow_data 带恶意 id 与注入 label', expectNodes: 1, expectId: '<img src=x onerror="window.__xss=true">',
      seed: { flow_data: '{"nodes":[{"id":"<img src=x onerror=\\"window.__xss=true\\">","label":"<b> hostile </b>","desc":"<script>window.__xss=true</script>","x":2,"y":3,"w":8.5,"h":4,"color":"blue"}]}' }
    },
    { name: 'flow_data.viewport 垃圾', seed: { flow_data: '{"nodes":[],"viewport":{"scale":-9,"panX":"x"}}' }, expectNodes: 0 },
    { name: 'flow_data_seq 损坏（节点图正常）', seed: { flow_data: validFlow, flow_data_seq: '坏数据' }, expectNodes: 2 },
    { name: 'flow_custom_colors 损坏', seed: { flow_data: validFlow, flow_custom_colors: '坏[' }, expectNodes: 2 },
    { name: 'flow_custom_colors 含非法色', seed: { flow_data: validFlow, flow_custom_colors: '["red","#zzzzzz",123,null]' }, expectNodes: 2 },
    { name: 'flow_mode 为未知值', seed: { flow_data: validFlow, flow_mode: 'sequence; DROP TABLE' }, expectNodes: 2 },
    { name: 'flow_mode 为 sequence 但时序档损坏', seed: { flow_data: validFlow, flow_mode: 'sequence', flow_data_seq: '坏' }, expectNodes: 0, expectMode: 'sequence' }
  ];

  for (const sc of SCENARIOS) {
    const before = pageErrors.length;
    //植入损坏数据。必须同时屏蔽旧页面的 saveCanvas：应用在 beforeunload 里会
    //落盘（设计如此），否则 reload 一刻旧页面把当前状态写回 flow_data，植入的
    //值在新页面启动前就被覆盖——"本地数据已损坏"这个前提根本建立不起来。
    await page.evaluate(data => {
      for (const k of Object.keys(data)) localStorage.setItem(k, data[k]);
      App.saveCanvas = () => {};
    }, sc.seed);
    await reloadApp(page);

    const probe = await probeAfterStart(page);
    ok(probe.badCount === 0 && !probe.addErr && !probe.saveErr,
      'C 组「' + sc.name + '」：损坏启动不崩且应用可用 ' + detail(probe));
    ok(probe.nodeIds.length === sc.expectNodes,
      'C 组「' + sc.name + '」：按预期回退/恢复（节点数 ' + probe.nodeIds.length + '，期望 ' + sc.expectNodes + '）' +
      detail(probe.nodeIds));
    if (sc.expectId) {
      ok(probe.nodeIds[0] === sc.expectId && !probe.xss,
        'C 组「' + sc.name + '」：恶意 id 原样恢复且未执行');
    }
    if (sc.expectMode) {
      ok(probe.mode === sc.expectMode, 'C 组「' + sc.name + '」：模式按持久化值装配');
    }
    ok(pageErrors.length === before, 'C 组「' + sc.name + '」：启动期间无未捕获页面异常' +
      (pageErrors.length > before ? ': ' + detail(pageErrors.slice(before)) : ''));

    //"清空并在后续正常加载"：在损坏启动之上清空当前文档并重载。
    const cleared = await page.evaluate(() => {
      App.canvasState.nodes = [];
      App.canvasState.connections = [];
      App.canvasState.regions = [];
      App.canvasState.history = [];
      App.canvasHistoryIndex = -1;
      App.saveCanvasSnapshot();
      App.renderCanvas({ center: false });
      App.saveCanvas();
      return localStorage.getItem(App._docKey());
    });
    ok(typeof cleared === 'string' && cleared.length > 0, 'C 组「' + sc.name + '」：损坏之上可清空并落盘');
    await reloadApp(page);
    const after = await probeAfterStart(page);
    ok(after.nodeIds.length === 0 && after.afterAdd === 1 && after.badCount === 0 && !after.addErr && !after.saveErr,
      'C 组「' + sc.name + '」：清空重存后正常加载并可用 ' + detail(after));
  }

  //切回节点图模式收尾（上面最后一个场景可能停在时序模式）。
  await page.evaluate(() => { if (App._mode !== 'graph') App._setMode('graph'); App.saveCanvas(); });
  await page.close();
  ok(pageErrors.length === errorStart, 'C 组整体无未捕获页面异常' + (pageErrors.length > errorStart ? ': ' + detail(pageErrors.slice(errorStart)) : ''));
}

(async () => {
  const launched = await launchBrowser(process.argv.includes('--headed'));
  try {
    const { page, cdp } = await openApp(launched.browser, { clearStorage: true });
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(err && err.message ? err.message : String(err)));

    await runHostileIdTests(page, cdp, pageErrors);
    await runBrokenImportTests(page, pageErrors);
    await runCorruptStorageTests(launched.browser, pageErrors);

    ok(pageErrors.length === 0, '全部测试期间无未捕获页面异常' + (pageErrors.length ? ': ' + detail(pageErrors) : ''));
  } finally {
    await launched.cleanup();
  }

  console.log(tally.fails === 0 ? '\n✅ 攻击性错误处理专项测试全部通过' : '\n❌ 攻击性错误处理专项测试 ' + tally.fails + ' 项失败');
  process.exitCode = tally.fails === 0 ? 0 : 1;
})().catch(err => {
  console.error('测试异常:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
