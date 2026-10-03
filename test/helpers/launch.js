'use strict';
// 统一 GUI 测试台架:浏览器启动/页面就绪/公共交互工具。
// 设计:
//  - launchWeave(opts)  启动 Edge(自动回退 spawn+connect,兼容受限管道沙箱)
//  - setupChain(page)   布置 A→B→C(+D) 标准链
//  - dblClick(page, cdp, x, y)  CDP 双击(clickCount 1→2)
//  - screenPt / 公共断言辅助
// 用法: const { launchBrowser, openApp, dblClick, setupChain, mkNode } = require('./helpers/launch');
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const EDGE = process.env.WEAVE_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ROOT = path.join(__dirname, '..', '..');
const APP_URL = process.env.WEAVE_APP_URL || 'file:///' + ROOT.replace(/\\/g, '/') + '/APPs/Weave.html';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 尝试 puppeteer.launch;失败(如沙箱 EPERM)回退手动 spawn+connect
async function launchBrowser(headed) {
  try {
    const browser = await puppeteer.launch({
      executablePath: EDGE,
      headless: !headed,
      args: ['--no-first-run', '--disable-gpu', '--window-size=1280,800'],
      defaultViewport: { width: 1280, height: 800 }
    });
    return { browser, mode: 'launch', cleanup: () => browser.close() };
  } catch (e) {
    // 回退:手动 spawn Edge + DevToolsActivePort 轮询 + connect(stdio ignore 兼容沙箱)
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-pup-'));
    const edgeProc = spawn(EDGE, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--window-size=1280,800',
      '--remote-debugging-port=0', '--user-data-dir=' + userDataDir, 'about:blank'
    ], { stdio: ['ignore', 'ignore', 'ignore'] });
    edgeProc.on('error', err => console.log('edge spawn error: ' + err.message));
    const portFile = path.join(userDataDir, 'DevToolsActivePort');
    const deadline = Date.now() + 25000;
    let wsUrl = null;
    while (Date.now() < deadline && !wsUrl) {
      if (fs.existsSync(portFile)) {
        const pl = fs.readFileSync(portFile, 'utf8').split(/\r?\n/).filter(Boolean);
        if (pl.length >= 2) wsUrl = 'ws://127.0.0.1:' + pl[0] + pl[1];
      }
      if (!wsUrl) await sleep(200);
    }
    const removeProfile = async () => {
      for (let i = 0; i < 20; i++) {
        try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }); } catch (_) {}
        if (!fs.existsSync(userDataDir)) return;
        await sleep(250);
      }
    };
    const stopEdge = async () => {
      try { edgeProc.kill(); } catch (_) {}
      for (let i = 0; i < 20 && edgeProc.exitCode === null && edgeProc.signalCode === null; i++) await sleep(100);
      await removeProfile();
    };
    if (!wsUrl) {
      await stopEdge();
      throw new Error('无法连接 Edge DevTools');
    }
    let browser;
    try {
      browser = await puppeteer.connect({ browserWSEndpoint: wsUrl, defaultViewport: { width: 1280, height: 800 }, protocolTimeout: 120000 });
    } catch (err) {
      await stopEdge();
      throw err;
    }
    let cleaned = false;
    return {
      browser,
      mode: 'spawn',
      cleanup: async () => {
        if (cleaned) return;
        cleaned = true;
        try { await browser.close(); }
        finally {
          await stopEdge();
        }
      }
    };
  }
}

// 打开应用页 + 等待就绪 + 关闭首启弹窗。返回 { page, cdp }
// dismissFirstRun: 是否按 Escape 关掉首次启动弹窗。默认 true；被测对象是首启
//   弹窗本身时传 false（gui-smoke 第 0 步）。
async function openApp(browser, { clearStorage = false, dismissFirstRun = true } = {}) {
  const page = await browser.newPage();
  if (clearStorage) {
    await page.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch (e) {} });
  }
  page.setDefaultNavigationTimeout(60000);
  await page.goto(APP_URL, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('!!window.App && !!document.getElementById("canvasStage") && document.getElementById("canvasStage").clientWidth > 0', { timeout: 25000 });
  await sleep(500);
  if (dismissFirstRun) {
    await page.keyboard.press('Escape');  // 关首启设置弹窗
    await sleep(200);
  }
  const cdp = await page.createCDPSession();
  return { page, cdp };
}

