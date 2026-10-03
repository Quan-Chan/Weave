'use strict';
// 多选模式专项：侧边栏按钮开关下的选中累加、平移不清除、空白单击取消、
// 整组拖拽，以及右键菜单「多选切换」项已移除。
// 覆盖鼠标（CDP mouse 事件）与触控（CDP touch 事件）两条输入路径。
const {
  sleep, launchBrowser, openApp, setupChain, mkNode, installFactories, assertions, blankPoint,
  dblClick, touchTap, touchDrag
} = require('./helpers/launch');

const tally = assertions();
const ok = tally.ok;

(async () => {
  const { browser, cleanup } = await launchBrowser(false);
  const { page, cdp } = await openApp(browser, { clearStorage: true });
  await installFactories(page);

  // 鼠标单击/拖拽（应用层用真实 mouse 事件）
  const mouseClick = async (x, y) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(40);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(250);
  };
  const mouseDrag = async (x0, y0, x1, y1, steps = 10) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= steps; i++) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', button: 'left', buttons: 1,
        x: x0 + (x1 - x0) * i / steps, y: y0 + (y1 - y0) * i / steps
      });
      await sleep(18);
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(300);
  };

  const reset = async () => {
    await page.evaluate(() => {
      App._setMultiSelectMode(false);
      App.selectedNodeIds.clear();
      window.__testReset();
    });
    await sleep(200);
  };
  const layout = async () => {
    await setupChain(page, [
      mkNode('A', 'A', 0, 0), mkNode('B', 'B', 320, 0), mkNode('C', 'C', 0, 320)
    ], []);
    await sleep(300);
  };
  const center = id => page.evaluate(nid => {
    const r = App._nodeElMap.get(nid).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, id);
  const sel = () => page.evaluate(() => Array.from(App.selectedNodeIds).sort());
  // 画布上的空白点（避开所有节点）
  const blankPt = () => blankPoint(page);

  console.log('\n── 1. 侧边栏按钮存在且可切换 ──');
  const btn = await page.evaluate(() => {
    const b = document.getElementById('btnMultiSelect');
    return b ? { exists: true, tag: b.tagName, cls: b.className, inSidebar: !!b.closest('#sidebar') } : { exists: false };
  });
  ok('侧边栏存在多选模式按钮', btn.exists && btn.inSidebar && btn.tag === 'BUTTON', btn);

  await reset(); await layout();
  await page.evaluate(() => document.getElementById('btnMultiSelect').click());
  await sleep(250);
  let m = await page.evaluate(() => ({
    on: App._multiSelectMode,
    active: document.getElementById('btnMultiSelect').classList.contains('active'),
    toast: document.querySelector('.toast') ? document.querySelector('.toast').textContent : ''
  }));
  ok('点击按钮开启多选模式', m.on, m);
  ok('按钮呈激活态', m.active, m);
  ok('给出开启提示', m.toast.indexOf('多选') >= 0, m);
  await page.evaluate(() => document.getElementById('btnMultiSelect').click());
  await sleep(200);
  ok('再次点击关闭多选模式', await page.evaluate(() => !App._multiSelectMode));
  ok('按钮取消激活态', await page.evaluate(() => !document.getElementById('btnMultiSelect').classList.contains('active')));

  console.log('\n── 2. 模式关闭：点按节点仍是单选替换 ──');
  await reset(); await layout();
  await mouseClick((await center('A')).x, (await center('A')).y);
  await mouseClick((await center('B')).x, (await center('B')).y);
  ok('后点按的节点替换前一个（只剩 1 个选中）', (await sel()).length === 1 && (await sel())[0] === 'B', await sel());

  console.log('\n── 3. 模式开启：点按节点累加选中 ──');
  await reset(); await layout();
  await page.evaluate(() => App._setMultiSelectMode(true));
  await sleep(200);
  await mouseClick((await center('A')).x, (await center('A')).y);
  ok('点按 A 选中 A', JSON.stringify(await sel()) === '["A"]', await sel());
  await mouseClick((await center('B')).x, (await center('B')).y);
  ok('再点按 B → A、B 同时选中', JSON.stringify(await sel()) === '["A","B"]', await sel());
  await mouseClick((await center('C')).x, (await center('C')).y);
  ok('再点按 C → 三个全选', JSON.stringify(await sel()) === '["A","B","C"]', await sel());
  await mouseClick((await center('B')).x, (await center('B')).y);
  ok('再次点按 B → 从选中中移除', JSON.stringify(await sel()) === '["A","C"]', await sel());

  console.log('\n── 4. 拖动画布不清除选中 ──');
  await reset(); await layout();
  await page.evaluate(() => App._setMultiSelectMode(true));
  await sleep(200);
  await mouseClick((await center('A')).x, (await center('A')).y);
  await mouseClick((await center('B')).x, (await center('B')).y);
  ok('先选中 A、B', JSON.stringify(await sel()) === '["A","B"]', await sel());
  let bp = await blankPt();
  await mouseDrag(bp.x, bp.y, bp.x - 70, bp.y - 50);
  await sleep(300);
  ok('拖动画布后选中仍在', JSON.stringify(await sel()) === '["A","B"]', await sel());

  console.log('\n── 5. 单击空白画布取消选中 ──');
  bp = await blankPt();
  await mouseClick(bp.x, bp.y);
  await sleep(250);
  ok('单击空白后选中被清空', (await sel()).length === 0, await sel());

  console.log('\n── 6. 整组拖拽 ──');
  await reset(); await layout();
  await page.evaluate(() => App._setMultiSelectMode(true));
  await sleep(200);
  await mouseClick((await center('A')).x, (await center('A')).y);
  await mouseClick((await center('B')).x, (await center('B')).y);
  const posBefore = await page.evaluate(() => {
    const g = id => { const n = App._getNodeById(id); return { x: n.x, y: n.y }; };
    return { A: g('A'), B: g('B'), C: g('C') };
  });
  const aC = await center('A');
  await mouseDrag(aC.x, aC.y, aC.x + 80, aC.y + 60);
  await sleep(400);
  const posAfter = await page.evaluate(() => {
    const g = id => { const n = App._getNodeById(id); return { x: n.x, y: n.y }; };
    return { A: g('A'), B: g('B'), C: g('C') };
  });
  const movedA = Math.abs(posAfter.A.x - posBefore.A.x);
  const movedB = Math.abs(posAfter.B.x - posBefore.B.x);
  const movedC = Math.abs(posAfter.C.x - posBefore.C.x);
  ok('拖 A 时 A 跟着走', movedA > 30, { movedA });
  ok('拖 A 时 B 整组跟随', Math.abs(movedB - movedA) < 2, { movedA, movedB });
  ok('未选中的 C 原地不动', movedC < 2, { movedC });

  console.log('\n── 7. 模式关闭后拖动画布恢复原行为（清除选中）──');
  await reset(); await layout();
  await mouseClick((await center('A')).x, (await center('A')).y);
  await mouseClick((await center('B')).x, (await center('B')).y);
  bp = await blankPt();
  await mouseDrag(bp.x, bp.y, bp.x - 60, bp.y - 45);
  await sleep(300);
  ok('非多选模式下拖动画布照旧清除选中', (await sel()).length === 0, await sel());

  console.log('\n── 8. Escape 退出多选模式 ──');
  await page.evaluate(() => App._setMultiSelectMode(true));
  await sleep(150);
  await page.keyboard.press('Escape');
  await sleep(250);
  ok('Escape 关闭多选模式', await page.evaluate(() => !App._multiSelectMode));
  ok('按钮同步取消激活态', await page.evaluate(() => !document.getElementById('btnMultiSelect').classList.contains('active')));

  console.log('\n── 8b. 分区 / 框选侧边栏按钮与三模式 Escape ──');
  // 分区与框选已从顶栏移入侧边栏，且都补了 active 反馈——这两处需守护
  for (const [id, flag, cls] of [
    ['btnRegion', '_regionModeActive', 'region-mode'],
    ['btnBox', '_boxModeActive', 'box-mode'],
    ['btnMultiSelect', '_multiSelectMode', null]
  ]) {
    await page.evaluate(() => {
      App._setRegionMode(false); App._setBoxMode(false); App._setMultiSelectMode(false);
    });
    await sleep(200);
    await page.evaluate(bid => document.getElementById(bid).click(), id);
    await sleep(250);
    const probe = args => page.evaluate(a => ({
      flag: App[a[1]],
      active: document.getElementById(a[0]).classList.contains('active'),
      canvasCls: a[2] ? document.getElementById('canvasStage').classList.contains(a[2]) : null
    }), args);
    const on = await probe([id, flag, cls]);
    ok(id + ' 点击后模式开启', on.flag === true, on);
    ok(id + ' 呈激活态', on.active === true, on);
    if (cls) ok(id + ' 画布同步加上 ' + cls + ' 类', on.canvasCls === true, on);
    await page.keyboard.press('Escape');
    await sleep(250);
    const off = await probe([id, flag, cls]);
    ok(id + ' Escape 关闭模式', off.flag === false, off);
    if (cls) ok(id + ' 画布移除 ' + cls + ' 类', off.canvasCls === false, off);
  }

  console.log('\n── 9. 右键菜单「多选切换」已移除 ──');
  const ctxGone = await page.evaluate(() => ({
    dom: !!document.getElementById('ctxSelMulti'),
    i18n: !!(window.Weave && Weave.I18N && Weave.I18N.zh['ctx.selMulti'])
  }));
  ok('DOM 中不再有 ctxSelMulti 按钮', !ctxGone.dom, ctxGone);
  ok('I18N 中不再有 ctx.selMulti 词条', !ctxGone.i18n, ctxGone);
  await reset(); await layout();
  await mouseClick((await center('A')).x, (await center('A')).y);
  await page.evaluate(() => App.showCtx(200, 200, 'A', null, 'title', null));
  await sleep(200);
  const nodeMenu = await page.evaluate(() => {
    const vis = id => { const e = document.getElementById(id); return !!e && e.style.display !== 'none'; };
    return { selMulti: vis('ctxSelMulti'), hl: vis('ctxHl'), edit: vis('ctxEdit'), del: vis('ctxDel') };
  });
  ok('节点右键菜单不再显示多选切换', !nodeMenu.selMulti, nodeMenu);
  ok('节点右键菜单其余项完好', nodeMenu.hl && nodeMenu.edit && nodeMenu.del, nodeMenu);
  await page.evaluate(() => { App._getEl('ctx').style.display = 'none'; });

  console.log('\n── 10. 触控路径：点按节点同样累加 ──');
  const cdp2 = await page.createCDPSession();
  await cdp2.send('Emulation.setDeviceMetricsOverride', { width: 412, height: 820, deviceScaleFactor: 2.625, mobile: true });
  await cdp2.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await sleep(500);
  // 窄视口下沿用 320px 的世界间距会把第二个节点挤出画面，改用紧凑布局
  await page.evaluate(() => {
    App.panX = 0; App.panY = 0; App.applyViewTransform();
    App.selectedNodeIds.clear();
    window.__testReset();
  });
  await sleep(200);
  await setupChain(page, [mkNode('A', 'A', 0, 0), mkNode('B', 'B', 200, 0)], []);
  await sleep(350);
  await page.evaluate(() => App._setMultiSelectMode(true));
  await sleep(200);
  const inView = async id => page.evaluate(nid => {
    const r = App._nodeElMap.get(nid).getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    return { x, y, visible: x > 0 && x < innerWidth && y > 0 && y < innerHeight };
  }, id);
  const va = await inView('A'), vb = await inView('B');
  ok('两个节点都落在窄视口内', va.visible && vb.visible, { va, vb });
  ok('起始无残留选中', (await sel()).length === 0, await sel());
  await touchTap(cdp2, va.x, va.y);
  await sleep(320);
  ok('触控点按 A 选中 A', JSON.stringify(await sel()) === '["A"]', await sel());
  await touchTap(cdp2, vb.x, vb.y);
  await sleep(320);
  ok('触控点按两个节点同时选中', JSON.stringify(await sel()) === '["A","B"]', await sel());
  await touchTap(cdp2, va.x, va.y);
  await sleep(320);
  ok('触控再次点按 A → 移出选中', JSON.stringify(await sel()) === '["B"]', await sel());
  await touchTap(cdp2, va.x, va.y);
  await sleep(320);
  ok('触控再点按 A → 重新加入', JSON.stringify(await sel()) === '["A","B"]', await sel());
  bp = await blankPt();
  await touchDrag(cdp2, bp.x, bp.y, bp.x - 50, bp.y - 40, 10, 14);
  await sleep(350);
  ok('触控拖动画布不清除选中', JSON.stringify(await sel()) === '["A","B"]', await sel());
  bp = await blankPt();
  await touchTap(cdp2, bp.x, bp.y);
  await sleep(320);
  ok('触控单击空白画布取消选中', (await sel()).length === 0, await sel());

  console.log('\n────────────────────────────');
  console.log('结果: ' + tally.pass + ' 通过, ' + tally.fails + ' 失败');
  await cleanup();
  process.exit(tally.fails ? 1 : 0);
})().catch(e => { console.error('多选模式测试异常:', e); process.exit(1); });