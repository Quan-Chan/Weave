'use strict';
// 测试台架守护：GUI 测试必须走 test/helpers/launch.js，不得自带浏览器启动样板。
//
// 背景：自带 puppeteer.launch 样板的测试在受限环境（管道 stdio 被拒）下直接失败，
// 而台架内含 spawn+connect 降级路径与统一的页面就绪等待。样板复制还会让
// 「等待 App 就绪」「关首启弹窗」「双击用 clickCount 递增」这些约定各自漂移。
//
// 校验项：
//   1 GUI 测试脚本必须 require('./helpers/launch')
//   2 不得直接调用 puppeteer.launch
//   3 不得硬编码浏览器路径兜底（读 WEAVE_EDGE 应只出现在台架内）
//   4 不得自写断言辅助 ok()（统一走台架 assertions()）
//   5 文件必须可编译（new Function 解析）
//   6 调用了台架函数就必须导入（同名局部定义不算）
//   7 测试文件与 npm scripts 主链一一对应，且链中引用的文件存在
//
// 例外：diff-test.js 同时驱动两个浏览器（git HEAD 原版与工作区），结构上不适用
// 台架，见 test/README.md「差分测试」。
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const ALLOW_NO_HARNESS = new Set(['diff-test.js']);
// 非 GUI 测试或辅助脚本：静态检查、纯函数单测、压缩版构建工具、截图比对工具、重构工具。
const SKIP = new Set([
  'check-version.js', 'check-structure.js', 'check-tests.js', 'check-module-list.js',
  'i18n-keys.js', 'i18n-recovery.js', 'geom-unit-test.js', 'undo-cap-test.js',
  'build-min.js'
]);
const SKIP_DIRS = new Set(['node_modules', 'helpers', 'tools', 'refactor', 'samples', 'tmp', 'shots']);

const EDGE_LITERAL = /Microsoft\\+Edge|msedge\.exe/;
// 自定义断言辅助：统一走台架 assertions()，避免失败计数与输出格式再次分叉。
const LOCAL_ASSERT_HELPER = /^(?:const ok\s*=\s*\(|function ok\s*\()/m;

// 台架的导出名与"文件应可编译"检查。
// 调用台架函数却忘了写进 destructure 时，只有跑到那一行才报 ReferenceError；
// 这里在静态阶段就查出来（本仓库实际发生过一次）。
const HARNESS_FUNCS = [
  'launchBrowser', 'openApp', 'openAppTouch', 'enableTouch', 'dblClick', 'setupChain', 'mkNode',
  'installFactories', 'shotsDir', 'assertions', 'blankPoint', 'touchTap', 'touchDrag',
  'touchLongPress', 'touchPinch', 'touchDoubleTap', 'sleep'
];

function destructuredNames(src) {
  const names = new Set();
  // 必须限定在同一语句内：'const {' 到 require 之间可能是另一条 require('url')
  // 之类的语句，跨语句匹配会把无关标识符也当成本文件的导入名。
  const re = /const\s*\{([^{}]*)\}\s*=\s*require\(['"][^'"]*helpers\/launch(?:\.js)?['"]\)/g;
  for (const m of src.matchAll(re)) {
    for (const raw of m[1].split(',')) {
      const n = raw.trim().split(':').pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(n)) names.add(n);
    }
  }
  return names;
}

// 文件内自己定义过的名字：同名局部定义会遮蔽台架导入，不属于"漏导入"。
function locallyDefinedNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/(?:^|\n)\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  // 函数/箭头参数里的同名形参
  for (const fn of HARNESS_FUNCS) {
    if (new RegExp('\\(\\s*' + fn + '\\s*[,)]').test(src)) names.add(fn);
  }
  return names;
}

let fails = 0;
const report = (file, msg) => { fails++; console.log('  ❌ ' + file + ' : ' + msg); };

const files = fs.readdirSync(DIR, { withFileTypes: true })
  .filter(e => e.isFile() && e.name.endsWith('.js'))
  .map(e => e.name)
  .filter(n => !SKIP.has(n))
  .sort();

console.log('测试台架守护：检查 ' + files.length + ' 个测试脚本');
if (files.length < 15) {
  fails++;
  console.log('  ❌ 只发现 ' + files.length + ' 个测试脚本，扫描逻辑可能失效（预期 18 个以上）');
}

