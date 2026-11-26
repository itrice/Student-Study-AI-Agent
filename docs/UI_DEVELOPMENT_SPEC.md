# UI 开发规范（字体 · 字号 · 颜色 · 尺寸）

> 版本：1.1
> 日期：2026-11-26
> 状态：现行基线（§7 backlog B1–B7 已于 2026-11-26 全部落地，见 §9 变更记录）。
> 权威范围：`public/styles.css`、`public/index.html`、`public/app.js`、`public/api-docs.*`
> 非权威范围：电子墨水屏看板（800×480、1bpp，见 [eink/电子墨水屏看板设计.md](eink/电子墨水屏看板设计.md)）
> 读者：dev、qa、产品验收
> 上游依据：本文件是 [UI_ACCEPTANCE_CHECKLIST.md](UI_ACCEPTANCE_CHECKLIST.md) 的取值来源；两者冲突以本文件 + 代码为准。

本规范的所有"现状"均来自实测，标注 `文件:行号`。改动代码前请先读 §5 棘轮规则：**只许减少违规，不许新增。**

> 行号基准：本文行号为 1.1（2026-11-26 B1–B7 落地后）实测快照；后续改动前仍以选择器 / token 名 / 路由名为准。

---

## 1. 适用范围与权威边界

| 层 | 文件 | 规范处理 |
|---|---|---|
| 主应用样式 | `public/styles.css`（6047 行） | 全量适用 §2–§6 |
| 主应用结构 | `public/index.html`（1470 行） | 实测 0 处内联 `style=`，禁止新增 |
| 主应用逻辑 | `public/app.js`（6741 行） | 实测 18 处几何赋值（`style.width`×8、`style.height`×4、`style.top`×3、`style.left`×3），属裁剪/题框定位，允许；无字号/颜色内联赋值；绘制层色值已常量化（B7） |
| API 文档页 | `public/api-docs.css`（728 行）、`api-docs.html`、`api-docs.js` | **永久豁免主 token 体系**（B5 结论）：保留独立开发者文档视觉语言，但必须遵守 §6 棘轮并单独建基线（31 非 token 字号 / 33 色），不并入主体系、不移出测试 |
| 墨水屏 | `src/eink/` | 不适用；1bpp 无颜色自由度 |

---

## 2. 字号

### 2.1 现行 token（唯一正文字号来源）

`public/styles.css:20-22`（正文三档）与 `:26-36`（B1 新增标题/数据档）：

| Token | 值 | 用途 | 实测用量 |
|---|---|---|---|
| `--text-meta` | `16px` | 元信息、时间、标签、辅助说明、输入框 | 61 处 |
| `--text-label` | `16px` | 按钮、输入、下拉、导航 | 100 处 |
| `--text-body` | `17px` | 正文、题干、解析 | 42 处 |

B1 落地的标题/数据强调 token（`styles.css:26-36`，取值全部落在 R2 允许集合 `{18,20,22,24,26,30}` 或其 clamp 下限）：

| Token | 值 | 用途 | 实测用量 |
|---|---|---|---|
| `--text-display` | `clamp(34px, 3.6vw, 52px)` | 首屏大标题（`.hero h1` 及其 560px 覆盖） | 2 处 |
| `--text-h1` | `clamp(30px, 3vw, 42px)` | 页面主标题（`.page-heading h1`） | 1 处 |
| `--text-h2` | `24px` | 弹窗/区块二级标题 | 3 处 |
| `--text-h2-fluid` | `clamp(24px, 2.4vw, 30px)` | 设置子页标题 | 1 处 |
| `--text-h3` | `22px` | 空态/拍照引导/任务头三级标题 | 3 处 |
| `--text-h3-fluid` | `clamp(20px, 3vw, 26px)` | 裁剪编辑器标题 | 1 处 |
| `--text-h4` | `18px` | 卡片/条目四级标题与强调 | 6 处 |
| `--text-stat-xl` | `30px` | 首页级数据（`.knowledge-hero-stat strong`） | 1 处 |
| `--text-stat` | `26px` | 统计卡数值（`.stat-card strong`） | 1 处 |
| `--text-stat-md` | `24px` | 反馈指标（`.feedback-metric strong`） | 1 处 |
| `--text-stat-sm` | `20px` | 教材指标（`.curriculum-metric strong`） | 1 处 |