// CDP 双击:headless Chromium 需 clickCount 1→2 递增才会派发 dblclick
async function dblClick(page, cdp, x, y, settle = 250) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(60);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 2 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 2 });
  await sleep(settle);
}

// CDP 触摸点(与 Input.dispatchTouchEvent 的 touchPoints 同构)
const tp = (x, y, id) => ({ x: Math.round(x), y: Math.round(y), id: id || 1, radiusX: 6, radiusY: 6, force: 1 });

async function touchSend(cdp, type, points) {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
}

// 真实触控仿真:在导航之前开启,页面自举时即处于移动端配置
// (ontouchstart 存在、指针走 touch 路径)。裸 Input.dispatchTouchEvent
// 虽也能产生 pointer 事件,但页面是在无触控配置下启动的,与真机不同——
// 触控手势的守护测试必须用这条路径。
const PHONE = { width: 412, height: 820, deviceScaleFactor: 2.625, mobile: true };
async function enableTouch(page, cdp, metrics) {
  const m = metrics || PHONE;
  await cdp.send('Emulation.setDeviceMetricsOverride', m);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await cdp.send('Emulation.setEmitTouchEventsForMouse', { enabled: false, configuration: 'mobile' });
  await sleep(300);
}

// 以移动端触控配置打开应用页(须在 goto 之前调用 enableTouch)。
async function openAppTouch(browser, { clearStorage = true } = {}) {
  const page = await browser.newPage();
  if (clearStorage) {
    await page.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch (e) {} });
  }
  page.setDefaultNavigationTimeout(60000);
  const cdp = await page.createCDPSession();
  await enableTouch(page, cdp);
  await page.goto(APP_URL, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('!!window.App && !!document.getElementById("canvasStage") && document.getElementById("canvasStage").clientWidth > 0', { timeout: 25000 });
  await sleep(600);
  await page.keyboard.press('Escape');  // 关首启设置弹窗
  await sleep(200);
  return { page, cdp };
}

// 轻触:按下即抬起(全程无 touchmove → 应用侧判定为"点击")
async function touchTap(cdp, x, y, holdMs = 60) {
  await touchSend(cdp, 'touchStart', [tp(x, y)]);
  await sleep(holdMs);
  await touchSend(cdp, 'touchEnd', []);
}

// 单指拖拽:按下 → 分步 touchmove → 抬起。首步须越过应用侧 TOUCH_DRAG_SLOP。
async function touchDrag(cdp, x0, y0, x1, y1, steps = 12, stepDelay = 16) {
  await touchSend(cdp, 'touchStart', [tp(x0, y0)]);
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    await touchSend(cdp, 'touchMove', [tp(x0 + (x1 - x0) * k, y0 + (y1 - y0) * k)]);
    await sleep(stepDelay);
  }
  await sleep(40);
  await touchSend(cdp, 'touchEnd', []);
}

// 长按:按住不动达 holdMs → 应用侧弹出上下文菜单(触控版右键)
async function touchLongPress(cdp, x, y, holdMs = 700) {
  await touchSend(cdp, 'touchStart', [tp(x, y)]);
  await sleep(holdMs);
  await touchSend(cdp, 'touchEnd', []);
}

// 双指捏合:第二指落下 → 两指同步外扩/内收 → 抬起
async function touchPinch(cdp, cx, cy, fromDist, toDist, steps = 12) {
  const at = d => [tp(cx - d / 2, cy), tp(cx + d / 2, cy, 2)];
  await touchSend(cdp, 'touchStart', [at(fromDist)[0]]);
  await touchSend(cdp, 'touchStart', at(fromDist));
  await sleep(40);
  for (let i = 1; i <= steps; i++) {
    await touchSend(cdp, 'touchMove', at(fromDist + (toDist - fromDist) * (i / steps)));
    await sleep(16);
  }
  await sleep(40);
  await touchSend(cdp, 'touchEnd', []);
}

// 双击:两次独立轻触,间隔须落在应用的 TOUCH_DOUBLE_MS 窗口内
async function touchDoubleTap(cdp, x, y, gapMs = 70) {
  await touchTap(cdp, x, y, 40);
  await sleep(gapMs);
  await touchTap(cdp, x, y, 40);
}

