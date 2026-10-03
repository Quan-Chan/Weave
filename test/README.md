# Weave 测试与结构守护

## 快速开始

统一入口(按序跑全部断言型测试):

```bash
cd test && npm test          # 统一入口: 串行跑全部断言型测试
```

## 测试工作流(何时跑什么)

按改动范围选择,从快到慢:

| 场景 | 命令 | 耗时 |
|---|---|---|
| 只改纯函数(Weave.*) | `npm run test:fast` | ~1s |
| 改 Weave.html 任意代码 | `npm run test:structure` + `npm run test:gui` | ~1min |
| 改某功能域(collapse/region/undo…) | 对应 `npm run test:<域>` | ~1-2min |
| 改导入/持久化/编辑快捷键 | `npm run test:data-safety` | ~10s |
| 改恢复工具或本地存档救援 | `npm run test:recovery` | ~15s |
| 改触控手势 | `npm run test:touch` | ~1min |
| 改选中逻辑 / 多选模式 | `npm run test:multi` | ~1min |
| 改 CSS / 弹窗结构 | `npm run test:structure` + `npm run test:layout` | ~1min |
| 提交前完整回归（含压缩版门禁） | `npm test` | ~8min |
| 模块化重构前(不常做) | `node test/diff-test.js`(重构前先提交既有改动) | ~3min |

**推荐开发循环**:
1. 改代码 → 立即 `test:structure`(结构守护,秒级)
2. 涉及交互 → `test:gui`(冒烟,分钟级)
3. 涉及专项域 → 跑该域分组
4. 提交前 → `npm test` 全绿才提交

**可选 git 提交钩子**(防漏跑,放入 `.git/hooks/pre-commit`):

```bash
#!/bin/sh
# 提交前最小门禁: 结构 + 单测(秒级);完整回归在 CI/手动执行
cd test && npm run test:fast
if [ $? -ne 0 ]; then echo "❌ 结构/单测未通过,禁止提交"; exit 1; fi
```

> diff-test.js 不纳入 npm test:它对比 git HEAD 原版,仅重构回归适用(见下)。

## GitHub CI

仓库含 `.github/workflows/ci.yml`,push/PR 自动触发:

| Job | 内容 | 触发 |
|---|---|---|
| quick | 结构守护 + 纯函数单测(秒级) | 每次 push/PR |
| gui | 全量 GUI 回归(ubuntu + Chrome + 中文字体) | 每次 push/PR |

- 浏览器经 `WEAVE_EDGE` 环境变量注入(`/usr/bin/google-chrome`)。`test/` 下的测试脚本均读取该变量,缺省回退作者机 Edge 路径;`test/tools/` 与 `test/refactor/` 下的辅助脚本仍硬编码
- 失败自动归档 `test/shots*/**/*.png` 截图(artifact: test-shots,保留 7 天)
- `diff-test.js` 不入 CI:它对比 git HEAD 原版,仅重构前手动运行

> 本地跑 CI 等效: `cd test && WEAVE_EDGE=/path/to/chrome npm test`
> (Windows: `$env:WEAVE_EDGE='C:\path\to\msedge.exe'; npm test`)

## 统一测试台架 helpers/

`test/helpers/launch.js` 提供浏览器启动/页面就绪/公共交互,新测试应优先复用:

- `launchBrowser(headed)` — 自动 `puppeteer.launch`,失败(沙箱 EPERM)回退手动 spawn+connect,返回 { browser, mode, cleanup }
- `openApp(browser, opts)` — 打开应用、等就绪、关首启弹窗,返回 { page, cdp }。`clearStorage` 于导航前清空 localStorage；`dismissFirstRun:false` 保留首启弹窗(被测对象是它时用)
- `openAppTouch(browser, opts)` — 以移动端触控配置打开应用页（导航前调 `enableTouch`），触控手势类测试用它开局
- `enableTouch(page, cdp, metrics?)` — 设定设备指标并开启触控仿真；`openAppTouch` 内部调用，视口需要自行指定时可直接用
- `dblClick(page, cdp, x, y)` — CDP 双击(clickCount 1→2)
- `setupChain(page, nodes, conns)` — 按给定节点与连线布置标准链
- `mkNode(id,label,x,y)` / `installFactories(page)` — 布置工厂(注入页面级 `__testMk/__testChain/__testReset`)
- `sleep(ms)` / `shotsDir(name)` — 延时；截图目录。换浏览器或应用地址用 `WEAVE_EDGE` / `WEAVE_APP_URL` 环境变量，台架不导出解析结果
- `assertions(prefix?)` — 断言收集器；返回 `{ ok, pass, fails }`，把其中的断言函数取出当本地断言用（`const tally = assertions(); const ok = tally.ok;`）。支持两种调用形态：条件在前 `(cond, msg)`，或名称在前 `(name, cond, extra)`；extra 非 undefined 时在失败行追加 JSON
- `blankPoint(page)` — 在画布上按网格扫描并返回第一个空白屏幕坐标（避开节点、连线与菜单），供「点空白」类手势使用；找不到返回 null
- `touchTap()` / `touchDrag()` / `touchLongPress()` / `touchPinch()` / `touchDoubleTap()` — CDP `Input.dispatchTouchEvent` 触摸序列（更底层的 `touchSend` 只在台架内部使用）

