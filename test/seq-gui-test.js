'use strict';
// 时序图模式 · GUI 守护：
//  模式框架 —— 顶栏最右的模式切换按钮取代原先的节点/连线量徽标；
//           两个模式各持一份独立文档（切换互不覆盖，切回即恢复）；
//           切换是一次存档事务（同步落盘 + 记住模式，刷新后回到上次模式）；
//           模式不是开关，按钮不常亮，只有点击瞬间的一次反馈。
//  节点与时序线 —— 节点默认横向取奇数格（9 格 = 180px），连接点因此落在
//           格子正中；连接点在节点底边中点，向下引出与常规连线同款的实线；
//           拖拽末端把手改长度（逐格吸附 + 下限）；节点移动/缩放时跟随。
//  消息箭头 —— 从时序线拖出水平直线指向另一条时序线；高度逐格吸附；
//           只在目标端画箭头；连接点只画在源端（公留母去）；同高同对的消息互相避让。
// 复用统一台架 test/helpers/launch.js。
const { launchBrowser, openApp, sleep, assertions } = require('./helpers/launch.js');

const t = assertions('seq');

// 布置两个节点 + 一条连线的节点图文档（页面内执行）。
const LAYOUT_GRAPH = () => {
  window.__mkNode = (id, x, y, life) => {
    const n = { id, label: id, desc: '', color: 'blue', x, y, mirrored: false, w: 180, h: 80 };
    if (life !== undefined) n.life = life;
    return n;
  };
  App.canvasState.nodes = [window.__mkNode('g1', 0, 0), window.__mkNode('g2', 400, 0)];
  App.canvasState.connections = [{ id: 'gc1', from: 'g1', to: 'g2', label: '', mirrored: false }];
  App._nodeZOrder = ['g1', 'g2'];
  App.canvasState.history = [];
  App.canvasHistoryIndex = -1;
  App.saveCanvasSnapshot();
  App.renderCanvas();
};

// 当前模式与外壳状态快照。
const MODE_SNAPSHOT = () => ({
  mode: App._mode,
  seqClass: document.getElementById('canvasStage').classList.contains('seq-mode'),
  nodes: App.canvasState.nodes.length,
  conns: App.canvasState.connections.length,
  ids: App.canvasState.nodes.map(n => n.id),
  label: document.getElementById('modeLabel').textContent,
  active: document.getElementById('btnModeToggle').classList.contains('active'),
  modeSeq: document.getElementById('btnModeToggle').classList.contains('mode-seq'),
  regionHidden: document.getElementById('btnRegion').classList.contains('mode-hidden'),
  modeStored: localStorage.getItem('flow_mode'),
  graphStored: !!localStorage.getItem('flow_data'),
  seqStored: !!localStorage.getItem('flow_data_seq')
});

// 模式按钮的视觉状态（底色透明度用于判断是否"常亮"）。
const BTN_STYLE = () => {
  const b = document.getElementById('btnModeToggle');
  const cs = getComputedStyle(b);
  const m = cs.backgroundColor.match(/rgba?\(([^)]+)\)/);
  const parts = m ? m[1].split(',').map(s => s.trim()) : [];
  return {
    active: b.classList.contains('active'),
    flash: b.classList.contains('mode-flash'),
    alpha: parts.length === 4 ? parseFloat(parts[3]) : 1,
    graphIcon: getComputedStyle(b.querySelector('.mode-icon-graph')).display,
    seqIcon: getComputedStyle(b.querySelector('.mode-icon-seq')).display
  };
};

// 世界坐标 → 屏幕坐标（与 App.getWorldPos 互为逆运算）。
const worldToScreen = (page, wx, wy) => page.evaluate(([x, y]) => {
  const r = document.getElementById('canvasStage').getBoundingClientRect();
  return { x: r.left + x * App.scale + App.panX, y: r.top + y * App.scale + App.panY };
}, [wx, wy]);

// 两节点时序图的干净布局：s1(时序线 x=90, 80..480) 与 s2(x=690)，一条 200 高的消息。
const SETUP_SEQ = () => {
  const mk = (id, label, x, life) => ({ id, label, desc: '', color: 'blue', x, y: 0, mirrored: false, w: 180, h: 80, life: life || 400 });
  App._setMode('sequence');
  App.canvasState.nodes = [mk('s1', 'A', 0, 400), mk('s2', 'B', 600, 400)];
  App.canvasState.connections = [];
  App.canvasState.regions = [];
  App._nodeZOrder = ['s1', 's2'];
  App.selectedNodeIds.clear();
  App.selectedRegionId = null;
  App._seqMoveState = null;
  App.scale = 1; App.panX = 200; App.panY = 60;
  App.saveCanvasSnapshot();
  App.renderCanvas({ center: false });
  App.applyViewTransform();
  App._createSeqMessage('s1', 's2', 200);
  App.canvasState.connections[0].y = 200;
  App._connOffsCache = null;
  App.saveCanvasSnapshot();
  App.renderCanvas({ center: false });
  App.applyViewTransform();
};

// 真实鼠标拖拽（分步 move，跨过手势的起判阈值）。
async function dragMouse(page, from, to, steps = 8) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps);
    await sleep(16);
  }
  await page.mouse.up();
  //落定后有 150ms 的吸附动画（Weave.Geom.snapFrames 的 100ms + 50ms 过冲），
  //断言前留足余量，否则读到的是动画中间值。
  await sleep(320);
}

(async () => {
  const { browser, cleanup } = await launchBrowser(false);
  try {
    const { page } = await openApp(browser);

    // ══ 1) 顶栏：模式按钮取代徽标，位次仍是最后一个元素 ══
    const bar = await page.evaluate(() => {
      const btn = document.getElementById('btnModeToggle');
      const header = document.querySelector('.header');
      return {
        hasBtn: !!btn,
        hasBadge: !!document.getElementById('statusBadge'),
        isLast: header.lastElementChild === btn,
        label: document.getElementById('modeLabel') ? document.getElementById('modeLabel').textContent : null
      };
    });
    t.ok('模式按钮出现在顶栏', bar.hasBtn, bar);
    t.ok('原节点/连线量徽标已被取代', !bar.hasBadge, bar);
    t.ok('模式按钮是顶栏最后一个元素（右上角）', bar.isLast, bar);
    t.ok('按钮标签显示当前模式：节点图', bar.label === '节点图', bar);
    const bar0 = await page.evaluate(BTN_STYLE);
    t.ok('节点图模式下按钮不常亮', bar0.active === false && bar0.alpha < 1, bar0);

    // ══ 2) 节点图模式布置内容 ══
    await page.evaluate(LAYOUT_GRAPH);
    await sleep(250);
    const g0 = await page.evaluate(MODE_SNAPSHOT);
    t.ok('节点图模式就绪（2 节点 1 连线）', g0.nodes === 2 && g0.conns === 1, g0);

    // ══ 3) 点击按钮 → 切到时序图模式；反馈是"闪一下"而非常亮 ══
    await page.click('#btnModeToggle');
    const flashOn = await page.evaluate(BTN_STYLE);
    await sleep(520);
    const s1 = await page.evaluate(MODE_SNAPSHOT);
    const flashOff = await page.evaluate(BTN_STYLE);
    t.ok('点击瞬间按钮闪一下表示按到了', flashOn.flash === true, flashOn);
    t.ok('反馈随后自动消失（模式不常亮）', flashOff.flash === false && flashOff.active === false && flashOff.alpha < 1, flashOff);
    t.ok('切换到时序图模式', s1.mode === 'sequence', s1);
    t.ok('画布加上 seq-mode 类', s1.seqClass === true, s1);
    t.ok('时序图是独立文档（初始为空）', s1.nodes === 0 && s1.conns === 0, s1);
    t.ok('按钮标签改为时序图', s1.label === '时序图', s1);
    t.ok('时序图模式下按钮仍不常亮', s1.active === false && s1.modeSeq === true, s1);
    t.ok('图标随模式切换（时序图图标显示）', flashOff.seqIcon === 'block' && flashOff.graphIcon === 'none', flashOff);
    t.ok('时序图模式下画框分区入口照常显示', s1.regionHidden === false, s1);
    t.ok('切换即时落盘上一模式（flow_data 已写入）', s1.graphStored === true, s1);
    t.ok('当前模式被记住（flow_mode=sequence）', s1.modeStored === 'sequence', s1);

    // ══ 4) 默认节点横向为奇数格，时序线因此落在格子正中 ══
    await page.evaluate(() => { App.addNode(); });
    await sleep(300);
    const created = await page.evaluate(() => {
      const n = App.canvasState.nodes[0];
      const a = Weave.Geom.seqLifeAnchor(n);
      return {
        w: n.w, cells: n.w / 20, anchorX: a.x,
        cellCenter: (Math.floor(a.x / 20) + 0.5) * 20, snapNodes: App._snapNodes
      };
    });
    t.ok('默认节点横向为奇数格（9 格 = 180px）', created.w === 180 && created.cells === 9, created);
    t.ok('时序线落在所在格子的正中', created.anchorX === created.cellCenter, created);

    // 布置三个等距节点（显式给 life），供几何断言使用。
    await page.evaluate(() => {
      App.canvasState.nodes = [
        window.__mkNode('s1', 0, 0, 200),
        window.__mkNode('s2', 400, 0, 200),
        window.__mkNode('s3', 800, 0, 200)
      ];
      App.canvasState.connections = [];
      App._nodeZOrder = ['s1', 's2', 's3'];
      App.scale = 1; App.panX = 0; App.panY = 0;
      App.canvasState.history = [];
      App.canvasHistoryIndex = -1;
      App.saveCanvasSnapshot();
      App.renderCanvas({ center: false });
      App.applyViewTransform();
    });
    await sleep(300);

    // ══ 5) 画布图层顺序：时序线 → 连线 → 消息端点 → 节点 ══
    const layerOrder = await page.evaluate(() => [...document.getElementById('canvasWorld').children].map(c => c.id));
    const iLife = layerOrder.indexOf('seqSvg');
    const iLines = layerOrder.indexOf('linesSvg');
    const iPins = layerOrder.indexOf('seqPinsSvg');
    const iNodes = layerOrder.indexOf('canvasNodes');
    t.ok('图层顺序为 时序线 → 连线 → 端点连接点 → 节点',
      iLife >= 0 && iLife < iLines && iLines < iPins && iPins < iNodes,
      { order: layerOrder, iLife: iLife, iLines: iLines, iPins: iPins, iNodes: iNodes });

    // ══ 6) 连接点移到节点底边中点，输入连接点隐藏 ══
    const sock = await page.evaluate(() => {
      const el = App._nodeElMap.get('s2');
      const nr = el.getBoundingClientRect();
      const or = el._sckOut.getBoundingClientRect();
      return {
        inDisplay: getComputedStyle(el._sckIn).display,
        dx: (or.left + or.width / 2) - (nr.left + nr.width / 2),
        dy: (or.top + or.height / 2) - nr.bottom
      };
    });
    t.ok('时序图模式下隐藏输入连接点', sock.inDisplay === 'none', sock);
    t.ok('输出连接点位于节点底边中点', Math.abs(sock.dx) < 1.5 && Math.abs(sock.dy) < 1.5, sock);

    // ══ 7) 时序线：实线、取节点色、与常规连线同线宽 ══
    const lifelines = await page.evaluate(() => {
      const svg = document.getElementById('seqSvg');
      const lines = [...svg.querySelectorAll('.seq-life')];
      const first = lines[0];
      const cs = first ? getComputedStyle(first) : null;
      return {
        count: lines.length,
        handles: svg.querySelectorAll('.seq-life-handle').length,
        hits: svg.querySelectorAll('.seq-life-hit').length,
        x1: first ? +first.getAttribute('x1') : null,
        y1: first ? +first.getAttribute('y1') : null,
        y2: first ? +first.getAttribute('y2') : null,
        strokeWidth: first ? first.getAttribute('stroke-width') : null,
        dash: cs ? cs.strokeDasharray : null,
        stroke: cs ? cs.stroke : null,
        opacity: cs ? cs.opacity : null
      };
    });
    t.ok('每个节点渲染一条时序线', lifelines.count === 3, lifelines);
    t.ok('每条时序线带末端把手与命中线', lifelines.handles === 3 && lifelines.hits === 3, lifelines);
    t.ok('时序线自底边中点向下延伸 life（90,80 → 280）',
      lifelines.x1 === 90 && lifelines.y1 === 80 && lifelines.y2 === 280, lifelines);
    t.ok('时序线是实线（无虚线间隔）',
      !lifelines.dash || lifelines.dash === 'none', lifelines);
    t.ok('时序线取节点色且与常规连线同线宽/透明度',
      lifelines.stroke === 'rgb(59, 130, 246)' && lifelines.strokeWidth === '2.5' && lifelines.opacity === '0.6', lifelines);

    // ══ 8) 拖拽末端把手改变长度（逐格吸附） ══
    await dragMouse(page, await worldToScreen(page, 90, 280), await worldToScreen(page, 90, 380));
    const grown = await page.evaluate(() => {
      const n = App.canvasState.nodes.find(x => x.id === 's1');
      return { life: n.life, end: Weave.Geom.seqLifeEnd(n).y };
    });
    t.ok('拖把手把时序线拉长到 300（逐格吸附）', grown.life === 300, grown);
    t.ok('时序线末端随之落到 380', grown.end === 380, grown);

    // ══ 9) 从时序线拖出消息（水平 + 逐格吸附 + 只目标端箭头 + 只在源端画连接点） ══
    await dragMouse(page, await worldToScreen(page, 90, 160), await worldToScreen(page, 490, 160));
    const msg = await page.evaluate(() => {
      const conn = App.canvasState.connections[0];
      if (!conn) return { none: true };
      const f = App._getNodeById(conn.from), to = App._getNodeById(conn.to);
      const g = App._getConnGeometry(conn, f, to);
      const arrows = [...document.querySelectorAll('#linesSvg .conn-arrow[data-conn-key="' + conn.id + '"]')];
      const pins = [...document.querySelectorAll('#seqPinsSvg .seq-pin')];
      return {
        n: App.canvasState.connections.length,
        from: conn.from, to: conn.to, y: conn.y,
        ax: g.fromOut.x, bx: g.toIn.x, ay: g.fromOut.y, by: g.toIn.y, bow: g.cp.c1y,
        outHidden: arrows[0] ? arrows[0].getAttribute('visibility') : null,
        inHidden: arrows[1] ? arrows[1].getAttribute('visibility') : null,
        visPath: !!document.querySelector('#linesSvg path.line[data-conn-key="' + conn.id + '"]'),
        pins: pins.length,
        pinXs: pins.map(p => +p.getAttribute('cx')),
        pinYs: pins.map(p => +p.getAttribute('cy')),
        pinR: pins[0] ? +pins[0].getAttribute('r') : null,
        pinStroke: pins[0] ? pins[0].getAttribute('stroke') : null,
        innerR: (function() {
          const el = document.querySelector('#seqPinsSvg .seq-pin-inner');
          return el ? el.getAttribute('r') : null;
        })()
      };
    });
    t.ok('拖出一条消息连线', msg.n === 1 && msg.from === 's1' && msg.to === 's2', msg);
    t.ok('消息高度落在吸附后的格上（160）', msg.y === 160, msg);
    t.ok('消息两端钉在两条时序线上（90 / 490）', msg.ax === 90 && msg.bx === 490, msg);
    t.ok('无冲突时消息是水平的（两端同高、无弯曲）', msg.ay === msg.y && msg.by === msg.y && msg.bow === 0, msg);
    t.ok('消息只在目标端画箭头', msg.outHidden === 'hidden' && msg.inHidden !== 'hidden', msg);
    t.ok('消息以常规连线路径渲染（可选中/编辑）', msg.visPath === true, msg);
    t.ok('消息只在源端生成连接点（公留母去），目标端交给箭头',
      msg.pins === 1 && msg.pinXs.length === 1 && msg.pinXs[0] === 90 && msg.innerR === '4', msg);
    t.ok('源端连接点落在源时序线上、与消息同高',
      msg.pinXs.indexOf(90) >= 0 && msg.pinYs[0] === msg.y, msg);
    t.ok('连接点尺寸与节点图 socket 一致（外径 16）', msg.pinR === 7 && msg.pinStroke === '#3b82f6', msg);

    // ══ 10) 不变量：缩短时序线不得短于其承载的消息 ══
    await dragMouse(page, await worldToScreen(page, 90, 380), await worldToScreen(page, 90, 100));
    const clamped = await page.evaluate(() => {
      const n = App.canvasState.nodes.find(x => x.id === 's1');
      const conn = App.canvasState.connections[0];
      return { life: n.life, min: App._seqLifeMin(n), connY: conn.y, end: Weave.Geom.seqLifeEnd(n).y };
    });
    t.ok('缩短时序线时钳制在"不得短于最远消息"（100）', clamped.life === 100 && clamped.life === clamped.min, clamped);
    t.ok('消息仍落在时序线范围内', clamped.end >= clamped.connY, clamped);

    // ══ 11) 时序线跟随节点移动 ══
    await page.evaluate(() => {
      const n = App._getNodeById('s2');
      n.x += 200;
      App.saveCanvasSnapshot();
      App.renderCanvas({ center: false });
    });
    await sleep(250);
    const followed = await page.evaluate(() => {
      const n = App._getNodeById('s2');
      const conn = App.canvasState.connections[0];
      const g = App._getConnGeometry(conn, App._getNodeById(conn.from), n);
      return { anchorX: Weave.Geom.seqLifeAnchor(n).x, msgX: g.toIn.x, y: g.toIn.y, connY: conn.y };
    });
    t.ok('节点移动后时序线跟随（锚点移动）', followed.anchorX === 690, followed);
    t.ok('消息端点跟随目标时序线且高度不变', followed.msgX === 690 && followed.y === followed.connY, followed);

    // ══ 12) 刷新后时序线长度与消息高度都持久化 ══
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction('!!window.App && !!document.getElementById("canvasStage")', { timeout: 25000 });
    await sleep(600);
    await page.keyboard.press('Escape');
    await sleep(200);
    const after = await page.evaluate(() => {
      const n = App._getNodeById('s1');
      const conn = App.canvasState.connections[0];
      return {
        mode: App._mode,
        nodes: App.canvasState.nodes.length,
        life: n ? n.life : null,
        y: conn ? conn.y : null,
        from: conn ? conn.from : null,
        seqClass: document.getElementById('canvasStage').classList.contains('seq-mode'),
        regionHidden: document.getElementById('btnRegion').classList.contains('mode-hidden')
      };
    });
    t.ok('刷新后回到上次使用的模式', after.mode === 'sequence', after);
    t.ok('刷新后画布仍带 seq-mode 类（骨架重建后补上）', after.seqClass === true, after);
    t.ok('刷新后分区入口照常显示', after.regionHidden === false, after);
    const sockAfter = await page.evaluate(() => {
      const el = App._nodeElMap.get('s1');
      const nr = el.getBoundingClientRect();
      const or = el._sckOut.getBoundingClientRect();
      return {
        inDisplay: getComputedStyle(el._sckIn).display,
        dx: (or.left + or.width / 2) - (nr.left + nr.width / 2),
        dy: (or.top + or.height / 2) - nr.bottom
      };
    });
    t.ok('刷新后仍隐藏输入连接点', sockAfter.inDisplay === 'none', sockAfter);
    t.ok('刷新后连接点仍在底边中点', Math.abs(sockAfter.dx) < 1.5 && Math.abs(sockAfter.dy) < 1.5, sockAfter);
    t.ok('刷新后时序线长度保留（100）', after.life === 100, after);
    t.ok('刷新后消息高度保留（160）', after.y === 160 && after.from === 's1', after);
    t.ok('刷新后时序图节点数正确（3）', after.nodes === 3, after);
    const other = await page.evaluate(() => ({
      nodes: App._modeStore.graph.state.nodes.length,
      conns: App._modeStore.graph.state.connections.length,
      life: App._modeStore.graph.state.nodes[0].life
    }));
    t.ok('刷新后节点图文档也已装好（2 节点 1 连线）', other.nodes === 2 && other.conns === 1, other);
    t.ok('节点图文档的节点不带时序线字段', other.life === undefined, other);

    // ══ 13) 存档：直接写出可读的画面几何 ══
    const exp = await page.evaluate(() => {
      const d = App._serializeData();
      const n = App.canvasState.nodes[0];
      const c = App.canvasState.connections[0];
      const anchor = Weave.Geom.seqLifeAnchor(n);
      return {
        format: d.format, mode: d.mode,
        unit: d.unit, gridPx: d.gridPx,
        viewportUnit: d.viewport ? d.viewport.unit : null,
        messageStyle: d.messageStyle,
        time: d.time,
        node: d.nodes[0], conn: d.connections[0],
        px: { life: n.life, y: c.y, axisX: anchor.x, top: anchor.y,
              originY: Math.min.apply(null, App.canvasState.nodes.map(nn => Weave.Geom.seqLifeAnchor(nn).y)) },
        hasLife: 'life' in d.nodes[0],
        hasY: 'y' in d.connections[0],
        hasVersion: 'version' in d,
        hasMirror: 'mirrored' in d.nodes[0] || 'mirrored' in d.connections[0],
        hasRegions: 'regions' in d,
        hasDesc: 'desc' in d.nodes[0]
      };
    });
    t.ok('时序图存档声明自己的格式', exp.format === 'weave-sequence', exp);
    //功能首发即此唯一形态：不设 version，也没有旧档兼容可写。
    t.ok('存档不带 version 键（不存在多版本，不做旧档兼容）', !exp.hasVersion, exp);
    t.ok('存档带文档类型 mode=sequence（恢复页据此选存档键）', exp.mode === 'sequence', exp);
    t.ok('存档声明单位与换算（grid / 20px）', exp.unit === 'grid' && exp.gridPx === 20, exp);
    t.ok('视口块单独声明屏幕像素（不与几何的格混用）', exp.viewportUnit === 'px', exp);
    t.ok('缺省取色规则写进 messageStyle',
      !!exp.messageStyle && exp.messageStyle.colorSource === 'fixed' && exp.messageStyle.color === 'blue', exp.messageStyle);
    t.ok('时序线写出绝对几何 lifeline{x,y,length}（列、起点、长度定死一条线）',
      !!exp.node.lifeline
      && exp.node.lifeline.x === exp.px.axisX / 20
      && exp.node.lifeline.y === exp.px.top / 20
      && exp.node.lifeline.length === exp.px.life / 20, exp.node.lifeline);
    t.ok('时间轴以最顶部时序线起点为原点（originY/start/step，不拿画布顶端当起点）',
      !!exp.time && exp.time.originY === exp.px.originY / 20 && exp.time.start === 1 && exp.time.step === 1, exp.time);
    t.ok('消息写出时间步 t（以最顶部时序线起点为 t=1）与线型枚举',
      exp.conn.t === 1 + (exp.px.y - exp.px.originY) / 20 && exp.conn.line === 'solid', exp.conn);
    t.ok('相对长度 life 与旧字段 y/mirrored 不出现在存档里',
      !exp.hasLife && !exp.hasY && !exp.hasMirror, exp);
    t.ok('空描述与空分区不占用行', !exp.hasDesc && !exp.hasRegions, exp);

    // 导出 → 导入 → 再导出：存档必须能无损往返（几何与可读字段都不漂移）。
    const rt = await page.evaluate(() => {
      const d = App._serializeData();
      const before = { life: App.canvasState.nodes[0].life, y: App.canvasState.connections[0].y };
      App._loadFromData(JSON.parse(JSON.stringify(d)));
      const after = { life: App._getNodeById(d.nodes[0].id).life, y: App.canvasState.connections[0].y };
      return { before: before, after: after, same: JSON.stringify(App._serializeData()) === JSON.stringify(d) };
    });
    t.ok('存档导入后长度/高度原样还原',
      rt.after.life === rt.before.life && rt.after.y === rt.before.y, rt);
    t.ok('存档导出→导入→导出逐字一致（无信息丢失）', rt.same === true, rt);

    // ══ 13b) 时间轴只认纵向：整份图下移，t 不变、originY 平移 ══
    const shift = await page.evaluate(() => {
      const d0 = App._serializeData();
      const snap = () => ({ originY: App._serializeData().time.originY, t: App._serializeData().connections[0].t });
      const before = snap();
      //整份时序图下移 100px（5 格）：节点、时序线起点、消息高度一起动。
      App.canvasState.nodes.forEach(n => { n.y += 100; });
      App.canvasState.connections.forEach(c => { c.y += 100; });
      App._connOffsCache = null;
      App.saveCanvasSnapshot();
      App.renderCanvas({ center: false });
      const moved = snap();
      //移回原位，验证时间轴可逆。
      App.canvasState.nodes.forEach(n => { n.y -= 100; });
      App.canvasState.connections.forEach(c => { c.y -= 100; });
      App._connOffsCache = null;
      App.saveCanvasSnapshot();
      App.renderCanvas({ center: false });
      return { before: before, moved: moved, back: snap(), d0t: d0.connections[0].t };
    });
    t.ok('整份图下移 5 格后 originY 随之平移（时间原点跟着最顶部时序线走）',
      shift.moved.originY === shift.before.originY + 5, shift);
    t.ok('整份图下移后消息时间步不变（t 与画布摆多高无关）',
      shift.moved.t === shift.before.t && shift.before.t === shift.d0t, shift);
    t.ok('移回原位后时间轴与 t 原样还原',
      shift.back.originY === shift.before.originY && shift.back.t === shift.before.t, shift);

    // ══ 14) 导入按文件自带的类型落位 ══
    const routed = await page.evaluate(() => {
      App._loadFromData({
        mode: 'graph',
        nodes: [{ id: 'i1', label: 'i1', desc: '', color: 'blue', x: 0, y: 0, w: 180, h: 80, mirrored: false }],
        connections: [], regions: []
      });
      const a = { mode: App._mode, ids: App.canvasState.nodes.map(n => n.id) };
      // 时序图存档：可读格式（format + time + lifeline + t）。坐标按存档约定
      // 写“格”（1 格 = 20px），不是像素；空 desc 之类的省略项直接不写。
      App._loadFromData({
        format: 'weave-sequence', mode: 'sequence', unit: 'grid', gridPx: 20,
        time: { originY: 4, step: 1, start: 1 },
        nodes: [
          { id: 'q1', label: 'q1', color: 'blue', x: 0, y: 0, w: 9, h: 4, lifeline: { x: 4.5, y: 4, length: 12 } },
          { id: 'q2', label: 'q2', color: 'green', x: 20, y: 0, w: 9, h: 4, lifeline: { x: 24.5, y: 4, length: 12 } }
        ],
        connections: [{ id: 'qc1', from: 'q1', to: 'q2', label: '消息', t: 5, line: 'dashed' }]
      });
      const c = App.canvasState.connections[0];
      const b = {
        mode: App._mode, ids: App.canvasState.nodes.map(n => n.id), life: App.canvasState.nodes[0].life,
        y: c ? c.y : null, dashed: !!(c && c.dashed), label: c ? c.label : null
      };
      return { a: a, b: b };
    });
    t.ok('导入节点图文件自动切回节点图模式', routed.a.mode === 'graph' && routed.a.ids[0] === 'i1', routed.a);
    t.ok('导入时序图文件自动切到时序图模式', routed.b.mode === 'sequence' && routed.b.ids[0] === 'q1', routed.b);
    t.ok('时序存档的 lifeline.length 按格还原（12 格 = 240px）', routed.b.life === 240, routed.b);
    t.ok('时序存档的 time+t 还原消息高度（t=5 → 原点下 4 格 = 160px）、线型与标签',
      routed.b.y === 160 && routed.b.dashed === true && routed.b.label === '消息', routed.b);

    // ══ 15) PNG 导出覆盖时序线 ══
    const png = await page.evaluate(() => {
      const n = App.canvasState.nodes[0];
      const b = App._computeContentBounds(true);
      const sn = App._buildExportSnapshot();
      const svg = sn.querySelector('#seqSvg');
      const pins = sn.querySelector('#seqPinsSvg');
      //末端把手是拖拽着力点：编辑态导出它，只读态屏上没有它，导出同样不画。
      const wasReadOnly = App.readOnly;
      App.readOnly = true;
      const roSnap = App._buildExportSnapshot();
      App.readOnly = wasReadOnly;
      const roSvg = roSnap.querySelector('#seqSvg');
      return {
        nodes: App.canvasState.nodes.length,
        coversLife: b.maxY >= Weave.Geom.seqLifeEnd(n).y,
        lines: svg ? svg.querySelectorAll('.seq-life').length : -1,
        handles: svg ? svg.querySelectorAll('.seq-life-handle').length : -1,
        readOnlyHandles: roSvg ? roSvg.querySelectorAll('.seq-life-handle').length : -1,
        pins: pins ? pins.querySelectorAll('.seq-pin').length : -1,
        liveIntact: !!document.getElementById('seqSvg') && !!document.getElementById('seqPinsSvg')
      };
    });
    t.ok('导出边界包含时序线末端', png.coversLife, png);
    t.ok('导出快照按 1:1 重建时序线与把手（编辑态）', png.lines === png.nodes && png.handles === png.nodes, png);
    t.ok('只读态导出不画拖拽把手（与只读屏面一致）', png.readOnlyHandles === 0, png);
    t.ok('导出快照不影响实时画布层', png.liveIntact === true, png);

    // ══ 16) 避让：同一高度上水平投影重叠的消息共用端点、靠中段弯曲分开 ══
    const avoid = await page.evaluate(() => {
      //页面在 §12 刷新过，页面级工厂需要重新注入。
      window.__mkNode = (id, x, y, life) => {
        const n = { id, label: id, desc: '', color: 'blue', x, y, mirrored: false, w: 180, h: 80 };
        if (life !== undefined) n.life = life;
        return n;
      };
      App.canvasState.nodes = [
        window.__mkNode('a1', 0, 0, 600), window.__mkNode('a2', 600, 0, 600),
        window.__mkNode('a3', 1200, 0, 600), window.__mkNode('a4', 1800, 0, 600)
      ];
      App.canvasState.connections = [];
      App._nodeZOrder = ['a1', 'a2', 'a3', 'a4'];
      //直接改数据后走一次 saveCanvasSnapshot：它是缓存失效（含节点 id 映射）
      //的约定入口，否则接下来的 _createSeqMessage 找不到端点节点。
      App.saveCanvasSnapshot();
      App.renderCanvas({ center: false });
      App._createSeqMessage('a1', 'a2', 200);   // 0  ┐ 同跨度、同高度
      App._createSeqMessage('a2', 'a1', 200);   // 1  │ （含反向）
      App._createSeqMessage('a1', 'a2', 200);   // 2  ┘
      App._createSeqMessage('a3', 'a4', 200);   // 3  另一对，x 跨度不相交
      App._createSeqMessage('a1', 'a2', 300);   // 4  ┐ 同一起点、一段包含另一段
      App._createSeqMessage('a1', 'a3', 300);   // 5  ┘
      const rows = App.canvasState.connections.map((c, i) => {
        const g = App._getConnGeometry(c, App._getNodeById(c.from), App._getNodeById(c.to));
        return { i: i, base: c.y, fy: g.fromOut.y, ty: g.toIn.y, c1y: g.cp.c1y, c2y: g.cp.c2y };
      });
      //端点层几何预乘 scale，换算回世界坐标后再比较。
      const pins = [...document.querySelectorAll('#seqPinsSvg .seq-pin')]
        .map(p => Math.round(+p.getAttribute('cy') / App.scale));
      return { count: App.canvasState.connections.length, rows: rows, pins: pins };
    });
    const bows = i => [avoid.rows[i].c1y, avoid.rows[i].c2y];
    const G1 = [0, 1, 2].map(i => avoid.rows[i].c1y);
    t.ok('共 6 条消息', avoid.count === 6, avoid);
    t.ok('所有消息的两端都停在各自的时间高度上（端点不因避让移位）',
      avoid.rows.every(r => r.fy === r.base && r.ty === r.base), avoid);
    t.ok('同跨度、同高度的消息（含 A→B 与 B→A）靠中段弯曲分开',
      new Set(G1).size === 3 && G1.indexOf(0) >= 0 && G1.indexOf(-14) >= 0 && G1.indexOf(14) >= 0, avoid);
    t.ok('弯曲量只作用在控制点（c1y 与 c2y 相等）',
      avoid.rows.every(r => r.c1y === r.c2y), avoid);
    t.ok('同一高度但 x 跨度不相交的另一对不受避让影响',
      bows(3)[0] === 0 && bows(3)[1] === 0, avoid);
    t.ok('同一起点、一段包含另一段的两个消息也靠弯曲分开',
      bows(4)[0] === 0 && bows(5)[0] === -14, avoid);
    t.ok('连接点只画源端：同一源时序线上的同一高度合并成一个（4 个）', avoid.pins.length === 4, avoid);
    t.ok('连接点只出现在真实的时间高度上（不含避让位移）',
      avoid.pins.every(y => y === 200 || y === 300), avoid);

    // ══ 17) 连线对齐设置：取消消息的逐格吸附 ══
    const snapSetting = await page.evaluate(() => {
      //设置弹窗里第 5 项对齐开关（与 _snapToggleDefs 同源）。
      const box = document.getElementById('setSnapConn');
      const defs = App._snapToggleDefs.map(d => d.id);
      return { exists: !!box, checked: box ? box.checked : null, defs: defs, val: App._snapConn };
    });
    t.ok('设置里新增「连线对齐」开关且默认开启',
      snapSetting.exists && snapSetting.checked === true && snapSetting.val === true, snapSetting);
    t.ok('对齐设置接线表扩到 5 项（节点/大小/分区/分区大小/连线）',
      snapSetting.defs.length === 5 && snapSetting.defs[4] === 'setSnapConn', snapSetting);

    // 关掉吸附后落点不再取整到格：拖到 207 就停在 207。
    const noSnap = await (async () => {
      await page.evaluate(SETUP_SEQ);
      await sleep(250);
      await page.evaluate(() => { App._snapConn = false; });
      await dragMouse(page, await worldToScreen(page, 90, 207), await worldToScreen(page, 690, 207), 6);
      return page.evaluate(() => {
        const c = App.canvasState.connections[App.canvasState.connections.length - 1];
        return { y: c ? c.y : null, g: App._getConnGeometry(c, App._getNodeById(c.from), App._getNodeById(c.to)) };
      });
    })();
    t.ok('关闭「连线对齐」后消息停在非整格高度（207）', noSnap.y === 207, noSnap);
    t.ok('关闭吸附后两端仍然同高（消息保持水平）',
      noSnap.g.fromOut.y === 207 && noSnap.g.toIn.y === 207 && noSnap.g.cp.c1y === 0, noSnap);

    // ══ 18) 创建消息时上下拖动决定高度 ══
    const createDrag = await (async () => {
      await page.evaluate(SETUP_SEQ);
      await sleep(250);
      const from = await worldToScreen(page, 90, 200);
      const to = await worldToScreen(page, 690, 340);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      for (let i = 1; i <= 6; i++) {
        await page.mouse.move(from.x + (to.x - from.x) * i / 6, from.y + (to.y - from.y) * i / 6);
        await sleep(20);
      }
      //松手前：临时预览的高度已随光标下移到 340（而不是停在按下的 200）。
      const during = await page.evaluate(() => App.seqMsgDragState ? App.seqMsgDragState.y : null);
      await page.mouse.up();
      await sleep(320);
      const after = await page.evaluate(() => {
        const c = App.canvasState.connections[App.canvasState.connections.length - 1];
        return { n: App.canvasState.connections.length, y: c ? c.y : null };
      });
      return { during: during, after: after };
    })();
    t.ok('创建过程中上下拖动会带动临时连线的高度', createDrag.during === 340, createDrag);
    t.ok('松手建出的消息落在拖动决定的高度（340）',
      createDrag.after.n === 2 && createDrag.after.y === 340, createDrag);

    // ══ 19) 右键连线「调整位置」：拖动消息连线，两端连接点一起动 ══
    const connMove = await (async () => {
      await page.evaluate(() => { App._snapConn = true; });
      await page.evaluate(SETUP_SEQ);
      await sleep(250);
      const mid = await worldToScreen(page, 300, 200);
      await page.mouse.click(mid.x, mid.y, { button: 'right' });
      await sleep(200);
      const menu = await page.evaluate(() => ({
        move: getComputedStyle(document.getElementById('ctxSeqMove')).display,
        dash: getComputedStyle(document.getElementById('ctxSeqDash')).display,
        dashText: document.getElementById('ctxSeqDash').textContent,
        curve: getComputedStyle(document.getElementById('ctxCurve')).display
      }));
      await page.click('#ctxSeqMove');
      await sleep(250);
      const entered = await page.evaluate(() => ({
        kind: App._seqMoveState ? App._seqMoveState.kind : null,
        //移动模式的把手走通用样式（白底小圆角正方形），不再另画一套。
        grip: document.querySelectorAll('#seqPinsSvg .seq-drag-handle').length,
        gripSize: (function() {
          const el = document.querySelector('#seqPinsSvg .seq-drag-handle');
          return el ? +el.getAttribute('width') : null;
        })(),
        moving: document.querySelectorAll('#linesSvg .line.seq-moving').length
      }));
      //拖动到 310：拖动中连续跟随，松手后再吸附到 320。
      const p1 = await worldToScreen(page, 300, 200);
      const p2 = await worldToScreen(page, 300, 310);
      await page.mouse.move(p1.x, p1.y);
      await page.mouse.down();
      for (let i = 1; i <= 6; i++) { await page.mouse.move(p1.x, p1.y + (p2.y - p1.y) * i / 6); await sleep(20); }
      const heldY = await page.evaluate(() => App.canvasState.connections[0].y);
      await page.mouse.up();
      await sleep(320);
      const done = await page.evaluate(() => ({
        y: App.canvasState.connections[0].y,
        pins: [...document.querySelectorAll('#seqPinsSvg .seq-pin')].map(p => Math.round(+p.getAttribute('cy') / App.scale)),
        keepMode: !!App._seqMoveState
      }));
      return { menu: menu, entered: entered, heldY: heldY, done: done };
    })();
    t.ok('时序消息的右键菜单给出「调整位置」与「改为虚线」、不出现曲线项',
      connMove.menu.move === 'block' && connMove.menu.dash === 'block' &&
      connMove.menu.dashText === '改为虚线' && connMove.menu.curve === 'none', connMove);
    t.ok('进入调整位置后出现拖拽把手并高亮该连线',
      connMove.entered.kind === 'conn' && connMove.entered.grip === 1 && connMove.entered.moving === 1, connMove);
    t.ok('拖动把手与"时序线末端把手"同款（白底小圆角正方形、边长 9×scale）',
      connMove.entered.gripSize === 9, connMove.entered);
    t.ok('拖动中高度连续跟随光标（310，未取整）', connMove.heldY === 310, connMove);
    t.ok('松手后吸附到格（320）', connMove.done.y === 320, connMove);
    t.ok('移动连线时连接点一起移动到新高度（只画源端，故 1 个）',
      connMove.done.pins.length === 1 && connMove.done.pins.every(y => y === 320), connMove.done);
    t.ok('移动模式保持开启，可继续微调', connMove.done.keepMode === true, connMove.done);

    // ══ 20) 右键连接点「调整位置」：拖动连接点带动该点所有消息与另一端 ══
    const pinMove = await (async () => {
      await page.evaluate(() => {
        App._setMode('sequence');
        const mk = (id, label, x) => ({ id, label, desc: '', color: 'blue', x, y: 0, mirrored: false, w: 180, h: 80, life: 500 });
        App.canvasState.nodes = [mk('p1', 'A', 0), mk('p2', 'B', 600), mk('p3', 'C', 1200)];
        App.canvasState.connections = [];
        App.canvasState.regions = [];
        App._nodeZOrder = ['p1', 'p2', 'p3'];
        App.selectedNodeIds.clear();
        App.scale = 0.7; App.panX = 60; App.panY = 40;
        App.saveCanvasSnapshot(); App.renderCanvas({ center: false }); App.applyViewTransform();
        //p1 的连接点上挂两条消息（同一高度＝共用一个连接点），加上一条反向的。
        App._createSeqMessage('p1', 'p2', 200);
        App._createSeqMessage('p1', 'p3', 200);
        App._createSeqMessage('p2', 'p1', 200);
        App.canvasState.connections.forEach(c => { c.y = 200; });
        App._connOffsCache = null;
        App.saveCanvasSnapshot(); App.renderCanvas({ center: false }); App.applyViewTransform();
      });
      await sleep(300);
      //统计 p1 连接点上的消息数（应为 3：p1→p2、p1→p3、p2→p1 都停在 p1@200）。
      const before = await page.evaluate(() => ({
        atPin: App._seqPinConns('p1', 200).length,
        ys: App.canvasState.connections.map(c => c.y),
        pins: document.querySelectorAll('#seqPinsSvg .seq-pin').length
      }));
      const pin = await worldToScreen(page, 90, 200);
      await page.mouse.click(pin.x, pin.y, { button: 'right' });
      await sleep(200);
      const menu = await page.evaluate(() => ({
        move: getComputedStyle(document.getElementById('ctxSeqMove')).display,
        dash: getComputedStyle(document.getElementById('ctxSeqDash')).display,
        edit: getComputedStyle(document.getElementById('ctxEdit')).display,
        onCtx: App._ctxPin ? App._ctxPin.nodeId + '@' + App._ctxPin.y : null
      }));
      await page.click('#ctxSeqMove');
      await sleep(250);
      const entered = await page.evaluate(() => ({
        kind: App._seqMoveState ? App._seqMoveState.kind : null,
        ring: document.querySelectorAll('#seqPinsSvg .seq-pin-ring').length
      }));
      //把连接点从 200 拖到 320。
      const q1 = await worldToScreen(page, 90, 200);
      const q2 = await worldToScreen(page, 90, 320);
      await page.mouse.move(q1.x, q1.y);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) { await page.mouse.move(q1.x, q1.y + (q2.y - q1.y) * i / 8); await sleep(20); }
      await page.mouse.up();
      await sleep(340);
      const after = await page.evaluate(() => ({
        ys: App.canvasState.connections.map(c => c.y),
        atOld: App._seqPinConns('p1', 200).length,
        atNew: App._seqPinConns('p1', 320).length,
        //另一端（p2、p3）的连接点也应出现在 320。
        atP2: App._seqPinConns('p2', 320).length,
        atP3: App._seqPinConns('p3', 320).length
      }));
      return { before: before, menu: menu, entered: entered, after: after };
    })();
    t.ok('p1 的连接点上挂着 3 条消息（含反向）', pinMove.before.atPin === 3, pinMove.before);
    t.ok('右键连接点只给出「调整位置」（无编辑/线型）',
      pinMove.menu.move === 'block' && pinMove.menu.dash === 'none' &&
      pinMove.menu.edit === 'none' && pinMove.menu.onCtx === 'p1@200', pinMove.menu);
    t.ok('进入后连接点画出高亮圈', pinMove.entered.kind === 'pin' && pinMove.entered.ring === 1, pinMove.entered);
    t.ok('拖动连接点带动该点上所有消息（3 条一起移到 320）',
      pinMove.after.atNew === 3 && pinMove.after.ys.every(y => y === 320), pinMove.after);
    t.ok('另一端（输入/输出）连接点也一起移动',
      pinMove.after.atP2 === 2 && pinMove.after.atP3 === 1, pinMove.after);
    t.ok('旧连接点随之消失', pinMove.after.atOld === 0, pinMove.after);

    // ══ 20b) 多选多根连线：右键「调整位置」后整组一起拖动 ══
    const multiMove = await (async () => {
      await page.evaluate(() => {
        const mk = (id, x) => ({ id, label: id, desc: '', color: 'blue', x, y: 0, mirrored: false, w: 180, h: 80, life: 520 });
        App._setMode('sequence');
        App.canvasState.nodes = [mk('m1', 0), mk('m2', 600)];
        App.canvasState.connections = [];
        App.canvasState.regions = [];
        App._nodeZOrder = ['m1', 'm2'];
        App.selectedNodeIds.clear();
        App._seqMoveState = null;
        App.scale = 1; App.panX = 200; App.panY = 60;
        App.saveCanvasSnapshot(); App.renderCanvas({ center: false }); App.applyViewTransform();
        App._createSeqMessage('m1', 'm2', 160);
        App._createSeqMessage('m1', 'm2', 240);
        App._createSeqMessage('m1', 'm2', 320);
        App.canvasState.connections.forEach((c, i) => { c.y = [160, 240, 320][i]; });
        App._connOffsCache = null;
        //多选三根（Ctrl+单击的等价程序化路径）。
        App.selectedConnIds.clear();
        App.canvasState.connections.forEach(c => App.selectedConnIds.add(c.id));
        App.saveCanvasSnapshot(); App.renderCanvas({ center: false }); App.applyViewTransform();
      });
      await sleep(300);
      const before = await page.evaluate(() => ({
        ys: App.canvasState.connections.map(c => c.y),
        sel: App.selectedConnIds.size
      }));
      //右键中间那根（属选区内的非首条）。
      const mid = await worldToScreen(page, 300, 240);
      await page.mouse.click(mid.x, mid.y, { button: 'right' });
      await sleep(200);
      await page.click('#ctxSeqMove');
      await sleep(250);
      const entered = await page.evaluate(() => ({
        ids: App._seqMoveState && App._seqMoveState.ids ? App._seqMoveState.ids.length : 0,
        moving: document.querySelectorAll('#linesSvg .line.seq-moving').length,
        grips: document.querySelectorAll('#seqPinsSvg .seq-drag-handle').length
      }));
      //从中间那根上按下，整组上移 60。
      const p1 = await worldToScreen(page, 300, 240);
      await page.mouse.move(p1.x, p1.y);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) { await page.mouse.move(p1.x, p1.y - 60 * i / 8); await sleep(20); }
      await page.mouse.up();
      await sleep(340);
      const after = await page.evaluate(() => App.canvasState.connections.map(c => c.y));
      return { before: before, entered: entered, after: after };
    })();
    t.ok('三根消息都被选中', multiMove.before.sel === 3, multiMove.before);
    t.ok('右键选区内的一根进入调整位置时整组参与（3 条高亮 + 3 个把手）',
      multiMove.entered.ids === 3 && multiMove.entered.moving === 3 && multiMove.entered.grips === 3,
      multiMove.entered);
    t.ok('一次拖动移动整组三根，相对高度差保持不变',
      multiMove.after[0] === 100 && multiMove.after[1] === 180 && multiMove.after[2] === 260,
      { before: multiMove.before.ys, after: multiMove.after });

    // ══ 21) 平滑动画：拖动连续跟随、松手是过程而非瞬移 ══
    const smooth = await (async () => {
      await page.evaluate(SETUP_SEQ);
      await sleep(250);
      //消息连线要先经右键「调整位置」进入移动模式才可拖动。
      await page.evaluate(() => { App._enterSeqConnMove(App.canvasState.connections[0].id); });
      await sleep(150);
      //页面内用 rAF 采样：覆盖松手前后各一段时间。
      const sampler = page.evaluate(() => new Promise(res => {
        const out = [];
        const t0 = performance.now();
        (function tick() {
          out.push(Math.round(App.canvasState.connections[0].y * 100) / 100);
          if (performance.now() - t0 < 700) requestAnimationFrame(tick);
          else res(out);
        })();
      }));
      await sleep(120);
      //拖动消息到 310（非整格），松手 → 应经过 310→320 的动画而非直接跳。
      const p1 = await worldToScreen(page, 300, 200);
      const p2 = await worldToScreen(page, 300, 310);
      await page.mouse.move(p1.x, p1.y);
      await page.mouse.down();
      for (let i = 1; i <= 6; i++) { await page.mouse.move(p1.x, p1.y + (p2.y - p1.y) * i / 6); await sleep(20); }
      await page.mouse.up();
      const samples = await sampler;
      const uniq = [...new Set(samples)];
      const between = samples.filter(v => v > 310 && v < 320);
      return { uniq: uniq.length, between: between.length, first: samples[0], last: samples[samples.length - 1] };
    })();
    t.ok('消息高度在拖动中连续变化（采到多个不同值）', smooth.uniq >= 4, smooth);
    t.ok('松手后是 310→320 的过程动画而非瞬移',
      smooth.between >= 2 && smooth.last === 320, smooth);

    const lifeSmooth = await (async () => {
      const sampler = page.evaluate(() => new Promise(res => {
        const out = [];
        const t0 = performance.now();
        (function tick() {
          const n = App.canvasState.nodes.find(x => x.id === 's1');
          out.push(Math.round(n.life * 100) / 100);
          if (performance.now() - t0 < 700) requestAnimationFrame(tick);
          else res(out);
        })();
      }));
      await sleep(120);
      //时序线把手：从 400 拖到 313，松手后应经过 313→320 的动画。
      const h1 = await worldToScreen(page, 90, 480);
      const h2 = await worldToScreen(page, 90, 393);
      await page.mouse.move(h1.x, h1.y);
      await page.mouse.down();
      for (let i = 1; i <= 6; i++) { await page.mouse.move(h1.x, h1.y + (h2.y - h1.y) * i / 6); await sleep(20); }
      await page.mouse.up();
      const samples = await sampler;
      const between = samples.filter(v => v > 313 && v < 320);
      return { between: between.length, last: samples[samples.length - 1], mid: between.length ? between[0] : null };
    })();
    t.ok('时序线长度拖动中连续跟随、松手后有吸附过程',
      lifeSmooth.between >= 2 && lifeSmooth.last === 320, lifeSmooth);

    // ══ 22) 把手与连接点：不做任何悬停变色/半透明（那个效果从来不该出现）══
    const trans = await page.evaluate(() => {
      const hovers = [];
      for (const sh of Array.from(document.styleSheets)) {
        let rules;
        try { rules = sh.cssRules; } catch (e) { continue; }
        for (const r of Array.from(rules)) {
          const sel = r.selectorText || '';
          if (/:hover/.test(sel) && /seq-drag-handle|seq-pin/.test(sel)) hovers.push(sel);
        }
      }
      const handle = document.querySelector('#seqSvg .seq-life-handle');
      const pin = document.querySelector('#seqPinsSvg .seq-pin');
      return {
        handleExists: !!handle,
        pinExists: !!pin,
        hoverRules: hovers,
        handleDur: handle ? getComputedStyle(handle).transitionDuration : null,
        pinDur: pin ? getComputedStyle(pin).transitionDuration : null,
        handleFill: handle ? getComputedStyle(handle).fill : null,
        pinFill: pin ? getComputedStyle(pin).fill : null
      };
    });
    t.ok('时序线把手与消息连接点都存在', trans.handleExists && trans.pinExists, trans);
    t.ok('两者都没有任何 :hover 规则（悬停半透明不该存在）',
      trans.hoverRules.length === 0, trans);
    t.ok('两者都没有过渡（不存在需要过渡的状态变化）',
      trans.handleDur === '0s' && trans.pinDur === '0s', trans);
    t.ok('两者始终是实心白底',
      trans.handleFill === 'rgb(255, 255, 255)' && trans.pinFill === 'rgb(255, 255, 255)', trans);

    // ══ 22b) 设置界面两套：常规页按模式只显示相关项（值共用一份）══
    const settingsPanels = await (async () => {
      const read = () => page.evaluate(() => {
        const rows = [...document.querySelectorAll('#settingsModal .setting-row[data-modes]')];
        const vis = rows.filter(r => getComputedStyle(r).display !== 'none')
          .map(r => { const i = r.querySelector('input'); return i ? i.id : null; });
        return { vis: vis, scope: document.getElementById('settingsScope').textContent };
      });
      await page.evaluate(() => { App._setMode('graph'); });
      await page.evaluate(() => { App.showSettings(); });
      await sleep(200);
      const graph = await read();
      //弹窗开着时切模式，界面应立刻跟着换。
      await page.evaluate(() => { App._setMode('sequence'); App._applyModeChrome(); });
      await sleep(200);
      const seqOpen = await read();
      await page.evaluate(() => { App.closeSettings(); App._setMode('graph'); });
      await sleep(150);
      await page.evaluate(() => { App.showSettings(); });
      await sleep(150);
      const graphAgain = await read();
      //值共用：节点图关掉「节点大小对齐」，时序图看到的是同一个值。
      await page.evaluate(() => { App._setMode('sequence'); App._snapSize = false; App._applyModeChrome(); });
      await sleep(150);
      const shared = await page.evaluate(() => {
        const r = {
          mode: App._mode, val: App._snapSize,
          checked: document.getElementById('setSnapSize').checked
        };
        //还原：值与弹窗都不该留给后续用例。
        App._snapSize = true;
        document.getElementById('setSnapSize').checked = true;
        App.closeSettings();
        return r;
      });
      return { graph: graph, seqOpen: seqOpen, graphAgain: graphAgain, shared: shared };
    })();
    t.ok('节点图设置界面只出现节点图相关项（含两个分区项、不含连线项）',
      settingsPanels.graph.vis.indexOf('setSnapNodes') >= 0 &&
      settingsPanels.graph.vis.indexOf('setSnapSize') >= 0 &&
      settingsPanels.graph.vis.indexOf('setSnapRegionPos') >= 0 &&
      settingsPanels.graph.vis.indexOf('setSnapRegionSize') >= 0 &&
      settingsPanels.graph.vis.indexOf('setSnapConn') < 0, settingsPanels.graph);
    t.ok('时序图设置界面只出现时序图相关项（含连线项与跟随开关、不含两个分区项）',
      settingsPanels.seqOpen.vis.indexOf('setSnapConn') >= 0 &&
      settingsPanels.seqOpen.vis.indexOf('setSeqMsgFollow') >= 0 &&
      settingsPanels.seqOpen.vis.indexOf('setSnapRegionPos') < 0 &&
      settingsPanels.seqOpen.vis.indexOf('setSnapRegionSize') < 0 &&
      settingsPanels.seqOpen.vis.indexOf('setSnapNodes') >= 0, settingsPanels.seqOpen);
    t.ok('节点图那套里不出现时序图专属的跟随开关',
      settingsPanels.graph.vis.indexOf('setSeqMsgFollow') < 0, settingsPanels.graph);
    t.ok('弹窗开着时切模式，界面立刻换到另一套',
      settingsPanels.seqOpen.scope !== settingsPanels.graph.scope, settingsPanels.seqOpen);
    t.ok('标题只写是哪一套，不做陈述说明',
      settingsPanels.graph.scope === '节点图设置' && settingsPanels.seqOpen.scope === '时序图设置',
      { graph: settingsPanels.graph.scope, seq: settingsPanels.seqOpen.scope });
    t.ok('切回节点图后界面恢复节点图那套',
      settingsPanels.graphAgain.vis.indexOf('setSnapConn') < 0 &&
      settingsPanels.graphAgain.vis.indexOf('setSnapRegionPos') >= 0, settingsPanels.graphAgain);
    t.ok('两套界面共用同一份值（隔离只在界面层）',
      settingsPanels.shared.mode === 'sequence' && settingsPanels.shared.val === false &&
      settingsPanels.shared.checked === false, settingsPanels.shared);

    // ══ 23) 虚线线型：右键切换 + 渲染 + 存档往返 ══
    const dashed = await (async () => {
      await page.evaluate(SETUP_SEQ);
      await sleep(250);
      const mid = await worldToScreen(page, 300, 200);
      await page.mouse.click(mid.x, mid.y, { button: 'right' });
      await sleep(180);
      await page.click('#ctxSeqDash');
      await sleep(220);
      const on = await page.evaluate(() => {
        const el = document.querySelector('#linesSvg .line');
        return {
          flag: !!App.canvasState.connections[0].dashed,
          dash: el.getAttribute('stroke-dasharray'),
          //箭头不受线型影响
          arrowDash: document.querySelector('#linesSvg .conn-arrow').getAttribute('stroke-dasharray')
        };
      });
      //再右键一次应给出反向文案「改为实线」，点回去。
      await page.mouse.click(mid.x, mid.y, { button: 'right' });
      await sleep(180);
      const backText = await page.evaluate(() => document.getElementById('ctxSeqDash').textContent);
      await page.click('#ctxSeqDash');
      await sleep(220);
      const off = await page.evaluate(() => {
        const el = document.querySelector('#linesSvg .line');
        return { flag: !!App.canvasState.connections[0].dashed, dash: el.getAttribute('stroke-dasharray') };
      });
      //存档往返：虚线标记要能导出与导入（line 枚举，导入后回到 dashed 布尔）。
      const round = await page.evaluate(() => {
        App.canvasState.connections[0].dashed = true;
        const d = App._serializeData();
        const back = App._prepareSerializedData(d);
        return { out: d.connections[0].line, back: back.candidate.connections[0].dashed };
      });
      return { on: on, backText: backText, off: off, round: round };
    })();
    t.ok('右键「改为虚线」把连线改成虚线并写入虚线间隔',
      dashed.on.flag === true && dashed.on.dash === '7 5', dashed.on);
    t.ok('虚线只作用于线本身，箭头仍为实心',
      dashed.on.arrowDash === null, dashed.on);
    t.ok('已是虚线时菜单给出反向文案「改为实线」', dashed.backText === '改为实线', dashed);
    t.ok('再点一次改回实线并清掉虚线间隔',
      dashed.off.flag === false && dashed.off.dash === null, dashed.off);
    t.ok('虚线线型可导出（line=dashed）并原样导入',
      dashed.round.out === 'dashed' && dashed.round.back === true, dashed.round);

    // ══ 24) 消息脱离时序线 → 移除（高度是绝对时间坐标，不随节点移动）══
    const detached = await (async () => {
      // (a) 高度对齐把节点挪到消息之下：时序线撑不住，消息应被移除。
      await page.evaluate(SETUP_SEQ);
      await sleep(250);
      const before = await page.evaluate(() => ({
        n: App.canvasState.connections.length,
        y: App.canvasState.connections[0].y,
        bottoms: App.canvasState.nodes.map(n => n.y + n.h),
        life: App.canvasState.nodes[0].life
      }));
      const aligned = await page.evaluate(() => {
        const ids = App.canvasState.nodes.map(n => n.id);
        const r = App._applyAlignToHeight(ids, 400);
        return { r: r, n: App.canvasState.connections.length };
      });
      // (b) 真实拖动把节点拖到消息之下：松手后同样移除。
      await page.evaluate(SETUP_SEQ);
      await sleep(250);
      const p1 = await worldToScreen(page, 90, 40);
      await page.mouse.move(p1.x, p1.y);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) { await page.mouse.move(p1.x, p1.y + 22 * i); await sleep(16); }
      await page.mouse.up();
      await sleep(500);
      const dragged = await page.evaluate(() => ({
        n: App.canvasState.connections.length,
        bottom: App.canvasState.nodes[0].y + App.canvasState.nodes[0].h
      }));
      // (b2) 反向的真实拖动：把节点往上拖，消息越过线尾 → 松手后同样移除，
      //      拖动途中不把时序线拉长（这正是之前漏掉的一侧）。
      //      先把时序线收短到 200，才能在屏幕内拖出越界。
      await page.evaluate(SETUP_SEQ);
      await sleep(250);
      await page.evaluate(() => {
        App.canvasState.nodes.forEach(n => { n.life = 200; });
        App.saveCanvasSnapshot();
        App.renderCanvas({ center: false });
        App.renderLines();
      });
      await sleep(250);
      const q1 = await worldToScreen(page, 90, 40);
      await page.mouse.move(q1.x, q1.y);
      await page.mouse.down();
      const duringDrag = { life: 0, conns: 0 };
      for (let i = 1; i <= 8; i++) {
        await page.mouse.move(q1.x, q1.y - 24 * i);
        await sleep(16);
      }
      Object.assign(duringDrag, await page.evaluate(() => ({
        life: App.canvasState.nodes[0].life,
        conns: App.canvasState.connections.length
      })));
      await page.mouse.up();
      await sleep(500);
      const draggedUp = await page.evaluate(() => ({
        n: App.canvasState.connections.length,
        life: App.canvasState.nodes[0].life,
        top: App.canvasState.nodes[0].y
      }));
      draggedUp.duringDrag = duringDrag;
      // (c) 反向、不跟随（默认）：节点上移使消息越过线尾 → 同样移除，
      //     而不是"把时序线拉长"把它救回来。
      await page.evaluate(SETUP_SEQ);
      await sleep(250);
      const tailRemoved = await page.evaluate(() => {
        const beforeLife = App.canvasState.nodes[0].life;
        App.canvasState.nodes.forEach(n => { n.y -= 300; });
        App._connOffsCache = null;
        const r = App._repairSeqMessages(true, false);
        return {
          r: r, beforeLife: beforeLife, life: App.canvasState.nodes[0].life,
          conns: App.canvasState.connections.length
        };
      });
      // (d) 反向、跟随：不丢消息，改为延长时序线接住它。
      await page.evaluate(SETUP_SEQ);
      await sleep(250);
      const tailFollowed = await page.evaluate(() => {
        App._seqMsgFollow = true;
        const beforeLife = App.canvasState.nodes[0].life;
        App.canvasState.nodes.forEach(n => { n.y -= 300; });
        App._connOffsCache = null;
        const r = App._repairSeqMessages(true, false);
        const n = App.canvasState.nodes[0];
        const out = {
          r: r, beforeLife: beforeLife, life: n.life,
          conns: App.canvasState.connections.length,
          end: Weave.Geom.seqLifeEnd(n).y,
          y: App.canvasState.connections[0] ? App.canvasState.connections[0].y : null
        };
        App._seqMsgFollow = false;
        return out;
      });
      return {
        before: before, aligned: aligned, dragged: dragged, draggedUp: draggedUp,
        tailRemoved: tailRemoved, tailFollowed: tailFollowed
      };
    })();
    t.ok('起始状态：消息 200 高于两端底边（80），落在时序线内',
      detached.before.n === 1 && detached.before.y === 200 &&
      detached.before.bottoms.every(b => b === 80), detached.before);
    t.ok('高度对齐把节点挪到消息之下后，该消息被移除',
      detached.aligned.r.nodes === 2 && detached.aligned.r.removed === 1 && detached.aligned.n === 0,
      detached.aligned);
    t.ok('真实拖动节点到消息之下，松手后消息同样被移除',
      detached.dragged.n === 0 && detached.dragged.bottom >= 200, detached.dragged);
    t.ok('真实往上拖（消息越过线尾）：拖动途中不拉长时序线，松手后消息被移除',
      detached.draggedUp.duringDrag.conns === 1 && detached.draggedUp.duringDrag.life === 200 &&
      detached.draggedUp.n === 0 && detached.draggedUp.life === 200, detached.draggedUp);
    t.ok('不跟随（默认）：消息越过线尾也被移除，且时序线没被顺手拉长',
      detached.tailRemoved.conns === 0 && detached.tailRemoved.r.removed === 1 &&
      detached.tailRemoved.life === detached.tailRemoved.beforeLife, detached.tailRemoved);
    t.ok('跟随：同方向越界不丢消息，改为延长时序线接住它',
      detached.tailFollowed.conns === 1 && detached.tailFollowed.r.removed === 0 &&
      detached.tailFollowed.life > detached.tailFollowed.beforeLife &&
      detached.tailFollowed.end >= detached.tailFollowed.y, detached.tailFollowed);

    // ══ 25) 设置项「消息跟随节点」：承载不下时移除 还是 挪回线上 ══
    const followOn = await (async () => {
      const setting = await page.evaluate(() => {
        const box = document.getElementById('setSeqMsgFollow');
        const row = box ? box.closest('.setting-row') : null;
        return {
          exists: !!box, checked: box ? box.checked : null, val: App._seqMsgFollow,
          modes: row ? row.getAttribute('data-modes') : null
        };
      });
      await page.evaluate(SETUP_SEQ);
      await sleep(250);
      await page.evaluate(() => { App._seqMsgFollow = true; });
      const res = await page.evaluate(() => {
        const r = App._applyAlignToHeight(App.canvasState.nodes.map(n => n.id), 400);
        const c = App.canvasState.connections[0];
        const n = App.canvasState.nodes[0];
        return { r: r, n: App.canvasState.connections.length, y: c ? c.y : null, bottom: n.y + n.h };
      });
      await page.evaluate(() => { App._seqMsgFollow = false; App._applyModeChrome(); });
      return { setting: setting, res: res };
    })();
    t.ok('设置里有「消息跟随节点」开关，默认关闭且属时序图那套界面',
      followOn.setting.exists && followOn.setting.checked === false &&
      followOn.setting.val === false && followOn.setting.modes === 'sequence', followOn.setting);
    t.ok('开启后消息不消失（一条都没被移除）',
      followOn.res.n === 1 && followOn.res.r.removed === 0, followOn.res);
    t.ok('消息被挪回时序线上，落在节点底边处',
      followOn.res.y === followOn.res.bottom, followOn.res);

    // ══ 26) 颜色：连线 / 时序线 / 节点各自可改，且节点色驱动其连接点 ══
    const colors = await (async () => {
      const norm = s => String(s || '').replace(/\s+/g, '');
      const want = await page.evaluate(() => {
        const rgb = h => {
          const v = parseInt(h.slice(1), 16);
          return 'rgb(' + ((v >> 16) & 255) + ',' + ((v >> 8) & 255) + ',' + (v & 255) + ')';
        };
        return {
          yellow: rgb(App._resolveColor('yellow').hex),
          green: rgb(App._resolveColor('green').hex),
          orange: rgb(App._resolveColor('orange').hex),
          blue: rgb(App._resolveColor('blue').hex),
          //连接点把颜色写在 SVG 属性上（原样保留十六进制），时序线是 CSS
          //描边（计算值被规范成 rgb），因此两种写法都要备着。
          greenHex: App._resolveColor('green').hex,
          blueHex: App._resolveColor('blue').hex
        };
      });
      await page.evaluate(SETUP_SEQ);
      await sleep(250);
      const pick = c => page.evaluate(v => {
        const b = [...document.querySelectorAll('#cmColors button')].find(x => x.dataset.c === v);
        if (!b) return false;
        b.click();
        return true;
      }, c);
      const rightClick = async (wx, wy) => {
        const p = await worldToScreen(page, wx, wy);
        await page.mouse.click(p.x, p.y, { button: 'right' });
        await sleep(200);
      };
      const save = async () => {
        await page.evaluate(() => document.getElementById('btnSaveConnModal').click());
        await sleep(300);
      };
      const modal = () => page.evaluate(() => {
        const m = document.getElementById('connModal');
        return {
          open: m.classList.contains('on'),
          title: document.getElementById('cmTitle').textContent,
          labelShown: getComputedStyle(document.getElementById('cmLabelWrap')).display !== 'none',
          dots: document.querySelectorAll('#cmColors button').length,
          wheel: document.querySelectorAll('#cmColors [data-c="__wheel__"]').length
        };
      });
      const ctxMenu = () => page.evaluate(() => ({
        props: getComputedStyle(document.getElementById('ctxProps')).display,
        lifeColor: getComputedStyle(document.getElementById('ctxLifeColor')).display,
        edit: getComputedStyle(document.getElementById('ctxEdit')).display,
        del: getComputedStyle(document.getElementById('ctxDel')).display
      }));
      const snap = () => page.evaluate(() => {
        const n1 = App.canvasState.nodes.find(x => x.id === 's1');
        const c = App.canvasState.connections[0];
        const pinStroke = {};
        document.querySelectorAll('#seqPinsSvg .seq-pin').forEach(p => {
          pinStroke[Math.round(+p.getAttribute('cx') / App.scale)] = p.getAttribute('stroke');
        });
        const sock = document.querySelector('.node[data-node-id="s1"] .socket.out .socket-inner');
        return {
          nodeColor: n1.color, lifeColor: n1.lifeColor, connColor: c.color || null,
          life0: getComputedStyle(document.querySelectorAll('#seqSvg .seq-life')[0]).stroke,
          pins: pinStroke,
          sockBg: sock ? getComputedStyle(sock).backgroundColor : null,
          lineStroke: getComputedStyle(document.querySelector('#linesSvg .line')).stroke
        };
      });

      // (0) 跟随开关默认值：节点图开（连线随节点色）、时序图关（连线用自己选到的颜色）。
      const swDefault = await page.evaluate(() => ({
        seqField: App._connFollowSeq, graphField: App._connFollowGraph,
        seqBox: document.getElementById('setConnFollowSeq').checked,
        graphBox: document.getElementById('setConnFollowGraph').checked,
        seqRow: document.getElementById('setConnFollowSeq').closest('.setting-row').getAttribute('data-modes'),
        graphRow: document.getElementById('setConnFollowGraph').closest('.setting-row').getAttribute('data-modes')
      }));
      // (0b) 时序图默认不跟随：把源参与者改成黄色，未设色的消息仍用缺省蓝；
      //      打开开关后才改取源节点色。
      const offFollow = await page.evaluate(() => {
        App.canvasState.nodes[0].color = 'yellow';
        App.renderCanvas({ center: false });
        App.renderLines();
        return App._connFollowSeq;
      });
      await sleep(300);
      const notFollowing = await page.evaluate(() => ({
        stroke: getComputedStyle(document.querySelector('#linesSvg .line')).stroke,
        cls: document.querySelector('#linesSvg .line').getAttribute('class')
      }));
      await page.evaluate(() => {
        const box = document.getElementById('setConnFollowSeq');
        box.checked = true;
        box.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await sleep(300);
      const didFollow = await page.evaluate(() => ({
        stroke: getComputedStyle(document.querySelector('#linesSvg .line')).stroke,
        stored: App._settings.getBool('connFollowSeq'),
        //导出把当前取色规则写进 messageStyle，读者不必猜缺省色从哪来。
        rule: App._serializeData().messageStyle.colorSource
      }));
      // 复位：开关关回去、源节点恢复蓝色，后面的用例从干净状态出发。
      await page.evaluate(() => {
        App.canvasState.nodes[0].color = 'blue';
        const box = document.getElementById('setConnFollowSeq');
        box.checked = false;
        box.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await sleep(300);
      // (1) 右键连线 → 属性 → 弹窗改色。
      await rightClick(300, 200);
      const connMenu = await ctxMenu();
      await page.evaluate(() => document.getElementById('ctxProps').click());
      await sleep(300);
      const connModal = await modal();
      await pick('orange');
      await save();
      const afterConn = await snap();
      // (2) 右键时序线 → 时序线颜色 → 弹窗改色。
      await rightClick(90, 300);
      const lifeMenu = await ctxMenu();
      await page.evaluate(() => document.getElementById('ctxLifeColor').click());
      await sleep(300);
      const lifeModal = await modal();
      await pick('green');
      await save();
      const afterLife = await snap();
      // (3) 改节点色 → 它的连接点、时序线一并跟随。
      await page.evaluate(() => {
        const n = App._getNodeById('s1');
        n.color = 'yellow';
        App.renderCanvas({ center: false });
        App.renderLines();
      });
      await sleep(300);
      const afterNode = await snap();
      return {
        want: want, norm: norm,
        swDefault: swDefault, offFollow: offFollow, notFollowing: notFollowing, didFollow: didFollow,
        connMenu: connMenu, connModal: connModal, afterConn: afterConn,
        lifeMenu: lifeMenu, lifeModal: lifeModal, afterLife: afterLife, afterNode: afterNode
      };
    })();
    const W = colors.want, N = colors.norm;
    t.ok('两个模式的「连线颜色跟随节点色」开关各一份，默认节点图开、时序图关',
      colors.swDefault.seqField === false && colors.swDefault.graphField === true &&
      colors.swDefault.seqBox === false && colors.swDefault.graphBox === true &&
      colors.swDefault.seqRow === 'sequence' && colors.swDefault.graphRow === 'graph', colors.swDefault);
    t.ok('时序图默认不跟随：源参与者改成黄色后，未设色的消息仍是缺省蓝',
      colors.offFollow === false && N(colors.notFollowing.stroke) === N(W.blue) &&
      colors.notFollowing.cls.indexOf('s-blue') >= 0, colors.notFollowing);
    t.ok('打开跟随后：同一条消息改取源节点色（黄色），且值已持久化',
      N(colors.didFollow.stroke) === N(W.yellow) && colors.didFollow.stored === true, colors.didFollow);
    t.ok('跟随开启时导出的 messageStyle 记下 participant',
      colors.didFollow.rule === 'participant', colors.didFollow);
    t.ok('右键连线给出「属性」入口',
      colors.connMenu.props !== 'none', colors.connMenu);
    t.ok('连线的「属性」打开色彩属性弹窗（有标签行、预设色与自定义色轮）',
      colors.connModal.open && colors.connModal.title === '连线属性' && colors.connModal.labelShown &&
      colors.connModal.dots >= 6 && colors.connModal.wheel === 1,
      colors.connModal);
    t.ok('在属性弹窗里选色并保存后，连线变色',
      colors.afterConn.connColor === 'orange' && N(colors.afterConn.lineStroke) === N(W.orange), colors.afterConn);
    t.ok('右键时序线给出「时序线颜色」，且没有节点级动作',
      colors.lifeMenu.lifeColor !== 'none' && colors.lifeMenu.edit === 'none' && colors.lifeMenu.del === 'none',
      colors.lifeMenu);
    t.ok('时序线弹窗只有颜色（标签行隐藏）',
      colors.lifeModal.open && colors.lifeModal.title === '时序线颜色' && !colors.lifeModal.labelShown,
      colors.lifeModal);
    t.ok('改时序线颜色后：这条时序线变色，它上面的源端连接点跟着变（目标端没有连接点）',
      colors.afterLife.lifeColor === 'green' && N(colors.afterLife.life0) === N(W.green) &&
      colors.afterLife.pins[90] === W.greenHex && colors.afterLife.pins[690] === undefined, colors.afterLife);
    t.ok('改节点色后：连接点（底边 socket）与时序线同步变色',
      colors.afterNode.nodeColor === 'yellow' && N(colors.afterNode.sockBg) === N(W.yellow), colors.afterNode);
    //存档往返：三处颜色都要能导出并原样导入。
    const colorRound = await page.evaluate(() => {
      const d = App._serializeData();
      const back = App._prepareSerializedData(d);
      return {
        outLife: d.nodes[0].lifeline.color, outConn: d.connections[0].color,
        backLife: back.candidate.nodes[0].lifeColor,
        backNodeColor: back.candidate.nodes[0].color,
        backConn: back.candidate.connections[0].color
      };
    });
    t.ok('三处颜色都能导出并原样导入',
      colorRound.outLife === 'green' && colorRound.outConn === 'orange' &&
      colorRound.backLife === 'green' && colorRound.backNodeColor === 'yellow' &&
      colorRound.backConn === 'orange', colorRound);
    const badColor = await page.evaluate(() => {
      const d = {
        nodes: [{ id: 'z1', label: 'z1', x: 0, y: 0, w: 180, h: 80, color: 'blue', lifeColor: 'bogus' },
          { id: 'z2', label: 'z2', x: 400, y: 0, w: 180, h: 80, color: 'blue' }],
        connections: [{ id: 'zc', from: 'z1', to: 'z2', label: '', y: 200, color: '#zzz' }]
      };
      const back = App._prepareSerializedData(d);
      return {
        life: back.candidate.nodes[0].lifeColor,
        conn: back.candidate.connections[0] ? back.candidate.connections[0].color : 'gone'
      };
    });
    t.ok('非法颜色在导入时被剔除（回落到缺省）',
      badColor.life === undefined && badColor.conn === undefined, badColor);

    // ══ 27) 设置项「时序线尾端固定」：拖节点时线尾留在原处、向上拖即延长 ══
    const anchorCfg = await page.evaluate(() => {
      const box = document.getElementById('setSeqLifeAnchor');
      const row = box ? box.closest('.setting-row') : null;
      return {
        exists: !!box, checked: box ? box.checked : null, val: App._seqLifeAnchor,
        modes: row ? row.getAttribute('data-modes') : null
      };
    });
    //每次用例都从同一初始状态出发：节点 y=0（底边 80）、时序线 80（尾端 160）。
    //不带消息（否则时序线会被"至少容纳消息"的下限顶高），并把视口下移，
    //给"向上拖"留出屏幕空间。世界位移 = 屏幕位移 / 当前缩放，故按 App.scale 换算。
    const anchorSetup = async (on) => {
      await page.evaluate(SETUP_SEQ);
      await page.evaluate((flag) => {
        App.canvasState.connections = [];
        App._connOffsCache = null;
        App.canvasState.nodes.forEach(n => { n.life = 80; });
        App.scale = 1; App.panX = 200; App.panY = 320;
        const box = document.getElementById('setSeqLifeAnchor');
        box.checked = flag;
        box.dispatchEvent(new Event('change', { bubbles: true }));
        App.saveCanvasSnapshot();
        App.renderCanvas({ center: false });
        App.applyViewTransform();
        App.renderLines();
      }, on);
      await sleep(300);
    };
    const nodeState = () => page.evaluate(() => {
      const n = App.canvasState.nodes.find(x => x.id === 's1');
      return {
        y: n.y, life: n.life, scale: App.scale,
        bottom: Weave.Geom.seqLifeAnchor(n).y,
        end: Weave.Geom.seqLifeEnd(n).y
      };
    });
    const anchorDrag = async (worldDy) => {
      const start = await nodeState();
      const p = await worldToScreen(page, 90, 20);
      await page.mouse.move(p.x, p.y);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) {
        await page.mouse.move(p.x, p.y + worldDy * start.scale * i / 8);
        await sleep(16);
      }
      await page.mouse.up();
      await sleep(500);
      const after = await nodeState();
      after.startY = start.y;
      after.startBottom = start.bottom;
      after.startEnd = start.end;
      after.startLife = start.life;
      return after;
    };
    await anchorSetup(false);
    const plainUp = await anchorDrag(-120);
    await anchorSetup(true);
    const anchoredUp = await anchorDrag(-120);
    await anchorSetup(true);
    const anchoredDown = await anchorDrag(150);
    await page.evaluate(() => {
      const box = document.getElementById('setSeqLifeAnchor');
      box.checked = false;
      box.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await sleep(200);

    t.ok('设置里有「时序线尾端固定」开关，默认关闭且属时序图那套界面',
      anchorCfg.exists && anchorCfg.checked === false && anchorCfg.val === false &&
      anchorCfg.modes === 'sequence', anchorCfg);
    t.ok('关闭（默认）：整条时序线跟着节点走——长度不变、尾端同步位移',
      plainUp.y === plainUp.startY - 120 && plainUp.life === plainUp.startLife &&
      plainUp.end === plainUp.startEnd - 120, plainUp);
    t.ok('开启后：节点上移 120，尾端原地不动、时序线等量延长',
      anchoredUp.y === anchoredUp.startY - 120 &&
      anchoredUp.end === anchoredUp.startEnd &&
      anchoredUp.life === anchoredUp.startLife + 120, anchoredUp);
    t.ok('开启后：往下拖被自己的线尾挡住（底边停在尾端之上 40，线保留最短 40）',
      anchoredDown.end === anchoredDown.startEnd && anchoredDown.life === 40 &&
      anchoredDown.bottom === anchoredDown.startEnd - 40, anchoredDown);

    // ══ 27b) 高度对齐同样遵守尾端固定（对齐也是一种"移动节点"）══
    await anchorSetup(true);
    const alignPin = await page.evaluate(() => {
      const ids = App.canvasState.nodes.map(n => n.id);
      const snap = () => ids.map(id => {
        const n = App._getNodeById(id);
        return {
          id: id, y: n.y, life: n.life,
          bottom: Weave.Geom.seqLifeAnchor(n).y, end: Weave.Geom.seqLifeEnd(n).y
        };
      });
      const before = snap();
      App._applyAlignToHeight(ids, before[0].y - 120);   // 上移 120
      const afterUp = snap();
      App._applyAlignToHeight(ids, 400);    // 远在线尾之下
      const afterDown = snap();
      return { before: before, afterUp: afterUp, afterDown: afterDown };
    });
    const endsKept = (a, b) => a.every((x, i) => x.end === b[i].end);
    t.ok('尾端固定下：高度对齐把节点上移，线尾留在原处、时序线等量延长',
      alignPin.afterUp.every((x, i) =>
        x.y === alignPin.before[i].y - 120 && x.life === alignPin.before[i].life + 120) &&
      endsKept(alignPin.afterUp, alignPin.before), alignPin.afterUp);
    t.ok('尾端固定下：高度对齐也把节点夹在自己的线尾之上（线保留最短 40）',
      alignPin.afterDown.every(x => x.life === 40 && x.bottom === x.end - 40), alignPin.afterDown);
    await page.evaluate(() => {
      const box = document.getElementById('setSeqLifeAnchor');
      box.checked = false;
      box.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await sleep(200);

    // ══ 28) 写入口都维持不变量（第三方审查 F1–F3/F5/F8/F9 的回归）══
    const writes = {};

    // (a) 建消息：目标端更靠下时，下限取两端锚点的较大者，箭头不悬空。
    await page.evaluate(SETUP_SEQ);
    await sleep(250);
    writes.createClamp = await page.evaluate(() => {
      const s1 = App.canvasState.nodes.find(n => n.id === 's1');
      const s2 = App.canvasState.nodes.find(n => n.id === 's2');
      s2.y = 240;                                   // s2 底边 320，远在消息高度之下
      App.canvasState.connections = [];
      App._connOffsCache = null;
      App.saveCanvasSnapshot();
      const ok = App._createSeqMessage('s1', 's2', 200);   // 200 低于 s2 的锚点
      const c = App.canvasState.connections[0];
      return { ok: ok, y: c ? c.y : null, s2bottom: s2.y + s2.h, s1bottom: s1.y + s1.h };
    });
    t.ok('建消息以两端锚点较大者为下限（目标端不悬空）',
      writes.createClamp.ok === true && writes.createClamp.y === writes.createClamp.s2bottom &&
      writes.createClamp.s2bottom > writes.createClamp.s1bottom, writes.createClamp);

    // (b) 把消息拖到上限再松手：吸附不许把它带过线首（否则当场被移除）。
    await page.evaluate(SETUP_SEQ);
    await page.evaluate(() => {
      //两端底边都落在非格点上（45）：下限 lo = 45 不在格点，吸附到 40 就会
      //假越界——这正是要守住的那半格。
      App.canvasState.nodes.forEach(n => { n.y = -35; });
      App.canvasState.connections[0].y = 45;
      App._snapConn = true;                        // 网格吸附开着
      App._connOffsCache = null;
      App.saveCanvasSnapshot();
      App.renderCanvas({ center: false });
      App.applyViewTransform();
      App.renderLines();
    });
    await sleep(300);
    {
      //右键消息连线 → 「调整位置」→ 拖中点把手往上顶到上限再松手。
      const mp = await worldToScreen(page, 300, 45);
      await page.mouse.click(mp.x, mp.y, { button: 'right' });
    }
    await sleep(250);
    await page.evaluate(() => document.getElementById('ctxSeqMove').click());
    await sleep(250);
    {
      const grip = await page.evaluate(() => {
        const el = document.querySelector('#seqPinsSvg .seq-drag-handle');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      if (grip) {
        await page.mouse.move(grip.x, grip.y);
        await page.mouse.down();
        for (let i = 1; i <= 8; i++) { await page.mouse.move(grip.x, grip.y - 20 * i); await sleep(16); }
        await page.mouse.up();
        await sleep(600);
      }
    }
    writes.snapClamp = await page.evaluate(() => {
      const c = App.canvasState.connections[0];
      const bottoms = App.canvasState.nodes.map(n => n.y + n.h);
      return {
        conns: App.canvasState.connections.length, y: c ? c.y : null,
        lo: Math.max.apply(null, bottoms)
      };
    });
    t.ok('拖动消息贴到上限再松手：吸附不会把它带过线首（消息仍在）',
      writes.snapClamp.conns === 1 && writes.snapClamp.y === writes.snapClamp.lo, writes.snapClamp);

    // (c) 缩放节点把底边越过消息：缩放落定同样整理不变量，并弹提示。
    await page.evaluate(SETUP_SEQ);
    await page.evaluate(() => {
      App.canvasState.nodes.find(n => n.id === 's1').y = -40;
      App.canvasState.connections[0].y = 160;
      App._connOffsCache = null;
      App.saveCanvasSnapshot();
      App.renderCanvas({ center: false });
      App.applyViewTransform();
      App._showResizeHandles('s1');
      document.getElementById('toastContainer').textContent = '';
    });
    await sleep(300);
    {
      const h = await page.evaluate(() => {
        const el = document.querySelector('#canvasNodes .rsz-handle.se');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      if (h) {
        await page.mouse.move(h.x, h.y);
        await page.mouse.down();
        for (let i = 1; i <= 8; i++) { await page.mouse.move(h.x, h.y + 25 * i); await sleep(16); }
        await page.mouse.up();
        await sleep(700);
      }
    }
    writes.resizeDrop = await page.evaluate(() => {
      const n = App.canvasState.nodes.find(x => x.id === 's1');
      return {
        conns: App.canvasState.connections.length,
        bottom: n.y + n.h,
        toast: document.getElementById('toastContainer').textContent
      };
    });
    t.ok('缩放把底边越到消息之下：缩放落定也整理不变量，消息被移除',
      writes.resizeDrop.conns === 0 && writes.resizeDrop.bottom > 160, writes.resizeDrop);
    t.ok('移除消息时给了提示（不再静默丢数据）',
      writes.resizeDrop.toast.indexOf('脱离') >= 0, writes.resizeDrop.toast);

    // (d) 删掉整组消息后，「调整位置」模式要收敛（别留在看不见的状态）。
    await page.evaluate(SETUP_SEQ);
    await sleep(250);
    writes.prune = await page.evaluate(() => {
      const c = App.canvasState.connections[0];
      const n = App.canvasState.nodes.find(x => x.id === c.from);
      App._enterSeqPinMove({ nodeId: n.id, y: c.y });
      const entered = !!App._seqMoveState;
      App._deleteConnections([c.id]);
      return { entered: entered, after: App._seqMoveState };
    });
    t.ok('删掉参与移动的消息后退出「调整位置」模式',
      writes.prune.entered === true && writes.prune.after === null, writes.prune);

    // (e) 连接点拖动时整组可见：连线高亮 + 中点把手（口径不一致的回归）。
    await page.evaluate(SETUP_SEQ);
    await sleep(250);
    writes.groupVisible = await page.evaluate(() => {
      const c = App.canvasState.connections[0];
      const n = App.canvasState.nodes.find(x => x.id === c.from);
      App._enterSeqPinMove({ nodeId: n.id, y: c.y });
      App.renderLines();
      return { state: App._seqMoveState };
    });
    await sleep(250);
    writes.groupMarks = await page.evaluate(() => ({
      moving: document.querySelectorAll('#linesSvg .line.seq-moving').length,
      grips: document.querySelectorAll('#seqPinsSvg .seq-drag-handle').length
    }));
    t.ok('进入连接点移动模式时整组冻结并标出（连线高亮 + 中点把手）',
      writes.groupVisible.state && writes.groupVisible.state.ids.length === 1 &&
      writes.groupMarks.moving === 1 && writes.groupMarks.grips === 1,
      { state: writes.groupVisible.state, marks: writes.groupMarks });

    // ══ 29) 断裂预览：不跟随时，越界消息在拖动/落定之前就画成红色虚线 ══
    await page.evaluate(SETUP_SEQ);
    await sleep(250);
    // renderLines 按 rAF 合并，因此每次改数据后要等一帧再读 DOM。
    const breakRead = () => page.evaluate(() => {
      const conn = App.canvasState.connections[0];
      const p = document.querySelector('#linesSvg path.line[data-conn-key="' + conn.id + '"]');
      //取计算样式而不是内联串：既验证"写进去了"，也验证它确实盖过了预设色的类。
      return {
        dash: p ? p.getAttribute('stroke-dasharray') : null,
        stroke: p ? getComputedStyle(p).stroke : '',
        breaking: App._seqMsgBreaking(conn, App._getNodeById(conn.from), App._getNodeById(conn.to))
      };
    });
    const repaint = () => page.evaluate(() => { App._connOffsCache = null; App.renderLines(); });
    // 1) 不跟随 + 消息仍在两端时序线范围内：没有预览。
    await page.evaluate(() => { App._seqMsgFollow = false; });
    await repaint(); await sleep(150);
    const bpNormal = await breakRead();
    // 2) 节点整体下移，消息落到线首之上（不跟随 = 松手即被移除）。
    await page.evaluate(() => { App.canvasState.nodes.forEach(n => { n.y += 200; }); });
    await repaint(); await sleep(150);
    const bpBroken = await breakRead();
    // 断裂预览时端点连接点也要跟着变色（红线配蓝圆点读不出状态）——趁"正在断裂"
    // 这一帧读数，随后的跟随/还原都会重新渲染。
    const bpPin = await page.evaluate(() => {
      const p = document.querySelector('#seqPinsSvg .seq-pin');
      const inner = document.querySelector('#seqPinsSvg .seq-pin-inner');
      return {
        stroke: p ? p.getAttribute('stroke') : null,
        fill: inner ? inner.getAttribute('fill') : null
      };
    });
    // 3) 跟随打开后，同样的越界只是"待挪回"，不是断裂。
    await page.evaluate(() => { App._seqMsgFollow = true; });
    await repaint(); await sleep(150);
    const bpFollowed = await breakRead();
    // 4) 红度分档：不红→标准红，已红→深一档，红得发暗→红到发黑，发白→标准红。
    const bpLadder = await page.evaluate(() => ({
      preset: App._seqBreakHex('#3b82f6'), red: App._seqBreakHex('#dc2626'),
      darkRed: App._seqBreakHex('#991b1b'), blackRed: App._seqBreakHex('#450a0a'),
      pink: App._seqBreakHex('#ffc0cb')
    }));
    t.ok('不跟随时：范围内的消息不做断裂预览',
      bpNormal.dash === null && bpNormal.stroke !== 'rgb(220, 38, 38)', bpNormal);
    t.ok('不跟随时：越界消息立刻画成红色虚线（松手前就可见）',
      bpBroken.breaking === true && bpBroken.dash === '7 5' &&
      bpBroken.stroke === 'rgb(220, 38, 38)', bpBroken);
    t.ok('跟随开启时同样的越界不算断裂（不显示预览）',
      bpFollowed.dash === null && bpFollowed.stroke !== 'rgb(220, 38, 38)', bpFollowed);
    t.ok('断裂预览的红按当前颜色分档：不红→标准红、已红→更深、红得发暗→红到发黑、发白→标准红',
      JSON.stringify(bpLadder) === JSON.stringify({
        preset: '#dc2626', red: '#991b1b', darkRed: '#450a0a', blackRed: '#450a0a', pink: '#dc2626'
      }), bpLadder);
    t.ok('断裂预览时：同高度的端点连接点与消息同色（不是红线配蓝圆点）',
      bpPin.stroke === '#dc2626' && bpPin.fill === '#dc2626', bpPin);
    // 对照：把消息放回线内，圆点应回到所属时序线的颜色。
    await page.evaluate(() => {
      App._seqMsgFollow = false;
      App.canvasState.nodes.forEach(n => { n.y -= 200; });
      App._connOffsCache = null;
      App.renderLines();
    });
    await sleep(150);
    const bpPinBack = await page.evaluate(() => {
      const p = document.querySelector('#seqPinsSvg .seq-pin');
      return { stroke: p ? p.getAttribute('stroke') : null };
    });
    t.ok('（对照）消息回到线内后，连接点恢复所属时序线的颜色',
      bpPinBack.stroke === '#3b82f6', bpPinBack);

    // 共用端点的混合情形：同一高度上两条消息，**后画的那条**断裂——
    // 连接点是共用的，不能被先画的那条锁成蓝色。
    await page.evaluate(() => {
      App.canvasState.nodes = [
        { id: 'p1', label: 'p1', desc: '', color: 'blue', x: 0, y: 0, w: 180, h: 80, mirrored: false, life: 320 },
        { id: 'p2', label: 'p2', desc: '', color: 'blue', x: 600, y: 0, w: 180, h: 80, mirrored: false, life: 320 },
        { id: 'p3', label: 'p3', desc: '', color: 'blue', x: 1200, y: 0, w: 180, h: 80, mirrored: false, life: 150 }
      ];
      // k1：两端尾端都是 400 → 不断；k2：p3 尾端只有 230 → 越线尾 → 断。
      // 两条共用 p1 上 y=260 这一个端点，而 k1 排在前面（圆点由它先画出来）。
      App.canvasState.connections = [
        { id: 'k1', from: 'p1', to: 'p2', label: '', mirrored: false, y: 260 },
        { id: 'k2', from: 'p1', to: 'p3', label: '', mirrored: false, y: 260 }
      ];
      App._nodeZOrder = ['p1', 'p2', 'p3'];
      App._seqMsgFollow = false;
      App._seqMoveState = null;
      App.saveCanvasSnapshot();
      App.renderCanvas({ center: false });
      App._connOffsCache = null;
      App.renderLines();
    });
    await sleep(200);
    const mixedPin = await page.evaluate(() => {
      const pins = [...document.querySelectorAll('#seqPinsSvg .seq-pin')];
      const inner = document.querySelector('#seqPinsSvg .seq-pin-inner');
      const line = id => document.querySelector('#linesSvg path.line[data-conn-key="' + id + '"]');
      const k1 = line('k1'), k2 = line('k2');
      return {
        pinCount: pins.length,
        pinStroke: pins[0] ? pins[0].getAttribute('stroke') : null,
        innerFill: inner ? inner.getAttribute('fill') : null,
        k1dash: k1 ? k1.getAttribute('stroke-dasharray') : null,
        k1stroke: k1 ? getComputedStyle(k1).stroke : '',
        k2dash: k2 ? k2.getAttribute('stroke-dasharray') : null,
        k2stroke: k2 ? getComputedStyle(k2).stroke : ''
      };
    });
    t.ok('共用端点只画一个圆点',
      mixedPin.pinCount === 1, mixedPin);
    t.ok('同高度上只有一条消息断裂时：断的那条是红色虚线、不断的那条保持原样',
      mixedPin.k2dash === '7 5' && mixedPin.k2stroke === 'rgb(220, 38, 38)' &&
      mixedPin.k1dash === null && mixedPin.k1stroke !== 'rgb(220, 38, 38)', mixedPin);
    t.ok('共用的端点连接点跟着"断的那一条"变红（不被先画的那条锁住）',
      mixedPin.pinStroke === '#dc2626' && mixedPin.innerFill === '#dc2626', mixedPin);

    // 真实拖动：按住不放时预览就应出现（这才是"拖动期间可见"）。
    await page.evaluate(SETUP_SEQ);
    await sleep(250);
    const bp = await worldToScreen(page, 90, 20);
    await page.mouse.move(bp.x, bp.y);
    await page.mouse.down();
    for (let i = 1; i <= 9; i++) { await page.mouse.move(bp.x, bp.y + 20 * i); await sleep(16); }
    const dragging = await page.evaluate(() => {
      const conn = App.canvasState.connections[0];
      const p = document.querySelector('#linesSvg path.line[data-conn-key="' + conn.id + '"]');
      const arrows = [...document.querySelectorAll('#linesSvg .conn-arrow[data-conn-key="' + conn.id + '"]')];
      return {
        conns: App.canvasState.connections.length,
        dash: p ? p.getAttribute('stroke-dasharray') : null,
        stroke: p ? getComputedStyle(p).stroke : '',
        // 第 2 个箭头是目标端那个（源端那个在时序图里被隐藏）。
        arrowFill: arrows[1] ? arrows[1].getAttribute('fill') : null
      };
    });
    await page.mouse.up();
    await sleep(500);
    t.ok('真实拖动中：消息尚未被移除，但已经显示红色虚线预览',
      dragging.conns === 1 && dragging.dash === '7 5' && dragging.stroke === 'rgb(220, 38, 38)', dragging);
    t.ok('预览时目标端箭头同色（红线上不会挂一个蓝箭头）',
      dragging.arrowFill === '#dc2626', dragging);
    // ══ 14) 分区创建在时序图模式可用（Alt+拖拽：预览 + 成员归属） ══
    await page.evaluate(SETUP_SEQ);
    await sleep(250);
    const r1 = await page.evaluate(() => {
      const r = App._nodeElMap.get('s1').getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    });
    const ra = { x: r1.left - 40, y: r1.top - 40 };
    const rb = { x: r1.right + 40, y: r1.bottom + 60 };
    await page.keyboard.down('Alt');
    await page.mouse.move(ra.x, ra.y);
    await page.mouse.down();
    await page.mouse.move((ra.x + rb.x) / 2, (ra.y + rb.y) / 2, { steps: 4 });
    await sleep(80);
    const preview = await page.evaluate(() => {
      const ov = document.getElementById('regionPreview');
      return { shown: !!ov && ov.style.display === 'block', seqMode: App._mode };
    });
    await page.mouse.move(rb.x, rb.y, { steps: 4 });
    await page.mouse.up();
    await page.keyboard.up('Alt');
    await sleep(400);
    const region = await page.evaluate(() => {
      const r = App.canvasState.regions[0];
      return { count: App.canvasState.regions.length, members: r ? r.nodeIds : [] };
    });
    t.ok('时序图模式：Alt+拖拽显示分区创建预览', preview.shown === true && preview.seqMode === 'sequence', preview);
    t.ok('时序图模式：松手后分区创建成功', region.count === 1, region);
    t.ok('时序图模式：框内节点自动归属分区', region.members.includes('s1') && !region.members.includes('s2'), region);
  } finally {
    await cleanup();
  }
  console.log(t.fails === 0 ? '\n✅ 时序图模式 GUI 守护全部通过' : '\n❌ ' + t.fails + ' 项失败');
  process.exit(t.fails === 0 ? 0 : 1);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
