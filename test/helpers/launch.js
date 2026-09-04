'use strict';
// 统一 GUI 测试台架:浏览器启动/页面就绪/公共交互工具。
// 设计:
//  - launchWeave(opts)  启动 Edge(自动回退 spawn+connect,兼容受限管道沙箱)
//  - setupChain(page)   布置 A→B→C(+D) 标准链
//  - dblClick(page, cdp, x, y)  CDP 双击(clickCount 1→2)
//  - screenPt / 公共断言辅助
// 用法: const { launchWeave, setupChain, dblClick, ok, closeBrowser } = require('./helpers/launch');
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
    if (!wsUrl) { try { edgeProc.kill(); } catch (_) {} throw new Error('无法连接 Edge DevTools'); }
    const browser = await puppeteer.connect({ browserWSEndpoint: wsUrl, defaultViewport: { width: 1280, height: 800 }, protocolTimeout: 120000 });
    return { browser, mode: 'spawn', cleanup: async () => { await browser.close(); try { edgeProc.kill(); } catch (_) {} await sleep(300); } };
  }
}

// 打开应用页 + 等待就绪 + 关闭首启弹窗。返回 { page, cdp }
async function openApp(browser, { clearStorage = false } = {}) {
  const page = await browser.newPage();
  if (clearStorage) {
    await page.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch (e) {} });
  }
  await page.goto(APP_URL, { waitUntil: 'load' });
  await page.waitForFunction('!!window.App && !!document.getElementById("canvasStage") && document.getElementById("canvasStage").clientWidth > 0', { timeout: 25000 });
  await sleep(500);
  await page.keyboard.press('Escape');  // 关首启设置弹窗
  await sleep(200);
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

module.exports = { EDGE, APP_URL, sleep, launchBrowser, openApp, dblClick, setupChain, mkNode, installFactories, shotsDir };