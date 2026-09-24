'use strict';
// I18N 键与英文词典守护：检查语言键集、占位符、静态引用和未本地化的 CJK 转义。
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'APPs', 'Weave.html');
const src = fs.readFileSync(file, 'utf8');
let failed = 0;
let checks = 0;

function check(ok, message) {
  checks++;
  if (!ok) {
    failed++;
    console.log('  ❌ ' + message);
  }
}

function placeholders(value) {
  return [...new Set(value.match(/\{[^}]+\}/g) || [])].sort();
}

function isCjk(codePoint) {
  return (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff);
}

const dictStart = src.indexOf('const I18N = {');
const dictEnd = src.indexOf('\n};', dictStart);
if (dictStart < 0 || dictEnd < 0) {
  check(false, '定位 I18N 词典');
  process.exit(1);
}

let I18N;
try {
  const dictCode = src.slice(dictStart, dictEnd + 3).replace('const I18N =', 'return ');
  I18N = new Function(dictCode)();
} catch (error) {
  check(false, '解析 I18N 词典: ' + error.message);
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

const html = src.slice(0, src.indexOf('<script>'));
const attrRe = /\bdata-i18n(?:-title|-value)?\s*=\s*(['"])([^'"]+)\1/g;
let match;
while ((match = attrRe.exec(html))) {
  const key = match[2];
  check(sourceKeys.includes(key), 'HTML data-i18n 键存在: ' + key);
}

const scriptStart = src.indexOf('<script>') + '<script>'.length;
const scriptEnd = src.lastIndexOf('</script>');
const script = src.slice(scriptStart, scriptEnd);
const code = script.slice(0, dictStart - scriptStart) + script.slice(dictEnd + 3 - scriptStart);
const tRe = /\bt\(\s*(['"])([^'"]+)\1\s*(?=[),])/g;
while ((match = tRe.exec(code))) {
  const key = match[2];
  check(sourceKeys.includes(key), '静态 t() 键存在: ' + key);
}

const escapeRe = /\\u([0-9a-fA-F]{4})/g;
const unlocalizedEscapes = [];
while ((match = escapeRe.exec(src))) {
  if (match.index >= dictStart && match.index < dictEnd + 3) continue;
  if (isCjk(parseInt(match[1], 16))) unlocalizedEscapes.push(match[0]);
}
check(unlocalizedEscapes.length === 0, '词典外无 CJK Unicode 转义: ' + (unlocalizedEscapes.join(', ') || '无'));
check(/querySelectorAll\('\.lang-btn\[data-lang\]'\)/.test(script), '语言按钮使用 data-lang 动态绑定');

if (failed) {
  console.error('\n❌ I18N 检查失败: ' + failed + ' / ' + checks + ' 项');
  process.exit(1);
}
console.log('  ✅ I18N 检查通过 (' + checks + ' 项)');