全部 GUI 测试已接入台架，无人再自带 `puppeteer.launch` 样板或自写断言辅助；这条要求由 `check-tests.js` 守护（见下节），也是 `test:fast` 的一部分。新增 GUI 测试必须复用台架，并加入 `npm test` 主链——CI 只跑该链，只加域分组脚本不会被覆盖。

## 测试

### 测试清单与职责(文件名速查)

| 文件 | 层级 | 职责 | 何时跑 |
|---|---|---|---|
| check-version.js | 静态 | 版本号一致性(应用/CHANGELOG/git tag) | 发版或改版本号后 |
| i18n-keys.js | 静态 | 主程序 I18N 键集、占位符、英文词典与静态引用 | 每次改语言文案或 Weave.html 后 |
| i18n-recovery.js | 静态 | 恢复页 I18N 键集、占位符、英文无中文、无硬编码中文文案 | 每次改语言文案或 Weave-recovery.html 后 |
| check-structure.js | 静态 | 模块化结构守护(M01→M13/条目等价) | 每次改 Weave.html 后 |
| check-module-list.js | 静态 | 头部「模块清单」与各模块 banner 的职责行逐字一致（含 13 个模块齐全） | 改模块职责或头部注释后(`test:modules`) |
| check-tests.js | 静态 | 测试台架守护:必须走 helpers/launch、不得自带 puppeteer.launch 样板/硬编码浏览器路径/自写断言辅助;文件可编译、台架函数调用已导入;测试文件须进 npm test 主链;台架导出面与本文 API 清单一致且无死导出 | 新增或改测试、改台架或改本文后(`test:tests`) |
| geom-unit-test.js | 单测 | collapse 闭包/多父冲突纯函数 | 每次改 collapse 逻辑 |
| gui-smoke.js | 冒烟 | 核心交互主路径(建节点/连线/设置/i18n) | 每次改 Weave.html 后 |
| data-safety-gui-test.js | 专项 | 导入原子性/只读入口/编辑态快捷键/存储失败提示 | 改导入、快捷键或持久化后 |
| recovery-tool-test.js | 专项/性能 | 恢复页不渲染图；占用显示、清空节点图、JSON 导入导出、软件设置、10 项键位录制与配额失败；中英文切换与两语提示；本地与在线两种来源各自的读写与互不可见 | 改恢复工具或存档救援后(`test:recovery`) |
| region-smoke.js | 专项 | 分区全功能(63 断言) | 改分区相关后 |
| collapse-test.js | 专项 | 收起主流程(需求1-5) | 改 collapse 后 |
| collapse-edge-test.js | 专项 | 收起边界(撤销/删除/序列化) | 改 collapse/undo 后 |
| fold-click-badge-test.js | 回归 | fold 渲染族1: 徽标点击/拖拽显隐 | 改 socket/fold 渲染后 |
| fold-flush-sync-test.js | 回归 | fold 渲染族2: 收起可见性同步 | 同上 |
| fold-zoom-twitch-test.js | 回归 | fold 渲染族3: 缩放无抽搐 | 同上 |
| hl-smoke.js | 专项 | 关联高亮(高亮集合/抬升/背景模糊/清除还原) | 改关联高亮后 |
| hl-keybind-test.js | 专项 | 关联高亮键位自定义(改绑后手势切换) | 改键位/关联高亮后 |
| hl-keybind-ui-test.js | 专项 | 设置弹窗中关联高亮键位的录制/显示/重置 | 同上 |
| snap-reset-test.js | 专项 | 对齐设置重置(方法调用 + UI 点击双路径) | 改对齐设置后 |
| node-drag-snap-test.js | 专项 | 节点拖拽吸附动画/监听泄漏 | 改吸附/动画后(`test:dragsnap`) |
| undo-cap-test.js | 专项 | 撤销栈 50 步上限 | 改 undo/历史后 |
| repro-bugs.js | 回归 | 三个历史 bug 不再复现 | 改 collapse/导入/手势后 |
| touch-smoke-test.js | 专项 | 触控手势（平移/捏合/点选/双击/拖拽/长按菜单/框选/建线/无重复触发/只读） | 改输入手势或触控后（`test:touch`） |
| multi-select-test.js | 专项 | 多选模式（侧边栏开关/累加选中/平移不清除/空白单击取消/整组拖拽/菜单项移除） | 改选中逻辑或节点拖拽后（`test:multi`） |
| mobile-layout-test.js | 专项 | 手机布局（竖屏大/小 + 横屏 + 桌面，各弹窗不出屏、设置面板内滚动、顶栏占用、横向滚动；触控在导航前开启） | 改 CSS 或弹窗结构后（`test:layout`） |
| min-smoke.js | 冒烟 | 压缩发布版启动/建节点/连线/撤销 | 每次改 Weave.html 后 |
| diff-test.js | 差分 | git HEAD 双页对比(**仅重构前适用**) | 模块化重构前手动 |
| build-min.js | 工具/门禁 | 生成 Weave.min.html；`--check` 只比较不写入 | 发布及每次完整回归 |

