'use strict';
// 验证 hlNode 键位可自定义：改绑 Ctrl 后 Ctrl+点击触发高亮、Alt+点击不再触发
const { sleep, launchBrowser, openApp, dblClick, assertions } = require('./helpers/launch');
const tally = assertions();
const ok = tally.ok;
(async () => {
  const { browser, cleanup } = await launchBrowser(false);
  const { page, cdp } = await openApp(browser);
  const modClick = async (px, py, mods) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', buttons: 1, clickCount: 1, modifiers: mods });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: 'left', buttons: 0, clickCount: 1, modifiers: mods });
    await sleep(300);
  };
  const base = await page.evaluate(() => { const r = document.getElementById('canvasStage').getBoundingClientRect(); return { left: r.left, top: r.top, w: r.width, h: r.height }; });
  const cx = base.left + base.w/2, cy = base.top + base.h/2;
  await dblClick(page, cdp, cx - 300, cy); await dblClick(page, cdp, cx, cy); await dblClick(page, cdp, cx + 300, cy);
  const np = async (i) => page.evaluate((idx) => { const el = App._nodeElMap.get(App.canvasState.nodes[idx].id); const r = el.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; }, i);
  const sock = async (i, s) => page.evaluate((idx, sd) => { const el = App._nodeElMap.get(App.canvasState.nodes[idx].id); const r = el.querySelector('.socket.' + sd).getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; }, i, s);
  let a = await sock(0,'out'), b = await sock(1,'in');
  await page.mouse.move(a.x,a.y); await page.mouse.down(); await page.mouse.move(b.x,b.y,{steps:8}); await page.mouse.up(); await sleep(200);
  a = await sock(1,'out'); b = await sock(2,'in');
  await page.mouse.move(a.x,a.y); await page.mouse.down(); await page.mouse.move(b.x,b.y,{steps:8}); await page.mouse.up(); await sleep(250);
  // 默认绑定检查
  const def = await page.evaluate(() => App._keybinds.hlNode);
  ok(def && def.alt === true && def.key === 'any', '默认 hlNode 绑定 = Alt(修饰) : ' + JSON.stringify(def));
  // 改绑 Ctrl（模拟录制结果），同时持久化到设置以便 _loadKeybinds 语义一致
  await page.evaluate(() => { App._keybinds.hlNode = { ctrl:true, meta:false, alt:false, shift:false, key:'' }; });
  // Ctrl+点击 节点1 → 应高亮（CDP modifiers: 2 = Ctrl）
  const p1 = await np(1);
  await modClick(p1.x, p1.y, 2);
  let st = await page.evaluate(() => ({ hl: App.hlNodeIds ? App.hlNodeIds.size : 0 }));
  ok(st.hl === 3, '改绑 Ctrl 后 Ctrl+点击触发高亮 (n=' + st.hl + ')');
  // 点空白清除
  await modClick(base.left + 40, base.top + 40, 0);
  // Alt+点击 不再触发
  await modClick(p1.x, p1.y, 1);
  st = await page.evaluate(() => ({ hl: App.hlNodeIds ? 1 : 0 }));
  ok(st.hl === 0, '改绑 Ctrl 后 Alt+点击不再触发高亮');
  // 还原默认
  await page.evaluate(() => { App._keybinds.hlNode = { ctrl:false, meta:false, alt:true, shift:false, key:'any' }; });
  console.log(tally.fails === 0 ? '✅ 键位自定义验证通过' : '❌ 失败 ' + tally.fails);
  await cleanup();
  process.exit(tally.fails === 0 ? 0 : 1);
})().catch(e => { console.error('💥', e); process.exit(2); });
