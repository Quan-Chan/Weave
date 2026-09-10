# 软件本体形式

本文件描述软件本体的存在形式与代码结构。软件本体指 APPs/Weave.html。

## 存在形式

APPs/Weave.html 是 Weave 唯一的应用程序文件。所有 HTML、CSS、JavaScript 内联在同一文件中，不拆分为多文件结构，不引入本地文件依赖。

APPs/ 目录下另有：

- APPs/Weave.min.html — 由 test/build-min.js 生成的压缩发布版，存档格式与 localStorage 键与完整版一致
- 其他 HTML 文件 — 独立的历史应用，与 Weave 无关

APPs/Weave.html 的浏览器兼容性说明见 ../UnsupportedBrowsers/README.md。

## 技术栈

纯 JavaScript、HTML5、CSS3、Canvas 2D、SVG、localStorage。无框架、无构建步骤。运行时唯一的外部请求是 Google Fonts 的 Inter 字体，加载失败时回退系统字体。

## 界面语言

界面支持中文与 English 两种语言，切换入口位于设置弹窗。文案以键值对形式集中定义于 M01 常量与工具的 I18N 字典。App.t(key, params) 按键取值，以 {占位符} 形式替换 params，缺失时依次回退中文与键名。

例外：节点标签的缺省文案（导入时缺失标签、渲染时空标签均填 `未命名`）与克隆节点的 ` 副本` 后缀为硬编码中文，不随语言切换。

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
| M08 输入手势 | 节点拖/线拖/框选/平移/滚轮/单击双击/键位映射、分区手势、文件拖拽导入 | M02, M04 |
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

## 结构守护

test/check-structure.js 守护模块化拼接形态，校验项为：脚本语法（new Function 编译）、模块 banner 顺序（M01 → M13 各出现一次）、DOM id 集合、常量区与尾部区（归一化后）逐字一致、App 条目与 golden.json 逐条等价、Weave.* 命名空间成员等价。方法体修改后运行 node test/check-structure.js --snapshot 重新生成基线。结构、测试与开发流程的完整说明见 ../test/README.md 与 development-workflow.md。