> 命名规范: `{功能}-{层级}-test.js`。`*-smoke.js`(gui/region/hl)、`check-structure.js`、
> `i18n-keys.js`、`repro-bugs.js` 为规范确定前的历史命名,保持不改。

### 压测存档与工具(非测试)

- `test/samples/` — 手工导入用存档,不被自动化测试引用
  - `test/samples/weave_250_nodes.json` — 250 节点、465 连线的常规图
  - `test/samples/weave_arrow_demo.json` — 6 节点、4 连线的箭头形状演示
  - `test/samples/gen-fullmesh.cmd` + `test/samples/gen-fullmesh.js` — 生成 250 节点、62250 连线的有向全连接压测存档;产物 `test/samples/weave_250_fullmesh.json` 体积较大,不入库
- `test/tools/png-diff.js`、`test/tools/pixel-dump.js` — 截图与像素比对辅助

### GUI 冒烟测试

用 [puppeteer-core](https://www.npmjs.com/package/puppeteer-core) + 系统 Edge（headless）驱动真实浏览器，
对 `APPs/Weave.html` 做交互级冒烟测试：首次启动弹出快速入门（关闭）、双击建节点、socket 拖线、
右键镜像、平行连线、调整大小模式、设置弹窗、**语言切换（中文 ↔ English 断言）**、内联编辑、
专注模式，并逐步截图到 `shots/`。

```bash
cd test
npm install --cache ./.npm-cache    # 首次（或 node_modules 丢失时）
cd ..
node test/gui-smoke.js              # 无头运行
node test/gui-smoke.js --headed     # 有头运行（可观察窗口）
```

### 压缩发布版门禁

`build-min.js --check` 在内存中生成压缩结果，编译生成脚本并与仓库中的
`APPs/Weave.min.html` 逐字比较，不写文件。`min-smoke.js` 再验证压缩版启动、
创建节点、创建连线与撤销。

```bash
cd test
npm run test:min
```

### 画框分区专项测试

`region-smoke.js` 用同一台架驱动浏览器，覆盖分区创建（Alt+拖拽、Shift+R 模式）、
选中、整体移动、框体独立移动、四角手柄调整大小、属性弹窗（样式与节点弹窗一致、
无冗余尺寸输入）、右键菜单项、节点拖入自动归属、撤销/重做、存档往返与序列化。

```bash
node test/region-smoke.js           # 无头运行
```

### 差分测试（重构回归专用，功能开发后不再适用）

同时驱动两个页面：A = 原版（`git HEAD:APPs/Weave.html`），B = 新版（工作区），
逐步执行相同交互序列，每步比对 App 状态快照、页面截图与导出产物。

> ⚠️ **适用范围**：该测试用于验证"模块化重构 + 注释翻译"未改变行为。
> 一旦提交重构、或叠加新功能（如 i18n 多语言），与 git HEAD 的行为差异是
> **预期内**的，差分测试将不再作为门禁。日常回归请以 `gui-smoke.js` 为准。

```bash
node test/diff-test.js
```

注意：须在重构改动尚未提交、既有工作已提交时运行（原版取自 git HEAD）。测试截图在 `test/shots-diff/`。

### 撤销/重做上限测试（undo-cap-test.js）

纯状态层验证 `_canvasHistoryMax=50` 封顶、满栈撤销/重做、混合操作链逐级撤销。

```bash
node test/undo-cap-test.js
```

### 结构守护（模块化拼接形态的守门人）

`APPs/Weave.html` 的 `<script>` 是 13 个模块的拼接（M01 常量与工具 → M13 装配与启动），
`check-structure.js` 确保结构不腐化、内容与原版逐条等价：

```bash
node test/check-structure.js --snapshot   # 从当前文件生成 golden.json 基线（仅在基线变更时用）
node test/check-structure.js              # 校验（无参数）
```

校验项：

- 脚本语法（`new Function` 编译）
- 模块 banner 顺序 = M01 → … → M13，且各出现一次
- DOM id 集合与 golden 一致（112 个）
- 常量区 / 尾部区（注释与空白归一化后）逐字一致
- **App 条目逐条等价** —— 每个方法/状态字段的"名称 + 类型 + 归一化函数体"与 golden 逐一比对
  （374 条 = 268 方法 + 106 状态字段）
- `Weave.*` 命名空间成员逐条等价（44 个）

golden.json 的 `movedOut` / `renames` 记录 Phase 2 从 App 提取到 `Weave.Util/Color/Geom`
的纯函数及其调用点重命名，比对时对 golden 侧应用同样的重命名。

### 模块划分速查

| 模块 | 内容 | 依赖 |
| --- | --- | --- |
| M01 常量与工具 | 全局常量 + Weave.Util/Color/Geom | 无 |
| M02 状态与持久化 | App 声明、状态、基础设施、历史/序列化/自动保存/导入恢复 | M01 |
| M03 颜色系统 | 预设/自定义色、色轮、生成色下拉、自定义选择器 | M01, M02 |
| M04 视图与相机 | 平移/缩放/居中/网格绘制/坐标 HUD | M01, M02 |
| M05 渲染·节点 | 节点 DOM 创建/更新、renderCanvas 编排、z 序、溢出刷新 | M02, M04 |
| M06 渲染·连线 | 贝塞尔几何、箭头、SVG 渲染、空间索引、增量平移、分区渲染 | M01, M02 |
| M07 动画 | 网格吸附动画（240Hz 数据流 + rAF 渲染流） | M02, M05 |
| M08 输入手势 | 节点拖/线拖/框选/平移/滚轮/键位映射、分区手势、JSON 文件拖拽导入、触控手势 | M02, M04 |
| M09 节点编辑 | CRUD、剪贴板、内联编辑、详情弹窗、上下文菜单动作、收起/展开节点串、分区编辑 | M02, M03, M05, M08, M10 |
| M10 连线编辑 | 创建/删除、曲线手柄、标签编辑、选择维护 | M02, M06 |
| M11 界面外壳 | 右键菜单、关于/设置弹窗、键位录制、专注模式、状态徽标、Σ 彩蛋 | M02, M08, M09, M10 |
| M12 导入导出 | JSON 导入导出、PNG 导出（DOM 快照 + legacy 双通道） | M02, M05 |
| M13 装配与启动 | 全局事件监听、快捷键、Init 初始化 | 全部 |

### 重构工具（一次性，已忽略）

`test/refactor/` 下的重构工具（`partition.js` 模块化重构生成器、注释翻译脚本及中间产物）
已从版本库移除（见 `.gitignore`），仅保留在本地历史中，README 不再维护其用法说明。
其中 `test/refactor/weave-parse.js` 是 `check-structure.js` 的运行时依赖（脚本解析器），保留入库。

## 说明

- `test/` 下的测试脚本从 `WEAVE_EDGE` 环境变量读取浏览器路径，缺省回退作者机 Edge 路径；换机器或浏览器时设该变量即可
- 双击必须用 CDP `clickCount` 递增（1→2）序列：headless Chromium 对两次
  `clickCount:1` 的普通 click 不派发 `dblclick`（`page.mouse.click` 正是这种）
- 截图当前仅作人工查看/归档用途（自动化脚本用 DOM 断言/像素比较，不人工读图）
- 差分测试中 toast 容器会在截图前对称隐藏：toast 由 3s 定时器驱动，两页步骤时序
  微差会导致其淡出相位不同（属测试台架噪声，非应用差异）