> `test/helpers/ui-css.js` 的 `resolvePixels()` 对 `clamp()` 取**最小值**，因此上述 fluid/display token 同样受 §2.1 的 16px 硬门禁与 §6.2 第 5 条约束。

全局基线：`body { font-size: var(--text-body); line-height: 1.6 }`（`styles.css:46-47`）；`button/input/textarea/select { font: inherit }`（`styles.css:53-58`）。

**硬门禁（已在 CI）**：`test/ui-readability.test.js:54` 断言全站阅读文本 ≥ 16px；`:94` 断言按钮与输入框 ≥ 16px。本规范不得弱化该下限。

### 2.2 标题层级（B1 已 token 化）

实测 233 处 `font-size` 声明中仅 **9 处不走 token**（`styles.css`，B1 前为 33 处），另有 `api-docs.css` 31 处全部裸值（独立体系，见 §1/§6.1）。B1 已把 24 处标题/数据/输入框字号改为 `var(--text-*)`（含移动端覆盖与三处 `16px` 输入框）；剩余 9 处的语义分布（行号为 1.1 实测快照）：

| 类别 | 处数 | 位置 | 取值 | 保留原因 |
|---|---|---|---|---|
| 题干与正文特例 | 3 | `:1211 .question-block p`、`:5081 body.review-focus-mode #view-review #review-question`、`:2006 .mistake-index` | `clamp(19,2vw,24)`、19、17 | 承载正文语义而非标题层级，改动会影响题干排版 |
| 数据/标签特例 | 1 | `:2243 .knowledge-score` | 19 | 单点取值，未形成成组语义 |
| 图标/装饰 | 4 | `:1807 .mistake-search-clear`、`:2478 .entry-choice-arrow`、`:5298 .day-detail-close`、`:3647 .knowledge-library-summary::after` | 22、28、22、17 | 纯装饰字形（箭头/关闭符号/伪元素），不承载需理解的信息 |
| 移动端覆盖 | 1 | `:2910 .stat-card strong`（`@media (max-width: 560px)` 内） | 21 | 与桌面档 `--text-stat` 构成缩放对，待后续单独收敛 |

- 这 9 处即 §6.2 第 1 条的非 token 字号上限，**只能减少，不许新增**。

### 2.3 字号规则

- **R1** 新增阅读文本一律用 `var(--text-body)`/`var(--text-meta)`/`var(--text-label)`，禁止裸 `px`。
- **R2** 新增标题/数据强调必须直接复用 §2.1 的 `--text-display/--text-h1/--text-h2/--text-h2-fluid/--text-h3/--text-h3-fluid/--text-h4/--text-stat-xl/--text-stat/--text-stat-md/--text-stat-sm`；取值集合仍为 `{18, 20, 22, 24, 26, 30}`（clamp 场景取下限），并在 PR 描述里登记；**不得新造字号**。
- **R3** 任何阅读文本字号 < 16px 不予合入（CI 会红）。`12px` 仅限纯装饰图形或角标，且不承载需要理解的信息（沿用 `UI_ACCEPTANCE_CHECKLIST.md:11-14`）。
- **R4** 行高统一 `1.6`（`styles.css:47`）；标题如需收紧只允许 `1.1–1.3` 区间，禁止逐组件自定义。

---

## 3. 字体

