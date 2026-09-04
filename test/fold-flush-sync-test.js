'use strict';
// 【fold 渲染回归族 2/3 · 可见性同步】
// 验证问题 2 修复: 收起/展开后连线和节点可见性同步（无 rAF 延迟）
// 已迁移至统一台架 test/helpers/launch.js（样板从 ~35 行减至 ~6 行）
const { launchBrowser, openApp, sleep, mkNode } = require('./helpers/launch.js');
let failures = 0;
const ok = (cond, msg) => { console.log((cond ? '✅ ' : '❌ ') + msg); if (!cond) failures++; };

(async () => {
  const { browser, cleanup } = await launchBrowser(false);
  try {
    const { page } = await openApp(browser);
    // 布置 A→B→C 链
    await page.evaluate(([ns, cs]) => {
      App.canvasState.nodes = ns;
      App.canvasState.connections = cs;
      App._nodeZOrder = ns.map(n => n.id);
      App.saveCanvasSnapshot();
      App.renderCanvas();
    }, [
      [mkNode('x_A', 'A', 0, 0), mkNode('x_B', 'B', 320, 0), mkNode('x_C', 'C', 640, 0)],
      [
        { id: 'c_AB', from: 'x_A', to: 'x_B', label: '', mirrored: false },
        { id: 'c_BC', from: 'x_B', to: 'x_C', label: '', mirrored: false }
      ]
    ]);
    await sleep(300);
    await page.evaluate(() => { App.centerCanvasOnNodes(); });
    await sleep(400);
    const sample = () => page.evaluate(() => {
      const b = App._nodeElMap.get('x_B');
      const paths = document.querySelectorAll('#linesSvg .lines path.line:not(.temp)').length;
      return { bDisplay: b ? getComputedStyle(b).display : 'gone', visPaths: paths, pendingRaf: !!App._linesRaf };
    });
    console.log('before:', JSON.stringify(await sample()));
    await page.evaluate(() => { App.toggleCollapse('x_A'); });
    const c0 = await sample();
    console.log('collapse t0:', JSON.stringify(c0));
    // 收起瞬间:节点 B 与全部连线应立即同步隐藏,无 rAF 延迟
    ok(c0.bDisplay === 'none' && c0.visPaths === 0,
      '收起后立即(无rAF延迟)隐藏节点与连线 (b=' + c0.bDisplay + ', paths=' + c0.visPaths + ')');
    ok(!c0.pendingRaf, '收起后无挂起 rAF (_linesRaf=' + c0.pendingRaf + ')');
    await sleep(16);
    const c16 = await sample();
    console.log('collapse t+16:', JSON.stringify(c16));
    ok(c16.bDisplay === 'none' && c16.visPaths === 0, '收起 16ms 后仍隐藏 (paths=' + c16.visPaths + ')');
    await page.evaluate(() => { App.toggleCollapse('x_A'); });
    const e0 = await sample();
    console.log('expand t0:', JSON.stringify(e0));
    // 展开瞬间:节点与连线恢复可见
    ok(e0.bDisplay !== 'none' && e0.visPaths > 0,
      '展开后立即恢复节点与连线可见 (b=' + e0.bDisplay + ', paths=' + e0.visPaths + ')');
    await sleep(16);
    const e16 = await sample();
    console.log('expand t+16:', JSON.stringify(e16));
    ok(e16.bDisplay !== 'none' && e16.visPaths > 0, '展开 16ms 后保持可见 (paths=' + e16.visPaths + ')');
  } finally {
    await cleanup();
  }
  console.log(failures === 0 ? '\n✅ fold-flush 同步断言全部通过' : '\n❌ ' + failures + ' 项失败');
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
