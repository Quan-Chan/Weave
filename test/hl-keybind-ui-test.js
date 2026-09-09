'use strict';
// 验证设置弹窗中 hlNode 键位的录制/显示/重置（纯修饰键手势）
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
  // 打开设置 → 键位信息面板
  await page.click('#btnShowSettings');
  await sleep(300);
  await page.evaluate(() => { document.querySelector('[data-settings-panel="keys"]').style.display = 'block'; });
  // 找到 hlNode 键位框
  const info = await page.evaluate(() => {
    const inp = document.querySelector('input[data-kb="hlNode"]');
    if (!inp) return null;
    const row = inp.closest('.key-row');
    const desc = row.querySelector('.key-desc');
    return { value: inp.value, desc: desc.textContent.trim(), hasReset: !!document.getElementById('btnResetKeybinds') };
  });
  ok(info && info.value === 'Alt', '设置弹窗显示 hlNode 行, 默认值 ' + (info && info.value) + ' (描述: ' + (info && info.desc) + ')');
  // 点击该输入框开始录制 → 按下 Ctrl（modifiers 2 的 keydown）
  await page.evaluate(() => { const inp = document.querySelector('input[data-kb="hlNode"]'); inp.click(); });
  await sleep(200);
  const recording = await page.evaluate(() => document.querySelector('input[data-kb="hlNode"]').classList.contains('recording'));
  ok(recording, '点击后进入录制态');
  // 按 Ctrl 键（纯修饰键）→ keydown 应保存为纯 Ctrl
  await page.keyboard.down('Control');
  await page.keyboard.up('Control');
  await sleep(300);
  const after = await page.evaluate(() => ({ v: document.querySelector('input[data-kb="hlNode"]').value, kb: App._keybinds.hlNode }));
  ok(after.v === 'Ctrl' && after.kb.ctrl === true && after.kb.key === 'any', '录制纯 Ctrl 成功(无主键归一为哨兵 any): 显示=' + after.v + ' 存储=' + JSON.stringify(after.kb));
  // 刷新后纯修饰键绑定应保留（哨兵 any 可持久化——旧版 key:'' 会被载入侧丢弃）
  await page.reload({ waitUntil: 'load' });
  await sleep(600);
  const reloaded = await page.evaluate(() => ({
    v: document.querySelector('input[data-kb="hlNode"]').value,
    kb: App._keybinds.hlNode
  }));
  ok(reloaded.v === 'Ctrl' && reloaded.kb.ctrl === true && reloaded.kb.key === 'any',
     '刷新后纯 Ctrl 绑定保留: 显示=' + reloaded.v + ' 存储=' + JSON.stringify(reloaded.kb));
  // 重新打开设置 → 切到键位面板（reload 后无首次引导，需显式切换）
  // → 重置按钮滚入弹窗可视区 → 重置键位 → 恢复 Alt
  await page.click('#btnShowSettings');
  await sleep(300);
  await page.evaluate(() => {
    App._showSettingsTab('keys');
    document.getElementById('btnResetKeybinds').scrollIntoView({ block: 'center' });
  });
  await sleep(200);
  await page.click('#btnResetKeybinds');
  await sleep(300);
  const reset = await page.evaluate(() => ({ v: document.querySelector('input[data-kb="hlNode"]').value, kb: App._keybinds.hlNode }));
  ok(reset.v === 'Alt' && reset.kb.alt === true, '重置后恢复 Alt');
  console.log(fails === 0 ? '✅ 键位录制/显示/重置验证通过' : '❌ 失败 ' + fails);
  await browser.close();
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('💥', e); process.exit(2); });
