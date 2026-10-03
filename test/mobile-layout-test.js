'use strict';
// 手机布局守护:各弹窗在手机视口下必须完整落在屏幕内。
// 覆盖竖屏(大/小)与横屏——横屏宽度常大于 820，只按宽度设断点会整段失效，
// 弹窗按桌面尺寸渲染并被 .modal-box 的 scale(1.25) 放大到出屏。
// 守护的规则:
//   1 任何视口下弹窗都不得超出视口、不得上下出屏
//   2 设置面板必须在既定高度内滚动，不得撑破 .settings-body
//   3 顶栏 + 侧边栏占用不得挤占过多画布高度
//   4 文档不得出现横向滚动
const {
  sleep, launchBrowser, openAppTouch, setupChain, mkNode, installFactories, assertions
} = require('./helpers/launch');

// 视口的值里 width/height 是布局断点的决定量（setDeviceMetricsOverride 直接
// 设定布局视口）；mobile/dsf 用于贴近真机表征（触控指针与 DPR），不参与断点
// 判定——实测把 mobile 关掉布局结果不变，故不设以它们为准的断言。
const VIEWPORTS = [
  { name: '竖屏 iPhone 16 Pro Max', w: 440, h: 956, mobile: true, dsf: 3, maxChromeH: 300 },
  { name: '竖屏 iPhone SE', w: 375, h: 667, mobile: true, dsf: 2, maxChromeH: 300 },
  { name: '横屏 iPhone 16 Pro Max', w: 956, h: 440, mobile: true, dsf: 3, maxChromeH: 160 },
  { name: '横屏 iPhone SE', w: 667, h: 375, mobile: true, dsf: 2, maxChromeH: 160 },
  { name: '桌面基线', w: 1280, h: 800, mobile: false, dsf: 1, maxChromeH: 160 }
];

const tally = assertions();
const ok = tally.ok;

// 逐个打开每个弹窗，量它的实际视觉尺寸是否落在视口内
const MODALS = [
  { id: 'settingsModal', open: 'App.showSettings()', close: 'App.closeSettings()' },
  { id: 'modal', open: "App.openNodeModal(App.canvasState.nodes[0].id)", close: 'App.closeModal()' },
  { id: 'regionModal', open: "App.openRegionModal(App.canvasState.regions[0].id)", close: 'App.closeRegionModal()' },
  { id: 'cpModal', open: 'App.openCustomPicker && App.openCustomPicker()', close: 'App.cancelCustomPicker()' }
];

