'use strict';
// 共享解析工具 — 供 check-structure.js / partition.js 使用。
// 职责：
//   1. 从 APPs/Weave.html 提取 <script> 块
//   2. 把 App 对象字面量按"顶层逗号 + 花括号深度"切分为条目（方法/状态字段）
//   3. JS 代码归一化：去掉注释与空白，保留字符串/正则字面量原样
// 说明：本文件是重构专用工具，不属于 APPs/Weave.html 应用本体。
const fs = require('fs');
const path = require('path');

const HTML_PATH = path.join(__dirname, '..', '..', 'APPs', 'Weave.html');

function readHtml() {
  return fs.readFileSync(HTML_PATH, 'utf8');
}

// 提取 <script> 块内容（应用只有一个 <script>）
function extractScript(html) {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('未找到 <script> 块');
  return m[1];
}

function scriptRange(html) {
  const start = html.indexOf('<script>');
  const end = html.indexOf('</script>');
  if (start === -1 || end === -1) throw new Error('未找到 <script> 块');
  return { start: start + '<script>'.length, end };
}

// ── 词法扫描：跳过字符串/注释/正则字面量，逐字符产出"结构字符" ──
// 返回 { ch, i }：ch 为当前位置的结构字符；i 为其后的扫描位置。
function scanStringEnd(text, i) {
  // text[i] 是引号字符（' " `），返回闭合引号后的位置（含转义处理）
  const q = text[i];
  let j = i + 1;
  const n = text.length;
  while (j < n) {
    if (text[j] === '\\') { j += 2; continue; }
    if (text[j] === q) return j + 1;
    j++;
  }
  return n;
}

function scanRegexEnd(text, i) {
  // text[i] === '/', 前面已判定为正则字面量起点；返回闭合 / 之后的位置
  let j = i + 1;
  const n = text.length;
  let inClass = false;
  while (j < n) {
    const c = text[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) { j++; break; }
    j++;
  }
  return j;
}

const REGEX_PRECEDERS = new Set('([{=,:;!&|?+-*%^~<>'.split(''));
function isRegexStart(prev) {
  // prev 为前一个"非空白"字符；启发式判定：这些字符之后出现 / 大概率是正则字面量
  return prev === undefined || prev === null || REGEX_PRECEDERS.has(prev);
}

// 结构扫描：对 text 逐位置推进，跳过字符串/注释/正则与空白；对每个结构字符调用 fn(ch, pos)。
// 若 fn 返回 false 则提前终止。
// 注意：空白不传给 fn 也不更新 prev（否则 `= /re/` 中 prev 被空格污染，正则启发式失效）。
function walkSignificant(text, fn) {
  let i = 0;
  let prev = null; // 前一个结构字符（用于正则启发式）
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const c1 = text[i + 1];
    if (c === '/' && c1 === '/') { // 行注释
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && c1 === '*') { // 块注释
      const e = text.indexOf('*/', i + 2);
      i = e === -1 ? n : e + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { // 字符串字面量
      i = scanStringEnd(text, i);
      continue;
    }
    if (c === '/') { // 正则字面量（启发式判定）
      if (isRegexStart(prev)) {
        i = scanRegexEnd(text, i);
        continue;
      }
    }
    if (/\s/.test(c)) { i++; continue; } // 空白：跳过
    if (fn(c, i) === false) return;
    prev = c;
    i++;
  }
}

// 前一个非空白字符（原始文本视角，用于 normalizeJs 内的正则启发式）
function prevNonWs(text, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(text[j])) j--;
  return j < 0 ? null : text[j];
}

// 归一化：去注释、去空白；字符串与正则字面量原样保留（内部空白不动）
function normalizeJs(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const e = text.indexOf('*/', i + 2);
      i = e === -1 ? n : e + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const e = scanStringEnd(text, i);
      out += text.slice(i, e);
      i = e;
      continue;
    }
    if (c === '/') {
      if (isRegexStart(prevNonWs(text, i))) {
        const e = scanRegexEnd(text, i);
        out += text.slice(i, e);
        i = e;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

// 把对象字面量（从 openBraceIdx 的 '{' 开始）切分为顶层条目。
// 返回 { entries: [{ raw, name, kind }], endIdx }，endIdx 为闭合 '}' 之后的位置。
function splitObjectEntries(text, openBraceIdx) {
  const entries = [];
  let depth = 0; // 花/圆/方括号统一计数；起点 '{' 使深度变为 1；顶层逗号在 depth===1 处切分
  let segStart = openBraceIdx + 1;
  let closedAt = -1;
  walkSignificant(text, (ch, pos) => {
    if (pos < openBraceIdx) return true; // 起点之前不处理
    if (ch === '{' || ch === '(' || ch === '[') { depth++; return true; }
    if (ch === '}' || ch === ')' || ch === ']') {
      depth--;
      if (depth === 0) {
        entries.push(text.slice(segStart, pos));
        closedAt = pos;
        return false;
      }
      return true;
    }
    if (ch === ',' && depth === 1) {
      entries.push(text.slice(segStart, pos));
      segStart = pos + 1;
    }
    return true;
  });
  if (closedAt === -1) throw new Error('对象字面量未闭合');
  return { entries: entries.map(raw => classifyEntry(raw)), endIdx: closedAt + 1 };
}

// 去掉条目开头的注释与空白，返回剩余文本
function stripLeadingComments(s) {
  let t = s;
  for (;;) {
    t = t.replace(/^\s+/, '');
    if (t.startsWith('//')) {
      const nl = t.indexOf('\n');
      if (nl === -1) return '';
      t = t.slice(nl + 1);
      continue;
    }
    if (t.startsWith('/*')) {
      const e = t.indexOf('*/');
      if (e === -1) return '';
      t = t.slice(e + 2);
      continue;
    }
    return t;
  }
}

// 识别条目：method（[async] method(){} 或 name: function(){}）或 state（字段）
function classifyEntry(raw) {
  const t = stripLeadingComments(raw);
  let m = t.match(/^(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/);
  if (m) return { raw, name: m[1], kind: 'method' };
  m = t.match(/^([A-Za-z_$][\w$]*)\s*:/);
  if (m) {
    const rest = t.slice(m[0].length).replace(/^\s+/, '');
    return { raw, name: m[1], kind: /^function\b/.test(rest) ? 'method' : 'state' };
  }
  throw new Error('无法识别的条目: ' + JSON.stringify(t.slice(0, 80)));
}

// 条目归一化：去掉开头注释、条目名（含 async 前缀）与随后的 '(' 或 ':'，再归一化。
// 这样方法签名里的参数保留，但名字本身不参与比对（名字单独比对）。
function entryNorm(raw, name) {
  let t = stripLeadingComments(raw);
  const m = t.match(/^(?:async\s+)?([A-Za-z_$][\w$]*)\s*(\(|:)/);
  if (!m || m[1] !== name) throw new Error('条目名不匹配: ' + name);
  return normalizeJs(t.slice(m[0].length));
}

function extractDomIds(html) {
  const ids = new Set();
  const re = /id="([A-Za-z][\w-]*)"/g;
  let m;
  while ((m = re.exec(html))) ids.add(m[1]);
  return [...ids].sort();
}

module.exports = {
  HTML_PATH,
  readHtml,
  extractScript,
  scriptRange,
  normalizeJs,
  splitObjectEntries,
  classifyEntry,
  entryNorm,
  stripLeadingComments,
  extractDomIds,
};
