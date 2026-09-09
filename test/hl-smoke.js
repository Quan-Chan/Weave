'use strict';
// 关联高亮（按住 Alt 单击节点）专项冒烟测试
// 覆盖：高亮集合与抬升、连线抬升层的叠放、非高亮内容的背景模糊、清除后的还原。
// 用法: node test/hl-smoke.js
const puppeteer = require('puppeteer-core');
const path = require('path');
const { pathToFileURL } = require('url');
const EDGE = process.env.WEAVE_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const APP_URL = process.env.WEAVE_APP_URL || pathToFileURL(path.join(__dirname, '..', 'APPs', 'Weave.html')).href;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✅ ' : '  ❌ ') + msg); if (!cond) fails++; };

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EDGE, headless: true,
    args: ['--no-first-run', '--no-sandbox', '--disable-gpu', '--window-size=1280,800'],
    defaultViewport: { width: 1280, height: 800 }
  });
  const page = await browser.newPage();
  await page.goto(APP_URL, { waitUntil: 'load' });
  await page.waitForFunction('!!window.App && document.getElementById("canvasStage").clientWidth > 0', { timeout: 15000 });
  await sleep(500);
  const open = await page.evaluate('document.getElementById("settingsModal").classList.contains("on")');
  if (open) { await page.keyboard.press('Escape'); await sleep(200); }
  const cdp = await page.createCDPSession();
  const dbl = async (x, y) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(70);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 2 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 2 });
    await sleep(250);
  };
  const modClick = async (px, py, alt) => {
    const mods = alt ? 1 : 0; // 1 = Alt
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', buttons: 1, clickCount: 1, modifiers: mods });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: 'left', buttons: 0, clickCount: 1, modifiers: mods });
    await sleep(300);
  };
  const dragPan = async (from, to, shift) => {
    const mods = shift ? 8 : 0;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, modifiers: mods });
    for (let i = 1; i <= 6; i++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + (to.x - from.x) * i / 6, y: from.y + (to.y - from.y) * i / 6, buttons: 1, modifiers: mods });
      await sleep(16);
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, modifiers: mods });
    await sleep(300);
  };
  const base = await page.evaluate(() => {
    const r = document.getElementById('canvasStage').getBoundingClientRect();
    return { left: r.left, top: r.top, w: r.width, h: r.height };
  });
  const cx = base.left + base.w / 2, cy = base.top + base.h / 2;
  const npos = async (i) => await page.evaluate((idx) => {
    const el = App._nodeElMap.get(App.canvasState.nodes[idx].id);
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, i);
  // 建 A B C 链
  await dbl(cx - 320, cy);
  await dbl(cx, cy);
  await dbl(cx + 320, cy);
  await sleep(200);
  ok((await page.evaluate('App.canvasState.nodes.length')) === 3, '建出 3 个节点');
  const sockPos = async (i, side) => await page.evaluate((idx, sd) => {
    const el = App._nodeElMap.get(App.canvasState.nodes[idx].id);
    const r = el.querySelector('.socket.' + sd).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, i, side);
  const sA = await sockPos(0, 'out'), sB = await sockPos(1, 'in');
  await page.mouse.move(sA.x, sA.y); await page.mouse.down();
  await page.mouse.move(sB.x, sB.y, { steps: 10 }); await page.mouse.up(); await sleep(250);
  const sB2 = await sockPos(1, 'out'), sC = await sockPos(2, 'in');
  await page.mouse.move(sB2.x, sB2.y); await page.mouse.down();
  await page.mouse.move(sC.x, sC.y, { steps: 10 }); await page.mouse.up(); await sleep(250);
  ok((await page.evaluate('App.canvasState.connections.length')) === 2, '建出 2 条连线');
  // 给第一条线加标签
  await page.evaluate(() => {
    App.canvasState.connections[0].label = 'edgeAB';
    App.saveCanvasSnapshot(); App.renderCanvas();
  });
  await sleep(300);
  const nodeIds = await page.evaluate('App.canvasState.nodes.map(n=>n.id)');
  // Alt+点击 B
  const pB = await npos(1);
  await modClick(pB.x, pB.y, true);
  const st1 = await page.evaluate((ids) => {
    const vis = id => { const p = App._visPathByKey && App._visPathByKey.get(id); return p ? p.classList.contains('selected') : null; };
    return {
      hlNodes: App.hlNodeIds ? [...App.hlNodeIds] : null,
      hlConns: App.hlConnKeys ? [...App.hlConnKeys] : null,
      selCls: ids.map(id => App._nodeElMap.get(id).classList.contains('selected')),
      liftKids: (document.querySelector('.conn-group.hl-lift') || { querySelectorAll: () => [] }).querySelectorAll('*').length,
      lineSel: App.canvasState.connections.map(c => vis(c.id)),
      labelSel: (() => { const l = App._labelByKey && [...App._labelByKey.values()][0]; return l ? l.classList.contains('selected') : false; })()
    };
  }, nodeIds);
  ok(st1.hlNodes && st1.hlNodes.length === 3, 'Alt+点B 高亮 3 节点: ' + JSON.stringify(st1.hlNodes));
  ok(st1.hlConns && st1.hlConns.length === 2, '高亮连线 2 条');
  ok(st1.selCls.every(Boolean), '3 节点均有 selected 类');
  ok(st1.liftKids >= 6, '连线抬升组含元素 (' + st1.liftKids + ')');
  ok(st1.lineSel.every(Boolean), '2 条连线 selected');
  ok(st1.labelSel === true, '连线文字 selected');
  // 非高亮内容加轻微模糊（网格 / 非高亮节点层 / 非高亮连线 / 分区）
  const blur = await page.evaluate((ids) => {
    const f = el => el ? getComputedStyle(el).filter : '(none)';
    const layerOf = id => { const el = App._nodeElMap.get(id); return el && el.parentNode ? el.parentNode.id : '(none)'; };
    return {
      dim: document.getElementById('canvasStage').classList.contains('hl-blur'),
      radius: getComputedStyle(document.getElementById('canvasStage')).getPropertyValue('--hl-blur').trim(),
      grid: f(document.getElementById('gridCvs')),
      mainLayer: f(document.getElementById('nodeLayerMain')),
      hlLayer: f(document.getElementById('nodeLayerHl')),
      baseConns: f(document.querySelector('#linesSvg > .conn-group:not(.hl-lift)')),
      liftConns: f(document.querySelector('#linesSvgHl .conn-group.hl-lift')),
      regions: f(document.getElementById('regionsSvg')),
      layers: ids.map(layerOf)
    };
  }, nodeIds);
  console.log('blur:', JSON.stringify(blur));
  ok(blur.dim, '画布加 hl-blur 类');
  ok(blur.radius === '1.2px', '模糊半径 1.2px (' + blur.radius + ')');
  ok(blur.grid.indexOf('blur(') === 0, '网格背景模糊 (' + blur.grid + ')');
  ok(blur.mainLayer.indexOf('blur(') === 0, '非高亮节点层模糊 (' + blur.mainLayer + ')');
  ok(blur.hlLayer === 'none', '高亮节点层不模糊 (' + blur.hlLayer + ')');
  ok(blur.baseConns.indexOf('blur(') === 0, '非高亮连线模糊 (' + blur.baseConns + ')');
  ok(blur.liftConns === 'none', '抬升的连线不模糊 (' + blur.liftConns + ')');
  ok(blur.regions.indexOf('blur(') === 0, '分区框模糊 (' + blur.regions + ')');
  ok(blur.layers.every(l => l === 'nodeLayerHl'), '高亮节点移入清晰层 (' + JSON.stringify(blur.layers) + ')');
  // 缩放折算：连线/分区按 --hl-scale 还原为世界半径，节点层与网格取同一世界值
  const zoomBlur = await page.evaluate(() => {
    const keep = App.scale;
    App.scale = 2; App.applyViewTransform();
    const f = el => getComputedStyle(el).filter;
    const out = {
      scale: App.scale,
      mainLayer: f(document.getElementById('nodeLayerMain')),
      grid: f(document.getElementById('gridCvs')),
      baseConns: f(document.querySelector('#linesSvg > .conn-group:not(.hl-lift)')),
      regions: f(document.getElementById('regionsSvg'))
    };
    App.scale = keep; App.applyViewTransform();
    return out;
  });
  console.log('zoom blur:', JSON.stringify(zoomBlur));
  ok(zoomBlur.mainLayer === 'blur(1.2px)', '缩放后节点层半径保持世界值 (' + zoomBlur.mainLayer + ')');
  ok(zoomBlur.grid === 'blur(2.4px)' && zoomBlur.baseConns === 'blur(2.4px)' && zoomBlur.regions === 'blur(2.4px)', '缩放后网格/连线/分区半径随 scale 折算 (' + [zoomBlur.grid, zoomBlur.baseConns, zoomBlur.regions].join(' / ') + ')');
  // 连续 Alt+单击不同节点：旧集合的节点必须退出清晰层与 selected
  // 当前高亮 {A,B,C}；再 Alt+点 A → 集合变为 {A,B}，C 应退出
  const pA1 = await npos(0);
  await modClick(pA1.x, pA1.y, true);
  const swap = await page.evaluate((ids) => ({
    hl: App.hlNodeIds ? [...App.hlNodeIds].length : 0,
    staleCls: ids.filter(id => !App.hlNodeIds.has(id) && App._nodeElMap.get(id).classList.contains('hl-on')).length,
    staleSel: ids.filter(id => !App.hlNodeIds.has(id) && App._nodeElMap.get(id).classList.contains('selected')).length,
    hlLayerNodes: document.querySelectorAll('#nodeLayerHl .node').length,
    mainLayerNodes: document.querySelectorAll('#nodeLayerMain .node').length
  }), nodeIds);
  console.log('swap:', JSON.stringify(swap));
  ok(swap.hl === 2, 'Alt+点 A 后高亮集合为 {A,B} (' + swap.hl + ')');
  ok(swap.staleCls === 0, '旧集合无 hl-on 残留 (' + swap.staleCls + ')');
  ok(swap.staleSel === 0, '旧集合无 selected 残留 (' + swap.staleSel + ')');
  ok(swap.hlLayerNodes === 2 && swap.mainLayerNodes === 1, '清晰层仅剩高亮节点 (' + swap.hlLayerNodes + '/' + swap.mainLayerNodes + ')');
  // 普通点击 B → 清除高亮、正常选中
  await modClick(pB.x, pB.y, false);
  const st1b = await page.evaluate(() => ({
    hl: !!App.hlNodeIds,
    sel: App.selectedNodeIds.size,
    dim: document.getElementById('canvasStage').classList.contains('hl-blur'),
    mainLayer: getComputedStyle(document.getElementById('nodeLayerMain')).filter,
    hlNodes: document.querySelectorAll('#nodeLayerHl .node').length,
    mainNodes: document.querySelectorAll('#nodeLayerMain .node').length
  }));
  ok(!st1b.hl && st1b.sel === 1, '无 Alt 单击清除高亮并选中 (' + JSON.stringify(st1b) + ')');
  ok(!st1b.dim && st1b.mainLayer === 'none', '清除后移除模糊 (' + st1b.mainLayer + ')');
  ok(st1b.hlNodes === 0 && st1b.mainNodes === 3, '清除后节点全部回到主层 (' + JSON.stringify(st1b) + ')');
  // 清除后连线元素必须回到原分组（视觉/命中路径 → lines，文字 → labels）：
  // 归位串组会让再次高亮时抬升逻辑找不到元素，连线留在模糊层。
  const restored = await page.evaluate(() => {
    const k = App.canvasState.connections[0].id;
    const p = App._visPathByKey.get(k), h = App._hitPathByKey.get(k), l = App._labelByKey.get(k);
    const g = el => el && el.parentNode ? el.parentNode.getAttribute('class') : '(none)';
    return { vis: g(p), hit: g(h), label: g(l), visInHl: !!(p && p.closest && p.closest('#linesSvgHl')) };
  });
  console.log('restored:', JSON.stringify(restored));
  ok(restored.vis === 'lines' && restored.hit === 'lines' && restored.label === 'labels' && !restored.visInHl,
    '清除后连线元素回到原分组 (' + JSON.stringify(restored) + ')');
  // 再次 Alt+点 B：连线应重新抬升到顶层
  await modClick(pB.x, pB.y, true);
  const again = await page.evaluate(() => {
    const keys = App.canvasState.connections.map(c => c.id);
    const lift = document.querySelector('#linesSvgHl .conn-group.hl-lift');
    return {
      hl: App.hlNodeIds ? App.hlNodeIds.size : 0,
      liftKids: lift ? lift.querySelectorAll('*').length : 0,
      allInHl: keys.every(k => { const p = App._visPathByKey.get(k); return !!(p && p.closest && p.closest('#linesSvgHl')); })
    };
  });
  console.log('re-highlight:', JSON.stringify(again));
  ok(again.hl === 3 && again.liftKids >= 6 && again.allInHl,
    '第二次高亮连线重新抬升到顶层 (' + JSON.stringify(again) + ')');
  await modClick(base.left + 30, base.top + 30, false);
  // Alt 点 B → 点空白 → 清除
  await modClick(pB.x, pB.y, true);
  await modClick(base.left + 30, base.top + 30, false);
  const st2 = await page.evaluate(() => ({ hl: !!App.hlNodeIds, lift: !!document.querySelector('.conn-group.hl-lift'), sel: document.querySelectorAll('.node.selected').length }));
  ok(!st2.hl && !st2.lift && st2.sel === 0, '点击空白清除高亮与抬升组');
  // Alt+点 A → {A,B}，拖视角、缩放保留
  const pA = await npos(0);
  await modClick(pA.x, pA.y, true);
  let st = await page.evaluate(() => ({ n: App.hlNodeIds ? App.hlNodeIds.size : 0, c: App.hlConnKeys ? App.hlConnKeys.size : 0 }));
  ok(st.n === 2 && st.c === 1, 'Alt+点A 高亮 2 节点 1 连线');
  await dragPan({ x: base.left + base.w - 80, y: base.top + 200 }, { x: base.left + base.w - 160, y: base.top + 220 }, false);
  st = await page.evaluate(() => ({ hl: !!App.hlNodeIds }));
  ok(st.hl === true, '拖动视角后高亮保留');
  await page.mouse.move(cx, cy);
  await page.mouse.wheel({ deltaY: -240 });
  await sleep(300);
  st = await page.evaluate(() => ({ hl: !!App.hlNodeIds }));
  ok(st.hl === true, '滚轮缩放后高亮保留');
  await modClick(base.left + 40, base.top + 40, false);
  st = await page.evaluate(() => ({ hl: !!App.hlNodeIds }));
  ok(st.hl === false, '空白单击清除高亮');
  // 框选 → 清除（缩放后节点位置已变，重新取 A 的屏幕坐标）
  const pA3 = await npos(0);
  await modClick(pA3.x, pA3.y, true);
  st = await page.evaluate(() => ({ hl: !!App.hlNodeIds }));
  ok(st.hl === true, '再次高亮 {A,B}');
  await dragPan({ x: base.left + base.w - 120, y: base.top + 60 }, { x: base.left + 100, y: base.top + 300 }, true);
  st = await page.evaluate(() => ({ hl: !!App.hlNodeIds }));
  ok(st.hl === false, '框选后高亮清除');
  // 恢复顺序：点空白清选中 → 拖 B 盖 A → 记 order1 → Alt+点B → 清除 → 还原
  await modClick(base.left + 30, base.top + 30, false);
  const pA2 = await npos(0), pB2 = await npos(1);
  await dragPan(pB2, pA2, false);   // B 拖到 A 上，bringToFront(B)
  await sleep(150);
  const order1 = await page.evaluate(() => App._nodeZOrder.slice());
  const pB3 = await npos(1);
  await modClick(pB3.x, pB3.y, true);
  const st8 = await page.evaluate(() => ({ z: App._nodeZOrder.slice(), base: App._hlBaseOrder ? App._hlBaseOrder.slice() : null }));
  // 高亮 {A,B,C}（B 的邻居 A,C + 自身）；B 覆盖 A，顺序保持 B 在 A 后
  const nmap = {};
  nodeIds.forEach((id, i) => nmap[id] = ['A', 'B', 'C'][i]);
  const lbl = arr => arr.map(id => nmap[id]).join('');
  ok(lbl(st8.z) === 'ABC' || lbl(st8.z) === 'BAC', '置顶后顺序保持 B 在 A 后: ' + lbl(st8.z));
  await modClick(base.left + 20, base.top + 20, false);
  const st9 = await page.evaluate(() => ({ z: App._nodeZOrder.slice(), hl: !!App.hlNodeIds }));
  ok(!st9.hl && JSON.stringify(st9.z) === JSON.stringify(order1), '清除后还原顺序 (' + lbl(st9.z) + ')');

  // 抬升层叠放：高亮连线盖过（被模糊的）节点
  await page.evaluate(() => {
    const mk = (id, x, y) => ({ id, label: id, desc: '', color: 'blue', x, y, mirrored: false, w: 170, h: 80 });
    App.canvasState.nodes = [mk('A', 0, 0), mk('B', 420, 0), mk('X', 210, -30)];
    App.canvasState.connections = [{ id: 'c_ab', from: 'A', to: 'B', label: '', mirrored: false }];
    App._nodeZOrder = ['A', 'B', 'X'];
    App.saveCanvasSnapshot(); App.renderCanvas();
    App.scale = 1; App.panX = 40; App.panY = 160; App.applyViewTransform();
  });
  await sleep(400);
  const cross = await page.evaluate(() => {
    const p = App._visPathByKey.get('c_ab');
    const pt = p.getPointAtLength(p.getTotalLength() * 0.5);
    const r = document.getElementById('canvasStage').getBoundingClientRect();
    const x = r.left + pt.x + App.panX, y = r.top + pt.y + App.panY;
    const before = document.elementFromPoint(x, y);
    App._highlightAtNode('B');
    const after = document.elementFromPoint(x, y);
    const lift = document.querySelector('.conn-group.hl-lift');
    return {
      beforeEl: before ? (before.getAttribute('class') || before.tagName) : null,
      afterEl: after ? (after.getAttribute('class') || after.tagName) : null,
      afterInHlSvg: !!(after && after.closest && after.closest('#linesSvgHl')),
      liftParent: lift && lift.parentNode ? lift.parentNode.id : null,
      zHl: getComputedStyle(document.getElementById('linesSvgHl')).zIndex,
      zNodes: getComputedStyle(document.getElementById('canvasNodes')).zIndex
    };
  });
  console.log('crossing:', JSON.stringify(cross));
  ok(cross.afterInHlSvg, '高亮连线盖过节点（命中元素来自抬升层，实际 ' + cross.afterEl + '）');
  ok(cross.liftParent === 'linesSvgHl', '抬升组位于顶层连线 SVG (' + cross.liftParent + ')');
  ok(Number(cross.zHl) > Number(cross.zNodes), '抬升层 z-index 高于节点层 (' + cross.zHl + ' > ' + cross.zNodes + ')');

  console.log(fails === 0 ? '✅ 关联高亮冒烟全部通过' : '❌ 存在 ' + fails + ' 项失败');
  await browser.close();
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('💥', e); process.exit(2); });