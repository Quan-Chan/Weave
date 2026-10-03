# 软件本体形式

本文件描述软件本体的存在形式与代码结构。软件本体指 APPs/Weave.html。

## 存在形式

APPs/Weave.html 是 Weave 主程序唯一的应用程序文件。所有 HTML、CSS、JavaScript 内联在同一文件中，不拆分为多文件结构，不引入本地文件依赖。

APPs/ 目录下另有：

- APPs/Weave.min.html — 由 test/build-min.js 生成的压缩发布版，存档格式与 localStorage 键与完整版一致
- APPs/Weave-recovery.html — 独立的恢复与设置面板；显示本地数据占用，调整 Weave 设置与键位，清空节点图，并支持节点图 JSON 导入/导出；不加载主程序，不创建节点、连线或分区 DOM。页面顶部声明当前查看的是哪一份数据——浏览器按来源隔离存储，本地文件与在线站点各存一份，页面无法跨来源读写
  - 该文件不生成压缩产物：`test/build-min.js` 只处理主程序。它同样纳入测试与在线部署工作流（部署为站点根目录的 `recovery.html`），差异仅在于没有 min 版
  - 界面语言与主程序共用 `localStorage` 的 `flow_lang` 键，词典为本文件内的独立 `I18N`，由 `test/i18n-recovery.js` 守护；新增语言需同时在本页词典与键位按钮中登记
- 其他 HTML 文件 — 独立的历史应用，与 Weave 无关

APPs/Weave.html 的浏览器兼容性说明见 ../UnsupportedBrowsers/README.md。

## 技术栈

纯 JavaScript、HTML5、CSS3、Canvas 2D、SVG、localStorage。无框架、无构建步骤。运行时唯一的外部请求是 Google Fonts 的 Inter 字体，加载失败时回退系统字体。

## 界面语言

界面支持中文与 English 两种语言，切换入口位于设置弹窗。文案以键值对形式集中定义于 M01 常量与工具的 I18N 字典。App.t(key, params) 按键取值，以 {占位符} 形式替换 params，缺失时依次回退英语、中文与键名。

节点缺省标签、描述占位提示与克隆节点后缀均通过 I18N 词典提供，随界面语言切换。

## 数据模型

状态存放于 App.canvasState：

| 字段 | 内容 |
|---|---|
| nodes | 节点数组 |
| connections | 连线数组 |
| regions | 分区数组 |
| history | 撤销历史快照数组 |

节点字段：id、label、desc、color、x、y、w、h、mirrored、collapse（可选）。mirrored 由创建路径恒写入，"可选"指旧存档兼容；collapse 仅由收起根节点携带。

连线字段：id、from、to、label、cp1（可选）、cp2（可选）、mirrored。

分区字段：id、label、color、x、y、w、h、nodeIds、parentId。

收起记录（collapse）字段：hidden 数组，元素为 { id, dx, dy }。dx、dy 是收起瞬间各隐藏节点相对根节点的偏移，根节点移动后展开仍按根节点加偏移还原相对位置。收起闭包内任一节点被两个及以上节点连接时禁止收起。

存档另含 viewport { panX, panY, scale }，挂在 App 上，不属于 canvasState。

单位：内存与交互中的 x、y、w、h 为世界像素。序列化存档中的 x、y、w、h（节点与分区）与 collapse.dx、collapse.dy 为格单位，1 格 = GRID_PX 像素，加载时乘以 GRID_PX 还原。连线的 cp1、cp2 是世界像素偏移，不参与折算。坐标 HUD 以格为单位显示与编辑；网格吸附在开启对齐设置时为 1 格，关闭时为 1 像素。

## 界面适配

响应式断点按**可用空间**取，不只看宽度：

| 断点 | 场景 | 关键处理 |
|---|---|---|
| `max-width:820px` | 平板/手机竖屏 | 顶栏换行、命中区 44px、弹窗近全屏、设置导航转横排 |
| `max-width:520px` | 手机竖屏 | 侧边栏转顶部横条、顶栏字号与内边距压缩 |
| `max-height:620px` | 任何矮视口（**含手机横屏**） | 关闭 `.modal-box` 的 `scale(1.25)`、设置弹窗改纵向自适应、顶栏压成单行可横向滚动、侧边栏恢复右侧竖排 |
| `max-height:480px` | 手机横屏 | 进一步压缩导航与行高，把高度让给画布 |
| `orientation:landscape and min-height:481px` | 平板/桌面横屏 | 设置弹窗放宽到 720px |

