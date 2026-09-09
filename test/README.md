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
| 提交前完整回归 | `npm test` | ~5min |
| 模块化重构前(不常做) | `node diff-test.js`(先提交当前改动) | ~3min |

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

- 浏览器经 `WEAVE_EDGE` 环境变量注入(`/usr/bin/google-chrome`),脚本已全部参数化(不再硬编码作者路径)
- 失败自动归档 `test/shots*/**/*.png` 截图(artifact: test-shots,保留 7 天)
- `diff-test.js` 不入 CI:它对比 git HEAD 原版,仅重构前手动运行

> 本地跑 CI 等效: `WEAVE_EDGE=/path/to/chrome npm test`(Windows 同法指向 Edge/Chrome 可执行文件)

## 统一测试台架 helpers/

`test/helpers/launch.js` 提供浏览器启动/页面就绪/公共交互,新测试应优先复用:

- `launchBrowser(headed)` — 自动 `puppeteer.launch`,失败(沙箱 EPERM)回退手动 spawn+connect
- `openApp(browser)` — 打开应用、等就绪、关首启弹窗,返回 { page, cdp }
- `dblClick(page, cdp, x, y)` — CDP 双击(clickCount 1→2)
- `mkNode(id,label,x,y)` / `installFactories(page)` — 布置工厂(注入页面级 `__testMk/__testChain/__testReset`)
- `sleep` / `shotsDir(name)`

已迁移: fold-flush-sync / collapse-edge / fold-click-badge / fold-zoom-twitch / undo-cap(新)。
旧脚本(gui-smoke/region-smoke/collapse-test/node-drag-snap)仍自带样板,迁移进行中。

## 测试

### 测试清单与职责(文件名速查)

| 文件 | 层级 | 职责 | 何时跑 |
|---|---|---|---|
| check-structure.js | 静态 | 模块化结构守护(M01→M13/条目等价) | 每次改 Weave.html 后 |
| geom-unit-test.js | 单测 | collapse 闭包/多父冲突纯函数 | 每次改 collapse 逻辑 |
| gui-smoke.js | 冒烟 | 核心交互主路径(建节点/连线/设置/i18n) | 每次改 Weave.html 后 |
| region-smoke.js | 专项 | 分区全功能(61 断言) | 改分区相关后 |
| collapse-test.js | 专项 | 收起主流程(需求1-5) | 改 collapse 后 |
| collapse-edge-test.js | 专项 | 收起边界(撤销/删除/序列化) | 改 collapse/undo 后 |
| fold-click-badge-test.js | 回归 | fold 渲染族1: 徽标点击/拖拽显隐 | 改 socket/fold 渲染后 |
| fold-flush-sync-test.js | 回归 | fold 渲染族2: 收起可见性同步 | 同上 |
| fold-zoom-twitch-test.js | 回归 | fold 渲染族3: 缩放无抽搐 | 同上 |
| hl-smoke.js | 专项 | 关联高亮(高亮集合/抬升/背景模糊/清除还原) | 改关联高亮后 |
| hl-keybind-test.js | 专项 | 关联高亮键位自定义(改绑后手势切换) | 改键位/关联高亮后 |
| hl-keybind-ui-test.js | 专项 | 设置弹窗中关联高亮键位的录制/显示/重置 | 同上 |
| snap-reset-test.js | 专项 | 对齐设置重置(方法调用 + UI 点击双路径) | 改对齐设置后 |
| node-drag-snap-test.js | 专项 | 节点拖拽吸附动画/监听泄漏 | 改吸附/动画后 |
| undo-cap-test.js | 专项 | 撤销栈 50 步上限 | 改 undo/历史后 |
| repro-bugs.js | 回归 | 三个历史 bug 不再复现 | 改 collapse/导入/手势后 |
| diff-test.js | 差分 | git HEAD 双页对比(**仅重构前适用**) | 模块化重构前手动 |
| build-min.js | 工具 | 生成 Weave.min.html(**非测试**) | 发布时 |

> 命名规范: `{功能}-{层级}-test.js`;fold-* 三探针同属"fold 渲染回归族"。

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

注意：须在 **工作区未提交重构改动** 时运行（原版取自 git HEAD）。测试截图在 `test/shots-diff/`。

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
- DOM id 集合与 golden 一致（84 个）
- 常量区 / 尾部区（注释与空白归一化后）逐字一致
- **App 条目逐条等价** —— 每个方法/状态字段的"名称 + 类型 + 归一化函数体"与 golden 逐一比对
  （267 条 → Phase 2 后为 254 条 App + 13 条 Weave.* 命名空间成员）
- `Weave.*` 命名空间成员逐条等价

golden.json 的 `movedOut` / `renames` 记录 Phase 2 从 App 提取到 `Weave.Util/Color/Geom`
的纯函数及其调用点重命名，比对时对 golden 侧应用同样的重命名。

### 模块划分速查

| 模块 | 内容 | 依赖 |
| --- | --- | --- |
| M01 常量与工具 | 全局常量 + Weave.Util/Color/Geom | 无 |
| M02 状态与持久化 | App 声明、状态、基础设施、历史/序列化/自动保存 | M01 |
| M03 颜色系统 | 预设/自定义色、色轮、生成色 | M01, M02 |
| M04 视图与相机 | 平移/缩放/居中/网格/坐标状态指示 | M01, M02 |
| M05 渲染·节点 | 节点 DOM、renderCanvas 编排 | M02, M04 |
| M06 渲染·连线 | 贝塞尔几何、箭头、SVG、空间索引 | M01, M02 |
| M07 动画 | 网格吸附动画 | M02, M05 |
| M08 输入手势 | 拖拽/框选/平移/键位映射 | M02, M04 |
| M09 节点编辑 | 增删改查（CRUD）、剪贴板、内联编辑、详情、上下文菜单动作 | M02, M03, M05, M08, M10 |
| M10 连线编辑 | 创建/删除、曲线手柄、标签、选择 | M02, M06 |
| M11 界面外壳 | 右键菜单、弹窗、设置、键位录制、专注模式 | M02, M08, M09, M10 |
| M12 导入导出 | JSON/PNG 双通道 | M02, M05 |
| M13 装配与启动 | 全局事件、快捷键、启动初始化 | 全部 |

### 重构工具（一次性，已忽略）

`test/refactor/`（`partition.js` 模块化重构生成器、注释翻译脚本及中间产物）已从版本库
移除（见 `.gitignore`），仅保留在本地历史中。README 不再维护其用法说明。

## 说明

- Edge 路径硬编码在脚本顶部 `EDGE`，换机器/浏览器时改这一行
- 双击必须用 CDP `clickCount` 递增（1→2）序列：headless Chromium 对两次
  `clickCount:1` 的普通 click 不派发 `dblclick`（`page.mouse.click` 正是这种）
- 截图当前仅作人工查看/归档用途（自动化脚本用 DOM 断言/像素比较，不人工读图）
- 差分测试中 toast 容器会在截图前对称隐藏：toast 由 3s 定时器驱动，两页步骤时序
  微差会导致其淡出相位不同（属测试台架噪声，非应用差异）