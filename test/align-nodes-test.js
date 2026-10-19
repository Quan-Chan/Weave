'use strict';
// 高度对齐工具（侧边栏）· GUI 守护：
//  仅时序图 —— 工具只在时序图模式提供：节点图模式下侧边栏入口隐藏，
//           键位路径同样拒绝开启，模式切换时自动收起。
//  操作模式 —— 无选中时点击把**全部**节点拉到该高度（默认模式）；
//           已选中节点时只拉选中的（选定模式）。
//  判定机制 —— "松手后完成操作"：按下只起手、拖动只更新参考线与目标高亮，
//           松开鼠标才真正移动节点。
//  其他 —— 目标高度按对齐设置吸附、目标节点高亮、Escape 退出、可撤销。
// 复用统一台架 test/helpers/launch.js。
const { launchBrowser, openApp, sleep, assertions } = require('./helpers/launch.js');

const t = assertions('align');

// 三个不同高度的节点，纵向中心分别为 -160 / 40 / 240。
const LAYOUT = () => {
  const mk = (id, label, x, y) => ({ id, label, desc: '', color: 'blue', x, y, mirrored: false, w: 180, h: 80 });
  App.canvasState.nodes = [mk('n1', 'A', 0, -200), mk('n2', 'B', 400, 0), mk('n3', 'C', 800, 200)];
  App.canvasState.connections = [];
  App.canvasState.regions = [];
  App._nodeZOrder = ['n1', 'n2', 'n3'];
  App.selectedNodeIds.clear();
  App.selectedRegionId = null;
  App.canvasState.history = [];
  App.canvasHistoryIndex = -1;
  App.scale = 1; App.panX = 0; App.panY = 0;
  App.saveCanvasSnapshot();
  App.renderCanvas({ center: false });
  App.applyViewTransform();
};

// 各节点纵向中心（世界 y）。
const CENTERS = () => App.canvasState.nodes.map(n => n.y + n.h / 2);

// 工具与画布的外壳状态。
const TOOL_STATE = () => ({
  active: App._alignModeActive,
  btnActive: document.getElementById('btnAlignNodes').classList.contains('active'),
  canvasClass: document.getElementById('canvasStage').classList.contains('align-mode'),
  previewShown: getComputedStyle(document.getElementById('alignPreview')).display !== 'none',
  previewLabel: document.getElementById('alignPreviewLabel').textContent,
  targets: document.querySelectorAll('.node.align-target').length
});

// 世界坐标 → 屏幕坐标（与 App.getWorldPos 互为逆运算）。
const worldToScreen = (page, wx, wy) => page.evaluate(([x, y]) => {
  const r = document.getElementById('canvasStage').getBoundingClientRect();
  return { x: r.left + x * App.scale + App.panX, y: r.top + y * App.scale + App.panY };
}, [wx, wy]);

// toast 容器固定在左下角且 .toast 自身 pointer-events:auto，会挡住落在它上面的
// 画布点击（与工具无关的既有行为）。按下前清空，使取点不受提示时序影响。
const clearToasts = page => page.evaluate(() => {
  document.getElementById('toastContainer').textContent = '';
});

// 取一个空白世界坐标：x 取 700（避开左下角 toast 区与全部节点），y 由调用方给。
const BLANK_X = 700;

// 复合断言里要用的页面级辅助（只注入一次）。
const INSTALL = () => {
  window.__alignCenters = () => App.canvasState.nodes.map(n => n.y + n.h / 2);
  window.__alignTops = () => App.canvasState.nodes.map(n => n.y);
  window.__alignLayout = () => {
    const mk = (id, label, x, y) => ({ id, label, desc: '', color: 'blue', x, y, mirrored: false, w: 180, h: 80 });
    App.canvasState.nodes = [mk('n1', 'A', 0, -200), mk('n2', 'B', 400, 0), mk('n3', 'C', 800, 200)];
    App.canvasState.connections = [];
    App.canvasState.regions = [];
    App._nodeZOrder = ['n1', 'n2', 'n3'];
    App.selectedNodeIds.clear();
    App.selectedRegionId = null;
    App.canvasState.history = [];
    App.canvasHistoryIndex = -1;
    App.scale = 1; App.panX = 0; App.panY = 0;
    App.saveCanvasSnapshot();
    App.renderCanvas({ center: false });
    App.applyViewTransform();
  };
};

