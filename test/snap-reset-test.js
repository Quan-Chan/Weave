'use strict';
// 常规页「重置对齐设置」冒烟 v2：直接方法调用 + UI 点击双路径
const { sleep, launchBrowser, openApp, assertions } = require('./helpers/launch');
const tally = assertions();
const ok = tally.ok;
(async () => {
  const { browser, cleanup } = await launchBrowser(false);
  // 原样板先 clear 再 reload，为的是拿到出厂默认；台架的 clearStorage 等价。
  const { page } = await openApp(browser, { clearStorage: true });
  const def = await page.evaluate(() => ({
    snapNodes: App._snapNodes, snapSize: App._snapSize,
    snapRegionPos: App._snapRegionPos, snapRegionSize: App._snapRegionSize
  }));
  ok(def.snapNodes && def.snapSize && def.snapRegionPos && def.snapRegionSize,
     '出厂默认 4 项全开: ' + JSON.stringify(def));
  // UI: 打开设置常规页
  await page.click('#btnShowSettings'); await sleep(250);
  await page.evaluate(() => document.querySelector('.settings-nav-item[data-settings-tab="general"]').click());
  await sleep(200);
  const hasBtn = await page.evaluate(() => { const b = document.getElementById('btnResetSnap'); return !!b && b.textContent.trim() === '重置对齐设置'; });
  ok(hasBtn, '常规页存在「重置对齐设置」按钮');
  // 用 UI 交互关闭 3 项开关（真实点击 label.switch，非 dispatch）
  const clickSwitch = async (id) => {
    await page.evaluate((i) => { const el = document.getElementById(i); el.click(); }, id);
    await sleep(120);
  };
  await clickSwitch('setSnapSize');
  await clickSwitch('setSnapRegionPos');
  await clickSwitch('setSnapRegionSize');
  const before = await page.evaluate(() => ({ s: App._snapSize, rp: App._snapRegionPos, rs: App._snapRegionSize, sn: App._snapNodes }));
  ok(!before.s && !before.rp && !before.rs && before.sn, 'UI 关闭 3 项: ' + JSON.stringify(before));
  // UI 点击重置按钮
  await page.click('#btnResetSnap'); await sleep(300);
  const afterClick = await page.evaluate(() => ({
    s: App._snapSize, rp: App._snapRegionPos, rs: App._snapRegionSize, sn: App._snapNodes,
    c1: document.getElementById('setSnapSize').checked,
    ls: [localStorage.getItem('flow_snap_size'), localStorage.getItem('flow_snap_region_pos'), localStorage.getItem('flow_snap_region_size')]
  }));
  ok(afterClick.sn && afterClick.s && afterClick.rp && afterClick.rs && afterClick.c1,
     'UI 点击重置后 4 项全开且复选框勾选: ' + JSON.stringify({sn:afterClick.sn,s:afterClick.s,rp:afterClick.rp,rs:afterClick.rs,c1:afterClick.c1}));
  ok(afterClick.ls.every(v => v === '1'), 'localStorage 持久化: ' + JSON.stringify(afterClick.ls));
  // 刷新后仍全开
  await page.reload({ waitUntil: 'load' });
  await sleep(600);
  const persist = await page.evaluate(() => ({ s: App._snapSize, rs: App._snapRegionSize, sn: App._snapNodes, rp: App._snapRegionPos }));
  ok(persist.sn && persist.s && persist.rp && persist.rs, '刷新后仍全开: ' + JSON.stringify(persist));
  console.log(tally.fails === 0 ? '✅ 重置对齐设置冒烟通过' : '❌ 失败 ' + tally.fails);
  await cleanup();
  process.exit(tally.fails === 0 ? 0 : 1);
})().catch(e => { console.error('💥', e); process.exit(2); });
