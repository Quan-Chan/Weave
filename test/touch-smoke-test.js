'use strict';
// 触控手势回归(M08 · 指针手势)。
// 实现于 Pointer Events:pointerType !== 'mouse' 的事件由指针层接管,
// 合成同构鼠标事件交给既有手势代码。
// 关键:本测试在导航之前就开启触控仿真(见 helpers 的 openAppTouch),
// 页面自举时即处于移动端配置——裸 Input.dispatchTouchEvent 虽也能产生
// pointer 事件,但页面是在无触控配置下启动的,与真机不同。
// 覆盖:指针事件到达/不重复触发 / 平移 / 捏合缩放 / 点选 / 双击建节点 /
//       拖节点 / 长按菜单(节点·空白) / 框选模式 / 拖连接点建线 / 只读。
const path = require('path');
const {
  sleep, launchBrowser, openAppTouch, setupChain, mkNode, installFactories, shotsDir, assertions, blankPoint,
  touchTap, touchDrag, touchLongPress, touchPinch, touchDoubleTap
} = require('./helpers/launch');

const tally = assertions();
const ok = tally.ok;

(async () => {
  const shots = shotsDir('touch');
  const { browser, mode, cleanup } = await launchBrowser(false);
  console.log('浏览器: ' + mode);
  const { page, cdp } = await openAppTouch(browser, { clearStorage: true });
  await installFactories(page);

  console.log('\n── 0. 移动端环境与指针事件可用性 ──');
  const caps = await page.evaluate(() => ({
    ontouchstart: 'ontouchstart' in window,
    maxTouchPoints: navigator.maxTouchPoints,
    pointerEvent: 'PointerEvent' in window,
    stageTouchAction: getComputedStyle(document.getElementById('canvasStage')).touchAction,
    bound: document.getElementById('canvasStage').dataset.pointerBound
  }));
  ok('页面在移动端触控配置下启动（ontouchstart 存在）', caps.ontouchstart, caps);
  ok('Pointer Events 可用', caps.pointerEvent, caps);
  ok('支持多点触控（maxTouchPoints ≥ 2）', caps.maxTouchPoints >= 2, caps);
  ok('画布 touch-action:none', caps.stageTouchAction === 'none', caps);
  ok('指针层已绑定到画布', caps.bound === '1', caps);

  // 探针:记录画布上真实到达的事件类型与 pointerType
  await page.evaluate(() => {
    window.__log = [];
    const stage = document.getElementById('canvasStage');
    ['pointerdown', 'pointermove', 'pointerup', 'touchstart', 'mousedown', 'mouseup', 'click']
      .forEach(t => stage.addEventListener(t, e => window.__log.push({
        t, pt: e.pointerType || '', btn: e.button
      }), true));
  });

  // 画布区域(移动端视口)
  const geom = await page.evaluate(() => {
    const r = document.getElementById('canvasStage').getBoundingClientRect();
    return { left: r.left, top: r.top, w: r.width, h: r.height };
  });
  const cx = geom.left + geom.w / 2, cy = geom.top + geom.h / 2;

  const nodeCenter = id => page.evaluate(nid => {
    const n = App.canvasState.nodes.find(x => x.id === nid);
    if (!n) return null;
    const el = App._nodeElMap.get(nid);
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, id);

  const reset = () => page.evaluate(() => window.__testReset());
  let before, after, hl;

  // 找一个确实没有节点的画布点:长按空白与框选的坐标前提。
  const blankPt = () => blankPoint(page);

  console.log('\n── 1. 指针事件到达且不重复触发 ──');
  await page.evaluate(() => { window.__log = []; });
  await touchTap(cdp, cx, cy);
  await sleep(300);
  let log = await page.evaluate(() => window.__log);
  const pdown = log.filter(e => e.t === 'pointerdown');
  const compatMouse = log.filter(e => e.t === 'mousedown');
  ok('真实 pointerdown 到达画布且 pointerType=touch', pdown.length === 1 && pdown[0].pt === 'touch', log);
  ok('触控期间只有一次 mousedown（无浏览器兼容事件叠加）', compatMouse.length <= 1, log);
  let st = await page.evaluate(() => ({
    touchMode: !!App._touchMode,
    bodyClass: document.body.classList.contains('touch')
  }));
  ok('首次触摸置 _touchMode', st.touchMode, st);
  ok('body 获得 touch 类（命中区样式生效）', st.bodyClass, st);

  console.log('\n── 2. 单指拖拽空白 → 平移画布 ──');
  before = await page.evaluate(() => ({ panX: App.panX, panY: App.panY, hist: App.canvasState.history.length }));
  await touchDrag(cdp, cx + 120, cy + 180, cx + 20, cy + 80, 12, 14);
  await sleep(250);
  after = await page.evaluate(() => ({ panX: App.panX, panY: App.panY, hist: App.canvasState.history.length }));
  ok('panX 随单指左移而减少', after.panX < before.panX - 40, { before, after });
  ok('panY 随单指上移而减少', after.panY < before.panY - 40, { before, after });
  ok('平移不新增历史快照（视图操作不入撤销栈）', after.hist === before.hist, { before, after });

  console.log('\n── 3. 双指捏合 → 缩放 ──');
  before = await page.evaluate(() => App.scale);
  await touchPinch(cdp, cx, cy, 80, 240, 12);
  await sleep(250);
  after = await page.evaluate(() => App.scale);
  ok('双指外扩放大画布', after > before * 1.3, { before, after });
  before = after;
  await touchPinch(cdp, cx, cy, 240, 70, 12);
  await sleep(250);
  after = await page.evaluate(() => App.scale);
  ok('双指内收缩小画布', after < before * 0.8, { before, after });
  await page.evaluate(() => { App.scale = 1; App.applyViewTransform(); });
  await sleep(150);

  console.log('\n── 4. 双击空白 → 生成新节点 ──');
  await reset();
  const n0 = await page.evaluate(() => App.canvasState.nodes.length);
  await touchDoubleTap(cdp, cx, cy);
  await sleep(350);
  let nodes = await page.evaluate(() => App.canvasState.nodes.length);
  ok('双击空白新增 1 个节点（且只新增 1 个）', nodes === n0 + 1, { n0, nodes });

  console.log('\n── 5. 点按节点 → 选中 ──');
  await reset();
  await setupChain(page, [mkNode('A', 'A', 0, 0), mkNode('B', 'B', 320, 0)], []);
  await sleep(250);
  let a = await nodeCenter('A');
  await touchTap(cdp, a.x, a.y);
  await sleep(250);
  let sel = await page.evaluate(() => Array.from(App.selectedNodeIds));
  ok('点按节点 A 选中它', sel.length === 1 && sel[0] === 'A', sel);

  console.log('\n── 6. 单指拖拽节点 → 移动 ──');
  before = await page.evaluate(() => { const n = App._getNodeById('A'); return { x: n.x, y: n.y }; });
  await touchDrag(cdp, a.x, a.y, a.x + 60, a.y + 50, 12, 14);
  await sleep(400);
  after = await page.evaluate(() => { const n = App._getNodeById('A'); return { x: n.x, y: n.y }; });
  ok('节点 A 随手指移动', Math.abs(after.x - before.x) > 20 && Math.abs(after.y - before.y) > 15, { before, after });
  ok('拖拽后节点仍在选中态（未被随后的 click 清掉）',
    await page.evaluate(() => App.selectedNodeIds.has('A')));

  console.log('\n── 7. 长按节点 → 上下文菜单 ──');
  a = await nodeCenter('A');
  await touchLongPress(cdp, a.x, a.y, 700);
  await sleep(300);
  let ctx = await page.evaluate(() => {
    const vis = id => { const e = document.getElementById(id); return e && e.style.display !== 'none'; };
    return {
      shown: getComputedStyle(document.getElementById('ctx')).display === 'block',
      ctxNodeId: App._ctxNodeId,
      edit: vis('ctxEdit'), del: vis('ctxDel'), props: vis('ctxProps'),
      selMulti: vis('ctxSelMulti'), hl: vis('ctxHl'),
      paste: vis('ctxPaste'), boxMode: vis('ctxBoxMode'),
      multiBtn: !!document.getElementById('btnMultiSelect')
    };
  });
  ok('长按节点弹出上下文菜单', ctx.shown, ctx);
  ok('菜单锁定到该节点', ctx.ctxNodeId === 'A', ctx);
  ok('保留节点既有项（编辑/属性/删除）', ctx.edit && ctx.props && ctx.del, ctx);
  ok('触控补齐项：高亮关联', ctx.hl, ctx);
  // 多选累加改由侧边栏「多选模式」按钮承担，菜单里不再设该入口
  ok('菜单中不再有多选切换项', !ctx.selMulti, ctx);
  ok('侧边栏存在多选模式按钮（触控下的多选入口）', ctx.multiBtn, ctx);
  ok('画布专属项在节点菜单中隐藏', !ctx.paste && !ctx.boxMode, ctx);
  await page.screenshot({ path: path.join(shots, '01_longpress_node_ctx.png') });

  console.log('\n── 8. 补发 click 不得误触菜单项 ──');
  // 长按弹出的菜单正画在手指附近，抬手时浏览器补发的 click 若落到菜单项上，
  // 等于长按完顺手按下了某一项。这里守的是"补发 click 被拦下、
  // 用户真正点菜单项不受影响"这条规则。
  await sleep(350);
  const stray = await page.evaluate(() => ({
    shown: getComputedStyle(document.getElementById('ctx')).display === 'block',
    ctxNodeId: App._ctxNodeId,
    hl: !!App.hlNodeIds,
    sel: Array.from(App.selectedNodeIds)
  }));
  ok('抬手后菜单保持打开', stray.shown, stray);
  ok('菜单仍锁定到该节点（未被补发 click 消费）', stray.ctxNodeId === 'A', stray);
  ok('补发 click 未误触发"高亮关联"', !stray.hl, stray);
  ok('补发 click 未改变选中集合', stray.sel.length === 1 && stray.sel[0] === 'A', stray);

  console.log('\n── 9. 长按菜单的高亮关联 ──');
  // 第 8 节遗留的菜单仍开着且盖在节点附近，先关掉，否则长按会落到菜单上
  await page.evaluate(() => { const m = App._getEl('ctx'); m.style.display = 'none'; App._clearCtx(); });
  await sleep(200);
  // 用真实手指点菜单项（含 pointerdown + click），而不是 element.click()——
  // 后者没有前置 pointerdown，会被"补发 click"守卫正确拦下（见第 8 项）。
  const tapCtxButton = async id => {
    const r = await page.evaluate(bid => {
      const b = document.getElementById(bid);
      const q = b.getBoundingClientRect();
      return { x: q.left + q.width / 2, y: q.top + q.height / 2 };
    }, id);
    await touchTap(cdp, r.x, r.y);
    await sleep(300);
  };
  a = await nodeCenter('A');
  await touchLongPress(cdp, a.x, a.y, 700);
  await sleep(300);
  await tapCtxButton('ctxHl');
  hl = await page.evaluate(() => ({ on: !!App.hlNodeIds, size: App.hlNodeIds ? App.hlNodeIds.size : 0 }));
  ok('长按菜单的高亮关联建立高亮集合', hl.on && hl.size >= 1, hl);
  await page.evaluate(() => App._clearHighlight());

  console.log('\n── 10. 长按空白 → 画布菜单（粘贴 / 全选 / 框选模式）──');
  const bc = await blankPt();
  await touchLongPress(cdp, bc.x, bc.y, 700);
  await sleep(300);
  ctx = await page.evaluate(() => {
    const vis = id => { const e = document.getElementById(id); return e && e.style.display !== 'none'; };
    const r = document.getElementById('ctx').getBoundingClientRect();
    return {
      shown: getComputedStyle(document.getElementById('ctx')).display === 'block',
      paste: vis('ctxPaste'), selectAll: vis('ctxSelectAll'), boxMode: vis('ctxBoxMode'), fit: vis('ctxFit'),
      edit: vis('ctxEdit'), del: vis('ctxDel'), props: vis('ctxProps'),
      inViewport: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight
    };
  });
  ok('长按空白弹出画布菜单', ctx.shown, ctx);
  ok('画布菜单含粘贴 / 全选 / 框选模式 / 适应视图', ctx.paste && ctx.selectAll && ctx.boxMode && ctx.fit, ctx);
  ok('画布菜单不含节点专属项', !ctx.edit && !ctx.del && !ctx.props, ctx);
  ok('菜单完整落在视口内', ctx.inViewport, ctx);
  await page.screenshot({ path: path.join(shots, '02_longpress_canvas_ctx.png') });

  console.log('\n── 11. 框选模式：单指拖拽空白 → 框选 ──');
  await reset();
  await setupChain(page, [
    mkNode('A', 'A', 0, 0), mkNode('B', 'B', 300, 0),
    mkNode('C', 'C', 0, 300), mkNode('D', 'D', 300, 300)
  ], []);
  await sleep(250);
  await page.evaluate(() => document.getElementById('ctxBoxMode').click());
  await sleep(250);
  ok('框选模式已开启', await page.evaluate(() => App._boxModeActive));
  const boxPt = await page.evaluate(() => {
    const r = document.getElementById('canvasStage').getBoundingClientRect();
    const p = (wx, wy) => ({ x: r.left + wx * App.scale + App.panX, y: r.top + wy * App.scale + App.panY });
    return { a: p(-80, -80), b: p(500, 500) };
  });
  await touchDrag(cdp, boxPt.a.x, boxPt.a.y, boxPt.b.x, boxPt.b.y, 16, 12);
  await sleep(450);
  sel = await page.evaluate(() => Array.from(App.selectedNodeIds).sort());
  ok('单指拖拽框选到 4 个节点', sel.length === 4, sel);
  await page.evaluate(() => App._setBoxMode(false));
  await sleep(150);
  ok('框选模式可关闭', await page.evaluate(() => !App._boxModeActive));

  console.log('\n── 12. 拖连接点 → 建立连线 ──');
  await reset();
  await setupChain(page, [mkNode('A', 'A', 0, 0), mkNode('B', 'B', 340, 0)], []);
  await sleep(250);
  const sock = await page.evaluate(() => {
    const out = App._nodeElMap.get('A').querySelector('.socket.out').getBoundingClientRect();
    const inp = App._nodeElMap.get('B').querySelector('.socket.in').getBoundingClientRect();
    return {
      ox: out.left + out.width / 2, oy: out.top + out.height / 2,
      ix: inp.left + inp.width / 2, iy: inp.top + inp.height / 2
    };
  });
  await touchDrag(cdp, sock.ox, sock.oy, sock.ix, sock.iy, 16, 14);
  await sleep(450);
  const conns = await page.evaluate(() => App.canvasState.connections.length);
  ok('拖连接点建立 1 条连线', conns === 1, { conns });

  console.log('\n── 13. 双击节点标题 → 内联编辑 ──');
  await reset();
  await setupChain(page, [mkNode('A', 'A', 0, 0)], []);
  await sleep(250);
  const hdr = await page.evaluate(() => {
    const r = App._nodeElMap.get('A').querySelector('.node-header').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await touchDoubleTap(cdp, hdr.x, hdr.y);
  await sleep(450);
  const editing = await page.evaluate(() => ({
    active: !!App._inlineEditTarget,
    tag: App._inlineEditTarget ? App._inlineEditTarget.type : null
  }));
  ok('双击节点标题进入内联编辑', editing.active && editing.tag === 'nodeTitle', editing);
  await page.evaluate(() => App.closeInlineEdit && App.closeInlineEdit());
  await sleep(200);

  console.log('\n── 14. 触控不产生重复触发 ──');
  await reset();
  await setupChain(page, [mkNode('A', 'A', 0, 0)], []);
  await sleep(250);
  a = await nodeCenter('A');
  await touchTap(cdp, a.x, a.y);
  await sleep(300);
  st = await page.evaluate(() => ({ selSize: App.selectedNodeIds.size }));
  ok('一次点按只选中 1 个节点（无触控+鼠标双触发）', st.selSize === 1, st);
  await touchDoubleTap(cdp, cx + 80, cy + 200);
  await sleep(350);
  nodes = await page.evaluate(() => App.canvasState.nodes.length);
  ok('一次双击只建 1 个节点', nodes === 2, { nodes });

  console.log('\n── 15. 只读模式下触控不产生修改 ──');
  await reset();
  await setupChain(page, [mkNode('A', 'A', 0, 0), mkNode('B', 'B', 340, 0)], []);
  await sleep(250);
  await page.evaluate(() => App.toggleReadOnly());
  await sleep(200);
  a = await nodeCenter('A');
  const posBefore = await page.evaluate(() => { const n = App._getNodeById('A'); return { x: n.x, y: n.y }; });
  await touchDrag(cdp, a.x, a.y, a.x + 70, a.y + 60, 12, 14);
  await sleep(350);
  const posAfter = await page.evaluate(() => { const n = App._getNodeById('A'); return { x: n.x, y: n.y }; });
  ok('只读模式下触控拖拽不移动节点', posBefore.x === posAfter.x && posBefore.y === posAfter.y, { posBefore, posAfter });
  await page.evaluate(() => App.toggleReadOnly());
  await sleep(150);

  console.log('\n── 16. 指针捕获：手指滑出画布后拖拽不断 ──');
  await reset();
  before = await page.evaluate(() => ({ panX: App.panX, panY: App.panY }));
  // 起点在画布内，终点拖到画布外很远——无指针捕获时事件会丢失
  await touchDrag(cdp, cx - 100, cy - 100, cx + 900, cy + 1200, 16, 12);
  await sleep(300);
  after = await page.evaluate(() => ({ panX: App.panX, panY: App.panY }));
  ok('手指滑出画布范围后平移仍跟手（setPointerCapture 生效）',
    Math.abs(after.panX - before.panX) > 200, { before, after });

  await page.screenshot({ path: path.join(shots, '03_final.png') });

  console.log('\n────────────────────────────');
  console.log('结果: ' + tally.pass + ' 通过, ' + tally.fails + ' 失败');
  console.log('截图: ' + shots);
  await cleanup();
  process.exit(tally.fails ? 1 : 0);
})().catch(e => { console.error('触控测试异常:', e); process.exit(1); });