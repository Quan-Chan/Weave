'use strict';
// PNG 内嵌存档专项 GUI 回归：导出的 PNG 把当前文档的存档 JSON 写进
// 图片自身（iTXt 文本块，keyword = PNG_TEXT_KEYWORD），拖入 / 选择这张
// PNG 时再把图数据读出来加载。五组断言：
//   A 组 纯函数层：CRC-32 标准向量、块结构（IEND 仍收尾、逐块 CRC 正确）、
//      嵌入/读回逐字往返（引号、反斜杠、emoji、换行、空串、大 JSON）、
//      重复嵌入替换而非叠加、非 PNG / 非 Latin-1 keyword 明确失败、
//      tEXt 容忍读、嵌入后图片仍可解码。
//   B 组 节点图往返：App._downloadPngWithDoc 产出的 PNG 内嵌 JSON 必须
//      与 _serializeData() 逐字一致；换掉画布内容后经 _readImageFile
//      导入该 PNG，文档与视口完整还原。
//   C 组 时序图往返：同上，且内嵌 JSON 带 format:'weave-sequence'；
//      先切回节点图再导入，模式被正确切回时序图。
//   D 组 异常路径：无文本块、块内坏 JSON、非 PNG 字节、合法 JSON 但
//      结构非法的文档、只读模式——都要给出明确提示且不动当前文档。
//   E 组 真实拖拽：DataTransfer 派发 dragenter/dragover/drop，验证
//      类型门控（json 与 image 放行、其余不放行）与三种文件的分流。
const { launchBrowser, openApp, sleep, assertions } = require('./helpers/launch.js');

const tally = assertions();
const ok = tally.ok;
const detail = value => {
  try { return JSON.stringify(value); } catch (_) { return String(value); }
};