手机横屏的宽度常大于 820（iPhone 16 Pro Max 横屏为 956×440），只按宽度设断点会让整段移动端规则失效——弹窗按桌面尺寸渲染，再被 `scale(1.25)` 放大，在 440 高的屏幕上双向出屏。故必须有 `max-height` 分支。

`.settings-panels` 上的 `min-height:0` 不可省：设置弹窗在窄屏改为纵向排布后 `flex:1` 作用在垂直轴，而 flex 项默认 `min-height:auto` 无法收缩到内容高度以下，面板会被内容撑破容器。

viewport 声明 `viewport-fit=cover`，配合 `env(safe-area-inset-*)` 让顶栏与侧边栏避开刘海与圆角；不设 `user-scalable=no`，保留用户缩放能力。

安全区避让是无条件规则，放在 CSS 1 末尾、全部断点之前。`.header` 用 `padding-inline`、`.sidebar` 用 `padding-inline` 与 `padding-block` 写出：断点用 `padding` 简写覆盖内边距，两者同特异性，源序在后的一方获胜，无条件规则排在断点之后会让断点声明的内边距失效。

四个弹窗遮罩的 `z-index` 一律显式写出（`#modal` 300、`#cpModal` 400、`#settingsModal` 350、`#regionModal` 360）。缺省为 `auto` 时遮罩会排在顶栏（`z-index:100`）之下，顶栏覆盖的一条区域内点遮罩不关闭、也点不到弹窗顶部内容。

守护见 test/mobile-layout-test.js。

## 渲染结构

画布元素自 #canvasStage 起嵌套，缩放层位于平移层内部，scale 叠加在 translate 之上：

```
#canvasStage (.canvas)
├─ canvas#gridCvs          网格线，绘制于屏幕像素空间
├─ #canvasWorld            transform: translate(panX, panY)
│  ├─ svg#regionsSvg        分区矩形
│  ├─ #regionLabels         分区标签
│  ├─ svg#linesSvg          连线路径与标签（坐标预乘 scale），临时连线同层
│  ├─ #canvasNodes          transform: scale(scale)，节点 DOM
│  │  ├─ #nodeLayerMain     普通节点（关联高亮时整体模糊）
│  │  ├─ svg#linesSvgHl     高亮抬升层连线
│  │  └─ #nodeLayerHl       高亮节点
│  └─ svg#curveOverlay      曲线控制手柄
├─ #boxSelectOverlay       框选矩形（屏幕坐标）
├─ #regionPreview          分区创建预览（屏幕坐标）
└─ #coord                  坐标 HUD
```

位于 #canvasWorld 内的覆盖层使用世界坐标乘 scale；#boxSelectOverlay 与 #regionPreview 是 #canvasStage 的直接子元素，使用屏幕坐标。

连线 SVG 路径坐标预乘 scale；节点容器以 CSS scale 变换，缩放变化超过 3% 时重新插入节点容器以重栅格化文字。

## 模块划分

<script> 内为 13 个模块的拼接，按顺序排列，以块注释 `/* ══ Mxx · 名称 ──` 开头、其后两行为 `职责:` 与 `依赖:` 为界。模块顺序由 check-structure.js 校验：

| 模块 | 职责 | 依赖 |
|---|---|---|
| M01 常量与工具 | 全局常量 + Weave.Util/Color/Geom 纯函数命名空间 | 无 |
| M02 状态与持久化 | App 声明、状态字段、基础设施工具、历史/序列化/自动保存/导入恢复 | M01 |
| M03 颜色系统 | 预设/自定义色、色轮、生成色下拉、自定义选择器 | M01, M02 |
| M04 视图与相机 | 平移/缩放/居中/网格绘制/坐标 HUD | M01, M02 |
| M05 渲染·节点 | 节点 DOM 创建/更新、renderCanvas 编排、z 序、溢出刷新、关联高亮模糊 | M02, M04 |
| M06 渲染·连线 | 贝塞尔几何、箭头、SVG 渲染、空间索引、增量平移、分区渲染 | M01, M02 |
| M07 动画 | 网格吸附动画（240Hz 数据流 + rAF 渲染流） | M02, M05 |
| M08 输入手势 | 节点拖/线拖/框选/平移/滚轮/单击双击/键位映射、分区手势、文件拖拽导入、指针手势（触控/触控笔） | M02, M04 |
| M09 节点编辑 | CRUD、剪贴板、内联编辑、描述浮层、详情弹窗、上下文菜单动作、收起/展开节点串、分区编辑 | M02, M03, M05, M08, M10 |
| M10 连线编辑 | 创建/删除、曲线手柄、标签编辑、选择维护 | M02, M06 |
| M11 UI 外壳 | 右键菜单、关于/设置弹窗、键位录制、专注模式、状态徽标、Σ 彩蛋 | M02, M08, M09, M10 |
| M12 导入导出 | JSON 导入导出、PNG 导出（DOM 快照 + legacy 双通道） | M02, M05 |
| M13 装配与启动 | 全局事件监听、快捷键、Init 初始化 | 全部 |

