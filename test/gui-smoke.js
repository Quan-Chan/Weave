// Weave GUI 冒烟测试（puppeteer-core + 系统 Edge 无头）
// 用法: node test/gui-smoke.js [--headed]
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

// 浏览器可执行文件: 环境变量优先(CI 用), 缺省回退本机 Edge
const EDGE = process.env.WEAVE_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
// 应用地址: 相对 test/ 定位仓库内 APPs/Weave.html(可移植, 不依赖作者磁盘路径)
const APP_URL = process.env.WEAVE_APP_URL || pathToFileURL(path.join(__dirname, '..', 'APPs', 'Weave.html')).href;
const SHOTS = path.join(__dirname, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const HEADED = process.argv.includes('--headed');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let step = 0;
const shot = async (page, name) => {
  step++;
  const f = path.join(SHOTS, String(step).padStart(2, '0') + '_' + name + '.png');
  await page.screenshot({ path: f });
  console.log('📸 ' + name + ' → ' + f);
};

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: !HEADED,
    args: ['--no-first-run', '--no-sandbox', '--disable-gpu', '--window-size=1280,800'],
    defaultViewport: { width: 1280, height: 800 }
  });
  const page = await browser.newPage();
  await page.goto(APP_URL, { waitUntil: 'load' });

  // 等待 App 就绪
  await page.waitForFunction('!!window.App && !!document.getElementById("canvasStage") && document.getElementById("canvasStage").clientWidth > 0', { timeout: 15000 });
  await sleep(600);
  console.log('✅ 应用加载完成');

  // ── 0) 首次启动：自动弹出设置弹窗并定位到键位设置 ──
  const firstHelp = await page.evaluate(`({
    settingsOn: document.getElementById('settingsModal').classList.contains('on'),
    keysVisible: document.querySelector('[data-settings-panel="keys"]').style.display !== 'none',
    navItems: document.querySelectorAll('.settings-nav-item').length,
    keysTitle: document.querySelector('.settings-nav-item.active').textContent
  })`);
  console.log('首次弹出设置:', JSON.stringify(firstHelp));
  if (!firstHelp.settingsOn || !firstHelp.keysVisible || firstHelp.navItems < 2) throw new Error('首次启动未自动弹出设置/键位面板');
  if (firstHelp.keysTitle !== '键位信息') throw new Error('首次未定位到键位信息页: ' + firstHelp.keysTitle);
  await page.keyboard.press('Escape');
  await sleep(200);
  await shot(page, '00_first_settings_dismissed');

  const base = await page.evaluate(() => {
    const r = document.getElementById('canvasStage').getBoundingClientRect();
    return { left: r.left, top: r.top, w: r.width, h: r.height };
  });
  const cx = base.left + base.w / 2, cy = base.top + base.h / 2;
  await shot(page, '01_initial');

  // ── 1) 双击创建两个节点 ──
  // headless Chromium 只对 clickCount 递增(1→2)的序列派发 dblclick，
  // 普通 page.mouse.click 每次都是 clickCount:1，无法触发。
  const cdp = await page.createCDPSession();
  const dbl = async (x, y) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(60);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 2 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 2 });
    await sleep(300);
  };
  await dbl(cx - 200, cy);
  await dbl(cx + 200, cy);
  const n = await page.evaluate('App.canvasState.nodes.length');
  console.log('节点数:', n);
  if (n !== 2) throw new Error('期望 2 个节点，实际 ' + n);
  await shot(page, '02_two_nodes');

  // ── 2) socket 屏幕坐标 → 拖线 A.out → B.in ──
  const sock = await page.evaluate(() => {
    const sp = {};
    App.canvasState.nodes.forEach((nd, i) => {
      const el = App._nodeElMap.get(nd.id);
      for (const side of ['out', 'in']) {
        const r = el.querySelector('.socket.' + side).getBoundingClientRect();
        sp[i + '_' + side] = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
    });
    return sp;
  });
  await page.mouse.move(sock['0_out'].x, sock['0_out'].y);
  await page.mouse.down();
  await page.mouse.move(sock['1_in'].x, sock['1_in'].y, { steps: 12 });
  await page.mouse.up();
  await sleep(300);
  const c1 = await page.evaluate('App.canvasState.connections.length');
  console.log('连线数:', c1);
  if (c1 !== 1) throw new Error('期望 1 条连线，实际 ' + c1);
  await shot(page, '03_connection');

  // ── 3) 右键节点0 → 镜像节点 ──
  const node0 = await page.evaluate(() => {
    const el = App._nodeElMap.get(App.canvasState.nodes[0].id);
    const r = el.getBoundingClientRect();
    return { x: r.left + 30, y: r.top + 20 };
  });
  await page.mouse.click(node0.x, node0.y, { button: 'right' });
  await sleep(200);
  await shot(page, '04_context_menu');
  const menu = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#ctx button')).map(b => {
      const r = b.getBoundingClientRect();
      return { text: b.textContent.trim(), x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })
  );
  const mir = menu.find(m => m.text.includes('镜像'));
  if (!mir) throw new Error('菜单无镜像项: ' + JSON.stringify(menu));
  await page.mouse.click(mir.x, mir.y);
  await sleep(300);
  const mirrored = await page.evaluate('!!App.canvasState.nodes[0].mirrored');
  console.log('节点0 镜像:', mirrored);
  if (!mirrored) throw new Error('镜像失败');
  await shot(page, '05_mirrored');

  // ── 4) 镜像后拖第二条线（平行，验证偏移与箭头）──
  const sock2 = await page.evaluate(() => {
    const sp = {};
    App.canvasState.nodes.forEach((nd, i) => {
      const el = App._nodeElMap.get(nd.id);
      for (const side of ['out', 'in']) {
        const r = el.querySelector('.socket.' + side).getBoundingClientRect();
        sp[i + '_' + side] = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
    });
    return sp;
  });
  await page.mouse.move(sock2['0_out'].x, sock2['0_out'].y);
  await page.mouse.down();
  await page.mouse.move(sock2['1_in'].x, sock2['1_in'].y, { steps: 12 });
  await page.mouse.up();
  await sleep(300);
  const c2 = await page.evaluate('App.canvasState.connections.length');
  console.log('平行连线数:', c2);
  if (c2 !== 2) throw new Error('期望 2 条连线，实际 ' + c2);
  await shot(page, '06_parallel');

  // ── 5) 右键 → 调整节点大小（虚线框）──
  await page.mouse.click(node0.x, node0.y, { button: 'right' });
  await sleep(200);
  const menu2 = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#ctx button')).map(b => {
      const r = b.getBoundingClientRect();
      return { text: b.textContent.trim(), x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })
  );
  const rsz = menu2.find(m => m.text.includes('调整节点大小'));
  if (rsz) { await page.mouse.click(rsz.x, rsz.y); await sleep(300); }
  const resizing = await page.evaluate(`!!document.querySelector('.node.resizing')`);
  console.log('调整大小模式:', resizing);
  if (!resizing) throw new Error('调整大小模式未激活');
  await shot(page, '07_resize_mode');
  // 左键点空白取消
  await page.mouse.click(cx, cy - 200);
  await sleep(250);
  const resizing2 = await page.evaluate(`!!document.querySelector('.node.resizing')`);
  console.log('左键取消调整:', !resizing2);
  if (resizing2) throw new Error('左键空白未取消调整模式');
  await shot(page, '08_resize_cancelled');

  // ── 6) 设置弹窗 ──
  const gear = await page.evaluate(() => {
    const b = document.getElementById('btnShowSettings').getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });
  await page.mouse.click(gear.x, gear.y);
  await sleep(300);
  const settingsOn = await page.evaluate(`document.getElementById('settingsModal').classList.contains('on')`);
  console.log('设置弹窗:', settingsOn);
  if (!settingsOn) throw new Error('设置弹窗未打开');
  await shot(page, '09_settings');

  // ── 6a) 语言切换：切到常规页 → English → 断言界面变英文 → 切回中文 ──
  await page.evaluate(() => App._showSettingsTab('general'));
  await sleep(150);
  const langEn = await page.evaluate(() => {
    const b = document.getElementById('btnLangEn').getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });
  await page.mouse.click(langEn.x, langEn.y);
  await sleep(250);
  const enState = await page.evaluate(`({
    addBtn: document.getElementById('btnAddNode').textContent,
    setTitle: document.querySelector('#settingsModal h3').textContent,
    badge: document.getElementById('statusBadge').textContent,
    helpKey: document.querySelector('#settingsModal .key-value').textContent,
    helpDesc: document.querySelector('#settingsModal .key-desc').textContent,
    lang: App._lang
  })`);
  console.log('English 界面:', JSON.stringify(enState));
  if (enState.addBtn !== '+ Node' || enState.lang !== 'en') throw new Error('语言切换未生效: ' + JSON.stringify(enState));
  if (enState.helpKey !== 'Double-click') throw new Error('帮助键位框未翻译: ' + enState.helpKey);
  await shot(page, '09a_english_ui');
  const langZh = await page.evaluate(() => {
    const b = document.getElementById('btnLangZh').getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });
  await page.mouse.click(langZh.x, langZh.y);
  await sleep(250);
  const zhState = await page.evaluate(`({
    addBtn: document.getElementById('btnAddNode').textContent,
    lang: App._lang
  })`);
  console.log('切回中文:', JSON.stringify(zhState));
  if (zhState.addBtn !== '+ 节点' || zhState.lang !== 'zh') throw new Error('切回中文失败: ' + JSON.stringify(zhState));
  await page.keyboard.press('Escape');
  await sleep(250);

  // ── 6b) 快捷键自定义：设置弹窗 → 键位设置页 → 录制 → 保存 → 还原 ──
  const gear2 = await page.evaluate(() => {
    const b = document.getElementById('btnShowSettings').getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });
  await page.mouse.click(gear2.x, gear2.y);
  await sleep(250);
  // 侧边导航切到键位设置
  await page.evaluate(() => App._showSettingsTab('keys'));
  await sleep(150);
  const keysVisible = await page.evaluate(`document.querySelector('[data-settings-panel="keys"]').style.display !== 'none'`);
  console.log('键位设置页:', keysVisible);
  if (!keysVisible) throw new Error('侧边导航未切到键位设置');
  const undoInput = await page.evaluate(() => {
    const el = document.querySelector('[data-settings-panel="keys"] input[data-kb="undo"]');
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, value: el.value };
  });
  console.log('撤销键位框初始:', undoInput.value);
  if (undoInput.value !== 'Ctrl+Z') throw new Error('键位框初始值错误: ' + undoInput.value);
  // 键位框可能在滚动区内——用程序化 click（等价于滚动到可见后点击）
  await page.evaluate(() => document.querySelector('[data-settings-panel="keys"] input[data-kb="undo"]').click());
  await sleep(150);
  await page.keyboard.down('Control');
  await page.keyboard.down('Shift');
  await page.keyboard.press('k');
  await page.keyboard.up('Shift');
  await page.keyboard.up('Control');
  await sleep(250);
  const afterEdit = await page.evaluate(`({
    value: document.querySelector('[data-settings-panel="keys"] input[data-kb="undo"]').value,
    stored: App._keybinds.undo,
    persisted: JSON.parse(App._settings.get('keybinds')).undo
  })`);
  console.log('录制后:', JSON.stringify(afterEdit));
  if (afterEdit.value !== 'Ctrl+Shift+K' || afterEdit.stored.key !== 'k') throw new Error('快捷键录制失败: ' + JSON.stringify(afterEdit));
  // 还原为 Ctrl+Z
  await page.evaluate(() => document.querySelector('[data-settings-panel="keys"] input[data-kb="undo"]').click());
  await sleep(150);
  await page.keyboard.down('Control');
  await page.keyboard.press('z');
  await page.keyboard.up('Control');
  await sleep(250);
  const restoredKb = await page.evaluate(`document.querySelector('[data-settings-panel="keys"] input[data-kb="undo"]').value`);
  console.log('还原后:', restoredKb);
  if (restoredKb !== 'Ctrl+Z') throw new Error('快捷键还原失败: ' + restoredKb);
  await shot(page, '09b_keybinds');
  // 关闭设置弹窗
  await page.keyboard.press('Escape');
  await sleep(200);

  // ── 6b) 内联编辑：双击节点标题 → 修改 → 点空白保存 ──
  const titlePos = await page.evaluate(() => {
    const el = App._nodeElMap.get(App.canvasState.nodes[0].id);
    const h = el.querySelector('.node-header').getBoundingClientRect();
    return { x: h.left + h.width / 2, y: h.top + h.height / 2 };
  });
  await dbl(titlePos.x, titlePos.y);   // 进入标题编辑
  await sleep(300);
  const editing = await page.evaluate(`!!document.querySelector('.node-header[contenteditable]') || document.querySelector('.node-header')?.isContentEditable`);
  console.log('标题编辑激活:', editing);
  if (!editing) throw new Error('内联编辑未激活');
  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');
  await page.keyboard.type('自动化标题');
  await sleep(200);
  await shot(page, '09b_inline_edit');
  // 点空白保存
  await page.mouse.click(cx, cy + 250);
  await sleep(300);
  const label = await page.evaluate('App.canvasState.nodes[0].label');
  console.log('保存后标题:', label);
  if (label !== '自动化标题') throw new Error('内联编辑保存失败: ' + label);
  await shot(page, '09c_inline_saved');

  // ── 7) Ctrl+H 隐藏顶层 UI ──
  const canvasSizeBefore = await page.evaluate(`document.getElementById('canvasStage').clientWidth`);
  await page.keyboard.down('Control');
  await page.keyboard.press('h');
  await page.keyboard.up('Control');
  await sleep(350);
  const chrome = await page.evaluate(`({
    headerHidden: getComputedStyle(document.querySelector('.header')).display === 'none',
    sidebarHidden: getComputedStyle(document.querySelector('.sidebar')).display === 'none',
    canvasW: document.getElementById('canvasStage').clientWidth
  })`);
  console.log('Ctrl+H 隐藏:', JSON.stringify(chrome));
  if (!chrome.headerHidden || !chrome.sidebarHidden) throw new Error('Ctrl+H 未隐藏 header/sidebar');
  if (chrome.canvasW <= canvasSizeBefore) throw new Error('隐藏后画布未变宽: ' + canvasSizeBefore + ' → ' + chrome.canvasW);
  await shot(page, '10_chrome_hidden');
  // 再次 Ctrl+H 恢复
  await page.keyboard.down('Control');
  await page.keyboard.press('h');
  await page.keyboard.up('Control');
  await sleep(350);
  const restored = await page.evaluate(`({
    headerHidden: getComputedStyle(document.querySelector('.header')).display === 'none',
    canvasW: document.getElementById('canvasStage').clientWidth
  })`);
  console.log('恢复:', JSON.stringify(restored));
  if (restored.headerHidden) throw new Error('再次 Ctrl+H 未恢复 header');
  await shot(page, '11_chrome_restored');

  // ── 8) 最终断言 ──
  const summary = await page.evaluate(`({
    nodes: App.canvasState.nodes.length,
    conns: App.canvasState.connections.length,
    connsData: App.canvasState.connections.map(c => ({ mirrored: !!c.mirrored })),
    node0mirrored: !!App.canvasState.nodes[0].mirrored
  })`);
  console.log('最终状态:', JSON.stringify(summary));
  await shot(page, '12_final');

  console.log('✅ 冒烟测试全部通过');
  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌ 测试失败:', e.message); process.exit(1); });