//页内共享工具：文档夹具、导出捕获、导入封装、状态快照。
async function installFixture(page) {
  await page.evaluate(() => {
    App._lang = 'zh';                       //toast 文案确定性（默认即中文）
    window.__png = {
      //节点图夹具：id/label/desc 里放引号、反斜杠、emoji，分区与连线齐全。
      buildGraphDoc() {
        App.readOnly = false;
        App._setMode('graph');
        App.canvasState.nodes = [
          { id: 'n1', label: '节点"一"', desc: 'desc\\with"quotes"', color: 'blue', x: 40, y: 60, mirrored: false, w: 170, h: 80 },
          { id: 'n2', label: '😀second', desc: '', color: 'green', x: 320, y: 60, mirrored: true, w: 170, h: 80 },
          { id: 'n3', label: 'third', desc: 'x', color: 'orange', x: 320, y: 200, mirrored: false, w: 170, h: 80 }
        ];
        App.canvasState.connections = [
          { id: 'c1', from: 'n1', to: 'n2', label: 'a"b', mirrored: false },
          { id: 'c2', from: 'n2', to: 'n3', label: '', mirrored: true, dashed: true }
        ];
        App.canvasState.regions = [
          { id: 'r1', label: '分区"', color: 'cyan', x: 20, y: 40, w: 480, h: 260, nodeIds: ['n1', 'n2'], parentId: null }
        ];
        App.panX = 0; App.panY = 0; App.scale = 1;
        App._nodeZOrder = ['n1', 'n2', 'n3'];
        App.renderCanvas({ center: false });
        App.saveCanvasSnapshot();
      },
      //时序图夹具：两条时序线 + 一条消息（y=200px = 时间步 4）。
      buildSeqDoc() {
        App.readOnly = false;
        App._setMode('sequence');
        App.canvasState.nodes = [
          { id: 's1', label: '甲', desc: '', color: 'blue', x: 100, y: 60, mirrored: false, w: 180, h: 80, life: 240 },
          { id: 's2', label: '乙', desc: '', color: 'green', x: 400, y: 60, mirrored: false, w: 180, h: 80, life: 240 }
        ];
        App.canvasState.connections = [
          { id: 'm1', from: 's1', to: 's2', label: '请求', mirrored: false, y: 200, dashed: false }
        ];
        App.panX = 0; App.panY = 0; App.scale = 1;
        App._nodeZOrder = ['s1', 's2'];
        App.renderCanvas({ center: false });
        App.saveCanvasSnapshot();
      },
      //把画布换成另一份内容（用于验证"导入真的换了文档"）。
      replaceWithOther() {
        App.canvasState.nodes = [{ id: 'other', label: '别的节点', desc: '', color: 'yellow', x: 60, y: 80, mirrored: false, w: 170, h: 80 }];
        App.canvasState.connections = [];
        App.canvasState.regions = [];
        App.panX = 12; App.panY = 34; App.scale = 1.5;
        App._nodeZOrder = ['other'];
        App.renderCanvas({ center: false });
      },
      //走真实导出通道（_downloadPngWithDoc），截获下载目标并取回字节。
      async exportDoc() {
        const orig = App._triggerDownload;
        const href = await new Promise(resolve => {
          App._triggerDownload = (h) => resolve(h);
          const c = document.createElement('canvas');
          c.width = 40; c.height = 24;
          const cx = c.getContext('2d');
          cx.fillStyle = '#f00'; cx.fillRect(0, 0, 40, 24);
          App._downloadPngWithDoc(c);
        });
        App._triggerDownload = orig;
        const buf = await (await fetch(href)).arrayBuffer();
        return new Uint8Array(buf);
      },
      //没有任何文本块的裸 PNG（画布直接栅格化）。
      plainPng() {
        const c = document.createElement('canvas');
        c.width = 40; c.height = 24;
        const cx = c.getContext('2d');
        cx.fillStyle = '#0f0'; cx.fillRect(0, 0, 40, 24);
        return Weave.Util.dataUrlToBytes(c.toDataURL('image/png'));
      },
      importBytes(bytes, name, type) {
        document.getElementById('toastContainer').textContent = '';
        const f = new File([bytes], name, { type: type || 'image/png' });
        const ret = App._readImageFile(f);
        return new Promise(resolve => setTimeout(() => resolve({
          ret,
          toast: document.getElementById('toastContainer').textContent,
          serial: JSON.stringify(App._serializeData()),
          mode: App._mode
        }), 200));
      },
      serial() { return JSON.stringify(App._serializeData()); },
      toast() { return document.getElementById('toastContainer').textContent; },
      clearToast() { document.getElementById('toastContainer').textContent = ''; },
      //遍历 PNG 全部块：返回 [{type, len, crcOk}]，顺带校验每块 CRC。
      walk(png) {
        const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
        const out = [];
        let off = 8;
        while (off + 12 <= png.length) {
          const len = u32(png, off);
          if (off + 12 + len > png.length) { out.push({ type: 'TRUNCATED', len }); break; }
          const type = String.fromCharCode(png[off + 4], png[off + 5], png[off + 6], png[off + 7]);
          const crcStored = u32(png, off + 8 + len);
          const crcInput = png.subarray(off + 4, off + 8 + len);
          out.push({ type, len, crcOk: Weave.Util.crc32(crcInput) === crcStored });
          off += 12 + len;
          if (type === 'IEND') break;
        }
        return out;
      }
    };
  });
}