(async () => {
  const { browser, cleanup } = await launchBrowser(false);
  // 触控在导航前开启（openAppTouch 内部调 enableTouch）：页面自举时就带
  // ontouchstart 与触控指针能力，与真机一致——仅靠 setDeviceMetricsOverride
  // 不会开启触控。各视口随后只改尺寸。
  const { page, cdp } = await openAppTouch(browser);
  await installFactories(page);
  await setupChain(page, [mkNode('A', 'A', 0, 0), mkNode('B', 'B', 320, 0)], []);
  // 分区弹窗需要真实分区才有内容可量
  await page.evaluate(() => {
    App.canvasState.regions = [{ id: 'rg1', label: 'R', color: 'blue', x: -200, y: -200, w: 800, h: 600, nodeIds: [], parentId: null }];
    App.renderCanvas();
  });
  await sleep(400);

  for (const v of VIEWPORTS) {
    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width: v.w, height: v.h, deviceScaleFactor: v.dsf, mobile: v.mobile });
    await sleep(500);
    console.log('\n════ ' + v.name + ' (' + v.w + '×' + v.h + ') ════');

    // 顶栏 / 侧边栏占用
    const chrome = await page.evaluate(() => {
      const h = document.querySelector('.header').getBoundingClientRect().height;
      const s = document.getElementById('sidebar').getBoundingClientRect();
      const c = document.getElementById('canvasStage').getBoundingClientRect();
      return { headerH: Math.round(h), sidebarW: Math.round(s.width),
               sidebarH: Math.round(s.height), canvasH: Math.round(c.height), canvasW: Math.round(c.width) };
    });
    const chromeH = chrome.sidebarW >= chrome.canvasW ? chrome.headerH + chrome.sidebarH : chrome.headerH;
    ok('顶栏+侧边栏占用 ' + chromeH + 'px 未挤占过多画布（阈值 ' + v.maxChromeH + '）', chromeH <= v.maxChromeH, chrome);
    ok('画布仍有可用高度（≥200px）', chrome.canvasH >= 200, chrome);
    ok('文档无横向滚动', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));

    // 分区 / 框选 / 多选模式应已从顶栏移入侧边栏
    const place = await page.evaluate(() => {
      const where = id => {
        const el = document.getElementById(id);
        if (!el) return 'missing';
        return el.closest('#sidebar') ? 'sidebar' : (el.closest('.header') ? 'header' : 'other');
      };
      const btns = [...document.querySelectorAll('#sidebar .sidebar-btn')];
      return {
        region: where('btnRegion'), box: where('btnBox'), multi: where('btnMultiSelect'),
        sidebarCount: btns.length,
        sidebarScrollH: document.getElementById('sidebar').scrollHeight,
        sidebarClientH: document.getElementById('sidebar').clientHeight
      };
    });
    ok('分区按钮位于侧边栏', place.region === 'sidebar', place);
    ok('框选按钮位于侧边栏', place.box === 'sidebar', place);
    ok('多选模式按钮位于侧边栏', place.multi === 'sidebar', place);
    ok('侧边栏按钮未溢出（scroll=' + place.sidebarScrollH + ' client=' + place.sidebarClientH + '）',
      place.sidebarScrollH <= place.sidebarClientH + 2, place);

    // 逐个弹窗
    for (const m of MODALS) {
      const opened = await page.evaluate(code => {
        try {
          // eslint-disable-next-line no-new-func
          new Function(code)();
          return true;
        } catch (e) { return false; }
      }, m.open);
      await sleep(350);
      if (!opened) { console.log('     · ' + m.id + ' : 该版本无此入口，跳过'); continue; }
      const box = await page.evaluate(id => {
        const el = document.getElementById(id);
        const b = el.querySelector('.modal-box') || el;
        const r = b.getBoundingClientRect();
        return {
          w: Math.round(r.width), h: Math.round(r.height),
          top: Math.round(r.top), bottom: Math.round(r.bottom),
          left: Math.round(r.left), right: Math.round(r.right),
          vw: innerWidth, vh: innerHeight,
          on: el.classList.contains('on')
        };
      }, m.id);
      const fits = box.w <= box.vw && box.h <= box.vh && box.top >= -1 && box.bottom <= box.vh + 1;
      ok(m.id + ' 弹窗完整在屏内', fits && box.on, box);
      await page.evaluate(code => { try { new Function(code)(); } catch (e) {} }, m.close);
      await sleep(250);
    }

    // 设置面板必须在自己高度内滚动，而不是撑破容器
    await page.evaluate(() => App.showSettings());
    await sleep(400);
    const panel = await page.evaluate(() => {
      const p = document.querySelector('.settings-panel[data-settings-panel="keys"]');
      const body = document.querySelector('.settings-body');
      return {
        clientH: Math.round(p.clientHeight), scrollH: Math.round(p.scrollHeight),
        bodyH: Math.round(body.getBoundingClientRect().height),
        panelH: Math.round(p.getBoundingClientRect().height)
      };
    });
    ok('设置面板未撑破 .settings-body（' + panel.panelH + ' ≤ ' + panel.bodyH + '）',
      panel.panelH <= panel.bodyH + 2, panel);
    ok('设置面板内容多时在其内滚动', panel.scrollH > panel.clientH, panel);
    await page.evaluate(() => App.closeSettings());
    await sleep(250);
  }

  console.log('\n────────────────────────────');
  console.log('结果: ' + tally.pass + ' 通过, ' + tally.fails + ' 失败');
  await cleanup();
  process.exit(tally.fails ? 1 : 0);
})().catch(e => { console.error('布局测试异常:', e); process.exit(1); });