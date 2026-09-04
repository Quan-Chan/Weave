'use strict';
// 结构守护脚本 — 验证 APPs/Weave.html 保持"模块化拼接"形态，且与原版（golden）逐条等价。
// 用法:
//   node test/check-structure.js --snapshot   # 从当前（重构前）文件生成 golden.json 基线
//   node test/check-structure.js              # 校验：语法 / banner 顺序 / 条目逐条等价 / DOM id / 常量区 / 尾部区
// 退出码 0 = 通过；1 = 存在失败项。
const fs = require('fs');
const path = require('path');
const parse = require('./refactor/weave-parse');

const GOLDEN_PATH = path.join(__dirname, 'golden.json');
const MODULE_ORDER = ['M01', 'M02', 'M03', 'M04', 'M05', 'M06', 'M07', 'M08', 'M09', 'M10', 'M11', 'M12', 'M13'];

let failures = 0;
function check(ok, msg) {
  console.log((ok ? '  ✅ ' : '  ❌ ') + msg);
  if (!ok) failures++;
}

// 提取新版脚本中的 App 条目（状态块 + 各 Object.assign 块）
function extractAppEntries(script) {
  const out = [];
  const appOpen = script.indexOf('const App = window.App = {');
  if (appOpen !== -1) {
    const r = parse.splitObjectEntries(script, appOpen + 'const App = window.App = {'.length - 1);
    out.push(...r.entries);
  }
  const re = /Object\.assign\(App,\s*\{/g;
  let m;
  while ((m = re.exec(script))) {
    const r = parse.splitObjectEntries(script, m.index + m[0].length - 1);
    out.push(...r.entries);
  }
  return out;
}

// 提取 Weave.<ns> = { ... } 命名空间条目
function extractNsEntries(script) {
  const out = [];
  const re = /Weave\.(\w+)\s*=\s*\{/g;
  let m;
  while ((m = re.exec(script))) {
    const r = parse.splitObjectEntries(script, m.index + m[0].length - 1);
    out.push({ ns: m[1], entries: r.entries });
  }
  return out;
}

function applyRenames(text, renames) {
  let t = text;
  for (const [from, to] of renames) t = t.split(from).join(to);
  return t;
}

function snapshot() {
  const html = parse.readHtml();
  const script = parse.extractScript(html);
  const constStart = script.indexOf('const PRESET_COLORS');
  const appOpen = script.indexOf('const App = window.App = {');
  if (constStart === -1 || appOpen === -1) throw new Error('结构定位失败');
  const appEntries = extractAppEntries(script);
  const nsEntries = extractNsEntries(script);
  // 尾部区：最后一个 Object.assign 块之后（与 compare 相同的定位）
  const lastAssign = script.lastIndexOf('Object.assign(App, {');
  let tailStart;
  if (lastAssign !== -1) {
    const rr = parse.splitObjectEntries(script, lastAssign + 'Object.assign(App, {'.length - 1);
    tailStart = rr.endIdx;
    while (tailStart < script.length && /\s/.test(script[tailStart])) tailStart++;
    if (script[tailStart] === ')' && script[tailStart + 1] === ';') tailStart += 2;
  } else {
    const rr = parse.splitObjectEntries(script, appOpen + 'const App = window.App = {'.length - 1);
    tailStart = rr.endIdx;
  }
  const golden = {
    generatedFrom: 'APPs/Weave.html 当前基线（含 i18n 多语言功能）',
    domIds: parse.extractDomIds(html),
    constantsNorm: parse.normalizeJs(script.slice(constStart, Math.min(appOpen, script.indexOf('const Weave = window.Weave') === -1 ? appOpen : script.indexOf('const Weave = window.Weave')))),
    tailNorm: parse.normalizeJs(script.slice(tailStart)),
    scriptEntries: appEntries.map(e => ({ name: e.name, kind: e.kind, norm: parse.entryNorm(e.raw, e.name) })),
    nsEntries: nsEntries.map(ns => ({ ns: ns.ns, entries: ns.entries.map(e => ({ name: e.name, kind: e.kind, norm: parse.entryNorm(e.raw, e.name) })) })),
    movedOut: {},
    renames: []
  };
  fs.writeFileSync(GOLDEN_PATH, JSON.stringify(golden, null, 2));
  const methods = golden.scriptEntries.filter(e => e.kind === 'method').length;
  const states = golden.scriptEntries.length - methods;
  const nsTotal = golden.nsEntries.reduce((a, n) => a + n.entries.length, 0);
  console.log('✅ golden.json 已生成: ' + methods + ' 个方法 + ' + states + ' 个状态字段, ' +
    golden.domIds.length + ' 个 DOM id, ' + nsTotal + ' 个命名空间成员');
}

function compare() {
  const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
  const html = parse.readHtml();
  const script = parse.extractScript(html);

  // 1) 语法检查（编译不执行）
  try {
    new Function(script);
    check(true, '脚本语法检查通过');
  } catch (e) {
    check(false, '脚本语法错误: ' + e.message);
  }

  // 2) 模块 banner 顺序
  const ids = [];
  const re = /\*\s*══ (M\d\d) ·/g;
  let m;
  while ((m = re.exec(script))) ids.push(m[1]);
  check(JSON.stringify(ids) === JSON.stringify(MODULE_ORDER),
    '模块 banner 顺序: ' + (ids.join(' → ') || '(空)') + (ids.length ? '' : '  期望 M01 → M13'));

  // 3) DOM id 集合
  const idsNow = parse.extractDomIds(html);
  check(JSON.stringify(idsNow) === JSON.stringify(golden.domIds), 'DOM id 集合一致 (' + idsNow.length + ' 个)');

  // 4) 常量区 / 尾部区（归一化后逐字比对）
  const constStart = script.indexOf('const PRESET_COLORS');
  const appOpen = script.indexOf('const App = window.App = {');
  if (constStart === -1 || appOpen === -1) {
    check(false, '常量区/App 声明定位失败');
  } else {
    // 常量区：截止到 App 声明（Phase 2 起 M01 在常量后新增 Weave.* 命名空间，已单独校验）
    const weaveOpen = script.indexOf('const Weave = window.Weave');
    const constEnd = (weaveOpen !== -1 && weaveOpen < appOpen) ? weaveOpen : appOpen;
    check(parse.normalizeJs(script.slice(constStart, constEnd)) === golden.constantsNorm, '常量区（归一化）逐字一致');
    let tailStart;
    const lastAssign = script.lastIndexOf('Object.assign(App, {');
    if (lastAssign !== -1) {
      const rr = parse.splitObjectEntries(script, lastAssign + 'Object.assign(App, {'.length - 1);
      tailStart = rr.endIdx;
      while (tailStart < script.length && /\s/.test(script[tailStart])) tailStart++;
      if (script[tailStart] === ')' && script[tailStart + 1] === ';') tailStart += 2; // 跳过 Object.assign(...); 的收尾
    } else {
      const rr = parse.splitObjectEntries(script, appOpen + 'const App = window.App = {'.length - 1);
      tailStart = rr.endIdx;
    }
    const tailNorm = parse.normalizeJs(applyRenames(script.slice(tailStart), golden.renames)).replace(/^;/, '');
    const goldenTailNorm = applyRenames(golden.tailNorm, golden.renames).replace(/^;/, '');
    check(tailNorm === goldenTailNorm, '尾部区（归一化 + 重命名后）逐字一致');
  }

  // 5) 条目逐条等价（方法 + 状态字段，归一化文本比对）
  const movedOut = golden.movedOut || {};
  const movedNames = new Set();
  const nsExpected = {};
  if (golden.nsEntries && golden.nsEntries.length) {
    // 新版 golden：命名空间条目直接记录（含归一化文本）
    for (const ns of golden.nsEntries) {
      nsExpected[ns.ns] = ns.entries.map(e => ({ name: e.name, kind: e.kind, norm: applyRenames(e.norm, golden.renames) }));
    }
  } else {
    // 旧版 golden：从 movedOut 推导（成员名映射 + renames）
    for (const ns of Object.keys(movedOut)) {
      nsExpected[ns] = [];
      for (const [name, member] of movedOut[ns]) {
        movedNames.add(name);
        const ge = golden.scriptEntries.find(x => x.name === name);
        if (!ge) { check(false, 'golden 缺少条目 ' + name); continue; }
        nsExpected[ns].push({ name: member, kind: ge.kind, norm: applyRenames(ge.norm, golden.renames) });
      }
    }
  }
  const expectedApp = golden.scriptEntries
    .filter(x => !movedNames.has(x.name))
    .map(x => ({ name: x.name, kind: x.kind, norm: applyRenames(x.norm, golden.renames) }));

  const appEntries = extractAppEntries(script);
  const nsEntries = extractNsEntries(script);
  const normOf = e => parse.entryNorm(e.raw, e.name);

  const appMap = new Map(appEntries.map(e => [e.name, e]));
  let appOk = true;
  for (const exp of expectedApp) {
    const got = appMap.get(exp.name);
    if (!got) { check(false, 'App 缺少条目: ' + exp.name); appOk = false; continue; }
    if (got.kind !== exp.kind || normOf(got) !== exp.norm) {
      check(false, 'App 条目内容不一致: ' + exp.name); appOk = false;
    }
  }
  const expectedNames = new Set(expectedApp.map(e => e.name));
  const extra = appEntries.filter(e => !expectedNames.has(e.name));
  if (extra.length) {
    check(false, 'App 存在多余条目: ' + extra.map(e => e.name).join(', ')); appOk = false;
  }
  if (appOk) check(true, 'App 条目逐条等价（' + expectedApp.length + ' 条）');

  let nsOk = true;
  for (const ns of Object.keys(nsExpected)) {
    const list = nsEntries.find(x => x.ns === ns);
    const got = new Map((list ? list.entries : []).map(e => [e.name, e]));
    for (const exp of nsExpected[ns]) {
      const g = got.get(exp.name);
      if (!g) { check(false, 'Weave.' + ns + ' 缺少成员: ' + exp.name); nsOk = false; continue; }
      if (g.kind !== exp.kind || normOf(g) !== exp.norm) {
        check(false, 'Weave.' + ns + ' 成员内容不一致: ' + exp.name); nsOk = false;
      }
    }
    const expNames = new Set(nsExpected[ns].map(e => e.name));
    const extraNs = (list ? list.entries : []).filter(e => !expNames.has(e.name));
    if (extraNs.length) {
      check(false, 'Weave.' + ns + ' 存在多余成员: ' + extraNs.map(e => e.name).join(', ')); nsOk = false;
    }
  }
  const nsTotal = Object.values(nsExpected).reduce((a, b) => a + b.length, 0);
  if (nsOk) check(true, 'Weave.* 命名空间逐条等价（' + nsTotal + ' 条）');

  // 6) 汇总
  const methods = expectedApp.filter(e => e.kind === 'method').length;
  const states = expectedApp.length - methods;
  console.log('   摘要: App ' + methods + ' 方法 + ' + states + ' 状态字段, 命名空间 ' + nsTotal + ' 成员');
  if (failures === 0) console.log('✅ 结构校验全部通过');
  else console.log('❌ 存在 ' + failures + ' 项失败');
  process.exit(failures === 0 ? 0 : 1);
}

if (process.argv.includes('--snapshot')) snapshot();
else compare();