/* ── A 组：纯函数层 ─────────────────────────────────────────────── */
async function groupA(page) {
  const r = await page.evaluate(async () => {
    const U = Weave.Util;
    const out = {};
    out.crc = U.crc32(new TextEncoder().encode('123456789')).toString(16);
    const c = document.createElement('canvas'); c.width = 40; c.height = 24;
    const cx = c.getContext('2d'); cx.fillStyle = '#f00'; cx.fillRect(0, 0, 40, 24);
    const png = U.dataUrlToBytes(c.toDataURL('image/png'));
    out.pngSig = png[0] === 137 && png[1] === 80 && png[2] === 78 && png[3] === 71;
    const payload = JSON.stringify({ mode: 'graph', nodes: [{ id: 'a"b\\c', label: '中文😀', note: 'l1\nl2' }] });
    const emb = U.pngAddTextChunk(png, 'WeaveDoc', payload);
    out.embGrew = emb.length > png.length;
    out.walk = window.__png.walk(emb);
    out.read = U.pngGetTextChunk(emb, 'WeaveDoc');
    out.readEq = out.read === payload;
    out.otherKw = U.pngGetTextChunk(emb, 'Nope');
    out.plainKw = U.pngGetTextChunk(png, 'WeaveDoc');
    out.emptyText = U.pngGetTextChunk(U.pngAddTextChunk(png, 'WeaveDoc', ''), 'WeaveDoc');
    const big = 'x"\\' + '😀'.repeat(20000) + '\n'.repeat(500);
    out.bigEq = U.pngGetTextChunk(U.pngAddTextChunk(png, 'WeaveDoc', big), 'WeaveDoc') === big;
    //重复嵌入：替换而非叠加。
    const emb2 = U.pngAddTextChunk(emb, 'WeaveDoc', 'second');
    out.replaced = U.pngGetTextChunk(emb2, 'WeaveDoc');
    out.noDup = emb2.length < emb.length;
    //输入非法。
    out.nonPngAdd = U.pngAddTextChunk(new Uint8Array([1, 2, 3]), 'WeaveDoc', 'x');
    out.nonPngGet = U.pngGetTextChunk(new Uint8Array([1, 2, 3]), 'WeaveDoc');
    out.nonLatinKw = U.pngAddTextChunk(png, '中文', 'x');
    //截断的 PNG：不抛异常，要么读不到要么读到（块在 IEND 前）。
    let truncErr = null, truncVal = 'n/a';
    try { truncVal = U.pngGetTextChunk(emb.slice(0, emb.length - 10), 'WeaveDoc'); } catch (e) { truncErr = e.message; }
    out.truncErr = truncErr; out.truncVal = truncVal === payload || truncVal === null;
    //嵌入后图片仍可解码。
    const toUrl = b => { let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return 'data:image/png;base64,' + btoa(s); };
    out.imgOk = await new Promise(res => { const i = new Image(); i.onload = () => res(i.width === 40); i.onerror = () => res(false); i.src = toUrl(emb); });
    //dataUrlToBytes：非 base64 形态。
    out.percent = Array.from(U.dataUrlToBytes('data:text/plain,hi%20there')).join(',');
    //tEXt 容忍读：手工拼一个 tEXt 块插到 IEND 前。
    const kw = new TextEncoder().encode('WeaveDoc'), tx = new TextEncoder().encode('from-text');
    const tdata = new Uint8Array(kw.length + 1 + tx.length);
    tdata.set(kw, 0); tdata[kw.length] = 0; tdata.set(tx, kw.length + 1);
    const ttype = new TextEncoder().encode('tEXt');
    const tcrcIn = new Uint8Array(ttype.length + tdata.length);
    tcrcIn.set(ttype, 0); tcrcIn.set(tdata, ttype.length);
    const tchunk = new Uint8Array(12 + tdata.length);
    tchunk[0] = 0; tchunk[1] = 0; tchunk[2] = 0; tchunk[3] = tdata.length;
    tchunk.set(ttype, 4); tchunk.set(tdata, 8);
    const crc = U.crc32(tcrcIn);
    tchunk.set([(crc >>> 24) & 255, (crc >>> 16) & 255, (crc >>> 8) & 255, crc & 255], 12 + tdata.length - 4);
    const chunks = window.__png.walk(png);
    const iendOff = (() => { let off = 8; for (const ch of chunks) { if (ch.type === 'IEND') return off; off += 12 + ch.len; } return -1; })();
    const mixed = new Uint8Array(iendOff + tchunk.length + (png.length - iendOff));
    mixed.set(png.subarray(0, iendOff), 0); mixed.set(tchunk, iendOff); mixed.set(png.subarray(iendOff), iendOff + tchunk.length);
    out.tEXt = U.pngGetTextChunk(mixed, 'WeaveDoc');
    return out;
  });
  ok('CRC-32 对 "123456789" 得标准值 cbf43926', r.crc === 'cbf43926', { crc: r.crc });
  ok('canvas 输出的字节确是 PNG（签名正确）', r.pngSig === true);
  ok('嵌入后 PNG 变长', r.embGrew === true);
  ok('嵌入块插在 IEND 之前且 IEND 仍是最后一块', r.walk.length >= 3 && r.walk[r.walk.length - 1].type === 'IEND' && r.walk.some(c => c.type === 'iTXt'), { walk: r.walk });
  ok('嵌入后每个块的 CRC 都正确', r.walk.every(c => c.crcOk), { walk: r.walk });
  ok('读回内容与写入逐字一致（引号/反斜杠/emoji/换行）', r.readEq === true, { read: r.read });
  ok('其它 keyword 读不到', r.otherKw === null);
  ok('未嵌入的裸 PNG 读不到（null 而非抛错）', r.plainKw === null);
  ok('空文本可往返（空串 ≠ 缺失）', r.emptyText === '');
  ok('大 JSON（约 80KB）逐字往返', r.bigEq === true);
  ok('重复嵌入是替换而非叠加', r.replaced === 'second' && r.noDup === true);
  ok('非 PNG 输入：加块/读块都返回 null', r.nonPngAdd === null && r.nonPngGet === null);
  ok('keyword 含非 Latin-1 字符时拒绝嵌入', r.nonLatinKw === null);
  ok('截断的 PNG 不抛异常（读到原值或 null）', r.truncErr === null && r.truncVal === true, { err: r.truncErr });
  ok('嵌入文本块后图片仍可正常解码', r.imgOk === true);
  ok('dataUrlToBytes 支持百分号编码形态', r.percent === '104,105,32,116,104,101,114,101', { percent: r.percent });
  ok('读取容忍外部工具写的 tEXt 块', r.tEXt === 'from-text', { tEXt: r.tEXt });
}