| 角色 | 声明 | 位置 |
|---|---|---|
| 全局无衬线 | `"Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif` | `styles.css:23-24`（`:root`） |
| 中文标题/引文衬线 | `"STZhongsong", "Songti SC", Georgia, serif` | `styles.css:410`（选择器 `.hero h1, .page-heading h1` 在 `:407-408`）、`:1196`、`:1716` |
| 拉丁/数字衬线 | `Georgia, serif` / `Georgia, "Times New Roman", serif` | `styles.css:228`、`:274`、`:492`、`:754`、`:918`、`:1608` |
| 继承 | `font-family: inherit` | 表单控件经 `font: inherit` 统一 |

- **R5** 全站只有两套字族：**无衬线正文** + **衬线强调**。禁止引入第三套（含 `@font-face` 网络字体）。
- **R6** 衬线只用于标题、引文、数字强调；正文与控件必须继承 `:root` 无衬线。
- **R7** 中文衬线栈必须以 `"STZhongsong", "Songti SC", Georgia, serif` 结尾降级，不得只写 `serif`；Windows 无宋体变体时靠 `Georgia` + 系统 `serif` 兜底。
- **R8** 不引入 Web Font。本应用部署在局域网单机环境，字体加载失败即视为可读性事故。
- 现状记录：`font-synthesis: none`（`styles.css:27`）——浏览器伪粗体/伪斜体被禁用，因此强调必须靠真实 `<strong>/<em>` 或字号/颜色，不得依赖合成字形。

---

## 4. 颜色

### 4.1 品牌 token（`styles.css:2-17` + B2 新增 `:23-25`，共 19 个色值）

| Token | Hex | 语义 | Token/背景对比度（WCAG 2.1，实测计算） |
|---|---|---|---|
| `--ink` | `#17324d` | 主文字 | `12.16` on `--paper`，`13.13` on `--panel` — AAA |
| `--ink-soft` | `#5e7184` | 次级文字 | `4.66` / `5.03` — AA |
| `--paper` | `#f4f7f4` | 页面底 | — |
| `--panel` | `#ffffff` | 卡片底 | — |
| `--line` | `#e3e9e4` | 描边（非文字） | `1.23` — 仅作分隔线，禁止承载文字 |
| `--green` / `--green-dark` / `--green-pale` | `#1f7a63` / `#155b4a` / `#e9f5ef` | 成功、掌握、主操作 | `5.22` on panel，`4.67` on pale；`#fff` on `--green` = `5.22` — AA |
| `--coral` / `--coral-pale` | `#b04434` / `#fff0eb` | 警示、错题 | `5.08` on pale（B4 前 `3.07`）；`#fff` on `--coral` = `5.64`（B4 前 `3.41`）— **AA，普通文本可用**；小号警示文字仍优先 `--coral-dark` |
| `--blue` / `--blue-pale` | `#2f6389` / `#eaf3f9` | 信息、知识点 | `5.72` on pale、`6.43` on 白（B4 前 `4.22`）— AA |
| `--gold` / `--gold-pale` | `#8a5f1f` / `#fbf4e4` | 提示、待复习 | `5.13` on pale、`5.62` on 白（B4 前 `2.94`，未达 AA）— AA |
| `--purple` / `--purple-pale` | `#755b9c` / `#f2eef8` | 辅导/特殊标签 | `4.92` — AA |

其他既定表面色：侧栏渐变 `#1a3a52 → #142d43 → #102538`（`styles.css:94-96`），`#fff` on `#1a3a52` = `11.86`；阴影 `--shadow: 0 18px 45px rgba(24,50,77,.08)`（`:18`）；圆角 `--radius: 22px`（`:19`）。

### 4.2 越界色（现状，必须收编而非扩散）

实测 `styles.css` 去重后 **209 种颜色字面量** + **87 处 `rgba()`**，`api-docs.css` 另有 **33 种**（色值总数不变：三组字面量收编为 token 定义，引用处改走 `var()`）。B2 已把脱离调色板且成组使用的三组收编进 `:root`：

