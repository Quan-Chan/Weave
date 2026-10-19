'use strict';
// 节点尺寸调整专项 GUI 守护：
//   无级调节 —— 拖动中尺寸连续跟随光标（不吸附，因此不会是整格值）
//   吸附动画 —— 松手后经同一套过冲曲线平滑落到吸附尺寸，而不是瞬间跳变
//   吸附开关 —— 「节点大小对齐」关闭后只收敛到整像素
//   对面角固定 —— 拖动中与吸附动画的每一帧都保持对面角不动
//   最小尺寸 —— 钳到 NODE_MIN_W/H
//   可撤销 / 动画不泄漏
// 复用统一台架 test/helpers/launch.js。
const { launchBrowser, openApp, sleep, assertions } = require('./helpers/launch.js');

const t = assertions('resize');
const near = (a, b, eps) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= (eps === undefined ? 1 : eps);

// 动画集合与两个流都归零 = 吸附动画彻底结束（不依赖固定 sleep）。
async function waitAnimEnd(page) {
  await page.waitForFunction(
    () => App._activeSnapAnims.size === 0 && App._snapDataInterval === null && App._snapRenderRaf === null,
    { timeout: 5000 }
  );
  await page.evaluate(async () => {
    for (let i = 0; i < 2; i++) await new Promise(r => requestAnimationFrame(r));
  });
}

// 一个 180×80 的节点 + 进入调整大小模式。
const SETUP = () => {
  App._nodeElMap.forEach(el => App._cancelSnapAnim(el));
  App._setMode('graph');
  App.canvasState.nodes = [{ id: 'r1', label: 'R', desc: '', color: 'blue', x: 0, y: 0, w: 180, h: 80, mirrored: false }];
  App.canvasState.connections = [];
  App.canvasState.regions = [];
  App.canvasState.history = [];
  App.canvasHistoryIndex = -1;
  App._nodeZOrder = ['r1'];
  App.selectedNodeIds = new Set();
  App.selectedConnIds = new Set();
  App.selectedRegionId = null;
  App.scale = 1; App.panX = 0; App.panY = 0;
  App._snapNodes = true;
  App._snapSize = true;
  App.saveCanvasSnapshot();
  App.renderCanvas({ center: false });
  App.applyViewTransform();
  App._showResizeHandles('r1');
};

const BOX = () => {
  const n = App.canvasState.nodes[0];
  return { x: n.x, y: n.y, w: n.w, h: n.h };
};

// 某个调整手柄的屏幕中心（用真实几何，不猜 CSS 定位）。
const handlePoint = (page, dir) => page.evaluate(d => {
  const el = document.querySelector('#canvasNodes .rsz-handle.' + d);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}, dir);

// 按住手柄拖动，返回按下点（松手由调用方决定，便于在中间取样）。
async function dragHandle(page, dir, dx, dy, steps) {
  const p = await handlePoint(page, dir);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  const n = steps || 8;
  for (let i = 1; i <= n; i++) {
    await page.mouse.move(p.x + dx * i / n, p.y + dy * i / n);
    await sleep(16);
  }
  return p;
}

// 页面内 rAF 采样：覆盖松手前后的数值变化，用来区分"过程动画"与"瞬移"。
const sampler = (page, ms) => page.evaluate(limit => new Promise(res => {
  const out = [];
  const t0 = performance.now();
  (function tick() {
    const n = App.canvasState.nodes[0];
    out.push(Math.round(n.w * 100) / 100);
    if (performance.now() - t0 < limit) requestAnimationFrame(tick);
    else res(out);
  })();
}), ms);