/* ── B 组：节点图导出 → 导入往返 ────────────────────────────────── */
async function groupB(page) {
  const r = await page.evaluate(async () => {
    const out = {};
    window.__png.buildGraphDoc();
    out.before = window.__png.serial();
    const bytes = await window.__png.exportDoc();
    out.embedded = Weave.Util.pngGetTextChunk(bytes, 'WeaveDoc');
    out.embeddedEq = out.embedded === out.before;
    out.chunks = window.__png.walk(bytes).map(c => c.type);
    //换掉画布，再用 PNG 导入。
    window.__png.replaceWithOther();
    out.replaced = window.__png.serial() !== out.before;
    out.imp = await window.__png.importBytes(bytes, 'flow.png', 'image/png');
    return out;
  });
  ok('导出的 PNG 内嵌 JSON 与 _serializeData() 逐字一致', r.embeddedEq === true, { embedded: r.embedded && r.embedded.slice(0, 80) });
  ok('内嵌块位于 IEND 之前', r.chunks.indexOf('iTXt') < r.chunks.length - 1 && r.chunks[r.chunks.length - 1] === 'IEND', { chunks: r.chunks });
  ok('导入前画布确已被换成别的内容', r.replaced === true);
  ok('拖入 PNG 后文档完整还原（节点/连线/分区/视口）', r.imp.serial === r.before, { after: r.imp.serial && r.imp.serial.slice(0, 120) });
  ok('导入成功给出提示', r.imp.toast.indexOf('导入成功') >= 0, { toast: r.imp.toast });
  ok('_readImageFile 同步返回 true', r.imp.ret === true);
}

/* ── C 组：时序图导出 → 导入往返 ────────────────────────────────── */
async function groupC(page) {
  const r = await page.evaluate(async () => {
    const out = {};
    window.__png.buildSeqDoc();
    out.before = window.__png.serial();
    const bytes = await window.__png.exportDoc();
    const embedded = JSON.parse(Weave.Util.pngGetTextChunk(bytes, 'WeaveDoc'));
    out.format = embedded.format;
    out.mode = embedded.mode;
    out.lifeLen = embedded.nodes[0].lifeline.length;
    out.t = embedded.connections[0].t;
    out.embeddedEq = JSON.stringify(embedded) === out.before;
    //先切回节点图并换内容，再导入 PNG：模式应被切回时序图。
    window.__png.buildGraphDoc();
    out.imp = await window.__png.importBytes(bytes, 'flow.png', 'image/png');
    return out;
  });
  ok('时序图内嵌 JSON 带 format: weave-sequence', r.format === 'weave-sequence', { format: r.format });
  ok('内嵌 JSON 的 mode 为 sequence', r.mode === 'sequence');
  ok('lifeline.length 以格写出（240px = 12 格）', r.lifeLen === 12, { lifeLen: r.lifeLen });
  ok('消息 t 按时间轴换算（y=200px → 第 4 步）', r.t === 4, { t: r.t });
  ok('内嵌 JSON 与 _serializeData() 逐字一致', r.embeddedEq === true);
  ok('导入后模式被切回时序图', r.imp.mode === 'sequence', { mode: r.imp.mode });
  ok('时序图文档完整还原', r.imp.serial === r.before, { after: r.imp.serial && r.imp.serial.slice(0, 120) });
}