| Token | Hex | 引用位置（1.1 实测） | 实际语义 |
|---|---|---|---|
| `--focus-accent` | `#e11d48` | `:5529` `.scan-ocr-box.is-focused`、`:5600` `.scan-ocr-box-handle` | 题框选中/焦点强调 |
| `--coral-dark` | `#a44d42` | `:852` `.tag.is-coral`、`:5759` `.scan-candidate-tag.is-wrong`、`:5802` | 警示标签的**深色可读版**（实测 `5.09` on `--coral-pale`；B4 后 `--coral` 本体已达 `5.08`，`--coral-dark` 继续作为小号警示文字首选） |
| `--gold-bright` | `#e8c27d` | `:435` `.hero h1 em`、`:534` 背景、`:572` 4px 进度条 | 深色 hero 上的金色强调（hero 底色见 `styles.css:387-388`，实测对比度 `5.75–8.16`） |

这三个 hex 值只允许作为 `:root:23-25` 的 token 定义存在，新增引用一律写 `var(...)`（§6.2 第 2 条按允许清单守护）。

绘制层散点（B7 已收口）：`app.js:35-36` 定义 `OVERLAY_SHADE_COLOR = "#111827"`、`CROP_CANVAS_COLOR = "#132019"`，`app.js:551` 遮罩与 `app.js:1801` canvas 填充引用常量，`app.js` 中不再散落这两个 hex。

### 4.3 颜色规则

- **R9** 新增样式只能使用 `:root` 已有 token；需要新色值必须先在本文件 §4.1/§4.2 登记并说明语义，再加 token。
- **R10** 文字/背景对比度下限：**普通文本 ≥ 4.5:1**；**≥ 24px 或 ≥ 19px 粗体 ≥ 3:1**；图标与状态图形（非文字）≥ 3:1。经 B4 修正后 §4.1 各品牌色的 pale 组合均 ≥ 4.5:1，已知无违规组合；后续如需退化必须在本表登记并给出豁免范围。
- **R11** 状态语义固定映射：正确/掌握=`--green`，错误/危险=`--coral`（文字用 `--coral-dark`，见 B2），提醒/待办=`--gold`，信息/知识=`--blue`，辅导/特殊=`--purple`。禁止同一语义跨组件用不同色。
- **R12** 禁止用颜色作为唯一信息载体：状态必须同时有文字或图标（对应 `UI_ACCEPTANCE_CHECKLIST.md` 的可读性口径）。
- **R13** `rgba()` 只用于阴影、遮罩、hover 淡化；不得用于承载文本的前景色。
- **R14** 焦点态必须可见：新增可交互组件必须写 `:focus-visible`（现有范例 `styles.css:1145`、`:1903`、`:1968`、`:2393`、`:2486`、`:3055`），且 `outline` 不得设为 `none` 而不给替代样式。

---

## 5. 尺寸与断点

### 5.1 触控目标

实测 `min-height` 47 处 px 取值：`44px`×30（B6 后的事实标准，B6 前 15）、`50px`×2，其余为容器/区块高度（`58`–`380px`）。B6 已把 15 组可点击控件（按钮、输入、下拉、模式标签、文本操作）从 `30/32/34/35/36/38/42` 抬到 44px。

sub-44 仅剩 3 处，均为**非点击装饰**，按 R16 保留：`:3277` `.crop-selection`（24，拖拽选框）、`:4640` `.settings-badge`（24，徽标）、`:5539` `.scan-ocr-box-marker`（30，题框序号标记）。

- **R15** 可点击控件（按钮、输入、下拉、清除、关闭、分页、模式标签）高度下限 **44px**；B6 已落地，可点击控件不得低于 44px，§5.1 所列 3 处非点击装饰为唯一例外。
- **R16** 图标按钮的可点击区域 ≥ 44×44，视觉图标可小于该区域（用 padding 撑开，不许改字号撑大）。

### 5.2 断点

