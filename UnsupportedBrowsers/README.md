# UnsupportedBrowsers — 不兼容的浏览器

本目录记录已知与 Weave 不兼容的浏览器环境、具体表现以及处理结论。

---

## Issue #1 — M 浏览器 3.2.4.0706

- **Issue 链接**：[Quan-Chan/Weave#1](https://github.com/Quan-Chan/Weave/issues/1)
- **状态**：已关闭（not planned，无法修复，不值得修改）
- **发现日期**：2026-08-07

### 表现

1. 导出图片：节点数 ≥ 4 时，显示下载链接后软件崩溃
2. 导出图片：下载链接始终无效，无法下载任何图片
3. 导出存档：始终失败，显示错误

### 复现环境

| 项目 | 版本 |
| --- | --- |
| 设备 | IQOO Neo8 Pro（天玑 9200、安卓 16、16G 内存） |
| M 浏览器 | 3.2.4.0706 |
| 手机系统 | PD2302C_A_16.3.10.1.W10.V000L1 |
| Weave | 1.0 |

### 原因

M 浏览器 3.2.4.0706 的文件下载机制与标准实现不兼容，导致图片导出与存档下载全部失效。

### 处理结论

该问题通过常规手段无法解决，唯一的非常规替代方案：

> 不触发下载，改为弹窗展示图片 + 提供可复制的 JSON 文本，由用户自行长按保存图片、粘贴创建存档文件。

该方案交互体验差、价值低，判定**不值得实现**，故关闭 Issue 并在此记录备查。

---

## Safari（macOS / iOS / iPadOS，WebKit 内核全系）

- **状态**：部分兼容——PNG 导出自动降级为兼容模式（Canvas 数据重绘），其余功能正常
- **发现日期**：2026-08-13

### 表现

1. PNG 导出不走 DOM 快照管线：运行时探针判定失败，弹出"兼容模式"提示后改走 `_exportPNGLegacy()` 重绘；
2. 导出结果为近似重绘样式（字体回退、文本排版近似），连线与箭头观感已与实时渲染对齐。

### 原因

WebKit 的安全模型规定：**含 `<foreignObject>` 的 SVG 图片会污染画布**（可能经 CSS 泄漏跨源信息，如 :visited 链接样式、拼写检查数据）。因此 `drawImage` 后 `getImageData` / `toDataURL` 一律抛 SecurityError——快照管线无法完成。证据：

- WebKit 源码 `SVGImage::renderingTaintsOrigin()` 至今对 foreignObject 返回 true（带 FIXME）；
- WebKit Bug [156176](https://bugs.webkit.org/show_bug.cgi?id=156176)（解除该污染）自 2016 年建立仍为 NEW 未解决；
- 同管线的 html-to-image 库至今有约 28 个开放的 Safari issue（空白图、decode 挂起、iOS 不显示等）；dom-to-image 则直接声明不支持 Safari。

### 处理结论

不做特殊适配。运行时探针 + 兼容版回退即为最终方案：探针绘制 12×12 含 foreignObject 的测试图并采样像素，SecurityError 被捕获即判 false → 弹提示 → 走兼容版。兼容版的连线/箭头形状已与实时渲染完全同形，保证导出观感一致。iOS / iPadOS 上的第三方浏览器同样使用 WebKit，行为一致。