/* ── D 组：异常路径 ─────────────────────────────────────────────── */
async function groupD(page) {
  const r = await page.evaluate(async () => {
    const out = {};
    const U = Weave.Util;
    //① 没有文本块的 PNG。
    window.__png.buildGraphDoc();
    out.before = window.__png.serial();
    out.noChunk = await window.__png.importBytes(window.__png.plainPng(), 'flow.png', 'image/png');
    out.noChunkKept = out.noChunk.serial === out.before;
    //② 块内是坏 JSON。
    const png = window.__png.plainPng();
    const broken = U.pngAddTextChunk(png, 'WeaveDoc', '{not valid json');
    out.broken = await window.__png.importBytes(broken, 'flow.png', 'image/png');
    out.brokenKept = out.broken.serial === out.before;
    //③ 根本不是 PNG 的字节。
    const junk = new Uint8Array(300);
    for (let i = 0; i < junk.length; i++) junk[i] = (i * 37) % 256;
    out.junk = await window.__png.importBytes(junk, 'flow.png', 'image/png');
    out.junkKept = out.junk.serial === out.before;
    //④ 块内是合法 JSON 但不是合法文档。
    const badDoc = U.pngAddTextChunk(png, 'WeaveDoc', JSON.stringify({ nodes: 'not-an-array' }));
    out.badDoc = await window.__png.importBytes(badDoc, 'flow.png', 'image/png');
    out.badDocKept = out.badDoc.serial === out.before;
    //⑤ 只读模式：直接拒绝。
    App.readOnly = true;
    document.getElementById('toastContainer').textContent = '';
    const ret = App._readImageFile(new File([png], 'flow.png', { type: 'image/png' }));
    await new Promise(res => setTimeout(res, 150));
    out.readonly = { ret, toast: document.getElementById('toastContainer').textContent, kept: window.__png.serial() === out.before };
    App.readOnly = false;
    return out;
  });
  ok('无文本块的 PNG：提示没有图数据', r.noChunk.toast.indexOf('没有图数据') >= 0, { toast: r.noChunk.toast });
  ok('无文本块的 PNG：当前文档不动', r.noChunkKept === true);
  ok('块内坏 JSON：提示解析失败', r.broken.toast.indexOf('解析失败') >= 0, { toast: r.broken.toast });
  ok('块内坏 JSON：当前文档不动', r.brokenKept === true);
  ok('非 PNG 字节：提示没有图数据且不崩', r.junk.toast.indexOf('没有图数据') >= 0 && r.junk.ret === true, { toast: r.junk.toast });
  ok('非 PNG 字节：当前文档不动', r.junkKept === true);
  ok('合法 JSON 但结构非法：走无效存档提示', r.badDoc.toast.indexOf('无效') >= 0, { toast: r.badDoc.toast });
  ok('结构非法的文档不被载入', r.badDocKept === true);
  ok('只读模式：返回 false 且提示只读', r.readonly.ret === false && r.readonly.toast.indexOf('只读') >= 0, { readonly: r.readonly });
  ok('只读模式：当前文档不动', r.readonly.kept === true);
}

