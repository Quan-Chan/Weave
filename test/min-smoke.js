'use strict';
// Weave.min.html 核心发布冒烟：启动、建节点、连线、撤销、页面异常。
const path = require('path');
const { pathToFileURL } = require('url');

const MIN_URL = pathToFileURL(path.join(__dirname, '..', 'APPs', 'Weave.min.html')).href;
process.env.WEAVE_APP_URL = MIN_URL;
const { launchBrowser, openApp, dblClick } = require('./helpers/launch.js');

let failures = 0;
const ok = (condition, message) => {
  console.log((condition ? '✅ ' : '❌ ') + message);
  if (!condition) failures++;
};

(async () => {
  const launched = await launchBrowser(process.argv.includes('--headed'));
  try {
    const { page, cdp } = await openApp(launched.browser, { clearStorage: true });
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(err && err.message ? err.message : String(err)));

    const stage = await page.evaluate(() => {
      const rect = document.getElementById('canvasStage').getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    });
    await dblClick(page, cdp, stage.left + stage.width * 0.35, stage.top + stage.height * 0.55, 0);
    await page.waitForFunction(() => App.canvasState.nodes.length === 1, { timeout: 3000 });
    await dblClick(page, cdp, stage.left + stage.width * 0.65, stage.top + stage.height * 0.55, 0);
    await page.waitForFunction(() => App.canvasState.nodes.length === 2, { timeout: 3000 });
    ok(true, '压缩版可创建两个节点');

    const points = await page.evaluate(() => {
      const nodes = App.canvasState.nodes;
      const first = App._nodeElMap.get(nodes[0].id);
      const second = App._nodeElMap.get(nodes[1].id);
      const out = first.querySelector('.socket.out').getBoundingClientRect();
      const input = second.querySelector('.socket.in').getBoundingClientRect();
      return {
        out: { x: out.left + out.width / 2, y: out.top + out.height / 2 },
        input: { x: input.left + input.width / 2, y: input.top + input.height / 2 }
      };
    });
    await page.mouse.move(points.out.x, points.out.y);
    await page.mouse.down();
    await page.mouse.move(points.input.x, points.input.y, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(() => App.canvasState.connections.length === 1, { timeout: 3000 });
    ok(true, '压缩版可从 socket 创建连线');

    await page.evaluate(() => App.canvasUndo());
    await page.waitForFunction(() => App.canvasState.connections.length === 0, { timeout: 3000 });
    ok(true, '压缩版可撤销连线');
    ok(pageErrors.length === 0, '压缩版冒烟期间无未捕获页面异常' + (pageErrors.length ? ': ' + pageErrors.join(' | ') : ''));
  } finally {
    await launched.cleanup();
  }

  console.log(failures === 0 ? '\n✅ Weave.min.html 核心冒烟通过' : '\n❌ Weave.min.html 核心冒烟 ' + failures + ' 项失败');
  process.exitCode = failures === 0 ? 0 : 1;
})().catch(err => {
  console.error('压缩版冒烟异常:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
