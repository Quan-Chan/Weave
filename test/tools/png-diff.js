'use strict';
// 像素差异分析：在 headless 页面内解码两张 PNG，输出差异包围盒 + 粗粒度差异分布图。
// 用法: node test/tools/png-diff.js <a.png> <b.png>
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

(async () => {
  const [aPath, bPath] = process.argv.slice(2);
  if (!aPath || !bPath) { console.error('用法: node test/tools/png-diff.js <a.png> <b.png>'); process.exit(2); }
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-first-run', '--disable-gpu'] });
  const page = await browser.newPage();
  const aData = fs.readFileSync(aPath).toString('base64');
  const bData = fs.readFileSync(bPath).toString('base64');
  const result = await page.evaluate(async (a, b) => {
    const load = (d) => new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = rej;
      img.src = 'data:image/png;base64,' + d;
    });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const W = ia.width, H = ia.height;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.drawImage(ia, 0, 0);
    const da = ctx.getImageData(0, 0, W, H).data;
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(ib, 0, 0);
    const db = ctx.getImageData(0, 0, W, H).data;
    let minX = W, minY = H, maxX = -1, maxY = -1, count = 0;
    const GRID = 32;
    const gW = Math.ceil(W / GRID), gH = Math.ceil(H / GRID);
    const grid = new Array(gW * gH).fill(0);
    for (let y = 0; y < H; y += 2) {
      for (let x = 0; x < W; x += 2) {
        const i = (y * W + x) * 4;
        if (da[i] !== db[i] || da[i + 1] !== db[i + 1] || da[i + 2] !== db[i + 2] || da[i + 3] !== db[i + 3]) {
          count++;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          grid[Math.floor(y / GRID) * gW + Math.floor(x / GRID)]++;
        }
      }
    }
    // 分布图（每格 5 档密度）
    const rows = [];
    for (let gy = 0; gy < gH; gy++) {
      let row = '';
      for (let gx = 0; gx < gW; gx++) {
        const v = grid[gy * gW + gx];
        row += v === 0 ? '.' : (v < 4 ? '+' : (v < 16 ? '#' : (v < 64 ? 'X' : '@')));
      }
      rows.push(row);
    }
    return { W, H, minX, minY, maxX, maxY, count, rows };
  }, aData, bData);
  console.log('尺寸: ' + result.W + 'x' + result.H);
  console.log('差异像素(隔行采样): ' + result.count);
  if (result.count > 0) {
    console.log('差异包围盒: x[' + result.minX + '..' + result.maxX + '] y[' + result.minY + '..' + result.maxY + ']');
    console.log('差异分布（.无 +稀 #中 X密 @很密）:');
    result.rows.forEach(r => console.log('  ' + r));
  } else {
    console.log('两图完全一致');
  }
  await browser.close();
})().catch(e => { console.error('❌', e.message); process.exit(1); });