for (const name of files) {
  const src = fs.readFileSync(path.join(DIR, name), 'utf8');
  // 仓库内两种写法都有：'./helpers/launch' 与 './helpers/launch.js'
  const usesHarness = /require\(['"]\.\/helpers\/launch(\.js)?['"]\)/.test(src);
  const launches = /puppeteer\.launch\s*\(/.test(src);
  const hardcodedEdge = EDGE_LITERAL.test(src);

  // 文件应可编译：语法错误在这里就报出来，不必等到跑测试
  try { new Function(src); } catch (e) { report(name, '语法检查失败: ' + e.message); }

  if (ALLOW_NO_HARNESS.has(name)) {
    if (!launches) report(name, '例外文件应自行启动浏览器，当前未启动（例外名单已过期）');
    continue;
  }
  if (!usesHarness) report(name, "未接入台架（应 require('./helpers/launch')）");
  if (launches) report(name, '直接调用 puppeteer.launch，绕过台架的降级路径');
  if (hardcodedEdge) report(name, '硬编码浏览器路径，应只由台架的 WEAVE_EDGE 读取');
  if (LOCAL_ASSERT_HELPER.test(src)) report(name, '自写断言辅助 ok()，应改用台架 assertions()');

  // 调用了台架函数却没写进 destructure、也没在本地定义（同名遮蔽不算）：静态阶段即可查出
  const imported = destructuredNames(src);
  const local = locallyDefinedNames(src);
  const missing = HARNESS_FUNCS.filter(fn => {
    if (imported.has(fn) || local.has(fn)) return false;
    const re = new RegExp('(?<![\\w$.])' + fn + '\\s*\\(');
    return re.test(src);
  });
  if (missing.length) report(name, '调用了台架函数但未导入: ' + missing.join(', '));
}

// ── 5) 测试文件与 npm scripts 链的对应关系 ──
// 链里引用了不存在的文件会静默失败（npm 在 && 链中会停下，但报错指向不明）；
// 反过来，新写的测试若没进主回归链，就不会被 CI 覆盖——CI 只跑 npm test，
// 因此这里只认 scripts.test 这一条链，域分组脚本不算覆盖。
const pkg = JSON.parse(fs.readFileSync(path.join(DIR, 'package.json'), 'utf8'));
const chainedFiles = new Set();
for (const [script, cmd] of Object.entries(pkg.scripts)) {
  for (const m of cmd.matchAll(/node\s+([\w.-]+\.js)/g)) {
    chainedFiles.add(m[1]);
    if (!fs.existsSync(path.join(DIR, m[1]))) {
      fails++;
      console.log('  ❌ npm scripts.' + script + ' 引用了不存在的文件: ' + m[1]);
    }
  }
}
const mainChain = new Set(Array.from(pkg.scripts.test.matchAll(/node\s+([\w.-]+\.js)/g), m => m[1]));
const NOT_IN_CHAIN = new Set(['diff-test.js']);   // 差分测试按设计不入链，见 test/README.md
const uncovered = files.filter(f => !mainChain.has(f) && !NOT_IN_CHAIN.has(f) && !SKIP.has(f));
for (const f of uncovered) {
  fails++;
  console.log('  ❌ ' + f + ' 未出现在 npm test 主链中（CI 不会覆盖它）');
}

if (fails) {
  console.log('❌ 测试台架守护未通过（' + fails + ' 项）');
  process.exit(1);
}

// ── 6) 台架导出面与 test/README.md 的一致性 ──
// 文档里的台架 API 清单必须与实际导出一致：文档写了但没导出 → 使用者会踩空；
// 导出了但文档没写 → 使用者不知道它存在。两者都是长期漂移的来源。
const harnessSrc = fs.readFileSync(path.join(DIR, 'helpers', 'launch.js'), 'utf8');
const exportBlock = harnessSrc.match(/module\.exports\s*=\s*\{([\s\S]*?)\};/);
const exported = new Set(exportBlock
  ? exportBlock[1].split(',').map(s => s.trim()).filter(s => /^[A-Za-z_$][\w$]*$/.test(s))
  : []);

const readme = fs.readFileSync(path.join(DIR, 'README.md'), 'utf8');
// API 清单在「统一测试台架 helpers/」一节内，形态是「- `apiName(...)` — 说明」。
// 只取该节首个反引号内的标识符：说明文字里的其它代码片段（`clearStorage`、
// `WEAVE_EDGE`）与其它段落里的表项（`diff-test.js`）都不是 API 名。
const apiLines = [];
let inApiSection = false;
for (const line of readme.split('\n')) {
  if (/^##\s/.test(line)) { inApiSection = /台架/.test(line); continue; }
  if (inApiSection && /^-\s+`[A-Za-z_$]/.test(line)) apiLines.push(line);
}
const documented = new Set();
for (const line of apiLines) {
  // API 名有三种写法：`name(...)`、裸 name(...)、或二者同现（`sleep(ms)` / `shotsDir(name)`）。
  // 先把行内代码块整段剔除，再取「裸标识符 + 左括号」；这样文档正文里的示例代码
  // （写在反引号内的 `ok(cond, msg)`）不会被误当成 API 声明。
  const stripped = line.replace(/`[^`]*`/g, '');
  for (const m of stripped.matchAll(/(?:^|[\s、/])([A-Za-z_$][\w$]*)\s*\(/g)) documented.add(m[1]);
  for (const m of line.matchAll(/`([A-Za-z_$][\w$]*)\s*\(/g)) documented.add(m[1]);
}

for (const n of documented) {
  if (!exported.has(n)) {
    fails++;
    console.log('  ❌ test/README.md 记载的台架 API 未导出: ' + n);
  }
}
for (const n of exported) {
  if (!documented.has(n)) {
    fails++;
    console.log('  ❌ 台架导出未记入 test/README.md: ' + n);
  }
}
// 每个导出都应至少被一个测试文件使用（避免留下死导出）
const consumerFiles = files.filter(f => f !== 'diff-test.js');
for (const n of exported) {
  const re = new RegExp('(?<![\\w$.])' + n + '\\b');
  const used = consumerFiles.some(f => re.test(fs.readFileSync(path.join(DIR, f), 'utf8')));
  if (!used) {
    fails++;
    console.log('  ❌ 台架导出无人使用（可移除或改为内部函数）: ' + n);
  }
}

if (fails) {
  console.log('❌ 测试台架守护未通过（' + fails + ' 项）');
  process.exit(1);
}
console.log('✅ 测试台架守护通过：台架统一（含导入完整性与语法）、主链一一对应、导出面与文档一致');
