'use strict';
// 验证 hlNode 键位可自定义：改绑 Ctrl 后 Ctrl+点击触发高亮、Alt+点击不再触发
const puppeteer = require('puppeteer-core');
const path = require('path');
const { pathToFileURL } = require('url');
const EDGE = process.env.WEAVE_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const APP_URL = process.env.WEAVE_APP_URL || pathToFileURL(path.join(__dirname, '..', 'APPs', 'Weave.html')).href;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); if (!c) fails++; };
(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: true,
    args: ['--no-first-run', '--no-sandbox', '--disable-gpu', '--window-size=1280,800'], defaultViewport: { width: 1280, height: 800 } });
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
    await sleep(60);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 2 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 2 });
    await sleep(250);
  };
  const modClick = async (px, py, mods) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', buttons: 1, clickCount: 1, modifiers: mods });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: 'left', buttons: 0, clickCount: 1, modifiers: mods });
    await sleep(300);
  };
  const base = await page.evaluate(() => { const r = document.getElementById('canvasStage').getBoundingClientRect(); return { left: r.left, top: r.top, w: r.width, h: r.height }; });
  const cx = base.left + base.w/2, cy = base.top + base.h/2;
  await dbl(cx - 300, cy); await dbl(cx, cy); await dbl(cx + 300, cy);
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
  console.log(fails === 0 ? '✅ 键位自定义验证通过' : '❌ 失败 ' + fails);
  await browser.close();
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('💥', e); process.exit(2); });