实测 **4 个**宽度断点：`560px`×9、`820px`×3、`980px`×5、`1100px`×1；外加 1 处 `prefers-reduced-motion: reduce`。B3 已淘汰 `389px`（其唯一规则 `.calendar-day { min-width: 0 }` 并入既有 `560px` 块）并把原 `900px` 的三处复合条件（`(max-width:900px), (max-height:860px)`、`(max-width:900px)`、`(max-width:900px), (pointer: coarse)`）统一为 `980px`。

- **R17** 新增响应式只允许使用 `560 / 820 / 980 / 1100` 四个断点；`900`/`389` 已从 `styles.css` 移除，`test/ui-tokens.test.js` 的允许集合同样收敛为这四个值，出现其他宽度断点即 CI 红。
- **R18** 动效必须包 `@media (prefers-reduced-motion: reduce)` 降级。

---

## 6. 冻结基线与棘轮

本轮把现状冻结为基线，由本轮新增的 `test/ui-tokens.test.js`（见 §6.2）在 CI 中守护，**任何指标只许下降，不许上升**。

### 6.1 基线数值（1.1 实测，2026-11-26）

| 指标 | `styles.css` | `api-docs.css` |
|---|---|---|
| `font-size` 声明总数 | 233 | 31 |
| 非 token 字号数（上限） | **9**（1.0 为 33，B1 后） | **31** |
| 去重颜色字面量（上限） | **209** | **33** |
| 脱离 `:root` token 的成组色值 | **0**（B2 已收编为 `--focus-accent`/`--coral-dark`/`--gold-bright`） | 全套自有 `:3-17`（永久豁免，B5） |
| 宽度断点集合 | `{560,820,980,1100}` | 单独统计 |
| 可点击控件 `min-height` | 44px×30（B6，sub-44 仅 3 处非点击装饰） | 不适用 |
| `index.html` 内联 `style=` | 0 | 0 |
| 阅读文本字号下限 | 16px（`ui-readability.test.js` 守护，`clamp()` 按下限计入） | 不受该测试覆盖 |

> 校准说明（1.1，2026-11-26）：上表按 `origin/dev@e84bd13` 之后的 B1–B7 改动复测。B1 使非 token 字号 33 → 9（`--text-meta` 引用 58 → 61）；B2 把 3 组 8 处裸色改为 token 引用，去重颜色数仍 209、`rgba()` 仍 87；B4 换掉 `--gold`/`--coral`/`--blue` 三个 token 本体（旧值 `#b9862f`/`#dc6858`/`#3d78a5` 在全仓 `styles.css` 各只出现 1 次，故换值后 209 不变）；B3 使宽度断点 6 → 4；B6 使 `min-height: 44px` 15 → 30。1.0 表中的 33/6 断点/`{389,…}` 已作废，`test/ui-tokens.test.js` 常量随本表同步下调。

### 6.2 门禁断言清单（新增 `test/ui-tokens.test.js`）

解析器已抽到 `test/helpers/ui-css.js`（源自 `ui-readability.test.js:10-52`），由两个测试共用：

1. `styles.css` 非 token `font-size` 数量 ≤ 9（B1 前为 33），并输出违规行号清单。
2. `styles.css` 去重颜色字面量数量 ≤ 209；出现**基线集合之外**的新色值即失败（允许清单为当前 209 色，逐色写死在测试内）。
3. `@media` 宽度断点集合 ⊆ `{560,820,980,1100}`（B3 前允许 `389`/`900`），出现新断点值即失败。
4. `index.html` 内联 `style=` 数量 = 0。
5. 禁止把既有 token 字号（`--text-*`）调低到 16px 以下（防止用改 token 绕开门禁）。
6. `api-docs.css` 同规则独立基线（31 / 33），测试文件头部注释写明"**永久豁免**主 token 色板：API 文档页保持自身开发者视觉语言，不并入主体系，但独立棘轮长期保留、不移出测试"（B5 结论）。
7. 棘轮只能改小：由 R19 评审执行；测试内基线常量必须与本节表一致。单测无法自动证明 PR 未抬高基线。