## 代码规则

- App 方法使用简写 method(){} 形式，定义在所属模块的 Object.assign(App, {...}) 块中
- 不使用箭头函数定义 App 方法
- 纯函数放入 Weave.Util、Weave.Color、Weave.Geom 命名空间
- App 内部状态与方法以下划线前缀命名
- 箭头方向实时取自两端节点的 node.mirrored。conn.mirrored 是持久化的派生记录，值为输出端节点的镜像状态，渲染不读取

## 输入手势

鼠标手势与触控手势并存，互不干扰：画布在触控指针按下起即 preventDefault，浏览器不再合成鼠标事件，因此不存在双重触发。

触控手势层实现于 Pointer Events（`pointerdown/pointermove/pointerup/pointercancel`），`pointerType === 'mouse'` 一律放行给既有鼠标处理器，只有 touch/pen 进入指针层。MDN 规定混合鼠标/触控输入应使用 Pointer Events。

触控不另写一套拖拽实现。既有手势代码只读事件上的 clientX/clientY 与修饰键，对事件类型无假设，故有两个转换点：

- `_bindDragListeners` 同时绑定 mousemove/mouseup 与 pointermove/pointerup/pointercancel（指针事件归一为同构的 `{clientX, clientY}`，且过滤 `pointerType === 'mouse'`，否则真实鼠标的同一次物理移动会被应用两遍）——节点拖拽、连接点建线、调整手柄、分区移动因此在触控下原样工作
- `App._touchFire` 补发同构的合成鼠标事件——手势起手补发 mousedown，点击补发 mousedown → mouseup → click，双击追加 dblclick，长按补发 contextmenu

单指一次按压的三态分界共用同一次 pointerdown：位移超过 `TOUCH_DRAG_SLOP` → 真实拖拽；按住 `TOUCH_LONGPRESS_MS` 不动 → 长按弹菜单；抬手且前两者皆未发生 → 点击，窗口内的第二次为双击。双指为捏合缩放并平移。按下即 `setPointerCapture`，拖拽在手指滑出画布后不中断。

触控补齐的操作（触屏无修饰键、无右键、无滚轮、无物理键盘）：

| 桌面操作 | 触控入口 |
|---|---|
| 右键菜单 | 长按节点 / 连线 / 分区；长按空白弹画布菜单（粘贴、全选、框选模式、适应视图） |
| Ctrl + 单击（多选） | 侧边栏「多选模式」开关，开启后点按节点累加/移出选中 |
| Alt + 单击（关联高亮） | 节点菜单「高亮关联节点」 |
| Shift + 拖拽（框选） | 侧边栏「框选」模式开关，开启后单指拖拽空白 |
| 滚轮（缩放） | 双指捏合 |
| Ctrl + 滚轮（换色） | 顶栏「颜色」按钮 |

仅空白画布一路（平移、框选、分区预览，驱动位于 M13 尾部的 document mousemove）需由 `_ptrMove` 补发 mousemove；其余手势各自已接管 pointermove，补发会造成重复位移。

长按菜单有两处配套处理：菜单下移避开指尖；`_ctxGuardUntil` 窗口内"没有前置 pointerdown"的 click 视为浏览器补发并拦下——用户点菜单项必然先有 pointerdown，不受影响。

## 结构守护

test/check-structure.js 守护模块化拼接形态，校验项为：脚本语法（new Function 编译）、模块 banner 顺序（M01 → M13 各出现一次）、DOM id 集合、常量区与尾部区（归一化后）逐字一致、App 条目与 golden.json 逐条等价、Weave.* 命名空间成员等价。方法体修改后运行 node test/check-structure.js --snapshot 重新生成基线。结构、测试与开发流程的完整说明见 ../test/README.md 与 development-workflow.md。