/* ── E 组：真实拖拽事件 ─────────────────────────────────────────── */
async function groupE(page) {
  const r = await page.evaluate(async () => {
    const out = {};
    const stage = document.getElementById('canvasStage');
    const fire = (type, file) => {
      const dt = new DataTransfer();
      if (file) dt.items.add(file);
      const e = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
      stage.dispatchEvent(e);
      return e;
    };
    window.__png.buildGraphDoc();
    out.before = window.__png.serial();
    const bytes = await window.__png.exportDoc();
    const jsonText = JSON.stringify({
      mode: 'graph',
      nodes: [{ id: 'drag_j', label: '拖入的 JSON', desc: '', color: 'blue', x: 2, y: 3, mirrored: false, w: 8.5, h: 4 }],
      connections: [], regions: [], viewport: { panX: 0, panY: 0, scale: 1 }
    });
    const pngFile = new File([bytes], 'flow.png', { type: 'image/png' });
    const plainFile = new File([window.__png.plainPng()], 'plain.png', { type: 'image/png' });
    const jsonFile = new File([jsonText], 'flow.json', { type: 'application/json' });
    const txtFile = new File(['hello'], 'note.txt', { type: 'text/plain' });

    //门控：dragover 的 preventDefault 决定浏览器是否放行这次拖放。
    out.overPng = fire('dragover', pngFile).defaultPrevented;
    out.overJson = fire('dragover', jsonFile).defaultPrevented;
    out.overTxt = fire('dragover', txtFile).defaultPrevented;
    //dragenter 只对可导入类型加高亮类。
    fire('dragleave', null);
    out.enterPng = (fire('dragenter', pngFile), stage.classList.contains('drag-over'));
    fire('dragleave', null);
    out.enterTxt = (fire('dragenter', txtFile), stage.classList.contains('drag-over'));
    fire('dragleave', null);

    //drop 分流：PNG（带存档）→ 加载。
    fire('drop', pngFile);
    await new Promise(res => setTimeout(res, 250));
    out.dropPng = { serial: window.__png.serial(), toast: window.__png.toast(), mode: App._mode };

    //PNG（无存档）→ 明确提示，文档保持刚载入的状态。
    fire('drop', plainFile);
    await new Promise(res => setTimeout(res, 250));
    out.dropPlain = { toast: window.__png.toast(), kept: window.__png.serial() === out.dropPng.serial };

    //JSON → 仍然走原路径。
    fire('drop', jsonFile);
    await new Promise(res => setTimeout(res, 250));
    out.dropJson = { label: (App.canvasState.nodes[0] || {}).label, mode: App._mode };

    //txt → 提示支持的类型，不崩。
    window.__png.clearToast();
    fire('drop', txtFile);
    await new Promise(res => setTimeout(res, 250));
    out.dropTxt = { toast: window.__png.toast(), label: (App.canvasState.nodes[0] || {}).label };

    //空的拖放（没有文件）→ 静默忽略。
    let emptyErr = null;
    try { fire('drop', null); } catch (e) { emptyErr = e.message; }
    out.emptyErr = emptyErr;
    return out;
  });
  ok('dragover：PNG 放行（preventDefault）', r.overPng === true);
  ok('dragover：JSON 放行（回归）', r.overJson === true);
  ok('dragover：文本文件不放行', r.overTxt === false);
  ok('dragenter：PNG 高亮放置区', r.enterPng === true);
  ok('dragenter：文本文件不高亮', r.enterTxt === false);
  ok('drop PNG：内嵌文档被载入', r.dropPng.serial === r.before, { after: r.dropPng.serial && r.dropPng.serial.slice(0, 120) });
  ok('drop PNG：给出导入成功提示', r.dropPng.toast.indexOf('导入成功') >= 0, { toast: r.dropPng.toast });
  ok('drop 无存档 PNG：提示没有图数据', r.dropPlain.toast.indexOf('没有图数据') >= 0, { toast: r.dropPlain.toast });
  ok('drop 无存档 PNG：不破坏已载入的文档', r.dropPlain.kept === true);
  ok('drop JSON：仍走原路径（节点载入）', r.dropJson.label === '拖入的 JSON', { label: r.dropJson.label });
  ok('drop txt：提示支持 .json/.png', r.dropTxt.toast.indexOf('.json') >= 0 && r.dropTxt.toast.indexOf('.png') >= 0, { toast: r.dropTxt.toast });
  ok('drop txt：不破坏当前文档', r.dropTxt.label === '拖入的 JSON');
  ok('空拖放（无文件）静默忽略', r.emptyErr === null);
}

(async () => {
  const { browser, cleanup } = await launchBrowser(false);
  try {
    const { page } = await openApp(browser, { clearStorage: true });
    let pageErrors = 0;
    page.on('pageerror', () => { pageErrors++; });
    await installFixture(page);
    await groupA(page);
    await groupB(page);
    await groupC(page);
    await groupD(page);
    await groupE(page);
    ok('全程无未捕获页面异常', pageErrors === 0, { pageErrors });
  } finally {
    await cleanup();
  }
  if (tally.fails) {
    console.error('\n❌ PNG 内嵌存档专项未通过（' + tally.fails + ' 项失败 / ' + tally.pass + ' 项通过）');
    process.exit(1);
  }
  console.log('\n✅ PNG 内嵌存档专项全部通过（' + tally.pass + ' 项断言）');
})().catch(err => { console.error('PNG 测试执行异常:', err); process.exit(1); });
