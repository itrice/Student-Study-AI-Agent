# UI 开发规范（字体 · 字号 · 颜色 · 尺寸）

> 版本：1.0
> 日期：2026-11-26
> 状态：现行基线（固化现状 + 约束新增）。本轮**不改动任何代码**；存量违规进入 §7 backlog。
> 权威范围：`public/styles.css`、`public/index.html`、`public/app.js`、`public/api-docs.*`
> 非权威范围：电子墨水屏看板（800×480、1bpp，见 [eink/电子墨水屏看板设计.md](eink/电子墨水屏看板设计.md)）
> 读者：dev、qa、产品验收
> 上游依据：本文件是 [UI_ACCEPTANCE_CHECKLIST.md](UI_ACCEPTANCE_CHECKLIST.md) 的取值来源；两者冲突以本文件 + 代码为准。

本规范的所有"现状"均来自实测，标注 `文件:行号`。改动代码前请先读 §5 棘轮规则：**只许减少违规，不许新增。**

> 行号基准：本文行号为 2026-11-26 实测快照；PR #63 合入后部分位置下移，改动前以选择器 / token 名 / 路由名为准。

---

## 1. 适用范围与权威边界

| 层 | 文件 | 规范处理 |
|---|---|---|
| 主应用样式 | `public/styles.css`（6037 行） | 全量适用 §2–§6 |
| 主应用结构 | `public/index.html`（1469 行） | 实测 0 处内联 `style=`，禁止新增 |
| 主应用逻辑 | `public/app.js`（6735 行） | 实测 18 处几何赋值（`style.width`×8、`style.height`×4、`style.top`×3、`style.left`×3），属裁剪/题框定位，允许；无字号/颜色内联赋值 |
| API 文档页 | `public/api-docs.css`（728 行）、`api-docs.html`、`api-docs.js` | **豁免主体 token 体系**，但必须遵守 §6 棘轮并单独建基线；并入主体系列为 backlog B5 |
| 墨水屏 | `src/eink/` | 不适用；1bpp 无颜色自由度 |

---

## 2. 字号

### 2.1 现行 token（唯一正文字号来源）

`public/styles.css:20-22`：

| Token | 值 | 用途 | 实测用量 |
|---|---|---|---|
| `--text-meta` | `16px` | 元信息、时间、标签、辅助说明 | 58 处 |
| `--text-label` | `16px` | 按钮、输入、下拉、导航 | 100 处 |
| `--text-body` | `17px` | 正文、题干、解析 | 42 处 |

全局基线：`body { font-size: var(--text-body); line-height: 1.6 }`（`styles.css:46-47`）；`button/input/textarea/select { font: inherit }`（`styles.css:53-58`）。

**硬门禁（已在 CI）**：`test/ui-readability.test.js:54` 断言全站阅读文本 ≥ 16px；`:94` 断言按钮与输入框 ≥ 16px。本规范不得弱化该下限。

### 2.2 标题层级（现状未 token 化）

实测 233 处 `font-size` 声明中 **33 处不走 token**（`styles.css`），另有 `api-docs.css` 31 处全部裸值。33 处的语义分布：

| 类别 | 处数 | 代表位置 | 取值 |
|---|---|---|---|
| 页面/弹窗标题 | 13 | `:416 .hero h1`、`:1018 .page-heading h1`、`:2512 .dialog-header h2`、`:2358 .entry-choice-header h2`、`:4841 .settings-subpage-heading h2`、`:3224 .crop-editor-heading h3` | `clamp(34,3.6vw,52)`、`clamp(30,3vw,42)`、25、24、22、18 |
| 数据强调（`strong`/metric） | 6 | `:2183 .knowledge-hero-stat strong`、`:755 .stat-card strong`、`:3828 .feedback-metric strong`、`:4238 .curriculum-metric strong` | 30、26、24、20 |
| 题干与正文特例 | 5 | `:1197 .question-block p`、`:5066 body.review-focus-mode #review-question`、`:1982 .mistake-index` | `clamp(19,2vw,24)`、19、17 |
| 输入框 16px | 3 | `:5820`、`:5834`、`:5962` | 16（等价 `--text-meta`，可无风险替换） |
| 图标/装饰 | 4 | `:2454 .entry-choice-arrow`、`:1793 .mistake-search-clear`、`:5276 .day-detail-close`、`:3623 ::after` | 28、22、22、17 |
| 移动端覆盖 | 2 | `:2860`、`:2886`（均在 `@media (max-width: 560px)` 内） | 34、21 |

### 2.3 字号规则

- **R1** 新增阅读文本一律用 `var(--text-body)`/`var(--text-meta)`/`var(--text-label)`，禁止裸 `px`。
- **R2** 新增标题按语义复用既有取值集合 `{18, 20, 22, 24, 26, 30}`（clamp 场景取下限），并在 PR 描述里登记；**不得新造字号**。
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