// 布置 A→B→C(+可选 D) 标准链,返回节点 id 集合
function setupChain(page, nodes, conns) {
  return page.evaluate(([ns, cs]) => {
    App.canvasState.nodes = ns;
    App.canvasState.connections = cs;
    App._nodeZOrder = ns.map(n => n.id);
    App.saveCanvasSnapshot();
    App.renderCanvas();
  }, [nodes, conns]);
}

// 节点工厂(页面内使用)
const mkNode = (id, label, x, y, color) => ({ id, label, desc: '', color: color || 'blue', x, y, mirrored: false, w: 170, h: 80 });

// 把节点工厂注入页面(使 page.evaluate 内可直接 mkNode/mkChain)
async function installFactories(page) {
  await page.evaluate(() => {
    window.__testMk = (id, label, x, y, color) => ({ id, label, desc: '', color: color || 'blue', x, y, mirrored: false, w: 170, h: 80 });
    window.__testChain = (prefix) => {
      const ids = ['A', 'B', 'C', 'D'];
      const ns = ids.slice(0, prefix === 'ABCD' ? 4 : 3).map((L, i) => window.__testMk('x_' + L, L, i * 320, 0));
      const cs = [];
      for (let i = 0; i < ns.length - 1; i++) cs.push({ id: 'c_' + i, from: ns[i].id, to: ns[i + 1].id, label: '', mirrored: false });
      return { ns, cs };
    };
    window.__testReset = () => {
      App.canvasState.nodes = [];
      App.canvasState.connections = [];
      App.canvasState.regions = [];
      App.canvasState.history = [];
      App.canvasHistoryIndex = -1;
      App.saveCanvasSnapshot();
      App.renderCanvas();
    };
  });
  return page;
}

// 截图目录
function shotsDir(name) {
  const d = path.join(__dirname, '..', 'shots-' + name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// 断言收集器：各测试原先各写一份 ok + 失败计数（计数变量在 fails / failures 之间
// 各半，输出前缀也不统一）。统一为一份实现，调用方持有返回的计数（t.fails）。
// 两种既有的调用形态都支持，迁移时无需改调用点：
//   t.ok(cond, msg)          条件在前
//   t.ok(name, cond, extra)  名称在前，extra 非 undefined 时在失败行追加 JSON
// prefix 用于给名称加区域前缀，便于从日志定位。
function assertions(prefix) {
  const api = { pass: 0, fails: 0 };
  api.ok = function(a, b, extra) {
    let name, cond;
    if (typeof a === 'string') { name = a; cond = b; }
    else { name = b; cond = a; }
    const label = (prefix ? prefix + ' ' : '') + (name === undefined ? '' : String(name));
    if (cond) { api.pass++; console.log('  ✅ ' + label); return true; }
    api.fails++;
    console.log('  ❌ ' + label + (extra === undefined ? '' : ' → ' + JSON.stringify(extra)));
    return false;
  };
  return api;
}

// 在画布上找一个空白落点：按网格扫描，返回第一个不落在节点、连线或菜单上的屏幕坐标。
// 「点空白」类手势都要这个点，此前两个测试各写一份扫描（网格与排除集合略有差异）。
// 排除集合取两者并集（含连线标签），避免点在连线上；返回 null 表示没找到。
function blankPoint(page) {
  return page.evaluate(() => {
    const r = document.getElementById('canvasStage').getBoundingClientRect();
    for (let gy = 0.12; gy < 0.92; gy += 0.06) {
      for (let gx = 0.12; gx < 0.92; gx += 0.06) {
        const x = r.left + r.width * gx, y = r.top + r.height * gy;
        const el = document.elementFromPoint(x, y);
        if (el && !el.closest('.node') && !el.closest('#ctx') && !el.closest('.line, .line-label')) return { x, y };
      }
    }
    return null;
  });
}

// 导出面 = 测试实际会用到的部分。EDGE / APP_URL 是台架内部解析结果（测试不直接
// 引用，需要换目标时用 WEAVE_EDGE / WEAVE_APP_URL 环境变量），touchSend 也只在
// 本文件的触摸序列里使用，三者的导出已移除；导出面与 test/README.md 的对应关系
// 由 check-tests.js 守护。
module.exports = { sleep, launchBrowser, openApp, openAppTouch, enableTouch, dblClick, setupChain, mkNode, installFactories, shotsDir, assertions, blankPoint,
  touchTap, touchDrag, touchLongPress, touchPinch, touchDoubleTap };