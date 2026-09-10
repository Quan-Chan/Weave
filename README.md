<h1 align="center">Weave</h1>

<p align="center"><a href="README.en.md">English</a> · 中文</p>

<p align="center">纯网页的节点式图编辑器 —— 自由摆放节点，拖拽 socket 连线，构建思维导图、流程图与逻辑树。</p>

<hr>

<h2>立刻开始</h2>

<p align="center">
  <img src="gif/usage.gif" alt="Weave 使用演示" width="720">
</p>

1. **在线使用** — 打开 [quan-chan.github.io/Weave](https://quan-chan.github.io/Weave/) 直接使用，无需下载
2. **下载** — 下载 `APPs/Weave.html`（完整版）或 `APPs/Weave.min.html`（压缩版，功能一致），不需要安装
3. **打开** — 用任意现代浏览器（Chrome / Edge / Firefox / Safari）打开文件
4. **使用** — 双击画布生成节点，拖拽 socket 连接节点，双击文字即改即得

<hr>

<h2>功能</h2>

- **节点** — 添加、删除、选中（单击 / 框选 / 多选）、拖拽移动、内联编辑、复制粘贴、右键调整节点大小
- **连线** — socket 拖拽创建、删除、标签编辑、贝塞尔曲线自定义调整
- **画框分区** — Region 键 / Alt+左键拖拽创建；整体移动（联动框内节点）；右键编辑名称颜色、删除；节点拖入自动归属
- **节点串收起** — 点击节点右侧输出连接点的 − 徽标收起其后相连的节点串，+ 徽标展开；支持嵌套
- **关联高亮** — 按住 Alt 单击节点，高亮直接关联的节点与连线，其余内容加轻微模糊
- **画布** — 平移（拖拽 / 中键）、滚轮缩放、适应视图、坐标 HUD 编辑
- **颜色** — 5 种预设色 + 自定义色轮选择器，Ctrl+滚轮快速切换
- **导入/导出** — JSON 导入导出（含视口信息）、PNG 导出、拖拽 JSON 文件导入
- **其他** — 撤销/重做（最多 50 步）、只读模式、专注模式（Ctrl+H）、键位设置（首次启动自动弹出，快捷键可自定义）、对齐设置（节点位置与大小、分区位置与大小对齐网格，可一键重置）、语言切换（设置内：中文 / English）、自动保存到 localStorage

<hr>

<h2>技术栈展示</h2>

Weave 用纯前端技术构建，零框架、零依赖、零构建步骤，一个 HTML 文件就是完整产品：

- **纯 JavaScript** — 全部逻辑内联在单文件中，无框架、无构建，源码即产品
- **HTML5 + CSS3** — 原生标签结构 + CSS 变量主题，界面风格统一易维护
- **Canvas 2D** — 绘制网格背景与连线，缩放平移时流畅重绘
- **SVG** — 叠加层承载贝塞尔曲线控制手柄与连线标签，可精确交互
- **localStorage** — 画布数据自动持久化，刷新或重开不丢失

<hr>

<h2>性能测试数据</h2>

仓库附带压测与演示存档（位于 `test/samples/`），在 Weave 中通过「导入」加载（JSON 导入按钮，或直接把文件拖进画布）：

- **`test/samples/weave_250_nodes.json`** — 250 个节点、465 条连线的常规图
- **`test/samples/weave_arrow_demo.json`** — 6 个节点、4 条连线的箭头形状演示

250 个节点、62250 条连线的全连接图体积较大，不入库。双击 `test/samples/gen-fullmesh.cmd`（或在 `test/samples/` 执行 `node gen-fullmesh.js`）生成 `weave_250_fullmesh.json`，再用「导入」加载。

<hr>

<h2>许可证</h2>

本项目采用 <a href="LICENSE">Apache License 2.0</a> 开源。

<pre>Copyright © 2026 Quan-Chan</pre>