- **R19** 上述任一断言失败即不予合入；降低基线的 PR 必须同时更新基线常量与本文件 §6.1 表。

---

## 7. Backlog 执行结果

| ID | 事项 | 状态 | 落地位置 |
|---|---|---|---|
| B1 | 新增标题/数据强调 token 并替换 §2.2 的裸字号 | **已完成（2026-11-26）** | `styles.css:26-36` 新增 11 个 token；24 处 `font-size` 改走 token（非 token 33 → 9） |
| B2 | 收编 §4.2 三组越界色为 `--focus-accent`/`--coral-dark`/`--gold-bright` | **已完成（2026-11-26）** | `styles.css:23-25` 定义，8 处引用改 `var()`；去重色数维持 209 |
| B3 | 断点从 6 个收敛为 4 个（`560/820/980/1100`），淘汰 `389`、合并 `900` 复合条件 | **已完成（2026-11-26）** | 删除 `@media (max-width: 389px)`，规则并入 `:5345` 的 560px 块；3 处 900px → 980px |
| B4 | 修正 §4.1 对比度不达标的品牌色（`--gold`/`--coral`/`--blue`） | **已完成（2026-11-26）** | `#8a5f1f`（5.13）、`#b04434`（5.08 / 白字 5.64）、`#2f6389`（5.72）——pale 组合全部达 AA |
| B5 | `api-docs.css` 并入主 token 体系，或正式声明永久豁免 | **已完成（2026-11-26）：选择永久豁免** | §1/§4.3 措辞 + `test/ui-tokens.test.js` 头注释；**保留独立棘轮（31 / 33），不移出测试、不改 `api-docs.css`** |
| B6 | 触控目标统一 44px，清理 30/34/38/42 存量 | **已完成（2026-11-26）** | 15 组可点击控件 `min-height` → 44px（44px 计数 15 → 30）；3 处非点击装饰按 R16 保留 |
| B7 | `app.js` 绘制层色值接入统一常量 | **已完成（2026-11-26）** | `app.js:35-36` `OVERLAY_SHADE_COLOR`/`CROP_CANVAS_COLOR`，引用处 `:551`、`:1801` |

> 后续（非本轮范围）：§2.2 剩余 9 处中的 `.knowledge-score` 19px 与移动端 `.stat-card strong` 21px 可继续归一到 `--text-stat-*`；`rgba()` 87 处尚未纳入棘轮（R13 仅靠评审）。

---

## 8. 例外与豁免流程

1. 违反 R1–R19 的需求，先在 PR 描述写明：违反哪条、为什么、影响范围、回列到哪个 backlog。
2. 一次性装饰（插画、启动图、品牌区）可豁免 §5.1 触控与 §2.3 R2，但**不得豁免 R3（16px 下限）与 R10（对比度）**。
3. 墨水屏、PDF 导出、邮件模板等非 Web 渲染目标不适用本规范，各自文档单独定义。

---

## 9. 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| 1.0 | 2026-11-26 | 首版：固化 `styles.css`/`api-docs.css` 现状基线，制定 R1–R19 约束新增规则，定义 `test/ui-tokens.test.js` 棘轮断言与 B1–B7 backlog |
| 1.1 | 2026-11-26 | B1–B7 全部落地：§2.1 新增 11 个标题/数据 token（非 token 字号 33 → 9）；§4.2 三组越界色收编为 `--focus-accent`/`--coral-dark`/`--gold-bright`；§5.2 断点收敛为 `{560,820,980,1100}`（6 → 4）；§4.1 `--gold`/`--coral`/`--blue` 换值后 pale 组合达 AA；§5.1 可点击控件 44px（15 → 30 处）；B7 绘制层色值常量化；B5 结论为 `api-docs.css` 永久豁免但保留独立棘轮。§6.1 基线表与 `test/ui-tokens.test.js` 常量同步下调，`resolvePixels()` 增加 `clamp()` 下限解析 |