(async () => {
  const { browser, cleanup } = await launchBrowser(false);
  try {
    const { page } = await openApp(browser);

    // ── 1) 调整大小模式的入口就位 ──
    await page.evaluate(SETUP);
    await sleep(250);
    const handles = await page.evaluate(() => ({
      resizing: document.querySelector('#canvasNodes .node').classList.contains('resizing'),
      count: document.querySelectorAll('#canvasNodes .rsz-handle').length,
      dirs: [...document.querySelectorAll('#canvasNodes .rsz-handle')].map(h => h.dataset.dir).sort()
    }));
    t.ok('节点带 resizing 类并有四角调整手柄',
      handles.resizing === true && handles.count === 4, handles);
    t.ok('手柄方向齐全（四个角）',
      handles.dirs.join(',') === 'ne,nw,se,sw', handles);

    // ── 2) 拖动中：尺寸连续跟随光标（无级调节，不是整格值）──
    await page.evaluate(SETUP);
    await sleep(250);
    await dragHandle(page, 'se', 37, 23);
    const during = await page.evaluate(BOX);
    await page.mouse.up();
    await waitAnimEnd(page);
    const settled = await page.evaluate(BOX);
    t.ok('拖动中尺寸连续（w≈217、h≈103，都不是整格值）',
      near(during.w, 217, 2) && near(during.h, 103, 2) &&
      during.w % 20 !== 0 && during.h % 20 !== 0, during);
    t.ok('松手后吸附到整格尺寸（220×100）',
      settled.w === 220 && settled.h === 100, settled);
    t.ok('se 方向拖动不移动左上角', settled.x === 0 && settled.y === 0, settled);

    // ── 3) 松手是过程动画而非瞬移 ──
    await page.evaluate(SETUP);
    await sleep(250);
    const took = sampler(page, 700);
    await sleep(120);
    await dragHandle(page, 'se', 37, 23);
    const beforeUp = await page.evaluate(() => App.canvasState.nodes[0].w);
    await page.mouse.up();
    const samples = await took;
    const between = samples.filter(v => v > beforeUp + 0.5 && v < 220);
    await waitAnimEnd(page);
    t.ok('松手后存在 217→220 之间的中间帧（吸附是动画）',
      between.length >= 2, { beforeUp: beforeUp, between: between.length, last: samples[samples.length - 1] });
    t.ok('最终值精确落在吸附尺寸上',
      samples[samples.length - 1] === 220, { last: samples[samples.length - 1] });

    // ── 4) 拖动 nw：对面角（右下）在拖动与动画全程固定 ──
    await page.evaluate(SETUP);
    await sleep(250);
    await dragHandle(page, 'nw', 30, 30);
    const nwDuring = await page.evaluate(BOX);
    await page.mouse.up();
    await waitAnimEnd(page);
    const nwAfter = await page.evaluate(BOX);
    t.ok('nw 拖动中右下角固定（180,80）',
      near(nwDuring.x + nwDuring.w, 180, 1) && near(nwDuring.y + nwDuring.h, 80, 1), nwDuring);
    t.ok('nw 落定后右下角仍固定（160×60、左上移到 20,20）',
      nwAfter.w === 160 && nwAfter.h === 60 && nwAfter.x === 20 && nwAfter.y === 20 &&
      nwAfter.x + nwAfter.w === 180 && nwAfter.y + nwAfter.h === 80, nwAfter);

    // ── 5) 最小尺寸钳制 ──
    await page.evaluate(SETUP);
    await sleep(250);
    await dragHandle(page, 'se', -600, -600);
    await page.mouse.up();
    await waitAnimEnd(page);
    const clamped = await page.evaluate(BOX);
    t.ok('反向拖过头时钳在最小尺寸（120×60）',
      clamped.w === 120 && clamped.h === 60, clamped);

    // ── 6) 「节点大小对齐」关闭：只收敛到整像素 ──
    await page.evaluate(() => { App._snapSize = false; });
    await page.evaluate(SETUP);
    await page.evaluate(() => { App._snapSize = false; });
    await sleep(250);
    await dragHandle(page, 'se', 37, 23);
    await page.mouse.up();
    await waitAnimEnd(page);
    const free = await page.evaluate(BOX);
    t.ok('关闭吸附后尺寸停在整像素且不必是整格值',
      Number.isInteger(free.w) && Number.isInteger(free.h) && free.w % 20 !== 0, free);
    await page.evaluate(() => { App._snapSize = true; });

    // ── 7) 可撤销：一次拖动只入一条历史 ──
    await page.evaluate(SETUP);
    await sleep(250);
    const histBefore = await page.evaluate(() => App.canvasState.history.length);
    await dragHandle(page, 'se', 40, 40);
    await page.mouse.up();
    await waitAnimEnd(page);
    const afterDrag = await page.evaluate(BOX);
    const undone = await page.evaluate(() => { App.canvasUndo(); return { box: { x: App.canvasState.nodes[0].x, y: App.canvasState.nodes[0].y, w: App.canvasState.nodes[0].w, h: App.canvasState.nodes[0].h }, hist: App.canvasState.history.length }; });
    t.ok('拖动后尺寸已改变（220×120）',
      afterDrag.w === 220 && afterDrag.h === 120, afterDrag);
    t.ok('撤销回到拖动前的 180×80', undone.box.w === 180 && undone.box.h === 80, undone);

    // ── 8) 动画不泄漏：集合与两个数据流都停干净 ──
    const idle = await page.evaluate(() => ({
      anims: App._activeSnapAnims.size,
      data: App._snapDataInterval === null,
      raf: App._snapRenderRaf === null
    }));
    t.ok('动画结束后无残留（集合空、数据流与渲染流都已停）',
      idle.anims === 0 && idle.data === true && idle.raf === true, idle);
  } finally {
    await cleanup();
  }
  console.log(t.fails === 0 ? '\n✅ 节点尺寸调整 GUI 守护全部通过' : '\n❌ ' + t.fails + ' 项失败');
  process.exit(t.fails === 0 ? 0 : 1);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
