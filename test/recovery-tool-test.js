'use strict';
// Weave 恢复与设置专项测试：验证极简恢复面板不渲染图、显示本地占用、
// 可清空节点图、导入/导出 JSON，并直接修改原软件设置。
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const vm = require('vm');
const { launchBrowser, assertions } = require('./helpers/launch');

const ROOT = path.join(__dirname, '..');
const TOOL_FILE = path.join(ROOT, 'APPs', 'Weave-recovery.html');
const TOOL_URL = pathToFileURL(TOOL_FILE).href;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tally = assertions();
const ok = tally.ok;
async function waitText(page, id, needle, timeout = 10000) {
  await page.waitForFunction((i, n) => {
    const el = document.getElementById(i);
    return !!el && el.textContent.includes(n);
  }, { timeout }, id, needle);
}

(async () => {
  const browserHandle = await launchBrowser();
  const browser = browserHandle.browser;
  let tempDir = null;
  let exitCode = 1;
  const pageErrors = [];
  const externalRequests = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', e => pageErrors.push(e.message));
    page.on('dialog', async d => { await d.accept(); });
    page.on('request', req => {
      const u = req.url();
      if (!u.startsWith('file:') && !u.startsWith('data:') && !u.startsWith('blob:')) externalRequests.push(u);
    });

    // 预置真实的 250 节点 / 62250 连线紧凑存档（约 4.96 MB 字符）。
    await page.evaluateOnNewDocument(() => {
      const nodes = [];
      for (let i = 0; i < 250; i++) nodes.push({
        id: 'seed_' + i, label: 'N' + i, desc: '', color: (['blue', 'cyan', 'green', 'yellow', 'orange'])[i % 5],
        x: (i % 25) * 10, y: Math.floor(i / 25) * 6, w: 8.5, h: 4, mirrored: false
      });
      const connections = [];
      for (let i = 0; i < 250; i++) for (let j = 0; j < 250; j++) {
        if (i !== j) connections.push({ id: 'c_' + i + '_' + j, from: 'seed_' + i, to: 'seed_' + j, label: '', mirrored: false });
      }
      try {
        localStorage.setItem('flow_data', JSON.stringify({ nodes, connections, regions: [], viewport: { panX: 0, panY: 0, scale: 1 } }));
        window.__seedOk = true;
      } catch (e) { window.__seedOk = false; window.__seedError = e.name; }
      window.__flowDataReads = 0;
      window.__largeParses = 0;
      const getItem = Storage.prototype.getItem;
      Storage.prototype.getItem = function (key) {
        if (key === 'flow_data') window.__flowDataReads++;
        return getItem.call(this, key);
      };
      const parse = JSON.parse;
      JSON.parse = function (text) {
        if (typeof text === 'string' && text.length > 1000000) window.__largeParses++;
        return parse.apply(this, arguments);
      };
    });

    const started = Date.now();
    await page.goto(TOOL_URL, { waitUntil: 'load', timeout: 60000 });
    const loadMs = Date.now() - started;
    await page.waitForFunction(() => document.getElementById('graphSize').textContent !== '—', { timeout: 10000 });

    ok(await page.evaluate(() => window.__seedOk === true), '预置 250/62250 节点图数据成功');
    ok(loadMs < 10000, '恢复页在 ' + loadMs + 'ms 内打开');
    const boot = await page.evaluate(() => ({
      reads: window.__flowDataReads,
      parses: window.__largeParses,
      graphSize: document.getElementById('graphSize').textContent,
      settingsSize: document.getElementById('settingsSize').textContent,
      totalSize: document.getElementById('totalSize').textContent,
      clearText: document.getElementById('btnClearGraph').textContent.trim(),
      sourceInfo: document.getElementById('sourceInfo').textContent,
      bucketNote: document.getElementById('bucketNote').textContent,
      ioHint: document.querySelector('[data-i18n="io.hint"]').textContent,
      defaultAlignment: ['flow_snap_nodes', 'flow_snap_size', 'flow_snap_region_pos', 'flow_snap_region_size'].map(k => document.querySelector('[data-bool="' + k + '"]').checked),
      advancedEditor: !!document.getElementById('jsonEditor'),
      complexWrite: !!document.getElementById('btnWrite'),
      keybindCount: document.querySelectorAll('.key-capture').length,
      keybindLabels: Array.from(document.querySelectorAll('.key-capture')).map(b => b.textContent.trim()),
      keybindReset: document.getElementById('btnResetKeys').textContent.includes('重置键位'),
      customColorOnlyClear: !document.getElementById('customColorState') && document.getElementById('btnClearColors').textContent.includes('清除自选颜色'),
      workspaceColumns: getComputedStyle(document.querySelector('.workspace')).gridTemplateColumns.split(/\s+/).length,
      settingsColumns: getComputedStyle(document.querySelector('.settings-grid')).gridTemplateColumns.split(/\s+/).length,
      keybindColumns: getComputedStyle(document.querySelector('.keybind-grid')).gridTemplateColumns.split(/\s+/).length,
      sideBySide: document.querySelector('.left-column').getBoundingClientRect().right <= document.querySelector('.right-column').getBoundingClientRect().left + 1,
      clearInViewport: document.getElementById('btnClearGraph').getBoundingClientRect().bottom <= window.innerHeight
    }));
    ok(boot.reads === 1 && boot.parses === 0, '启动只读取一次节点图大小，不解析大 JSON');
    ok(/MB$/.test(boot.graphSize), '启动即显示节点图数据大小：' + boot.graphSize);
    ok(boot.settingsSize !== '—' && boot.totalSize !== '—', '启动即显示设置大小与 Weave 合计');
    ok(boot.clearText === '清空节点图', '主界面显示“清空节点图”操作');
    ok(boot.sourceInfo === '当前查看：本地文件数据（file:）', '本地恢复页声明当前查看的是本地文件数据');
    ok(boot.bucketNote.includes('只显示并修改上面这一份数据'), '声明本页操作只作用于当前这一份数据');
    ok(boot.ioHint.includes('上面声明的那一份节点图'), '导入导出区指向当前声明的那份数据');

    // 语言：与主程序共用 flow_lang，英文界面下全页文案同步切换。
    const zhText = await page.evaluate(() => ({
      htmlLang: document.documentElement.lang,
      title: document.querySelector('h1').textContent,
      clearBtn: document.getElementById('btnClearGraph').textContent,
      keyNames: Array.from(document.querySelectorAll('[data-kb-label]')).map(e => e.textContent),
      hints: Array.from(document.querySelectorAll('.hint')).map(e => e.textContent)
    }));
    ok(zhText.htmlLang === 'zh-CN' && zhText.title === 'Weave 恢复与设置', '默认中文界面，html lang 为 zh-CN');
    ok(zhText.keyNames.length === 10 && zhText.keyNames[0] === '撤销' && zhText.keyNames[9] === '删除选中', '中文下 10 项键位名称正确');
    await page.click('[data-lang="en"]');
    await waitText(page, 'settingsStatus', 'Language setting saved');
    const enText = await page.evaluate(() => ({
      htmlLang: document.documentElement.lang,
      title: document.querySelector('h1').textContent,
      clearBtn: document.getElementById('btnClearGraph').textContent,
      keyNames: Array.from(document.querySelectorAll('[data-kb-label]')).map(e => e.textContent),
      hints: Array.from(document.querySelectorAll('.hint')).map(e => e.textContent),
      sourceInfo: document.getElementById('sourceInfo').textContent,
      //语言按钮自身的标签（中文 / English）不算残留中文。
      cjkLeft: (() => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const left = [];
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const el = n.parentElement;
          if (el.closest('script, style') || el.closest('[data-lang]')) continue;
          if (/[㐀-鿿]/.test(n.nodeValue)) left.push(n.nodeValue.trim().slice(0, 30));
        }
        return left;
      })()
    }));
    ok(enText.htmlLang === 'en' && enText.title === 'Weave Recovery & Settings', '切换英文后标题与 html lang 同步');
    ok(enText.clearBtn === 'Clear graph' && enText.hints.every(h => !/[㐀-鿿]/.test(h)), '英文界面按钮与全部提示文案已切换');
    ok(enText.keyNames.length === 10 && enText.keyNames[0] === 'Undo' && enText.keyNames[9] === 'Delete selection', '英文下 10 项键位名称正确');
    ok(enText.sourceInfo === 'Now viewing: local file data (file:)', '英文下仍声明当前查看的数据来源');
    ok(enText.cjkLeft.length === 0, '英文界面无残留中文（语言按钮标签除外）: ' + (enText.cjkLeft.join(' | ') || '无'));
    ok(await page.evaluate(() => localStorage.getItem('flow_lang')) === 'en', '语言与主程序共用 flow_lang 键');

    // 英文下的动态文案（状态提示、冲突提示）也随语言切换。
    await page.click('#btnResetKeys');
    await waitText(page, 'keybindStatus', 'Keybindings reset');
    ok(await page.$eval('.key-capture[data-kb="undo"]', e => e.textContent.trim()) === 'Ctrl+Z', '英文下重置键位提示为英文');
    //英文下键位冲突提示用英文动作名。
    await page.click('.key-capture[data-kb="delete"]');
    await page.keyboard.down('Shift');
    await page.keyboard.press('KeyR');
    await page.keyboard.up('Shift');
    await waitText(page, 'keybindStatus', 'Duplicates "Draw region"');
    ok(true, '英文下键位冲突提示使用英文动作名');
    await page.click('[data-lang="zh"]');
    await waitText(page, 'settingsStatus', '语言设置已保存');
    ok(await page.$eval('.key-capture[data-kb="delete"]', e => e.textContent.trim()) === 'Delete', '切回中文后键位与提示复位');
    ok(boot.defaultAlignment.every(Boolean), '未存储设置时四个对齐开关正确显示为默认开启');
    ok(boot.workspaceColumns === 2 && boot.settingsColumns === 2 && boot.keybindColumns === 2 && boot.sideBySide, '桌面端使用左右双栏布局，设置项与键位双列排列');
    ok(boot.clearInViewport, '桌面首屏可直接看到清空节点图按钮');
    ok(!boot.advancedEditor && !boot.complexWrite, '主界面不包含 JSON 编辑器或复杂覆盖流程');
    ok(boot.keybindCount === 10 && boot.keybindReset && boot.keybindLabels.includes('Ctrl+Z') && boot.keybindLabels.includes('Alt') && boot.keybindLabels.includes('Delete'), '键位区域提供 10 项录制控件与重置操作');
    ok(boot.customColorOnlyClear, '自选颜色区域仅提供清除操作');
    ok(await page.evaluate(() => document.querySelectorAll('canvas,svg').length) === 0 && await page.evaluate(() => !window.App), '页面不渲染节点图、不加载 Weave 主程序');
    ok(await page.$eval('#openWeave', a => a.tagName === 'A' && a.getAttribute('href') === 'Weave.html'), '提供同目录“打开 Weave”入口');
    ok(externalRequests.length === 0, '无外部网络请求');
    const source = fs.readFileSync(TOOL_FILE, 'utf8');
    const appSource = fs.readFileSync(path.join(ROOT, 'APPs', 'Weave.html'), 'utf8');
    const appDefaultsMatch = appSource.match(/const defs = (\{[\s\S]*?\n    \});/);
    const recoveryDefaultsMatch = source.match(/var KEYBIND_DEFAULTS=(\{[\s\S]*?\n  \});/);
    ok(!!appDefaultsMatch && !!recoveryDefaultsMatch, '可读取主程序与恢复页的键位默认表');
    if (appDefaultsMatch && recoveryDefaultsMatch) {
      const appDefaults = vm.runInNewContext('(' + appDefaultsMatch[1] + ')');
      const recoveryDefaults = vm.runInNewContext('(' + recoveryDefaultsMatch[1] + ')');
      const sameDefaults = Object.keys(appDefaults).length === Object.keys(recoveryDefaults).length &&
        Object.keys(appDefaults).every(action => JSON.stringify(appDefaults[action]) === JSON.stringify(recoveryDefaults[action]));
      ok(sameDefaults, '恢复页 10 项默认键位与主程序逐项一致');
    }
    // 设置链同样是镜像：主程序 App._settings 与恢复页 BOOL_DEFAULTS/SETTING_KEYS/ALIGN_KEYS
    // 各维护一份。登记键、布尔键与默认值必须逐项一致，否则两页对同一份数据的解读会分叉。
    const appSettingsMatch = appSource.match(/(?:App\._settings = |^  _settings: )(\{[\s\S]*?\n    \})/m);
    const appAlignMatch = appSource.match(/_snapToggleDefs:\s*(\[[\s\S]*?\n  \])/);
    const appAlignKeys = appAlignMatch ? Array.from(appAlignMatch[1].matchAll(/store:\s*'([^']+)'/g), m => m[1]) : [];
    const appSettingEntries = appSettingsMatch ?
      Array.from(appSettingsMatch[1].matchAll(/(\w+):\s*\{\s*key:\s*'([^']+)',\s*def:\s*([^}\s]+)/g),
        m => ({ name: m[1], key: m[2], def: m[3] })) : [];
    const recBoolMatch = source.match(/var BOOL_DEFAULTS=(\{[\s\S]*?\});/);
    const recSettingKeysMatch = source.match(/var SETTING_KEYS=Object\.keys\(BOOL_DEFAULTS\)\.concat\((\[[\s\S]*?\])\);/);
    const recAlignMatch = source.match(/var ALIGN_KEYS=(\[[\s\S]*?\]);/);
    // 恢复页把主程序存储键提成了 KEY_* 常量，SETTING_KEYS 里是标识符而非字面量：
    // 先解析键名常量表，再把标识符还原成键字符串。
    const recKeyConsts = new Map(Array.from(source.matchAll(/var (KEY_\w+)\s*=\s*'([^']+)'/g), m => [m[1], m[2]]));
    // SETTING_KEYS = Object.keys(BOOL_DEFAULTS).concat([...])：整条表达式求值才
    // 得到真实范围。只在空上下文里求值 concat 的数组部分，Object.keys 会得到空
    // 数组，使「复位可覆盖全部设置」断言退化成无意义的子集检查。
    const extraKeyNames = recSettingKeysMatch && recBoolMatch
      ? Array.from(vm.runInNewContext(
          'Object.keys(' + recBoolMatch[1] + ').concat(' +
          recSettingKeysMatch[1].replace(/\b(KEY_\w+)\b/g, "'$1'") + ')'))
      : null;
    const recExtraKeys = extraKeyNames ? extraKeyNames.map(k => recKeyConsts.get(k) || k) : null;
    ok(appSettingEntries.length > 0 && appAlignKeys.length > 0 && !!recBoolMatch && !!recExtraKeys && !!recAlignMatch,
      '可读取主程序与恢复页的设置清单');
    if (appSettingEntries.length && appAlignKeys.length && recBoolMatch && recExtraKeys && recAlignMatch) {
      const recBool = vm.runInNewContext('(' + recBoolMatch[1] + ')');
      const recAlignKeys = vm.runInNewContext('(' + recAlignMatch[1] + ')');
      const appBool = new Map(appSettingEntries.filter(e => e.def === 'true' || e.def === 'false')
        .map(e => [e.key, e.def === 'true' ? '1' : '0']));
      const sameBoolKeys = appBool.size === Object.keys(recBool).length &&
        [...appBool].every(([k, v]) => recBool[k] === v);
      ok(sameBoolKeys, '恢复页布尔设置键与默认值与主程序逐项一致（' + appBool.size + ' 项）');
      ok(appSettingEntries.every(e => e.key in recBool || recExtraKeys.includes(e.key)),
        '恢复页登记了主程序全部设置键（复位可覆盖）');
      // 反向核对：恢复页的布尔开关必须与主程序的布尔设置键逐一对应，
      // 且 HTML 里的 data-bool 与 BOOL_DEFAULTS 键集一致（不重不漏）。
      // 只做子集检查时，多写或漏写一个开关都不会被发现。
      const recBoolKeys = Object.keys(recBool);
      const extraBoolKeys = recBoolKeys.filter(k => !appBool.has(k));
      ok(extraBoolKeys.length === 0,
        '恢复页布尔开关未超出主程序的布尔设置键' + (extraBoolKeys.length ? '（多出 ' + extraBoolKeys.join(', ') + '）' : ''));
      const htmlBoolKeys = Array.from(source.matchAll(/data-bool="([^"]+)"/g), m => m[1]).sort();
      const boolDefaultKeys = recBoolKeys.slice().sort();
      ok(JSON.stringify(htmlBoolKeys) === JSON.stringify(boolDefaultKeys),
        '恢复页 HTML 开关与 BOOL_DEFAULTS 键集一致（各 ' + htmlBoolKeys.length + ' 项）');
      // SETTING_KEYS 是「重置全部设置」的作用范围，必须覆盖 HTML 出现的每一个开关。
      const uncovered = htmlBoolKeys.filter(k => !recExtraKeys.includes(k));
      ok(uncovered.length === 0,
        'SETTING_KEYS 覆盖全部 HTML 开关' + (uncovered.length ? '（缺 ' + uncovered.join(', ') + '）' : ''));
      // _snapToggleDefs 存的是设置表行名（snapNodes），恢复页存的是 localStorage 键
      // （flow_snap_nodes）：先经 _settings 表映射成键再比较。
      const keyOfName = new Map(appSettingEntries.map(e => [e.name, e.key]));
      const appAlignStoreKeys = appAlignKeys.map(n => keyOfName.get(n) || n);
      ok(JSON.stringify(recAlignKeys) === JSON.stringify(appAlignStoreKeys),
        '恢复页「重置对齐设置」的键表与主程序 _snapToggleDefs 一致');
    }
    ok(!source.includes('localStorage.clear('), '不使用 localStorage.clear()');

    // 设置立即保存。
    await page.evaluate(() => {
      const c = document.querySelector('[data-bool="flow_snap_nodes"]');
      c.checked = false; c.dispatchEvent(new Event('change'));
    });
    await waitText(page, 'settingsStatus', '设置已保存');
    ok(await page.evaluate(() => localStorage.getItem('flow_snap_nodes')) === '0', '可直接修改原软件对齐设置');
    //设置段之前统一切回中文，使后续中文提示断言的前提明确（flow_lang 已验证可写）。
    await page.click('[data-lang="zh"]');
    await page.waitForFunction(() => localStorage.getItem('flow_lang') === 'zh', { timeout: 10000 });
    await page.evaluate(() => { const c = document.getElementById('genColor'); c.value = 'green'; c.dispatchEvent(new Event('change')); });
    await page.waitForFunction(() => localStorage.getItem('flow_gen_color') === 'green', { timeout: 10000 });
    ok(await page.evaluate(() => localStorage.getItem('flow_lang')) === 'zh' && await page.evaluate(() => localStorage.getItem('flow_gen_color')) === 'green', '可修改语言与生成颜色');

    // 键位录制：无修饰键冲突、anyMod 默认冲突、组合键保存、自定义冲突、取消、纯修饰键规则、重置。
    const keybindUiSizeBefore = await page.$eval('#settingsSize', e => e.textContent);
    await page.click('.key-capture[data-kb="delete"]');
    await page.keyboard.down('Shift'); await page.keyboard.press('KeyR'); await page.keyboard.up('Shift');
    await waitText(page, 'keybindStatus', '键位与“画分区”重复');
    ok(await page.$eval('.key-capture[data-kb="delete"]', e => e.textContent.trim()) === 'Delete', '无 Ctrl/Cmd 的重复组合拒绝保存');

    await page.click('.key-capture[data-kb="chrome"]');
    await page.keyboard.press('Delete');
    await waitText(page, 'keybindStatus', '键位与“删除选中”重复');
    ok(await page.$eval('.key-capture[data-kb="chrome"]', e => e.textContent.trim()) === 'Ctrl+H', '主键相同的无修饰键组合拒绝保存');

    await page.click('.key-capture[data-kb="undo"]');
    await page.keyboard.down('Control'); await page.keyboard.press('KeyY'); await page.keyboard.up('Control');
    await waitText(page, 'keybindStatus', '键位与“重做”重复');
    ok(await page.$eval('.key-capture[data-kb="undo"]', e => e.textContent.trim()) === 'Ctrl+Z', 'anyMod 默认键位参与冲突检查，重复组合拒绝保存');

    await page.click('.key-capture[data-kb="undo"]');
    await page.keyboard.down('Control'); await page.keyboard.press('KeyJ'); await page.keyboard.up('Control');
    await waitText(page, 'keybindStatus', '键位已保存');
    const savedUndo = await page.evaluate(() => JSON.parse(localStorage.getItem('flow_keybinds')).undo);
    ok(savedUndo.ctrl === true && savedUndo.key === 'j', '组合键录制后写入 flow_keybinds');
    ok(await page.$eval('.key-capture[data-kb="undo"]', e => e.textContent.trim()) === 'Ctrl+J', '录制完成后显示新键位');
    ok(await page.$eval('#settingsSize', e => e.textContent) !== keybindUiSizeBefore, '保存键位后设置占用同步刷新');

    await page.click('.key-capture[data-kb="redo"]');
    await page.keyboard.down('Control'); await page.keyboard.press('KeyJ'); await page.keyboard.up('Control');
    await waitText(page, 'keybindStatus', '键位与“撤销”重复');
    ok(await page.$eval('.key-capture[data-kb="redo"]', e => e.textContent.trim()) === 'Ctrl+Y', '自定义键位冲突时保留原值');

    await page.click('.key-capture[data-kb="copy"]');
    await page.keyboard.press('Escape');
    await waitText(page, 'keybindStatus', '已取消键位录制');
    ok(await page.$eval('.key-capture[data-kb="copy"]', e => e.textContent.trim()) === 'Ctrl+C' && await page.$eval('.key-capture[data-kb="copy"]', e => !e.classList.contains('recording')), 'Escape 取消录制并恢复原键位');

    await page.click('.key-capture[data-kb="hlNode"]');
    await page.keyboard.down('Shift'); await page.keyboard.up('Shift');
    await waitText(page, 'keybindStatus', '键位已保存');
    const savedHl = await page.evaluate(() => JSON.parse(localStorage.getItem('flow_keybinds')).hlNode);
    ok(savedHl.key === 'any' && savedHl.shift === true, '高亮关联节点支持纯修饰键');
    ok(await page.$eval('.key-capture[data-kb="hlNode"]', e => e.textContent.trim()) === 'Shift', '纯修饰键显示为 Shift');

    await page.click('.key-capture[data-kb="chrome"]');
    await page.keyboard.down('Control'); await page.keyboard.up('Control');
    await waitText(page, 'keybindStatus', '该动作需要主键');
    ok(await page.$eval('.key-capture[data-kb="chrome"]', e => e.textContent.trim()) === 'Ctrl+H', '普通键盘动作拒绝纯修饰键');

    await page.keyboard.press('Enter');
    ok(await page.$$eval('.key-capture.recording', els => els.length) === 0, '录制结束后按键不会重新进入录制状态');

    const flowDataBeforeKeybindReset = await page.evaluate(() => localStorage.getItem('flow_data'));
    await page.click('#btnResetKeys');
    await waitText(page, 'keybindStatus', '键位已重置');
    const resetKeybinds = await page.evaluate((before) => ({
      raw: localStorage.getItem('flow_keybinds'),
      undo: document.querySelector('.key-capture[data-kb="undo"]').textContent.trim(),
      dataUnchanged: localStorage.getItem('flow_data') === before
    }), flowDataBeforeKeybindReset);
    ok(resetKeybinds.raw === '' && resetKeybinds.undo === 'Ctrl+Z' && resetKeybinds.dataUnchanged, '重置键位恢复内置值且不影响节点图数据');

    // 清空节点图，设置保留。
    await page.click('#btnClearGraph');
    await waitText(page, 'graphStatus', '节点图数据已清空');
    const afterClear = await page.evaluate(() => ({
      data: localStorage.getItem('flow_data'),
      lang: localStorage.getItem('flow_lang'),
      gen: localStorage.getItem('flow_gen_color'),
      size: document.getElementById('graphSize').textContent
    }));
    ok(afterClear.data === null, '清空节点图后 flow_data 不存在');
    ok(afterClear.lang === 'zh' && afterClear.gen === 'green', '清空节点图不会删除软件设置');
    ok(afterClear.size === '0 B', '清空后占用立即更新为 0 B');

    // 导入有效节点图 → 紧凑写入。
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-recovery-simple-'));
    const goodFile = path.join(tempDir, 'good.json');
    fs.writeFileSync(goodFile, JSON.stringify({
      nodes: [
        { id: 'a', label: 'A', desc: '', color: 'blue', x: 0, y: 0, w: 8.5, h: 4, mirrored: false },
        { id: 'b', label: 'B', desc: '', color: 'green', x: 10, y: 0, w: 8.5, h: 4, mirrored: false }
      ],
      connections: [{ id: 'c', from: 'a', to: 'b', label: 'link', mirrored: false }],
      regions: [], viewport: { panX: 0, panY: 0, scale: 1 }
    }), 'utf8');
    await (await page.$('#graphFile')).uploadFile(goodFile);
    await waitText(page, 'ioStatus', '节点图数据已写入');
    const imported = await page.evaluate(() => localStorage.getItem('flow_data'));
    ok(JSON.parse(imported).nodes.length === 2 && JSON.parse(imported).connections.length === 1 && !imported.includes('\n'), '导入节点图成功并以紧凑格式保存');

    // 导出真实 JSON 下载。
    const cdp = await page.createCDPSession();
    const downloadDir = path.join(tempDir, 'downloads');
    fs.mkdirSync(downloadDir);
    await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
    await page.click('#btnExportGraph');
    let downloaded = null;
    for (let i = 0; i < 50 && !downloaded; i++) {
      await sleep(100);
      const files = fs.readdirSync(downloadDir).filter(f => f.endsWith('.json'));
      if (files.length) downloaded = path.join(downloadDir, files[0]);
    }
    ok(!!downloaded && JSON.parse(fs.readFileSync(downloaded, 'utf8')).nodes.length === 2, '可导出当前节点图 JSON');

    // 非法导入不改变当前数据。
    const beforeBad = await page.evaluate(() => localStorage.getItem('flow_data'));
    const badFile = path.join(tempDir, 'bad.json');
    fs.writeFileSync(badFile, JSON.stringify({ nodes: {}, connections: [] }), 'utf8');
    await (await page.$('#graphFile')).uploadFile(badFile);
    await waitText(page, 'ioStatus', 'nodes 必须是数组');
    ok(await page.evaluate(() => localStorage.getItem('flow_data')) === beforeBad, '非法节点图被拒绝且当前数据不变');

    // 配额失败不破坏旧值。
    const beforeQuota = await page.evaluate(() => localStorage.getItem('flow_data'));
    await page.evaluate(() => {
      window.__originalSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === 'flow_data') { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; }
        return window.__originalSetItem.call(this, key, value);
      };
    });
    const quotaFile = path.join(tempDir, 'quota.json');
    fs.writeFileSync(quotaFile, JSON.stringify({ nodes: [{ id: 'q', label: 'q', x: 0, y: 0, w: 8.5, h: 4 }], connections: [], regions: [] }), 'utf8');
    await (await page.$('#graphFile')).uploadFile(quotaFile);
    await waitText(page, 'ioStatus', 'QuotaExceededError');
    const quota = await page.evaluate(before => {
      const unchanged = localStorage.getItem('flow_data') === before;
      Storage.prototype.setItem = window.__originalSetItem;
      return unchanged;
    }, beforeQuota);
    ok(quota && await page.evaluate(() => document.getElementById('ioStatus').textContent.includes('当前节点图数据保持不变')), 'QuotaExceededError 时原节点图保持不变');

    // 恢复默认设置。
    await page.click('#btnResetAll');
    await waitText(page, 'settingsStatus', '全部设置已重置为默认值');
    const reset = await page.evaluate(() => ({ lang: localStorage.getItem('flow_lang'), gen: localStorage.getItem('flow_gen_color'), snap: localStorage.getItem('flow_snap_nodes'), data: !!localStorage.getItem('flow_data') }));
    ok(reset.lang === null && reset.gen === null && reset.snap === null && reset.data, '重置全部设置只清设置，不清节点图');

    // 其他页面写回节点图时出现告警。
    const page2 = await browser.newPage();
    await page2.goto(TOOL_URL, { waitUntil: 'load', timeout: 60000 });
    await page2.evaluate(() => localStorage.setItem('flow_data', JSON.stringify({ nodes: [{ id: 'x', label: 'x', x: 0, y: 0, w: 8.5, h: 4 }], connections: [], regions: [] })));
    await page2.close();
    await waitText(page, 'pageAlert', '节点图数据被其他页面修改');
    ok(await page.evaluate(() => document.getElementById('pageAlert').classList.contains('show')), '检测到旧 Weave 页面写回时显示告警');

    const keybindPage = await browser.newPage();
    await keybindPage.goto(TOOL_URL, { waitUntil: 'load', timeout: 60000 });
    await keybindPage.evaluate(() => localStorage.setItem('flow_keybinds', JSON.stringify({
      undo: { ctrl: true, meta: false, alt: false, shift: false, key: 'k' },
      redo: { anyMod: true, shift: false, alt: false, key: 'y' },
      selectAll: { anyMod: true, shift: false, alt: false, key: 'a' },
      copy: { anyMod: true, shift: false, alt: false, key: 'c' },
      paste: { anyMod: true, shift: false, alt: false, key: 'v' },
      autoModal: { anyMod: true, shift: false, alt: false, key: 'e' },
      chrome: { anyMod: true, shift: false, alt: false, key: 'h' },
      region: { anyMod: false, shift: true, alt: false, key: 'r' },
      hlNode: { anyMod: false, ctrl: false, meta: false, alt: true, shift: false, key: 'any' },
      delete: { anyMod: false, shift: false, alt: false, key: 'delete' }
    })));
    await keybindPage.close();
    await waitText(page, 'keybindStatus', '键位数据被其他页面修改');
    ok(await page.$eval('.key-capture[data-kb="undo"]', e => e.textContent.trim()) === 'Ctrl+K', '其他页面修改键位后当前页刷新显示');

    // 1024px 常见桌面窗口：保持左右分栏，设置不能被挤成逐字换行。
    await page.setViewport({ width: 1024, height: 768 });
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('graphSize').textContent !== '—');
    const compactDesktop = await page.evaluate(() => {
      const settings = Array.from(document.querySelectorAll('.settings-grid .setting'));
      const firstWidth = settings[0].getBoundingClientRect().width;
      const lastWidth = settings[settings.length - 1].getBoundingClientRect().width;
      return {
        workspaceColumns: getComputedStyle(document.querySelector('.workspace')).gridTemplateColumns.split(/\s+/).length,
        settingsColumns: getComputedStyle(document.querySelector('.settings-grid')).gridTemplateColumns.split(/\s+/).length,
        keybindColumns: getComputedStyle(document.querySelector('.keybind-grid')).gridTemplateColumns.split(/\s+/).length,
        maxSettingHeight: Math.max(...settings.map(e => e.getBoundingClientRect().height)),
        lastSpansFullRow: lastWidth > firstWidth * 1.8,
        clearInViewport: document.getElementById('btnClearGraph').getBoundingClientRect().bottom <= window.innerHeight,
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth
      };
    });
    ok(compactDesktop.workspaceColumns === 2 && compactDesktop.settingsColumns === 2 && compactDesktop.keybindColumns === 2 && compactDesktop.clearInViewport, '1024px 桌面仍保持双栏且清空按钮首屏可见');
    ok(compactDesktop.maxSettingHeight <= 140 && compactDesktop.lastSpansFullRow && compactDesktop.overflowX === 0, '1024px 设置行不过度拥挤，末项横跨整列且无横向溢出');

    // 窄屏才回落为单列；桌面布局不能被移动端媒体查询误伤。
    await page.setViewport({ width: 390, height: 844 });
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('graphSize').textContent !== '—');
    const mobile = await page.evaluate(() => ({
      workspaceColumns: getComputedStyle(document.querySelector('.workspace')).gridTemplateColumns.split(/\s+/).length,
      settingsColumns: getComputedStyle(document.querySelector('.settings-grid')).gridTemplateColumns.split(/\s+/).length,
      keybindColumns: getComputedStyle(document.querySelector('.keybind-grid')).gridTemplateColumns.split(/\s+/).length,
      clearInViewport: document.getElementById('btnClearGraph').getBoundingClientRect().bottom <= window.innerHeight,
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth
    }));
    ok(mobile.workspaceColumns === 1 && mobile.settingsColumns === 1 && mobile.keybindColumns === 1, '窄屏回落为单列布局');
    ok(mobile.clearInViewport && mobile.overflowX === 0, '窄屏首屏可见清空按钮且无横向溢出');

    // ── 在线场景：按站点部署映射起本地 HTTP 服务，复现恢复页与在线版同源的情形 ──
    // 映射对应 pages.yml：压缩版 → index.html，恢复页 → recovery.html。
    const siteRoutes = { '/': 'Weave.min.html', '/index.html': 'Weave.min.html', '/recovery.html': 'Weave-recovery.html' };
    const siteServer = http.createServer((req, res) => {
      const name = siteRoutes[decodeURIComponent(req.url.split('?')[0])];
      if (!name) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('404'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(path.join(ROOT, 'APPs', name)));
    });
    await new Promise(resolve => siteServer.listen(0, '127.0.0.1', resolve));
    const siteBase = 'http://127.0.0.1:' + siteServer.address().port;
    const fileBucketBefore = await page.evaluate(() => localStorage.getItem('flow_data'));
    const siteApp = await browser.newPage();
    siteApp.on('pageerror', e => pageErrors.push('在线版: ' + e.message));
    await siteApp.goto(siteBase + '/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await siteApp.waitForFunction('!!window.App', { timeout: 30000 });
    await siteApp.evaluate(() => {
      App.canvasState.nodes = [{ id: 'o1', label: 'online', desc: '', color: 'blue', x: 0, y: 0, mirrored: false, w: 170, h: 80 }];
      App.canvasState.connections = []; App.canvasState.regions = [];
      App.saveCanvasSnapshot();
    });
    await sleep(1200);
    const siteWrote = await siteApp.evaluate(() => (localStorage.getItem('flow_data') || '').length);
    await siteApp.close();
    ok(siteWrote > 0, '在线版写入节点图数据');

    const siteTool = await browser.newPage();
    siteTool.on('dialog', async d => { await d.accept(); });
    siteTool.on('pageerror', e => pageErrors.push('在线恢复页: ' + e.message));
    await siteTool.goto(siteBase + '/recovery.html', { waitUntil: 'load', timeout: 60000 });
    await siteTool.waitForFunction(() => document.getElementById('graphSize').textContent !== '—', { timeout: 15000 });
    const site = await siteTool.evaluate(() => ({
      sourceInfo: document.getElementById('sourceInfo').textContent,
      bucketNote: document.getElementById('bucketNote').textContent,
      graphSize: document.getElementById('graphSize').textContent,
      openWeave: document.getElementById('openWeave').getAttribute('href'),
      openWeaveResolved: document.getElementById('openWeave').href,
      dataLen: (localStorage.getItem('flow_data') || '').length,
      keybinds: Array.from(document.querySelectorAll('.key-capture')).map(b => b.textContent.trim())
    }));
    ok(site.sourceInfo.startsWith('当前查看：在线站点数据（') && site.sourceInfo.endsWith('）'), '在线恢复页声明当前查看的是在线站点数据');
    ok(site.dataLen === siteWrote && site.graphSize !== '0 B', '在线恢复页读到在线版写入的节点图数据');
    ok(site.openWeave === './index.html' && site.openWeaveResolved.endsWith('/index.html'), '在线恢复页的“打开 Weave”指向同源 index.html');
    ok(site.keybinds.includes('Ctrl+Z') && site.keybinds.includes('Alt') && site.keybinds.length === 10, '在线恢复页的键位区读取同源数据');

    await siteTool.evaluate(() => { const c = document.querySelector('[data-bool="flow_snap_size"]'); c.checked = false; c.dispatchEvent(new Event('change')); });
    await waitText(siteTool, 'settingsStatus', '设置已保存');
    await siteTool.click('#btnClearGraph');
    await waitText(siteTool, 'graphStatus', '节点图数据已清空');
    const siteCleared = await siteTool.evaluate(() => localStorage.getItem('flow_data'));
    await siteTool.close();

    const siteApp2 = await browser.newPage();
    siteApp2.on('pageerror', e => pageErrors.push('在线版: ' + e.message));
    await siteApp2.goto(siteBase + '/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await siteApp2.waitForFunction('!!window.App', { timeout: 30000 });
    await sleep(600);
    const siteSees = await siteApp2.evaluate(() => ({ nodes: App.canvasState.nodes.length, snapSize: localStorage.getItem('flow_snap_size') }));
    await siteApp2.close();
    ok(siteCleared === null && siteSees.nodes === 0, '在线恢复页清空后，在线版重开为空白画布');
    ok(siteSees.snapSize === '0', '在线恢复页修改的设置，在线版读到');

    // 两处数据互不可见：在线恢复页看不见本地那份，本地恢复页看不见在线那份。
    const siteTool2 = await browser.newPage();
    siteTool2.on('dialog', async d => { await d.accept(); });
    siteTool2.on('pageerror', e => pageErrors.push('在线恢复页: ' + e.message));
    await siteTool2.goto(siteBase + '/recovery.html', { waitUntil: 'load', timeout: 60000 });
    await siteTool2.waitForFunction(() => document.getElementById('graphSize').textContent !== '—', { timeout: 15000 });
    const siteSizeNow = await siteTool2.$eval('#graphSize', e => e.textContent);
    await siteTool2.evaluate(() => localStorage.setItem('flow_data', JSON.stringify({ nodes: [{ id: 'x', label: 'x', x: 0, y: 0, w: 8.5, h: 4 }], connections: [], regions: [] })));
    await siteTool2.close();

    const fileSizeBefore = await page.$eval('#graphSize', e => e.textContent);
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('graphSize').textContent !== '—', { timeout: 15000 });
    const fileAfter = await page.evaluate(() => localStorage.getItem('flow_data'));
    ok(siteSizeNow !== '0 B' && !siteSizeNow.includes('MB'),
      '在线版关闭时把内存中的空图写回，在线占用为 ' + siteSizeNow + '，与本地那份的 4.96 MB 无关');
    ok(!!fileBucketBefore && fileBucketBefore === fileAfter,
      '在线侧操作不改动本地那份数据（' + String(fileBucketBefore && fileBucketBefore.length) + ' → ' + String(fileAfter && fileAfter.length) + ' 字节）');
    ok(await page.$eval('#graphSize', e => e.textContent) === fileSizeBefore, '本地恢复页看不到在线那份数据');
    await new Promise(resolve => siteServer.close(resolve));

    ok(pageErrors.length === 0, '页面无未捕获脚本错误' + (pageErrors.length ? ': ' + pageErrors.join(' | ') : ''));
    await page.close();
    exitCode = tally.fails === 0 ? 0 : 1;
  } catch (e) {
    console.error('FAIL:', e && e.stack ? e.stack : e);
    tally.fails++;
    exitCode = 1;
  } finally {
    if (tempDir) { try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {} }
    try { await browserHandle.cleanup(); } catch (e) {}
  }
  console.log(tally.fails === 0 ? '\n✅ 恢复与设置测试通过' : '\n❌ 恢复与设置测试失败 ' + tally.fails + ' 项');
  process.exit(exitCode);
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
