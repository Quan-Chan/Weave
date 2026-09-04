'use strict';
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'APPs', 'Weave.html'), 'utf8');
// 直接定位 "collapseClosure(connections, rootId)" 方法体
function extractMethod(source, name) {
  const idx = source.indexOf(name + '(');
  if (idx === -1) throw new Error('not found: ' + name);
  // 找函数体 {
  const openIdx = source.indexOf('{', idx);
  let depth = 1, i = openIdx + 1;
  while (depth > 0 && i < source.length) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
    i++;
  }
  return source.slice(openIdx + 1, i - 1);
}
const closureBody = extractMethod(html, 'collapseClosure');
const multiBody = extractMethod(html, 'hasMultiParentConflict');
const collapseClosure = new Function('connections', 'rootId', closureBody);
const hasMultiParentConflict = new Function('connections', 'closureIds', multiBody);

let pass = 0, fail = 0;
function assert(name, cond) { if (cond) { pass++; console.log('✅ ' + name); } else { fail++; console.log('❌ ' + name); } }

let conns = [{ from: 'R', to: 'A' }, { from: 'A', to: 'B' }, { from: 'B', to: 'C' }];
assert('链闭包', JSON.stringify(collapseClosure(conns, 'R')) === JSON.stringify(['A', 'B', 'C']));
conns = [{ from: 'R', to: 'A' }, { from: 'R', to: 'B' }, { from: 'A', to: 'C' }];
let cl = collapseClosure(conns, 'R');
assert('分支闭包含全部', cl.includes('A') && cl.includes('B') && cl.includes('C') && cl.length === 3);
conns = [{ from: 'A', to: 'B' }, { from: 'B', to: 'C' }, { from: 'C', to: 'A' }];
cl = collapseClosure(conns, 'A');
assert('环闭包 [B,C]', JSON.stringify(cl) === JSON.stringify(['B', 'C']));
conns = [{ from: 'A', to: 'A' }];
cl = collapseClosure(conns, 'A');
assert('自环闭包空', cl.length === 0);
conns = [{ from: 'A', to: 'B' }];
cl = collapseClosure(conns, 'B');
assert('叶子闭包空', cl.length === 0);
conns = [{ from: 'R', to: 'A' }, { from: 'S', to: 'A' }, { from: 'A', to: 'B' }];
assert('多父冲突 true', hasMultiParentConflict(conns, ['A', 'B']) === true);
conns = [{ from: 'R', to: 'A' }, { from: 'R', to: 'A' }, { from: 'A', to: 'B' }];
assert('并联不冲突 false', hasMultiParentConflict(conns, ['A', 'B']) === false);
assert('空闭包无冲突', hasMultiParentConflict([], []) === false);
conns = [{ from: 'X', to: 'A' }, { from: 'Y', to: 'A' }];
assert('闭包外节点不计', hasMultiParentConflict(conns, ['B']) === false);
conns = [{ from: '1', to: '2' }, { from: '2', to: '3' }, { from: '3', to: '4' }, { from: '4', to: '5' }];
cl = collapseClosure(conns, '1');
assert('5层链闭包', cl.length === 4 && cl[3] === '5');

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
