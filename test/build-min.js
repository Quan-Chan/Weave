// 生成 APPs/Weave.min.html（压缩发布版）
// 用法: node build-min.js
// 与主版数据兼容：序列化结构/localStorage键/导出格式不变（仅删注释空白+CSS压缩）
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'APPs', 'Weave.html');
const OUT = path.join(__dirname, '..', 'APPs', 'Weave.min.html');
const html = fs.readFileSync(SRC, 'utf8');

// ── 1) CSS 压缩（极保守版）──
// 只删注释 + 行首缩进 + 行尾空白 + 空行；行内所有空白保留。
// 理由：CSS 空格语义复杂（后代选择器、属性值如 '0 auto'、calc()），
// 行内压缩收益小（约 1KB）而风险高，不值得。
function minifyCss(css) {
  // 注释替换为换行（防注释紧贴选择器时删除导致粘连），再按行 trim
  let s = css.replace(/\/\*[\s\S]*?\*\//g, '\n');
  return s
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .join('\n');
}

// ── 2) HTML 压缩（去缩进/空行；标签内属性保留）──
function minifyHtml(seg) {
  return seg
    .split('\n').map(l => l.trim()).filter(Boolean).join('\n')
    // 行内多余空白（标签间）保守保留——HTML 空白可能影响布局（内联元素）
    ;
}

// ── 3) JS 压缩（安全词法压缩器：删注释/缩进/多余空白，保留字符串正则与必需分隔）──
function minifyJs(js) {
  let out = '';
  let i = 0;
  const n = js.length;
  let prevType = null;
  let prevChar = null;
  const isIdChar = c => /[A-Za-z0-9_$]/.test(c);
  function emit(s, type) {
    if (prevType && type && prevType !== 'str' && type !== 'str') {
      const bothWord = (prevType === 'word' || prevType === 'num') && (type === 'word' || type === 'num');
      if (bothWord) out += ' ';
    }
    out += s;
    prevType = type;
  }
  while (i < n) {
    const c = js[i], c1 = js[i + 1];
    if (c === '/' && c1 === '/') { while (i < n && js[i] !== '\n') i++; prevType = null; continue; }
    if (c === '/' && c1 === '*') { const e = js.indexOf('*/', i + 2); i = e === -1 ? n : e + 2; prevType = null; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n) { if (js[j] === '\\') { j += 2; continue; } if (js[j] === c) break; j++; }
      emit(js.slice(i, j + 1), 'str'); i = j + 1; continue;
    }
    if (c === '/' && prevChar !== null && !isIdChar(prevChar) && prevChar !== ')' && prevChar !== ']' && prevChar !== '}' ) {
      let j = i + 1, inCls = false;
      while (j < n) {
        if (js[j] === '\\') { j += 2; continue; }
        if (js[j] === '[') inCls = true; else if (js[j] === ']') inCls = false;
        else if (js[j] === '/' && !inCls) break;
        j++;
      }
      let k = j + 1; while (k < n && /[a-z]/i.test(js[k])) k++;
      emit(js.slice(i, k), 'str'); i = k; continue;
    }
    if (/\s/.test(c)) { i++; continue; }
    if (isIdChar(c)) {
      let j = i; while (j < n && isIdChar(js[j])) j++;
      const word = js.slice(i, j);
      emit(word, /^\d/.test(word) ? 'num' : 'word'); i = j;
    } else { emit(c, 'sym'); i++; }
    prevChar = js[i - 1];
  }
  return out;
}


// ── 4) 词法安全后处理（增强压缩：内容等价）──
// 在 minifyJs 产物上再做一轮安全删除：
//   a. 语句块尾分号: ";}" 且后一字符非 ',' 非 ')'（对象方法尾 ;}, 与 IIFE ;}) 保留）
//   b. 分号后多余空格: "; "
// 用词法外扫描确保不触碰字符串/模板/正则内部。
function postMinifyJs(js) {
  // 词法外标记
  const out = new Set();
  let i = 0, n = js.length;
  while (i < n) {
    const c = js[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n) { if (js[j] === '\\') { j += 2; continue; } if (js[j] === c) break; j++; }
      i = j + 1; continue;
    }
    out.add(i); i++;
  }
  let res = '';
  for (let i = 0; i < js.length; i++) {
    const ch = js[i];
    if (ch === ';' && out.has(i)) {
      const next = js[i + 1];
      // 删块尾分号: 后一字符为 '}' 且再后一字符不是 ',' 或 ')'；
      // 保留对象方法尾(;},) 与箭头函数/IIFE 尾(;}))。
      if (next === '}') {
        const after = js[i + 2];
        if (after === ',' || after === ')') { res += ch; continue; }
        continue;  // 删分号
      }
      if (next === ' ') { continue; }  // 删 "; "
    }
    res += ch;
  }
  return res;
}

// ── 组装 ──
const styleStart = html.indexOf('<style>') + 7;
const styleEnd = html.indexOf('</style>');
const scriptStart = html.indexOf('<script>') + 8;
const scriptEnd = html.indexOf('</script>');

const head = html.slice(0, styleStart - 7);            // <!DOCTYPE...<head>...<style>
const css = minifyCss(html.slice(styleStart, styleEnd));
const mid = html.slice(styleEnd + 8, scriptStart - 8); // </style>...<body>...</script> 前
const js = postMinifyJs(minifyJs(html.slice(scriptStart, scriptEnd)));
const tail = html.slice(scriptEnd);                     // </script></body></html>

const result = head + '<style>' + css + '</style>' + mid + '<script>' + js + tail;
fs.writeFileSync(OUT, result, 'utf8');
console.log('✅ 已生成', OUT);
console.log('原始:', html.length, '字节');
console.log('压缩:', result.length, '字节 (' + Math.round(result.length / html.length * 100) + '%)');
console.log('节省:', html.length - result.length, '字节');
