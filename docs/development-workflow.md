# 开发流程

项目对软件本体的功能修改按三个阶段执行：实现功能、测试功能、优化代码质量。三个阶段按顺序完成。

## 实现功能

按需求修改代码。

修改过程遵循代码结构规则，规则全文见 ../AGENTS.md 与 application-form.md：

- 新增方法加入所属模块的 Object.assign(App, {...}) 块
- 纯函数放入 Weave.Util、Weave.Color、Weave.Geom（M01 常量与工具）
- 模块清单、数据模型注释随结构变化更新

## 测试功能

目标：确认修改未破坏已有功能。

判定：

- 相关测试全部通过：进入优化代码质量阶段。
- 测试失败：判断失败原因。
  - 失败来自功能修改或功能移除导致的预期行为变化：更新对应断言，使其符合新行为。
  - 功能移除：删除该功能的测试与对应断言。
  - 失败来自意外回归：修正代码，返回实现功能阶段。

结构守护与基线：check-structure.js 将方法与 golden.json 逐条比对。方法体修改会使比对失败，此失败代表基线过期，不代表功能回归。处理方式：运行 node test/check-structure.js --snapshot 重新生成基线，核对重新生成后的差异只包含本次预期的方法修改。

按修改范围运行测试，npm scripts 在 test 目录执行：

| 修改范围 | 命令 |
|---|---|
| 纯函数修改（Weave.*） | cd test && npm run test:fast |
| 版本号修改 | cd test && npm run test:version |
| 任意代码修改后，结构守护 | cd test && npm run test:structure |
| Weave.html 修改，GUI 冒烟 | cd test && npm run test:gui |
| 收起功能 | cd test && npm run test:collapse |
| 分区功能 | cd test && npm run test:region |
| fold 渲染族 | cd test && npm run test:fold |
| 关联高亮 | cd test && npm run test:hl |
| 对齐设置 | cd test && npm run test:snap |
| 吸附动画 | cd test && npm run test:dragsnap |
| 撤销历史 | cd test && npm run test:undo |
| 历史 bug 回归 | cd test && npm run test:repro |
| 提交前完整回归 | cd test && npm test |

npm scripts 与测试文件的对应关系：

- test:structure = check-structure.js
- test:gui = gui-smoke.js
- test:collapse = collapse-test.js + collapse-edge-test.js
- test:region = region-smoke.js
- test:fold = fold-click-badge-test.js + fold-flush-sync-test.js + fold-zoom-twitch-test.js
- test:hl = hl-smoke.js + hl-keybind-test.js + hl-keybind-ui-test.js
- test:snap = snap-reset-test.js
- test:dragsnap = node-drag-snap-test.js
- test:undo = undo-cap-test.js
- test:repro = repro-bugs.js
- test:fast = check-version.js + geom-unit-test.js + check-structure.js
- test:version = check-version.js

单独运行单个测试文件：在仓库根目录执行 node test/文件名.js。测试台架与测试清单见 ../test/README.md。

CI：push 或 PR 触发 quick（结构守护与纯函数单测）与 gui（GUI 回归）两个任务。CI 失败的处理方式与本地测试失败相同。

diff-test.js 在模块化重构前对 git HEAD 原版与工作区逐步比对。功能开发叠加后与 HEAD 的差异属预期，该测试不纳入 npm test 与 CI，仅在重构前手动运行。

新功能的测试：

- 文件命名 {功能}-{层级}-test.js，层级取值为 gui、region、collapse、undo 等测试类别，现有文件清单与命名例外见 ../test/README.md
- 复用 test/helpers/launch.js 的 launchBrowser、openApp、dblClick、installFactories
- 加入 test/package.json 的 scripts.test 与对应域分组脚本

## 优化代码质量

分析对象：本次新增与修改的代码。

优化项：

- 模块归属：方法位于所属模块的 Object.assign 块，纯函数位于 Weave.* 命名空间
- 重复代码：与既有实现合并
- 命名风格：与所属模块一致
- 注释与文档：符合 documentation-and-comments.md
- 结构确认：node test/check-structure.js 通过

优化代码质量阶段的代码修改同样需要测试功能阶段的验证。全部通过后，一次功能修改完成。

## 提交

提交信息描述本次变更的内容与原因，供后续维护者理解代码变化。

规范：

- 首行概括变更：类型 + 对象 + 结果。类型取值 feat、fix、refactor、style、test、chore、docs、revert、ci。
- 首行后空一行，以条目列出具体变更点。
- 描述变更本身，不描述开发过程。
- 不写入对话内容、问题来源（如"用户报告"）、方案取舍理由（如"未采用某方法"）、验证过程声明（如"已验证通过"）。
- 不使用评价词与自证表述。
- revert 提交引用被回退的提交，说明回退后的状态。

## 文档导读

docs/weave_docs_guide.json 是 docs/ 目录的导读存档。在 Weave 中导入该文件，以节点图方式浏览三份文档的结构：根节点收拢全部节点，三个文档节点各自收拢对应文档的内容要点串。