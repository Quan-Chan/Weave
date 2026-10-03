'use strict';
// 模块简表守护：APPs/Weave.html 头部「模块清单」的每一条，必须与对应模块
// banner 的「职责:」行逐字一致。
//
// 背景：模块名与职责在文件里有两处——头部清单（导航用）与各模块 banner
// （模块自身的权威描述）。两者描述同一件事，只靠人工同步会漂移：M08 的 banner
// 缺「（触控/触控笔）」、M09 的清单缺「分区编辑」，都是实际发生过的漂移。
// 模块顺序与存在性由 check-structure.js 守护；本脚本只管两处文案一致。
const fs = require('fs');
const path = require('path');

// WEAVE_MODULE_GUARD_FILE 仅供验证守护自身时指向临时副本，日常运行不必设置。
const FILE = path.resolve(__dirname, '..', process.env.WEAVE_MODULE_GUARD_FILE || 'APPs/Weave.html');
const lines = fs.readFileSync(FILE, 'utf8').split('\n');

// banner：「/* ══ Mxx · 名称 ──」起，其后首个「职责:」行为该模块职责
const banners = new Map();
let pending = null;
lines.forEach((line, i) => {
  const head = line.match(/^\/\* ══ (M\d\d) · /);
  if (head) { pending = head[1]; return; }
  const duty = line.match(/^\s+职责:\s*(.+?)\s*$/);
  if (duty && pending) {
    if (banners.has(pending)) {
      console.log('  ❌ ' + pending + ' 出现多个 banner（L' + i + 1 + '）');
    } else {
      banners.set(pending, { duty: duty[1], line: i + 1 });
    }
    pending = null;
  }
});

// 头部清单：「     Mxx 名称  —— 职责」
const synopsis = new Map();
lines.forEach((line, i) => {
  const m = line.match(/^\s+(M\d\d)\s+(.+?)\s+——\s*(.+?)\s*$/);
  if (m && !synopsis.has(m[1])) synopsis.set(m[1], { duty: m[3], name: m[2], line: i + 1 });
});

let fails = 0;
const bad = msg => { fails++; console.log('  ❌ ' + msg); };

console.log('模块简表守护：banner ' + banners.size + ' 个 / 简表 ' + synopsis.size + ' 条');
if (banners.size !== 13) bad('banner 应为 13 个，实为 ' + banners.size);
if (synopsis.size !== 13) bad('简表应为 13 条，实为 ' + synopsis.size);

for (const id of [...banners.keys()].sort()) {
  const b = banners.get(id);
  const s = synopsis.get(id);
  if (!s) { bad(id + ' 在 banner 中存在但简表未登记'); continue; }
  if (b.duty !== s.duty) {
    bad(id + ' 简表与 banner 职责不一致（简表 L' + s.line + ' ↔ banner L' + b.line + '）');
    console.log('       banner: ' + b.duty);
    console.log('       简表  : ' + s.duty);
  }
}
for (const id of synopsis.keys()) if (!banners.has(id)) bad(id + ' 在简表中存在但无 banner');

if (fails) {
  console.log('❌ 模块简表守护未通过（' + fails + ' 项）');
  process.exit(1);
}
console.log('✅ 模块简表守护通过：13 条与 banner 逐字一致');
