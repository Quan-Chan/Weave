'use strict';
// 打印两图指定区域的像素值（用于诊断微小截图差异）
const puppeteer = require('puppeteer-core');
const fs = require('fs');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

(async () => {
  const [aPath, bPath] = process.argv.slice(2);
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-first-run', '--disable-gpu'] });
  const page = await browser.newPage();
  const [aData, bData] = [fs.readFileSync(aPath).toString('base64'), fs.readFileSync(bPath).toString('base64')];
  const out = await page.evaluate(async (a, b) => {
    const load = (d) => new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = rej; img.src = 'data:image/png;base64,' + d; });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const W = ia.width, H = ia.height;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.drawImage(ia, 0, 0);
    const da = ctx.getImageData(0, 0, W, H).data;
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(ib, 0, 0);
    const db = ctx.getImageData(0, 0, W, H).data;
    const diffs = [];
    for (let y = 100; y < 160; y++) {
      for (let x = 1230; x < 1280; x++) {
        const i = (y * W + x) * 4;
        if (da[i] !== db[i] || da[i + 1] !== db[i + 1] || da[i + 2] !== db[i + 2]) {
          diffs.push({ x, y, A: [da[i], da[i + 1], da[i + 2], da[i + 3]], B: [db[i], db[i + 1], db[i + 2], db[i + 3]] });
        }
      }
    }
    return diffs;
  }, aData, bData);
  console.log('差异像素数(全采样):', out.length);
  out.slice(0, 40).forEach(d => console.log(`(${d.x},${d.y}) A=rgb(${d.A.slice(0,3).join(',')}) B=rgb(${d.B.slice(0,3).join(',')})`));
  await browser.close();
})().catch(e => { console.error('❌', e.message); process.exit(1); });