### 4.1 品牌 token（`styles.css:2-17`，共 16 个色值）

| Token | Hex | 语义 | Token/背景对比度（WCAG 2.1，实测计算） |
|---|---|---|---|
| `--ink` | `#17324d` | 主文字 | `12.16` on `--paper`，`13.13` on `--panel` — AAA |
| `--ink-soft` | `#5e7184` | 次级文字 | `4.66` / `5.03` — AA |
| `--paper` | `#f4f7f4` | 页面底 | — |
| `--panel` | `#ffffff` | 卡片底 | — |
| `--line` | `#e3e9e4` | 描边（非文字） | `1.23` — 仅作分隔线，禁止承载文字 |
| `--green` / `--green-dark` / `--green-pale` | `#1f7a63` / `#155b4a` / `#e9f5ef` | 成功、掌握、主操作 | `5.22` on panel，`4.67` on pale；`#fff` on `--green` = `5.22` — AA |
| `--coral` / `--coral-pale` | `#dc6858` / `#fff0eb` | 警示、错题 | `3.07`；`#fff` on `--coral` = `3.41` — **仅可用于 ≥24px 文本或图形** |
| `--blue` / `--blue-pale` | `#3d78a5` / `#eaf3f9` | 信息、知识点 | `4.22` — 边界值，正文需配 `--ink` |
| `--gold` / `--gold-pale` | `#b9862f` / `#fbf4e4` | 提示、待复习 | **`2.94` — 未达 AA 与 AA-large，禁止用于小号正文** |
| `--purple` / `--purple-pale` | `#755b9c` / `#f2eef8` | 辅导/特殊标签 | `4.92` — AA |

其他既定表面色：侧栏渐变 `#1a3a52 → #142d43 → #102538`（`styles.css:94-96`），`#fff` on `#1a3a52` = `11.86`；阴影 `--shadow: 0 18px 45px rgba(24,50,77,.08)`（`:18`）；圆角 `--radius: 22px`（`:19`）。

### 4.2 越界色（现状，必须收编而非扩散）

实测 `styles.css` 去重后 **209 种颜色字面量** + **87 处 `rgba()`**，`api-docs.css` 另有 **33 种**。其中脱离调色板且成组使用的三组：

| 值 | 出现位置 | 实际语义 | 目标 token（B2） |
|---|---|---|---|
| `#e11d48` | `:5520` `.scan-ocr-box.is-focused`、`:5591` `.scan-ocr-box-handle` | 题框选中/焦点强调 | `--focus-accent` |
| `#a44d42` | `:838` `.tag.is-coral`、`:5750` `.scan-candidate-tag.is-wrong`、`:5793` | 警示标签的**深色可读版**（实测 `5.09` on `--coral-pale`，优于 `--coral` 的 `3.07`） | `--coral-dark` |
| `#e8c27d` | `:421` `.hero h1 em`、`:520` 背景、`:558` 4px 进度条 | 深色 hero 上的金色强调（hero 底色见 `styles.css:372-374`，实测对比度 `5.68–8.21`） | `--gold-bright` |

绘制层散点：`app.js:546` 遮罩 `#111827`、`app.js:1796` canvas 填充 `#132019`。

### 4.3 颜色规则

- **R9** 新增样式只能使用 `:root` 已有 token；需要新色值必须先在本文件 §4.1/§4.2 登记并说明语义，再加 token。
- **R10** 文字/背景对比度下限：**普通文本 ≥ 4.5:1**；**≥ 24px 或 ≥ 19px 粗体 ≥ 3:1**；图标与状态图形（非文字）≥ 3:1。不达标组合见 §4.1 表（`--gold`/`--coral`/`--blue` 的 pale 组合）。
- **R11** 状态语义固定映射：正确/掌握=`--green`，错误/危险=`--coral`（文字用 `--coral-dark`，见 B2），提醒/待办=`--gold`，信息/知识=`--blue`，辅导/特殊=`--purple`。禁止同一语义跨组件用不同色。
- **R12** 禁止用颜色作为唯一信息载体：状态必须同时有文字或图标（对应 `UI_ACCEPTANCE_CHECKLIST.md` 的可读性口径）。
- **R13** `rgba()` 只用于阴影、遮罩、hover 淡化；不得用于承载文本的前景色。
- **R14** 焦点态必须可见：新增可交互组件必须写 `:focus-visible`（现有范例 `styles.css:1145`、`:1903`、`:1968`、`:2393`、`:2486`、`:3055`），且 `outline` 不得设为 `none` 而不给替代样式。

---

## 5. 尺寸与断点

### 5.1 触控目标

实测 `min-height` 50 处，取值分布：`44px`×15（事实标准）、`42`×5、`38`×3、`34`×3、`50`×2、`30`×2、`24`×2、`36`×1，另有 `.hero` `350px`（`:367`）等容器高度。

