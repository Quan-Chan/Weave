'use strict';
// 恢复页 I18N 守护：键集对齐、占位符一致、英文不含中文、data-i18n 键存在、无遗漏硬编码文案。
// 与 i18n-keys.js 同构，作用于 APPs/Weave-recovery.html 的独立词典。
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'APPs', 'Weave-recovery.html');
const src = fs.readFileSync(file, 'utf8');
let failed = 0;
let checks = 0;

function check(ok, message) {
  checks++;
  if (!ok) { failed++; console.log('  ❌ ' + message); }
}

function placeholders(value) {
  return [...new Set(value.match(/\{[^}]+\}/g) || [])].sort();
}

//词典形如 var I18N={ zh:{...}, en:{...} };
const dictStart = src.indexOf('var I18N={');
const dictEnd = src.indexOf('\n  };', dictStart);
if (dictStart < 0 || dictEnd < 0) {
  check(false, '定位恢复页 I18N 词典');
  process.exit(1);
}

let I18N;
try {
  const dictCode = src.slice(dictStart, dictEnd + 5).replace('var I18N=', 'return ');
  I18N = new Function(dictCode)();
} catch (error) {
  check(false, '解析恢复页 I18N 词典: ' + error.message);
  process.exit(1);
}

const languages = Object.keys(I18N);
check(languages.includes('zh'), '存在源语言 zh');
check(languages.includes('en'), '存在英文语言 en');

const sourceKeys = Object.keys(I18N.zh || {});
check(sourceKeys.length > 0, '源语言词典非空');

for (const lang of languages) {
  const table = I18N[lang];
  const keys = Object.keys(table || {});
  const missing = sourceKeys.filter(key => !Object.prototype.hasOwnProperty.call(table, key));
  const extra = keys.filter(key => !sourceKeys.includes(key));
  check(missing.length === 0, lang + ' 缺少键: ' + (missing.join(', ') || '无'));
  check(extra.length === 0, lang + ' 多出键: ' + (extra.join(', ') || '无'));
  for (const key of sourceKeys) {
    if (!Object.prototype.hasOwnProperty.call(table, key)) continue;
    const value = table[key];
    check(typeof value === 'string' && value.length > 0, lang + '.' + key + ' 为非空字符串');
    if (typeof value !== 'string') continue;
    check(
      placeholders(value).join('|') === placeholders(I18N.zh[key]).join('|'),
      lang + '.' + key + ' 占位符与 zh 一致'
    );
    if (lang === 'en') check(!/[㐀-鿿]/.test(value), 'en.' + key + ' 不含中文');
  }
}

//HTML 中所有 data-i18n 键必须在词典内，且每个可见文案元素都应带 data-i18n。
const html = src.slice(0, src.indexOf('<script>'));
const attrRe = /\bdata-i18n\s*=\s*(['"])([^'"]+)\1/g;
let match;
const usedKeys = new Set();
while ((match = attrRe.exec(html))) {
  usedKeys.add(match[2]);
  check(sourceKeys.includes(match[2]), 'HTML data-i18n 键存在: ' + match[2]);
}

//词典里未被 HTML 引用的键：动态文案（状态提示、确认语、拒绝原因）属正常，
//但键位名称键必须被键位行标签引用，否则切语言后键位名称不跟随。
for (const key of sourceKeys) {
  if (usedKeys.has(key)) continue;
  const isDynamic = /^(page\.|storage\.(saved|empty|readFailed|source|unavailable)|graph\.|io\.|settings\.|set\.clearColors$|keys\.|key\.)/.test(key);
  check(isDynamic, '未引用的键需属动态文案类别: ' + key);
}

//每个键位行标签都带 data-i18n，保证语言切换后名称同步。
const keyRowRe = /<div class="keybind-row"><span([^>]*)>/g;
let rows = 0;
while ((match = keyRowRe.exec(html))) {
  rows++;
  check(/\bdata-i18n\s*=/.test(match[1]), '键位行标签带 data-i18n');
}
check(rows === 10, '键位行标签共 10 行，实际 ' + rows);

//脚本内不得残留硬编码中文文案（注释与词典除外）。
const scriptStart = src.indexOf('<script>') + '<script>'.length;
const scriptEnd = src.lastIndexOf('</script>');
const script = src.slice(scriptStart, scriptEnd);
const code = script.slice(0, dictStart - scriptStart) + script.slice(dictEnd + 5 - scriptStart);
//剔除注释后再找中文字符串字面量。
const noComment = code
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
const cjkLiteral = /'[^']*[㐀-鿿][^']*'/g;
const leftovers = [...new Set(noComment.match(cjkLiteral) || [])];
check(leftovers.length === 0, '脚本内无硬编码中文文案: ' + (leftovers.join(' | ') || '无'));

if (failed) {
  console.error('\n❌ 恢复页 I18N 检查失败: ' + failed + ' / ' + checks + ' 项');
  process.exit(1);
}
console.log('  ✅ 恢复页 I18N 检查通过 (' + checks + ' 项)');