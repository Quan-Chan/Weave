// 生成 250 节点全连接压测存档，输出到本脚本所在目录。
// 双击 gen-fullmesh.cmd，或在本目录执行 node gen-fullmesh.js。
// 生成结果为 250 个节点、62250 条连线的有向全连接图，用于极端性能测试。
const fs = require('fs');
const path = require('path');

// 节点按 25 列 × 10 行排布，坐标为存档单位（格，1 格 = 20 像素）。
const NODE_COUNT = 250;
const COLUMNS = 25;
const COL_STEP = 14;
const ROW_STEP = 7;
const ORIGIN_X = -168;
const ORIGIN_Y = -35;
// 与 M01 的 PRESET_COLORS 顺序一致，按序循环取色。
const COLORS = ['blue', 'cyan', 'green', 'yellow', 'orange'];
const VIEWPORT = { panX: 0, panY: 0, scale: 0.5 };

const nodes = [];
for (let i = 0; i < NODE_COUNT; i++) {
  nodes.push({
    id: 'n_' + (i + 1),
    label: '节点' + (i + 1),
    desc: '',
    color: COLORS[i % COLORS.length],
    x: ORIGIN_X + (i % COLUMNS) * COL_STEP,
    y: ORIGIN_Y + Math.floor(i / COLUMNS) * ROW_STEP,
    w: 8.5,
    h: 4
  });
}

// 有向全连接：每一对不同的节点之间两个方向各一条连线。
const connections = [];
for (const to of nodes) {
  for (const from of nodes) {
    if (from.id === to.id) continue;
    connections.push({ from: from.id, to: to.id });
  }
}

const data = { nodes, connections, regions: [], viewport: VIEWPORT };
const file = path.join(__dirname, 'weave_250_fullmesh.json');
fs.writeFileSync(file, JSON.stringify(data), 'utf8');
console.log('已生成 ' + file);
console.log('节点 ' + nodes.length + ' 个，连线 ' + connections.length + ' 条，' + (fs.statSync(file).size / 1048576).toFixed(1) + ' MB');
console.log('在 Weave 中通过「导入」加载该文件。');