- **R15** 可点击控件（按钮、输入、清除、关闭、分页）高度下限 **44px**；低于 44 的现状（30/34/38/42）属存量，只减不增。
- **R16** 图标按钮的可点击区域 ≥ 44×44，视觉图标可小于该区域（用 padding 撑开，不许改字号撑大）。

### 5.2 断点

实测 6 个宽度断点：`560px`×9、`820px`×3、`980px`×2、`900px`（含 `(max-width:900px), (pointer: coarse)` 与 `(max-width:900px), (max-height:860px)` 两个复合）、`1100px`×1、`389px`×1；外加 1 处 `prefers-reduced-motion: reduce`。

- **R17** 新增响应式只允许使用 `560 / 820 / 980 / 1100` 四个断点；`900`/`389` 为历史特例，保留但不得新增。目标收敛见 B3。
- **R18** 动效必须包 `@media (prefers-reduced-motion: reduce)` 降级。

---

## 6. 冻结基线与棘轮

本轮把现状冻结为基线，由本轮新增的 `test/ui-tokens.test.js`（见 §6.2）在 CI 中守护，**任何指标只许下降，不许上升**。

### 6.1 基线数值（2026-11-26 实测）

| 指标 | `styles.css` | `api-docs.css` |
|---|---|---|
| `font-size` 声明总数 | 233 | 31 |
| 非 token 字号数（上限） | **33** | **31** |
| 去重颜色字面量（上限） | **209** | **33** |
| 脱离 `:root` token 的成组色值 | 3 组 8 处（§4.2） | 全套自有 `:3-17` |
| 宽度断点集合 | `{389,560,820,900,980,1100}` | 单独统计 |
| `index.html` 内联 `style=` | 0 | 0 |
| 阅读文本字号下限 | 16px（已由 `ui-readability.test.js` 守护） | 不受该测试覆盖 |

> 校准说明（2026-11-26）：上表按 `origin/dev@619a088` 复测。PR #63 合入前（fdd4962）为 236 / 33 / 207 / 81；合入后新增 `#d6e5db`、`#f8fcf9`（`styles.css:1823-1824`），并减少 3 处 `font-size`，故总数为 233、颜色 209、rgba 87。207 从未作为已生效门禁运行；本表 209 是棘轮起点。

### 6.2 门禁断言清单（新增 `test/ui-tokens.test.js`）

解析器已抽到 `test/helpers/ui-css.js`（源自 `ui-readability.test.js:10-52`），由两个测试共用：

1. `styles.css` 非 token `font-size` 数量 ≤ 33，并输出违规行号清单。
2. `styles.css` 去重颜色字面量数量 ≤ 209；出现**基线集合之外**的新色值即失败（允许清单为当前 209 色，逐色写死在测试内）。
3. `@media` 宽度断点集合 ⊆ `{389,560,820,900,980,1100}`，出现新断点值即失败。
4. `index.html` 内联 `style=` 数量 = 0。
5. 禁止把既有 token 字号（`--text-*`）调低到 16px 以下（防止用改 token 绕开门禁）。
6. `api-docs.css` 同规则独立基线（31 / 33），并在测试文件头部注释说明"独立体系，豁免主 token 色板"。
7. 棘轮只能改小：由 R19 评审执行；测试内基线常量必须与本节表一致。单测无法自动证明 PR 未抬高基线。

- **R19** 上述任一断言失败即不予合入；降低基线的 PR 必须同时更新基线常量与本文件 §6.1 表。

---

## 7. Backlog（本轮不做，需单独排期）

| ID | 事项 | 依据 |
|---|---|---|
| B1 | 新增标题 token `--text-h1/h2/h3/h4`（建议 `32/24/20/18`）与数据强调 token `--text-stat`，替换 §2.2 的 13 + 6 处 | `styles.css:416,1018,2358,2512,4841,3224` 等 |
| B2 | 收编 §4.2 三组越界色为 `--focus-accent`/`--coral-dark`/`--gold-bright` | `styles.css:5520,5591,838,5750,5793,421,520,558` |
| B3 | 断点从 6 个收敛为 4 个（`560/820/980/1100`），淘汰 `389`、合并 `900` 复合条件 | `styles.css` 断点分布见 §5.2 |
| B4 | 修正 §4.1 中对比度不达标的 pale 文字组合（`--gold` 2.94、`--coral` 3.07、`--blue` 4.22），或明确其只用于大号文本 | 对比度实测 |
| B5 | `api-docs.css` 并入主 token 体系（或正式声明永久豁免并移出棘轮） | `api-docs.css:3-17` |
| B6 | 触控目标统一 44px，清理 30/34/38/42 存量 | `styles.css` `min-height` 分布 |
| B7 | `app.js` 绘制层色值接入统一常量 | `app.js:546,1796` |

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
