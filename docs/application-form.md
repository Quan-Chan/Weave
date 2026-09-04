# 软件本体形式

本文件描述软件本体的存在形式与代码结构。软件本体指 APPs/Weave.html。

## 存在形式

APPs/Weave.html 是唯一的应用程序文件。所有 HTML、CSS、JavaScript 内联在同一文件中。软件不拆分为多文件结构，不引入本地文件依赖。外部资源（如字体）从 CDN 加载。

APPs/Weave.html 的浏览器兼容性说明见 ../UnsupportedBrowsers/README.md。

## 技术栈

纯 JavaScript、HTML5、CSS3、Canvas 2D、SVG、localStorage。无框架、无外部依赖。

## 界面语言

界面支持中文与 English 两种语言，切换入口位于设置弹窗。文案以键值对形式集中定义于 M01 常量与工具的 I18N 字典。App.t(key) 按键取值并替换占位符。

## 数据模型

状态存放于 App.canvasState：

| 字段 | 内容 |
|---|---|
| nodes | 节点数组 |
| connections | 连线数组 |
| regions | 分区数组 |
| history | 撤销历史快照数组 |

节点字段：id、label、desc、color、x、y、w、h、mirrored（可选）、collapse（可选）。

连线字段：id、from、to、label、cp1（可选）、cp2（可选）、mirrored。

分区字段：id、label、color、x、y、w、h、nodeIds、parentId。

收起记录（collapse）字段：hidden 数组，元素为 { id, dx, dy }。

单位：内存与交互中的 x、y、w、h 为世界像素。序列化存档中的 x、y、w、h（节点与分区）与 collapse.dx、collapse.dy 为格单位，1 格 = GRID_PX 像素，加载时乘以 GRID_PX 还原。坐标 HUD 与网格吸附以格为单位显示与操作。

## 渲染结构

画布由四层组成：

| 层 | 元素 | 内容 |
|---|---|---|
| 网格 | canvas#gridCvs | 网格线，绘制于屏幕像素空间 |
| 平移层 | .canvas-world | transform: translate(panX, panY)，含连线 SVG 与分区 SVG |
| 缩放层 | .canvas-nodes | transform: scale(scale)，节点 DOM |
| 浮层 | 各 overlay | 框选、连线临时线、曲线手柄等 |

连线 SVG 路径坐标预乘 scale；节点容器以 CSS scale 变换，缩放变化超过 3% 时重新插入节点容器以重栅格化文字。

## 模块划分

<script> 内为 13 个模块的拼接，按顺序排列，以 /* ══ M01 · 名称 ══ */ 形式锚点注释为界：

| 模块 | 内容 |
|---|---|
| M01 常量与工具 | 全局常量、Weave.Util、Weave.Color、Weave.Geom |
| M02 状态与持久化 | App 声明、状态字段、基础设施、历史、序列化、自动保存 |
| M03 颜色系统 | 预设色、自定义色、色轮、生成色下拉 |
| M04 视图与相机 | 平移、缩放、居中、网格绘制、坐标 HUD |
| M05 渲染·节点 | 节点 DOM 创建与更新、renderCanvas 编排 |
| M06 渲染·连线 | 贝塞尔几何、箭头、SVG 渲染、空间索引、增量平移 |
| M07 动画 | 网格吸附动画 |
| M08 输入手势 | 节点拖拽、连线拖拽、框选、平移、滚轮、键位映射 |
| M09 节点编辑 | 增删改查、剪贴板、内联编辑、描述浮层、详情弹窗、上下文菜单动作 |
| M10 连线编辑 | 创建、删除、曲线手柄、标签编辑、选择维护 |
| M11 UI 外壳 | 右键菜单、设置弹窗、软件详情、键位录制、专注模式、状态徽标 |
| M12 导入导出 | JSON 导入导出、PNG 导出 |
| M13 装配与启动 | 全局事件、快捷键、启动初始化 |

## 代码规则

- App 方法使用简写 method(){} 形式，定义在所属模块的 Object.assign(App, {...}) 块中
- 不使用箭头函数定义 App 方法
- 纯函数放入 Weave.Util、Weave.Color、Weave.Geom 命名空间
- App 内部状态与方法以下划线前缀命名
- 连线方向规则：conn.mirrored 记录输出端节点的镜像状态；输出端箭头跟随源节点镜像，输入端箭头跟随目标节点镜像

## 结构守护

test/check-structure.js 守护模块化拼接形态：校验脚本语法、模块 banner 顺序、DOM id 集合、App 条目与 golden.json 逐条等价、Weave.* 命名空间成员等价。方法体修改后运行 node test/check-structure.js --snapshot 重新生成基线。结构、测试与开发流程的完整说明见 ../test/README.md 与 development-workflow.md。