(async () => {
  const { browser, cleanup } = await launchBrowser(false);
  try {
    const { page } = await openApp(browser);
    // 高度对齐是时序图专有：全部用例在时序图模式下执行。
    await page.evaluate(() => App._setMode('sequence'));
    await sleep(450);
    await page.evaluate(INSTALL);

    // ── 1) 侧边栏按钮就位，默认关闭 ──
    const btn = await page.evaluate(() => {
      const b = document.getElementById('btnAlignNodes');
      return {
        exists: !!b,
        inSidebar: !!(b && b.closest('#sidebar')),
        modeHidden: b ? b.classList.contains('mode-hidden') : null,
        active: b ? b.classList.contains('active') : null,
        title: b ? b.getAttribute('title') : null
      };
    });
    t.ok('时序图模式下高度对齐按钮位于右侧边栏', btn.exists && btn.inSidebar && btn.modeHidden === false, btn);
    t.ok('工具默认关闭（按钮不高亮）', btn.active === false, btn);

    await page.evaluate(LAYOUT);
    await sleep(250);

    // ── 2) 点击按钮开启：按钮高亮 + 画布加 align-mode 类 ──
    await page.click('#btnAlignNodes');
    await sleep(200);
    const on = await page.evaluate(TOOL_STATE);
    t.ok('开启后工具状态与按钮高亮同步', on.active === true && on.btnActive === true, on);
    t.ok('画布加上 align-mode 类（光标变为十字）', on.canvasClass === true, on);

    // ── 3) 按住 Alt 不改变对齐手势（分区创建是节点图路径，与时序图互不干扰）──
    await clearToasts(page);
    const altPoint = await worldToScreen(page, BLANK_X, 600);
    await page.mouse.move(altPoint.x, altPoint.y);
    await page.keyboard.down('Alt');
    await page.mouse.down();
    await page.mouse.move(altPoint.x + 60, altPoint.y + 40);
    await sleep(80);
    const altState = await page.evaluate(() => ({ region: !!App.regionDragState, align: !!App.alignDragState }));
    await page.mouse.up();
    await page.keyboard.up('Alt');
    await sleep(250);
    t.ok('按住 Alt 拖拽仍进入高度对齐（时序图模式无分区路径）', altState.region === false && altState.align === true, altState);

    // ── 4) 默认模式：按下只起手，松手才把全部节点拉到该高度 ──
    await page.evaluate(LAYOUT);
    await sleep(250);
    const before = await page.evaluate(CENTERS);
    await clearToasts(page);
    const p1 = await worldToScreen(page, BLANK_X, 600);
    await page.mouse.move(p1.x, p1.y);
    await page.mouse.down();
    await sleep(120);
    const idle = await page.evaluate(TOOL_STATE);
    t.ok('按下后尚未开始对齐：不显示参考线、不高亮目标（此时松手即常规单击）',
      idle.previewShown === false && idle.targets === 0, idle);
    // 越过长按阈值后才开始对齐（ALIGN_HOLD_MS = 触控长按同一个 500ms）。
    await sleep(520);
    const held = await page.evaluate(TOOL_STATE);
    const centersHeld = await page.evaluate(CENTERS);
    t.ok('长按后开始对齐：参考线显示、目标节点全部高亮',
      held.previewShown === true && held.targets === 3, held);
    t.ok('按下并长按后节点尚未移动（判定为松手完成，不是点击即操作）',
      JSON.stringify(centersHeld) === JSON.stringify(before), { before: before, held: centersHeld });

    // 拖动到另一个高度：仍不移动，只更新参考线。
    const p2 = await worldToScreen(page, BLANK_X, 460);
    await page.mouse.move(p2.x, p2.y);
    await sleep(150);
    const dragged = await page.evaluate(TOOL_STATE);
    const centersDragged = await page.evaluate(CENTERS);
    t.ok('拖动过程中参考线跟随，节点仍不动',
      dragged.previewShown === true && JSON.stringify(centersDragged) === JSON.stringify(before), dragged);
    //参考线停在格子划分线上（460 = 23 格），下面的落点断言证明节点左上角正好
    //压在这条线上——也就是落进了它下方那一格。
    t.ok('参考线吸附到格子划分线上（23 格 = 460）',
      dragged.previewLabel === '23 格', dragged);

    await page.mouse.up();
    await sleep(300);
    const after = await page.evaluate(() => ({
      centers: window.__alignCenters(),
      tops: window.__alignTops(),
      sel: App.selectedNodeIds.size,
      previewDisplay: getComputedStyle(document.getElementById('alignPreview')).display,
      targets: document.querySelectorAll('.node.align-target').length
    }));
    t.ok('松手后全部节点左上角落在参考线所在格线上（y = 460），而不是纵向中心',
      after.tops.every(y => y === 460), after);
    t.ok('参考线与落点都吸附到格（460 = 23 格）',
      after.tops[0] % 20 === 0, after);
    t.ok('松手后参考线与目标高亮一并清除',
      after.previewDisplay === 'none' && after.targets === 0, after);
    t.ok('松手后的补发 click 不清除选中', after.sel === 0, after);

    // ── 5) 选定模式：先选节点，再拉高度时只动选中的 ──
    await page.evaluate(() => {
      window.__alignLayout();
      App.selectedNodeIds.add('n1');
      App.selectedNodeIds.add('n3');
      App.renderCanvas({ center: false });
    });
    await sleep(250);
    const selBefore = await page.evaluate(CENTERS);
    await clearToasts(page);
    const p3 = await worldToScreen(page, BLANK_X, 300);
    await page.mouse.move(p3.x, p3.y);
    await page.mouse.down();
    // 位移越过 ALIGN_DRAG_SLOP 即开始对齐（12/6 像素的释放点仍吸附到同一格 300）。
    await page.mouse.move(p3.x + 12, p3.y + 6);
    await sleep(120);
    const selHeld = await page.evaluate(TOOL_STATE);
    t.ok('选定模式下只高亮被选中的节点', selHeld.targets === 2, selHeld);
    await page.mouse.up();
    await sleep(300);
    const selAfter = await page.evaluate(() => ({
      centers: window.__alignCenters(),
      tops: window.__alignTops(),
      sel: App.selectedNodeIds.size
    }));
    t.ok('只有选中的两个节点左上角落到格线 300（视觉上落进它下方的格子）',
      selAfter.tops[0] === 300 && selAfter.tops[2] === 300, { before: selBefore, after: selAfter });
    t.ok('未选中的节点保持原位', selAfter.centers[1] === selBefore[1], { before: selBefore, after: selAfter });
    t.ok('对齐后选中仍在（补发 click 被吞掉）', selAfter.sel === 2, selAfter);

    // ── 5b) 常规单击：取消选中，且不对齐 ──
    const clickCase = await (async () => {
      await page.evaluate(() => {
        window.__alignLayout();
        App.selectedNodeIds.add('n1');
        App.selectedNodeIds.add('n2');
        App.renderCanvas({ center: false });
      });
      await sleep(250);
      const before = await page.evaluate(() => ({ centers: window.__alignCenters(), sel: App.selectedNodeIds.size }));
      await clearToasts(page);
      const pt = await worldToScreen(page, BLANK_X, 600);
      await page.mouse.click(pt.x, pt.y);
      await sleep(320);
      const after = await page.evaluate(() => ({
        centers: window.__alignCenters(),
        sel: App.selectedNodeIds.size,
        preview: getComputedStyle(document.getElementById('alignPreview')).display,
        targets: document.querySelectorAll('.node.align-target').length
      }));
      return { before: before, after: after };
    })();
    t.ok('单击前有两个节点被选中', clickCase.before.sel === 2, clickCase.before);
    t.ok('常规单击取消选中，且一个节点都没被对齐',
      clickCase.after.sel === 0 &&
      JSON.stringify(clickCase.after.centers) === JSON.stringify(clickCase.before.centers), clickCase);
    t.ok('常规单击不留下参考线与目标高亮',
      clickCase.after.preview === 'none' && clickCase.after.targets === 0, clickCase.after);

    // ── 6) 可撤销 ──
    const undone = await page.evaluate(() => { App.canvasUndo(); return window.__alignCenters(); });
    t.ok('撤销可还原对齐前的布局',
      JSON.stringify(undone) === JSON.stringify(selBefore), { before: selBefore, after: undone });

    // ── 7) Escape 退出工具 ──
    await page.keyboard.press('Escape');
    await sleep(250);
    const off = await page.evaluate(TOOL_STATE);
    t.ok('Escape 退出高度对齐', off.active === false && off.btnActive === false && off.canvasClass === false, off);

    // ── 8) 节点图模式下不可用：入口隐藏、键位路径拒绝开启，切回即恢复 ──
    await page.evaluate(() => App._setMode('graph'));
    await sleep(450);
    const graphBtn = await page.evaluate(() => ({
      hidden: document.getElementById('btnAlignNodes').classList.contains('mode-hidden'),
      active: App._alignModeActive
    }));
    t.ok('节点图模式下高度对齐入口被隐藏', graphBtn.hidden === true && graphBtn.active === false, graphBtn);
    await page.evaluate(() => App.toggleAlignMode());
    await sleep(150);
    const refused = await page.evaluate(TOOL_STATE);
    t.ok('节点图模式下键位路径拒绝开启高度对齐', refused.active === false && refused.btnActive === false, refused);
    await page.evaluate(() => App._setMode('sequence'));
    await sleep(450);
    const backHidden = await page.evaluate(() => document.getElementById('btnAlignNodes').classList.contains('mode-hidden'));
    t.ok('切回时序图模式后入口恢复', backHidden === false, { modeHidden: backHidden });
  } finally {
    await cleanup();
  }
  console.log(t.fails === 0 ? '\n✅ 高度对齐工具 GUI 守护全部通过' : '\n❌ ' + t.fails + ' 项失败');
  process.exit(t.fails === 0 ? 0 : 1);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
