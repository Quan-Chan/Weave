// 分区功能专项 GUI 冒烟测试（puppeteer-core + 系统 Edge 无头）
// 用法: node test/region-smoke.js [--headed]
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

// 浏览器可执行文件: 环境变量优先(CI), 缺省回退本机 Edge
const EDGE = process.env.WEAVE_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
// 应用地址: 相对定位仓库内文件(可移植)
const APP_URL = process.env.WEAVE_APP_URL || pathToFileURL(path.join(__dirname, '..', 'APPs', 'Weave.html')).href;
const SHOTS = path.join(__dirname, 'shots-region');
fs.mkdirSync(SHOTS, { recursive: true });
const HEADED = process.argv.includes('--headed');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (cond, msg) => { console.log((cond ? '✅ ' : '❌ ') + msg); if (!cond) failures++; };

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: !HEADED,
    args: ['--no-first-run', '--no-sandbox', '--disable-gpu', '--window-size=1280,800'],
    defaultViewport: { width: 1280, height: 800 }
  });
  const page = await browser.newPage();
  await page.goto(APP_URL, { waitUntil: 'load' });
  await page.waitForFunction('!!window.App && !!document.getElementById("canvasStage") && document.getElementById("canvasStage").clientWidth > 0', { timeout: 15000 });
  await sleep(500);
  // 关闭首次设置弹窗
  await page.keyboard.press('Escape');
  await sleep(150);

  const stage = await page.evaluate(() => {
    const r = document.getElementById('canvasStage').getBoundingClientRect();
    return { left: r.left, top: r.top, w: r.width, h: r.height };
  });

  // ── 1) 清空可能存在的旧存档状态（仅清 nodes；region 也一并清）──
  await page.evaluate(() => {
    localStorage.clear();
    location.reload();
  });
  await sleep(800);
  await page.waitForFunction('!!window.App && !!document.getElementById("canvasStage") && document.getElementById("canvasStage").clientWidth > 0', { timeout: 15000 });
  await page.keyboard.press('Escape');
  await sleep(150);

  const cdp = await page.createCDPSession();
  const dbl = async (x, y) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(60);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 2 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 2 });
    await sleep(250);
  };

  // 建 2 个相邻节点
  const s = await page.evaluate(() => {
    const r = document.getElementById('canvasStage').getBoundingClientRect();
    return { left: r.left, top: r.top, w: r.width, h: r.height };
  });
  const cx0 = s.left + s.w / 2 - 150, cy0 = s.top + s.h / 2 - 40;
  await dbl(cx0, cy0);
  await dbl(cx0 + 260, cy0);
  await sleep(200);
  const n0 = await page.evaluate('App.canvasState.nodes.length');
  ok(n0 === 2, '创建 2 节点，实际 ' + n0);

  // ── 2) Alt+拖拽 画分区（覆盖两节点）──
  const st2 = await page.evaluate(() => {
    const r = document.getElementById('canvasStage').getBoundingClientRect();
    return { left: r.left, top: r.top };
  });
  // 两节点已吸附网格：得到它们实际屏幕中心
  const pts = await page.evaluate(() => {
    return App.canvasState.nodes.map(n => {
      const el = App._nodeElMap.get(n.id);
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
  });
  // 画一个覆盖两点 + 边距的框（从节点最外侧再外扩 60px，保证整节点在框内）
  const b0 = await page.evaluate(() => {
    const a = App._nodeElMap.get(App.canvasState.nodes[0].id).getBoundingClientRect();
    const b = App._nodeElMap.get(App.canvasState.nodes[1].id).getBoundingClientRect();
    return {
      minX: Math.min(a.left, b.left), maxX: Math.max(a.right, b.right),
      minY: Math.min(a.top, b.top), maxY: Math.max(a.bottom, b.bottom)
    };
  });
  const x1 = b0.minX - 60, x2 = b0.maxX + 60;
  const y1 = b0.minY - 50, y2 = b0.maxY + 50;
  // 生成色取绿色：临时预览框颜色与创建完成后的分区颜色应同源
  const genBefore = await page.evaluate(() => App._selectedGenColor);
  await page.evaluate(() => { App._setGenColor('green'); });
  await page.keyboard.down('Alt');
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move(x2, y2, { steps: 15 });
  const pv = await page.evaluate(() => {
    const cs = getComputedStyle(document.getElementById('regionPreview'));
    return { display: cs.display, border: cs.borderTopColor, bg: cs.backgroundColor, gen: App._selectedGenColor };
  });
  ok(pv.display === 'block' && pv.border === 'rgb(16, 185, 129)' && pv.bg === 'rgba(16, 185, 129, 0.07)',
    '临时分区框颜色跟随生成色 green ' + JSON.stringify(pv));
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await sleep(400);
  const rg = await page.evaluate(() => ({
    count: App.canvasState.regions.length,
    sel: App.selectedNodeIds.size,
    reg: App.canvasState.regions[0] ? { x: App.canvasState.regions[0].x, y: App.canvasState.regions[0].y, w: App.canvasState.regions[0].w, h: App.canvasState.regions[0].h, color: App.canvasState.regions[0].color } : null
  }));
  ok(rg.count === 1, 'Alt 拖拽创建分区 1 个，实际 ' + rg.count);
  ok(rg.sel === 2, '分区创建后选中 2 个框内节点，实际 ' + rg.sel);
  ok(rg.reg && rg.reg.w > 200, '分区尺寸合理 ' + JSON.stringify(rg.reg));
  ok(rg.reg && rg.reg.color === 'green', '创建完成的分区颜色为生成色 green ' + JSON.stringify(rg.reg));
  await page.evaluate(v => { App._setGenColor(v || 'blue'); }, genBefore);
  await page.screenshot({ path: path.join(SHOTS, '01_region_created.png') });

  // ── 3) 拖动分区整体移动（框内空白拖动）──
  // 节点都在框内，点击框内空白（非节点处）拖动 → 节点应随动
  const hitPt = await page.evaluate(() => {
    const r0 = App.canvasState.regions[0];
    const el0 = document.querySelector('#regionsSvg [data-region-id="' + App.canvasState.regions[0].id + '"]');
    // 用 DOM rect 找到框左上附近的空白点（避开节点）
    const r = el0.getBoundingClientRect();
    return { x: r.left + 20, y: r.top + r.height - 20, left: r.left, top: r.top };
  });
  // 若空白点在节点上会拖节点——先确认该点非节点
  const before = await page.evaluate(() => App.canvasState.nodes.map(n => ({ x: n.x, y: n.y })));
  // 新语义：未选中分区上按下拖动 = 平移画布；须先单击选中分区，再拖才移动。
  await page.mouse.move(hitPt.x, hitPt.y);
  await page.mouse.down();
  await page.mouse.up();
  await sleep(350);   // 等 click 选中完成，且超过双击判定窗（250ms），避免"点选后拖"被当双击
  await page.mouse.move(hitPt.x, hitPt.y);
  await page.mouse.down();
  await page.mouse.move(hitPt.x + 90, hitPt.y + 50, { steps: 12 });
  await page.mouse.up();
  await sleep(400);
  const after = await page.evaluate(() => App.canvasState.nodes.map(n => ({ x: n.x, y: n.y })));
  const moved = (after[0].x - before[0].x) + (after[1].x - before[1].x);
  ok(Math.abs(moved) > 100, '先选中再拖：分区移动后节点随动（Δx 合计 ' + moved + '）');
  await page.screenshot({ path: path.join(SHOTS, '02_region_moved.png') });

  // ── 4) 右键分区 → 编辑分区 → 改名 / 改颜色 ──
  const rp = await page.evaluate(() => {
    const el = document.querySelector('#regionsSvg .region-rect');
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(rp.x, rp.y, { button: 'right' });
  await sleep(250);
  const menuItems = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#ctx button')).filter(b => b.style.display !== 'none').map(b => b.textContent.trim())
  );
  ok(menuItems.length === 5 && menuItems[0] === '编辑' && menuItems[1] === '属性' && menuItems[2] === '移动分区框' && menuItems[3] === '调整分区框大小' && menuItems[4] === '删除',
    '分区右键菜单为 [编辑/属性/移动分区框/调整分区框大小/删除]（属性在第二组）: ' + JSON.stringify(menuItems));
  await page.screenshot({ path: path.join(SHOTS, '03_region_ctx.png') });
  // 点 属性
  const editBtn = await page.evaluate(() => {
    const b = document.getElementById('ctxProps');
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(editBtn.x, editBtn.y);
  await sleep(300);
  const modalOn = await page.evaluate(() => document.getElementById('regionModal').classList.contains('on'));
  ok(modalOn, '分区属性弹窗打开');
  // 弹窗样式与内容断言：input 有节点属性弹窗同款样式；无宽高输入行。
  const modalStyle = await page.evaluate(() => {
    const inp = document.getElementById('rmLabel');
    const cs = getComputedStyle(inp);
    return {
      w: cs.width, bg: cs.backgroundColor, border: cs.borderTopWidth,
      hasW: !!document.getElementById('rmW'), hasH: !!document.getElementById('rmH'),
      h3: document.querySelector('#regionModalBox h3').textContent,
      titleFont: getComputedStyle(document.querySelector('#regionModalBox h3')).fontSize
    };
  });
  ok(modalStyle.w !== 'auto' && parseFloat(modalStyle.w) > 200 && modalStyle.border === '1px', '分区属性弹窗输入框有完整样式 ' + JSON.stringify(modalStyle));
  ok(!modalStyle.hasW && !modalStyle.hasH, '分区属性弹窗不含宽高输入');
  await page.evaluate(() => {
    const inp = document.getElementById('rmLabel');
    inp.value = '核心区';
    document.getElementById('regionModal').dataset.color = 'green';
  });
  const saveBtn = await page.evaluate(() => {
    const b = document.getElementById('btnSaveRegionModal');
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(saveBtn.x, saveBtn.y);
  await sleep(400);
  const afterSave = await page.evaluate(() => {
    const r = App.canvasState.regions[0];
    return { label: r.label, color: r.color, w: r.w };
  });
  ok(afterSave.label === '核心区' && afterSave.color === 'green', '分区属性保存 ' + JSON.stringify(afterSave));
  await page.screenshot({ path: path.join(SHOTS, '04_region_props.png') });

  // ── 5) 节点拖入分区（新节点落在框外再拖进）──
  // 在分区外创建新节点，再拖到分区内
  const far = await page.evaluate(() => {
    const r = document.getElementById('canvasStage').getBoundingClientRect();
    return { x: r.left + r.width - 120, y: r.top + 80 };
  });
  await dbl(far.x, far.y);
  await sleep(200);
  const n3pos = await page.evaluate(() => {
    const n = App.canvasState.nodes[2];
    const el = App._nodeElMap.get(n.id);
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  // 拖入分区中心
  const target = await page.evaluate(() => {
    const el = document.querySelector('#regionsSvg .region-rect');
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(n3pos.x, n3pos.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 15 });
  await page.mouse.up();
  await sleep(400);
  // 用几何判定（region 内节点数）
  const inRegion = await page.evaluate(() => {
    const r = App.canvasState.regions[0];
    let cnt = 0;
    App.canvasState.nodes.forEach(n => {
      const cx = n.x + (n.w || 170) / 2, cy = n.y + (n.h || 80) / 2;
      if (cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) cnt++;
    });
    return cnt;
  });
  ok(inRegion === 3, '拖入后分区内节点 3 个，实际 ' + inRegion);
  await page.screenshot({ path: path.join(SHOTS, '05_node_dropped_in.png') });

  // ── 6) 撤销链（region 移动/修改可撤销）──
  await page.evaluate(() => {
    localStorage.removeItem('flow_data');
  });
  // 触发一次撤销（保存后存在历史）
  await page.keyboard.down('Control');
  await page.keyboard.press('z');
  await page.keyboard.up('Control');
  await sleep(300);
  const rgAfterUndo = await page.evaluate(() => ({ regions: App.canvasState.regions.length, nodes: App.canvasState.nodes.length }));
  ok(rgAfterUndo.regions === 1, '撤销后分区仍存在（撤销到节点拖入前）' + JSON.stringify(rgAfterUndo));
  await page.screenshot({ path: path.join(SHOTS, '06_after_undo.png') });

  // ── 7) 删除分区（右键 → 删除分区），节点保留 ──
  const rp2 = await page.evaluate(() => {
    const el = document.querySelector('#regionsSvg .region-rect');
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(rp2.x, rp2.y, { button: 'right' });
  await sleep(200);
  const delBtn = await page.evaluate(() => {
    const b = document.getElementById('ctxDel');
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(delBtn.x, delBtn.y);
  await sleep(350);
  const afterDel = await page.evaluate(() => ({ regions: App.canvasState.regions.length, nodes: App.canvasState.nodes.length }));
  ok(afterDel.regions === 0, '删除分区后 regions=0，实际 ' + afterDel.regions);
  ok(afterDel.nodes === 3, '删除分区后节点保留 3 个，实际 ' + afterDel.nodes);
  await page.screenshot({ path: path.join(SHOTS, '07_region_deleted.png') });

  // ── 8) 序列化往返（regions 进存档/导出）──
  // 用 Alt 拖拽新建一个分区再序列化
  const rr = await page.evaluate(() => {
    const s = document.getElementById('canvasStage').getBoundingClientRect();
    return { left: s.left, top: s.top };
  });
  await page.keyboard.down('Alt');
  await page.mouse.move(rr.left + 200, rr.top + 100);
  await page.mouse.down();
  await page.mouse.move(rr.left + 400, rr.top + 250, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await sleep(300);
  const ser = await page.evaluate(() => {
    const d = App._serializeData();
    return { hasRegions: !!d.regions, n: d.regions ? d.regions.length : 0, first: d.regions && d.regions[0] ? { x: d.regions[0].x, y: d.regions[0].y } : null };
  });
  ok(ser.hasRegions && ser.n === 1, '序列化包含 regions ' + JSON.stringify(ser));
  await page.screenshot({ path: path.join(SHOTS, '08_serialize.png') });

  // ── 9) 撤销/重做对分区操作生效 ──
  // 撤销刚创建的序列化分区 → 分区消失；重做 → 分区恢复
  const curRg = await page.evaluate(() => App.canvasState.regions.length);
  await page.keyboard.down('Control');
  await page.keyboard.press('z');
  await page.keyboard.up('Control');
  await sleep(300);
  const undoneRg = await page.evaluate(() => ({ regions: App.canvasState.regions.length, nodes: App.canvasState.nodes.length }));
  ok(undoneRg.regions === curRg - 1, '撤销可撤销分区创建（' + curRg + '→' + undoneRg.regions + '）');
  await page.keyboard.down('Control');
  await page.keyboard.press('y');
  await page.keyboard.up('Control');
  await sleep(300);
  const redoneRg = await page.evaluate(() => App.canvasState.regions.length);
  ok(redoneRg === curRg, '重做恢复分区（' + redoneRg + '）');

  // ── 9b) 存档往返：导出数据 → 重新载入 → region 几何与属性还原 ──
  const roundtrip = await page.evaluate(() => {
    const d = App._serializeData();
    const before = JSON.parse(JSON.stringify(d.regions));
    // 走导入路径（新撤销基线）
    App._loadFromData(d);
    const after = App.canvasState.regions.map(r => ({ label: r.label, color: r.color, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) }));
    return { before, after };
  });
  ok(roundtrip.after.length === 1 && roundtrip.before.length === 1, '存档往返后分区数保持 1');
  //存档单位统一：w/h 与 x/y 同为格单位，往返后 x/y/w/h 全部 ×20 还原为像素。
  ok(roundtrip.after[0] && roundtrip.after[0].x === Math.round(roundtrip.before[0].x * 20) &&
     roundtrip.after[0].w === Math.round(roundtrip.before[0].w * 20) &&
     roundtrip.after[0].h === Math.round(roundtrip.before[0].h * 20),
    '往返后分区几何还原（' + JSON.stringify(roundtrip.after[0]) + '）');
  await sleep(200);

  // ── 10) Region 键（Shift+R）模式画分区 ──
  await page.keyboard.down('Shift');
  await page.keyboard.press('r');
  await page.keyboard.up('Shift');
  await sleep(200);
  const modeOn = await page.evaluate(() => App._regionModeActive);
  ok(modeOn, 'Shift+R 开启分区模式');
  const rr2 = await page.evaluate(() => {
    const s = document.getElementById('canvasStage').getBoundingClientRect();
    return { left: s.left, top: s.top };
  });
  const beforeCount = await page.evaluate(() => App.canvasState.regions.length);
  await page.mouse.move(rr2.left + 60, rr2.top + 60);
  await page.mouse.down();
  await page.mouse.move(rr2.left + 220, rr2.top + 180, { steps: 10 });
  await page.mouse.up();
  await sleep(300);
  const afterCount = await page.evaluate(() => App.canvasState.regions.length);
  ok(afterCount === beforeCount + 1, '分区模式下拖拽创建分区（' + beforeCount + '→' + afterCount + '）');
  await page.keyboard.down('Shift');
  await page.keyboard.press('r');
  await page.keyboard.up('Shift');
  await sleep(200);
  const modeOff = await page.evaluate(() => App._regionModeActive);
  ok(!modeOff, 'Shift+R 关闭分区模式');
  await page.screenshot({ path: path.join(SHOTS, '09_region_mode.png') });

  // ── 11) 右键"移动分区框"：仅移动框体，节点不随动 ──
  // 当前画布：若干节点在分区内（先前移动过），先清点节点绝对位置
  const curR = await page.evaluate(() => {
    const r = App.canvasState.regions[0];
    return { rx: r.x, ry: r.y, rw: r.w, rh: r.h, id: r.id };
  });
  const nodesBefore = await page.evaluate(() => App.canvasState.nodes.map(n => ({ x: n.x, y: n.y })));
  // 在分区内空白处右键（选一个避开节点的点：用 region 左下角附近但确保在 rect 上）
  const frameCtx = await page.evaluate(() => {
    // 用区域 rect DOM 边界找内部空白（左下角 +10/+10 相对坐标）
    const el = document.querySelector('#regionsSvg [data-region-id="' + App.canvasState.regions[0].id + '"].region-rect');
    const r = el.getBoundingClientRect();
    // 底部区域一般无节点：r.bottom-12 附近
    return { x: r.left + r.width / 2, y: r.bottom - 12 };
  });
  await page.mouse.click(frameCtx.x, frameCtx.y, { button: 'right' });
  await sleep(250);
  const moveItem = await page.evaluate(() => {
    const b = document.getElementById('ctxRegionMove');
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(moveItem.x, moveItem.y);
  await sleep(300);
  const modeChk = await page.evaluate(() => App._frameMoveRegionId !== null);
  ok(modeChk, '移动分区框模式开启');
  // 在框内空白处拖动（仅框移动）
  const dragPt = await page.evaluate(() => {
    const el = document.querySelector('#regionsSvg [data-region-id="' + App.canvasState.regions[0].id + '"].region-rect');
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.bottom - 15 };
  });
  await page.mouse.move(dragPt.x, dragPt.y);
  await page.mouse.down();
  await page.mouse.move(dragPt.x + 100, dragPt.y + 30, { steps: 10 });
  await page.mouse.up();
  await sleep(400);
  const res = await page.evaluate(() => {
    const r = App.canvasState.regions[0];
    return { rx: r.x, ry: r.y };
  });
  const nodesAfter = await page.evaluate(() => App.canvasState.nodes.map(n => ({ x: n.x, y: n.y })));
  const regionMoved = Math.abs(res.rx - curR.rx) > 80;
  const nodesMoved = nodesAfter.some((n, i) => Math.abs(n.x - nodesBefore[i].x) > 1 || Math.abs(n.y - nodesBefore[i].y) > 1);
  ok(regionMoved, '仅移动框体：分区移动 ' + (res.rx - curR.rx));
  ok(!nodesMoved, '仅移动框体：节点未随动');
  // Escape 退出模式
  await page.keyboard.press('Escape');
  await sleep(200);
  const modeChk2 = await page.evaluate(() => App._frameMoveRegionId === null);
  ok(modeChk2, 'Escape 退出移动分区框模式');
  await page.screenshot({ path: path.join(SHOTS, '10_frame_move.png') });

  // ── 12) 右键"调整分区框大小"：四角手柄拖动改框大小，节点不变 ──
  const beforeR2 = await page.evaluate(() => {
    const r = App.canvasState.regions[0];
    return { x: r.x, y: r.y, w: r.w, h: r.h };
  });
  const nodesBefore2 = await page.evaluate(() => App.canvasState.nodes.map(n => ({ x: n.x, y: n.y })));
  const rp3 = await page.evaluate(() => {
    const el = document.querySelector('#regionsSvg .region-rect');
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(rp3.x, rp3.y, { button: 'right' });
  await sleep(250);
  const rzItem = await page.evaluate(() => {
    const b = document.getElementById('ctxRegionResize');
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(rzItem.x, rzItem.y);
  await sleep(300);
  const handleCount = await page.evaluate(() => document.querySelectorAll('#regionsSvg .region-rsz-handle').length);
  ok(handleCount === 4, '调整分区框大小显示 4 个手柄，实际 ' + handleCount);
  // 拖动 se 手柄扩大
  const seHandle = await page.evaluate(() => {
    const h = document.querySelector('#regionsSvg .region-rsz-handle[data-dir="se"]');
    const r = h.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(seHandle.x, seHandle.y);
  await page.mouse.down();
  await page.mouse.move(seHandle.x + 120, seHandle.y + 60, { steps: 10 });
  await page.mouse.up();
  await sleep(400);
  const afterR2 = await page.evaluate(() => {
    const r = App.canvasState.regions[0];
    return { x: r.x, y: r.y, w: r.w, h: r.h };
  });
  const nodesAfter2 = await page.evaluate(() => App.canvasState.nodes.map(n => ({ x: n.x, y: n.y })));
  ok(afterR2.w > beforeR2.w + 80 && afterR2.h > beforeR2.h + 40, 'se 手柄拖拽后分区变大 ' + JSON.stringify(beforeR2) + '→' + JSON.stringify(afterR2));
  ok(!nodesAfter2.some((n, i) => Math.abs(n.x - nodesBefore2[i].x) > 1 || Math.abs(n.y - nodesBefore2[i].y) > 1), '调整大小后节点未移动');
  await page.keyboard.press('Escape');
  await sleep(200);
  const handleGone = await page.evaluate(() => document.querySelectorAll('#regionsSvg .region-rsz-handle').length);
  ok(handleGone === 0, 'Escape 退出调整模式并移除手柄');
  await page.screenshot({ path: path.join(SHOTS, '11_region_resize.png') });

  // ── 13) 连线端点归属：框内节点 + 框外节点连线，整体移动时只动框内端 ──
  await page.evaluate(() => {
    // 直接构造：inNode 在框内、outNode 在框外、两者间一条连线
    App.canvasState.nodes = [
      { id: 'in', label: 'in', desc: '', color: 'blue', x: 0, y: 0, mirrored: false, w: 170, h: 80 },
      { id: 'out', label: 'out', desc: '', color: 'blue', x: 600, y: 0, mirrored: false, w: 170, h: 80 }
    ];
    App.canvasState.connections = [{ id: 'c1', from: 'in', to: 'out', label: '', mirrored: false }];
    //显式归属：'in' 是 rgA 的直属成员，'out' 无归属。
    App.canvasState.regions = [{ id: 'rgA', label: 'A', color: 'blue', x: -100, y: -100, w: 400, h: 300, nodeIds: ['in'], parentId: null }];
    App.canvasState.history = [];
    App.canvasHistoryIndex = -1;
    App.saveCanvasSnapshot();
    App.renderCanvas();
  });
  await sleep(350);
  // 记录起点（世界坐标）与连线
  const s13 = await page.evaluate(() => ({
    inX: App.canvasState.nodes.find(n => n.id === 'in').x,
    outX: App.canvasState.nodes.find(n => n.id === 'out').x,
    rx: App.canvasState.regions[0].x
  }));
  // 在框内空白处拖动（左键默认联动移动）
  const dragP13 = await page.evaluate(() => {
    const el = document.querySelector('#regionsSvg .region-rect');
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.bottom - 15 };
  });
  // 新语义：先单击选中分区，再拖才移动
  await page.mouse.move(dragP13.x, dragP13.y);
  await page.mouse.down();
  await page.mouse.up();
  await sleep(350);   // 等 click 选中完成且超过双击判定窗
  await page.mouse.move(dragP13.x, dragP13.y);
  await page.mouse.down();
  await page.mouse.move(dragP13.x + 150, dragP13.y + 20, { steps: 10 });
  await page.mouse.up();
  await sleep(400);
  const a13 = await page.evaluate(() => ({
    inX: App.canvasState.nodes.find(n => n.id === 'in').x,
    outX: App.canvasState.nodes.find(n => n.id === 'out').x,
    rx: App.canvasState.regions[0].x
  }));
  ok(Math.abs(a13.inX - s13.inX) > 100, '框内节点随框移动（Δ ' + (a13.inX - s13.inX) + '）');
  ok(Math.abs(a13.outX - s13.outX) < 1, '框外节点不移动（Δ ' + (a13.outX - s13.outX) + '）');
  ok(Math.abs(a13.rx - s13.rx) > 100, '分区框已移动（Δ ' + (a13.rx - s13.rx) + '）');
  await page.screenshot({ path: path.join(SHOTS, '12_conn_ownership.png') });

  // ── 14) 选中样式为实线加深加粗（无虚线）；右键模式动作不弹通知 ──
  // 点选分区（单击选中）
  const selPt = await page.evaluate(() => {
    const el = document.querySelector('#regionsSvg .region-rect');
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.bottom - 20 };
  });
  await page.mouse.click(selPt.x, selPt.y);
  await sleep(300);
  const selStyle = await page.evaluate(() => {
    const el = document.querySelector('#regionsSvg .region-rect.selected');
    if (!el) return { found: false };
    return {
      found: true,
      sw: el.getAttribute('stroke-width'),
      dash: el.getAttribute('stroke-dasharray'),
      cls: el.getAttribute('class'),
      so: el.getAttribute('stroke-opacity')
    };
  });
  ok(selStyle.found && selStyle.dash === null && parseFloat(selStyle.sw) >= 1.5, '选中分区为实线加粗（stroke-width=' + selStyle.sw + '）');
  // 右键 → 移动分区框：不弹 toast
  await page.mouse.click(selPt.x, selPt.y, { button: 'right' });
  await sleep(250);
  const mvBtn = await page.evaluate(() => {
    const b = document.getElementById('ctxRegionMove');
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(mvBtn.x, mvBtn.y);
  await sleep(250);
  const toastAfterMove = await page.evaluate(() => document.getElementById('toastContainer').children.length);
  ok(toastAfterMove === 0, '点击 移动分区框 不弹通知（toast=' + toastAfterMove + '）');
  await page.keyboard.press('Escape');
  await sleep(150);
  // 右键 → 调整分区框大小：不弹 toast
  await page.mouse.click(selPt.x, selPt.y, { button: 'right' });
  await sleep(250);
  const rzBtn = await page.evaluate(() => {
    const b = document.getElementById('ctxRegionResize');
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(rzBtn.x, rzBtn.y);
  await sleep(250);
  const toastAfterResize = await page.evaluate(() => document.getElementById('toastContainer').children.length);
  ok(toastAfterResize === 0, '点击 调整分区框大小 不弹通知（toast=' + toastAfterResize + '）');
  await page.keyboard.press('Escape');
  await sleep(200);

  // ── 15) 双击分区标签 → contenteditable 直接改名（同节点标题，无输入框）──
  const labelPt = await page.evaluate(() => {
    const t = document.querySelector('#regionLabels .region-label');
    const r = t.getBoundingClientRect();
    // 单字符标签文字窄，取字形内靠左点（left+2 仍在字内）。
    return { x: r.left + Math.min(4, r.width / 2), y: r.top + r.height / 2 };
  });
  // CDP 双击（clickCount 1→2）
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: labelPt.x, y: labelPt.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: labelPt.x, y: labelPt.y, button: 'left', buttons: 1, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: labelPt.x, y: labelPt.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(60);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: labelPt.x, y: labelPt.y, button: 'left', buttons: 1, clickCount: 2 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: labelPt.x, y: labelPt.y, button: 'left', buttons: 0, clickCount: 2 });
  await sleep(400);
  const editableState = await page.evaluate(() => {
    const t = document.querySelector('#regionLabels .region-label');
    // 无 inlineEdit 浮层（display 来自 CSS，用计算样式判定）；
    // 标签本身进入 contenteditable 编辑态。
    const overlay = document.getElementById('inlineEdit');
    return {
      editable: t && t.isContentEditable,
      cls: t ? t.className : '',
      overlayHidden: !overlay || getComputedStyle(overlay).display === 'none'
    };
  });
  ok(editableState.editable && editableState.overlayHidden, '双击标签：原位 contenteditable 编辑（无输入框浮层）');
  // 全选替换文本并提交（Ctrl+A 后输入，再 Enter）
  await page.evaluate(() => {
    const t = document.querySelector('#regionLabels .region-label');
    const range = document.createRange();
    range.selectNodeContents(t);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await page.keyboard.press('Backspace');
  await page.keyboard.type('命名区');
  await page.keyboard.press('Enter');
  await sleep(350);
  const renamed = await page.evaluate(() => App.canvasState.regions[0].label);
  ok(renamed === '命名区', '改名保存为 ' + renamed);
  await page.screenshot({ path: path.join(SHOTS, '13_label_rename.png') });

  // ── 16) 调整大小手柄复用节点手柄视觉（圆角、accent、10px 世界边长）并缩放不丢失 ──
  // 右键 → 调整分区框大小
  const rp16 = await page.evaluate(() => {
    const el = document.querySelector('#regionsSvg .region-rect');
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.bottom - 18 };
  });
  await page.mouse.click(rp16.x, rp16.y, { button: 'right' });
  await sleep(250);
  const rz16 = await page.evaluate(() => {
    const b = document.getElementById('ctxRegionResize');
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(rz16.x, rz16.y);
  await sleep(350);
  const hStyle = await page.evaluate(() => {
    const h = document.querySelector('#regionsSvg .region-rsz-handle[data-dir="se"]');
    const r = h.getBoundingClientRect();
    return {
      rx: h.getAttribute('rx'), w: r.width,
      fill: h.getAttribute('fill'),
      stroke: h.getAttribute('stroke'),
      hasFrame: !!document.querySelector('#regionsSvg .region-resize-frame')
    };
  });
  ok(parseFloat(hStyle.rx) > 0 && hStyle.fill === '#fff' && hStyle.stroke === '#3b82f6' && hStyle.w >= 9,
    '手柄有圆角/白底/accent 描边/约 10px（' + JSON.stringify(hStyle) + '）');
  ok(hStyle.hasFrame, '调整模式含外圈虚线框（同节点 resizing 伪元素）');
  // 滚轮缩放（放大到 ~1.3x）后手柄仍在
  const stage16 = await page.evaluate(() => {
    const s = document.getElementById('canvasStage').getBoundingClientRect();
    return { cx: s.left + s.width / 2, cy: s.top + s.height / 2 };
  });
  await page.mouse.move(stage16.cx, stage16.cy);
  for (let i = 0; i < 6; i++) await page.mouse.wheel({ deltaY: -100 });
  await sleep(400);
  const afterZoom = await page.evaluate(() => ({
    handles: document.querySelectorAll('#regionsSvg .region-rsz-handle').length,
    frame: !!document.querySelector('#regionsSvg .region-resize-frame'),
    scale: App.scale,
    mode: App._regionResizeId !== null
  }));
  ok(afterZoom.handles === 4 && afterZoom.frame && afterZoom.mode, '滚轮缩放后手柄与虚线框保留（' + JSON.stringify(afterZoom) + '）');
  await page.keyboard.press('Escape');
  await sleep(250);
  const cleared = await page.evaluate(() => document.querySelectorAll('#regionsSvg .region-rsz-handle').length === 0 && App._regionResizeId === null);
  ok(cleared, 'Escape 退出后手柄清除');
  await page.screenshot({ path: path.join(SHOTS, '14_handles_zoom.png') });

  // ── 17) 右键菜单分组：编辑 ｜ 属性 ｜ 移动/调整 ｜ 删除（属性在第二组）──
  const rp17 = await page.evaluate(() => {
    const el = document.querySelector('#regionsSvg .region-rect');
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.bottom - 18 };
  });
  await page.mouse.click(rp17.x, rp17.y, { button: 'right' });
  await sleep(250);
  const seps = await page.evaluate(() => {
    const visible = Array.from(document.querySelectorAll('#ctx > *')).filter(el => el.style.display !== 'none');
    const sepCount = visible.filter(el => el.classList.contains('sep2')).length;
    const order = visible.map(el => el.textContent.trim() || '──').filter(Boolean);
    return { sepCount, order };
  });
  // 4 组 = 3 条分隔；属性是第二组（第一项 编辑 之后、下一条分隔之前）。
  const idxProps = seps.order.indexOf('属性');
  ok(seps.sepCount === 3 && idxProps === 2 && seps.order[0] === '编辑' && seps.order[seps.order.length - 1] === '删除',
    '分区菜单四组分隔，属性位于第二组: ' + JSON.stringify(seps));
  await page.screenshot({ path: path.join(SHOTS, '15_ctx_groups.png') });
  // 点击空白关闭菜单（document 捕获 click 隐藏 ctx）
  const blank17 = await page.evaluate(() => {
    const s = document.getElementById('canvasStage').getBoundingClientRect();
    return { x: s.left + s.width - 30, y: s.top + 30 };
  });
  await page.mouse.click(blank17.x, blank17.y);
  await sleep(150);

  // ── 18) "分区位置/大小对齐网格"双开关：与节点对齐设置同构 ──
  const snapUi = await page.evaluate(() => ({
    posExists: !!document.getElementById('setSnapRegionPos'),
    sizeExists: !!document.getElementById('setSnapRegionSize'),
    posDef: App._snapRegionPos,
    sizeDef: App._snapRegionSize
  }));
  ok(snapUi.posExists && snapUi.sizeExists && snapUi.posDef === true && snapUi.sizeDef === true,
    '双开关存在：位置/大小默认均开启 ' + JSON.stringify(snapUi));
  // 视口归位：scale=1、pan=0 → 屏幕相对坐标 == 世界坐标
  await page.evaluate(() => {
    App._snapRegionPos = false;
    document.getElementById('setSnapRegionPos').checked = false;
    App.scale = 1; App.panX = 0; App.panY = 0;
    App.applyViewTransform();
    App.saveCanvas();
  });
  const rr18 = await page.evaluate(() => {
    const s = document.getElementById('canvasStage').getBoundingClientRect();
    return { left: s.left, top: s.top };
  });
  // 起终点选非 20 倍数的屏幕相对坐标（137,91）→（333,217），位置吸附关闭应原样保留
  await page.keyboard.down('Alt');
  await page.mouse.move(rr18.left + 137, rr18.top + 91);
  await page.mouse.down();
  await page.mouse.move(rr18.left + 333, rr18.top + 217, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await sleep(350);
  const created = await page.evaluate(() => {
    const regs = App.canvasState.regions;
    const r = regs[regs.length - 1];
    return { x: r.x, y: r.y, w: r.w, h: r.h, n: regs.length };
  });
  const xMod = created.x % 20, yMod = created.y % 20;
  ok(xMod !== 0 && yMod !== 0, '关闭位置吸附后创建的分区坐标为像素级（x%20=' + xMod + ', y%20=' + yMod + '）');
  // 恢复位置吸附（默认开）
  await page.evaluate(() => {
    App._snapRegionPos = true;
    document.getElementById('setSnapRegionPos').checked = true;
  });
  // 重新开吸附后再画一个框 → 坐标对齐 20
  await page.keyboard.down('Alt');
  await page.mouse.move(rr18.left + 137, rr18.top + 91);
  await page.mouse.down();
  await page.mouse.move(rr18.left + 333, rr18.top + 217, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await sleep(350);
  const created2 = await page.evaluate(() => {
    const regs = App.canvasState.regions;
    const r = regs[regs.length - 1];
    return { x: r.x, y: r.y, n: regs.length };
  });
  ok(created2.x % 20 === 0 && created2.y % 20 === 0, '开启位置吸附后创建的分区坐标对齐网格（x=' + created2.x + ', y=' + created2.y + '）');
  // 尺寸开关独立验证：先显式关闭位置与大小吸附（新默认两者均开启）
  // → 框宽高保留像素（起终点 137→333 宽 196）；再开启大小 → 宽高为 20 倍数
  await page.evaluate(() => {
    App._snapRegionPos = false;
    document.getElementById('setSnapRegionPos').checked = false;
    App._snapRegionSize = false;
    document.getElementById('setSnapRegionSize').checked = false;
    //清空既有分区，避免 Alt 起点命中旧框而变成"移动分区"而非创建
    App.canvasState.regions = [];
    App.saveCanvas();
  });
  await page.keyboard.down('Alt');
  await page.mouse.move(rr18.left + 437, rr18.top + 91);
  await page.mouse.down();
  await page.mouse.move(rr18.left + 633, rr18.top + 217, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await sleep(350);
  const sizeOff = await page.evaluate(() => {
    const regs = App.canvasState.regions;
    const r = regs[regs.length - 1];
    return { w: r.w, h: r.h, sizeOn: App._snapRegionSize };
  });
  ok(sizeOff.w % 20 !== 0, '分区大小对齐 关闭后：创建框宽为像素级（w=' + sizeOff.w + '）');
  // 恢复位置吸附（默认开），仅测大小开关
  await page.evaluate(() => {
    App._snapRegionPos = true;
    document.getElementById('setSnapRegionPos').checked = true;
  });
  await page.evaluate(() => {
    App._snapRegionSize = true;
    document.getElementById('setSnapRegionSize').checked = true;
  });
  // 起终点避开 sizeOff 画的框（命中已存在分区会变成移动而非创建）
  await page.keyboard.down('Alt');
  await page.mouse.move(rr18.left + 737, rr18.top + 91);
  await page.mouse.down();
  await page.mouse.move(rr18.left + 933, rr18.top + 217, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await sleep(350);
  const sizeOn = await page.evaluate(() => {
    const regs = App.canvasState.regions;
    const r = regs[regs.length - 1];
    return { w: r.w, h: r.h };
  });
  ok(sizeOn.w % 20 === 0 && sizeOn.h % 20 === 0, '开启分区大小对齐：创建框宽高为网格倍数（w=' + sizeOn.w + ', h=' + sizeOn.h + '）');
  // 恢复默认（位置/大小均开启），供后续步骤使用
  await page.evaluate(() => {
    App._snapRegionSize = true;
    document.getElementById('setSnapRegionSize').checked = true;
  });
  await page.screenshot({ path: path.join(SHOTS, '16_snap_region.png') });

  // ── 19) 嵌套分区：小框被大框包含后，移动大框 → 小框与其中节点整体随动 ──
  await page.evaluate(() => {
    // 数据直写干净场景：inner 节点在 innerRegion 中；outerRegion 完全包含 innerRegion
    App.canvasState.nodes = [
      { id: 'nA', label: 'A', desc: '', color: 'blue', x: -60, y: -60, mirrored: false, w: 170, h: 80 },
      { id: 'nB', label: 'B', desc: '', color: 'green', x: 700, y: 500, mirrored: false, w: 170, h: 80 }
    ];
    App.canvasState.connections = [];
    //显式树形归属：nA 直属 inner；inner 是 outer 的子分区（parentId）。
    App.canvasState.regions = [
      { id: 'inner', label: '内部', color: 'blue', x: -120, y: -120, w: 300, h: 200, nodeIds: ['nA'], parentId: 'outer' },
      { id: 'outer', label: '外部', color: 'green', x: -300, y: -300, w: 800, h: 600, nodeIds: [], parentId: null }
    ];
    App.canvasState.history = [];
    App.canvasHistoryIndex = -1;
    App.saveCanvasSnapshot();
    App.renderCanvas();
  });
  await sleep(350);
  const before19 = await page.evaluate(() => {
    const byId = id => App.canvasState.regions.find(r => r.id === id);
    const inner = byId('inner'), outer = byId('outer');
    const nA = App.canvasState.nodes.find(n => n.id === 'nA');
    const nB = App.canvasState.nodes.find(n => n.id === 'nB');
    return { ix: inner.x, ox: outer.x, nax: nA.x, nbx: nB.x };
  });
  // 在外框内、内框与节点之外的空白按下拖动（世界 (460,100)：避开 nB 与 inner）
  const outerPt = await page.evaluate(() => {
    const s = document.getElementById('canvasStage').getBoundingClientRect();
    const wx = 460, wy = 100;
    return { x: wx * App.scale + App.panX + s.left, y: wy * App.scale + App.panY + s.top };
  });
  // 新语义：先单击选中 outer（点在内框外的外框空白），再拖才整体移动
  await page.mouse.move(outerPt.x, outerPt.y);
  await page.mouse.down();
  await page.mouse.up();
  await sleep(350);   // 等 click 选中完成且超过双击判定窗
  await page.mouse.move(outerPt.x, outerPt.y);
  await page.mouse.down();
  await page.mouse.move(outerPt.x + 120, outerPt.y + 60, { steps: 10 });
  await page.mouse.up();
  await sleep(400);
  const after19 = await page.evaluate(() => {
    const byId = id => App.canvasState.regions.find(r => r.id === id);
    const inner = byId('inner'), outer = byId('outer');
    const nA = App.canvasState.nodes.find(n => n.id === 'nA');
    const nB = App.canvasState.nodes.find(n => n.id === 'nB');
    return { ix: inner.x, ox: outer.x, nax: nA.x, nbx: nB.x };
  });
  ok(Math.abs(after19.ox - before19.ox) > 100, '外框移动（Δ ' + (after19.ox - before19.ox) + '）');
  ok(Math.abs(after19.ix - before19.ix) > 100 && Math.abs(after19.nax - before19.nax) > 100,
    '内框与其节点随外框移动（inner Δ ' + (after19.ix - before19.ix) + ', nodeA Δ ' + (after19.nax - before19.nax) + '）');
  ok(Math.abs(after19.nbx - before19.nbx) < 1, '外框外节点不移动（Δ ' + (after19.nbx - before19.nbx) + '）');
  await page.screenshot({ path: path.join(SHOTS, '17_nested_move.png') });

  // ── 20) 拖动分区自动吸附网格（回归：吸附代码曾被全局 mouseup 抢跑跳过）──
  await page.evaluate(() => {
    App._snapRegionPos = true;
    document.getElementById('setSnapRegionPos').checked = true;
    App.canvasState.nodes = [];
    App.canvasState.connections = [];
    App.canvasState.regions = [{ id: 'rgS', label: 'S', color: 'blue', x: 73, y: 47, w: 300, h: 200 }];
    App.canvasState.history = [];
    App.canvasHistoryIndex = -1;
    App.saveCanvasSnapshot();
    App.renderCanvas();
    App.scale = 1; App.panX = 0; App.panY = 0; App.applyViewTransform();
  });
  await sleep(350);
  const cpt = await page.evaluate(() => {
    const el = document.querySelector('#regionsSvg .region-rect');
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  // 新语义：先单击选中分区，再拖（吸附动画回归点不变）
  await page.mouse.move(cpt.x, cpt.y);
  await page.mouse.down();
  await page.mouse.up();
  await sleep(350);   // 等 click 选中完成且超过双击判定窗
  await page.mouse.move(cpt.x, cpt.y);
  await page.mouse.down();
  await page.mouse.move(cpt.x + 137, cpt.y + 91, { steps: 8 });
  // 记录松手瞬间的鼠标与区域位置（吸附动画起点）
  const preUp = await page.evaluate(() => { const r = App.canvasState.regions[0]; return { x: r.x, y: r.y }; });
  await page.mouse.up();
  // 动画过程断言：mouseup 后 ~50ms 内动画应进行中（_regionSnapAnim 非空
  // 且坐标已离开起点、尚未到达 20px 网格目标——中间帧）
  await sleep(50);
  const mid = await page.evaluate(() => {
    const r = App.canvasState.regions[0];
    return { x: r.x, y: r.y, anim: !!App._regionSnapAnim, n: App._activeSnapAnims.size };
  });
  const moving = mid.anim && mid.n >= 1 && (Math.abs(mid.x - preUp.x) > 1 || Math.abs(mid.y - preUp.y) > 1);
  ok(moving, '吸附动画进行中（50ms 采样：起点 ' + JSON.stringify(preUp) + ' → 中途 ' + JSON.stringify({ x: mid.x, y: mid.y }) + '）');
  await sleep(400);
  const snapOn = await page.evaluate(() => { const r = App.canvasState.regions[0]; return { x: r.x, y: r.y, hist: App.canvasState.history.length }; });
  ok(snapOn.x % 20 === 0 && snapOn.y % 20 === 0, '吸附开：拖动后自动吸附网格 (x=' + snapOn.x + ',y=' + snapOn.y + ')');
  ok(snapOn.hist >= 1, '吸附移动进入撤销栈 (history=' + snapOn.hist + ')');
  // 位置吸附关 → 像素级
  await page.evaluate(() => {
    App._snapRegionPos = false;
    document.getElementById('setSnapRegionPos').checked = false;
    const r = App.canvasState.regions[0];
    r.x = 73; r.y = 47;
    App.saveCanvasSnapshot(); App.renderCanvas();
  });
  await sleep(300);
  const cpt2 = await page.evaluate(() => {
    const el = document.querySelector('#regionsSvg .region-rect');
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(cpt2.x, cpt2.y);
  await page.mouse.down();
  await page.mouse.move(cpt2.x + 137, cpt2.y + 91, { steps: 8 });
  await page.mouse.up();
  await sleep(400);
  const snapOff = await page.evaluate(() => { const r = App.canvasState.regions[0]; return { x: r.x, y: r.y }; });
  ok(snapOff.x % 20 !== 0 || snapOff.y % 20 !== 0, '吸附关：保留像素级位置 (x=' + snapOff.x + ',y=' + snapOff.y + ')');
  await page.screenshot({ path: path.join(SHOTS, '18_drag_snap.png') });

  // ── 21) 新手势语义：未选中分区拖 = 平移画布；双击分区内空白 = 建节点且不选中 ──
  await page.evaluate(() => {
    App.selectedRegionId = null;   // 清上一场景遗留选中
    App.canvasState.regions = [{ id: 'rgG', label: 'G', color: 'blue', x: -150, y: -150, w: 400, h: 300, nodeIds: [], parentId: null }];
    App.canvasState.nodes = [];
    App.canvasState.connections = [];
    App.canvasState.history = [];
    App.canvasHistoryIndex = -1;
    App.panX = 0; App.panY = 0; App.scale = 1;
    App.saveCanvasSnapshot();
    App.renderCanvas();
    App.applyViewTransform();
  });
  await sleep(350);
  const gPt = await page.evaluate(() => {
    const el = document.querySelector('#regionsSvg .region-rect');
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  // 21a) 未选中 → 拖 = 平移（分区不动、pan 变）
  const g0 = await page.evaluate(() => ({ panX: App.panX, rx: App.canvasState.regions[0].x }));
  await page.mouse.move(gPt.x, gPt.y);
  await page.mouse.down();
  await page.mouse.move(gPt.x + 70, gPt.y + 40, { steps: 8 });
  await page.mouse.up();
  await sleep(300);
  const g1 = await page.evaluate(() => ({ panX: App.panX, rx: App.canvasState.regions[0].x, sel: App.selectedRegionId }));
  ok(Math.abs(g1.panX - g0.panX) > 30 && Math.abs(g1.rx - g0.rx) < 1,
    '未选中分区上拖 = 平移画布（panX Δ' + (g1.panX - g0.panX) + '，分区未动）');
  ok(g1.sel === null, '拖动平移后分区不被选中（sel=' + g1.sel + '）');
  // 复位
  await page.evaluate(() => { App.panX = 0; App.panY = 0; App.applyViewTransform(); });
  await sleep(200);
  // 21b) 单击选中 → 再拖 = 移动
  const gPt2 = await page.evaluate(() => {
    const el = document.querySelector('#regionsSvg .region-rect');
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(gPt2.x, gPt2.y);
  await page.mouse.down();
  await page.mouse.up();
  await sleep(350);   // 等 click 选中完成且超过双击判定窗
  const sel21 = await page.evaluate(() => App.selectedRegionId);
  ok(sel21 === 'rgG', '单击未选中分区 = 选中（sel=' + sel21 + '）');
  const m0 = await page.evaluate(() => App.canvasState.regions[0].x);
  await page.mouse.move(gPt2.x, gPt2.y);
  await page.mouse.down();
  await page.mouse.move(gPt2.x - 90, gPt2.y - 50, { steps: 8 });
  await page.mouse.up();
  await sleep(350);
  const m1 = await page.evaluate(() => ({ rx: App.canvasState.regions[0].x, panX: App.panX }));
  ok(Math.abs(m1.rx - m0) > 50 && Math.abs(m1.panX) < 1, '已选中分区拖 = 移动分区（Δx ' + (m1.rx - m0) + '，画布未平移）');
  // 21c) 双击分区内空白 = 建节点且不选中分区
  const dblPt21 = await page.evaluate(() => {
    const el = document.querySelector('#regionsSvg .region-rect');
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width * 0.8, y: r.top + r.height * 0.8 };
  });
  const nBefore21 = await page.evaluate(() => App.canvasState.nodes.length);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dblPt21.x, y: dblPt21.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dblPt21.x, y: dblPt21.y, button: 'left', buttons: 1, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dblPt21.x, y: dblPt21.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(60);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dblPt21.x, y: dblPt21.y, button: 'left', buttons: 1, clickCount: 2 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dblPt21.x, y: dblPt21.y, button: 'left', buttons: 0, clickCount: 2 });
  await sleep(350);
  const a21 = await page.evaluate(() => ({
    nodes: App.canvasState.nodes.length,
    selRegion: App.selectedRegionId,
    selNodes: App.selectedNodeIds.size
  }));
  ok(a21.nodes === nBefore21 + 1, '双击分区内空白 = 建节点（' + nBefore21 + '→' + a21.nodes + '）');
  ok(a21.selRegion === null && a21.selNodes === 1, '双击建节点后分区不选中（selRegion=' + a21.selRegion + '），新节点选中（selNodes=' + a21.selNodes + '）');
  await page.screenshot({ path: path.join(SHOTS, '19_gesture_semantics.png') });

  console.log(failures === 0 ? '\n✅ 分区测试全部通过' : '\n❌ ' + failures + ' 项失败');
  await browser.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });

