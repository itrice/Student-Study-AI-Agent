# 2026-11-26 夜跑交付：文档收敛、测试门禁与代码清理

> 日期：2026-11-26（夜跑批次 nightly-2026-11-26）
> 最终 dev：`11f2fd9e8fcb589045df01dfe3f3b7d826d68858`
> 状态：Phase 1–5 完成，3 次 dev 部署全部成功；本报告经用户授权合并，第 4 次 dev 部署重跑后成功
> 范围：`docs/`、`test/`、`src/` 零引用清理与 `scripts/` 零引用删除；不改 UI 样式、不迁移、不改 e-ink 代码
> 本报告 PR：[#68](https://github.com/itrice/Student-Study-AI-Agent/pull/68)

## 1. 一句话结论与回滚

一句话：本轮把 39 份原文档收敛为 34 份现行 + 5 份归档，另新增 3 份现行文档（最终 37 现行 + 5 归档），补齐 10 条可统计批注；测试从 244 增至 250 条显式用例并新增 6 条 UI 棘轮断言；删除 2 个零引用脚本、2 个零引用符号并收敛 1 个重复常量；最终 dev 全量 252/252 通过，三次 dev 部署（Validate/Build/Deploy）全绿，红线文件零改动。

| 阶段 | 回滚到 | 说明 |
| --- | --- | --- |
| docs（PR #65） | `4171773` | #65 合并前 dev；#66 中的 docs 校准 `65e2776` 不在该点，若只需撤销 #65 请用 `git revert 619a088` |
| qa（PR #66） | `619a088` | #66 合并前 dev；同时撤销测试整理、ui-tokens 与 docs 校准 `65e2776` |
| dev（PR #67） | `2213f79` | #67 合并前 dev；仅撤销代码清理 |

最终状态：`11f2fd9`。三次 dev 推送依次为 `619a088`、`2213f79`、`11f2fd9`。

## 2. 门禁遵守证明

### 2.1 红线文件

在最终 dev 上执行：

```bash
git log --oneline 4171773..11f2fd9 -- docker-compose.yml
# 无输出

git diff --name-only 4171773..11f2fd9 | grep -E '^(docker-compose\.yml|public/styles\.css|public/api-docs\.css|src/migrations\.js)$'
# 无输出
```

结论：

- `docker-compose.yml` 本轮零提交；工作区原有的 1 行未提交删除保持原样，未纳入任何 commit。
- `public/styles.css`、`public/api-docs.css` 本轮零改动；UI 16/16/17px 基线（`styles.css:20-22`）未触碰。
- `src/migrations.js` 与 `SCHEMA_MIGRATIONS` 零改动（40 表/16 迁移不变）。
- `src/database.js` 未拆分（最终仍为 7426 行量级）；`public/app.js` 仅新增 1 行注释锚点，未拆分。
- `docs/reports/` 未删除、未移动；仅 `reports/ui-readability-2026-11-10.md:7-9` 增加“历史快照”标注，另有本报告新增。
- 未执行任何手工部署命令，未通知 deployer；3 次部署均由 push dev 触发。
- PR #64（base=main，head=dev）本轮未合并、未关闭、未评论。其在 2026-11-26T06:08:22Z 已被合入 main（merge `9ff569d`），发生在本轮开始前；详见 §8.5。

### 2.2 commit 粒度与暂存区

本轮 10 个业务 commit，按“文档 / 测试 / 代码”三类动作拆分；每次 `git add` 显式列路径，提交前断言暂存区不含 `docker-compose.yml`。

| 阶段 | commit | 内容 |
| --- | --- | --- |
| docs | `197aaba` | 固化 2026-11-26 拍照选题流程文档 |
| docs | `75e4653` | 归档 5 份被取代文档 |
| docs | `aca2f21` | 新增 docs/README.md 索引页 |
| docs | `439ca76` | 口径对齐与批注 |
| tests | `dc4807c` | 合并 CSS/HTTP 测试夹具 |
| tests | `d8af48b` | 新增 UI token 棘轮断言 |
| docs 校准 | `65e2776` | 校准 UI 基线与文档事实 |
| dev | `3d6d3b0` | 删除零引用死代码 |
| dev | `a41056c` | 收敛 `MAX_SCAN_CANDIDATES` |
| dev | `e9b87ff` | 删除零引用 QA 脚本 |

## 3. 文档处置总表

统计口径：夜跑前 `docs/**/*.md` 共 39 份；本轮新增 3 份（`docs/README.md`、`docs/UI_DEVELOPMENT_SPEC.md`、`题库/07-拍照选题最终流程.md`），归档 5 份，最终现行 37 份 + 归档 5 份 = 42 份 Markdown；另有本报告与 `docs/_notes/qa-findings.md` 两份交付记录，合并后 `docs/` 共 44 份 Markdown。

处置含义：保留 = 正文不改或仅加批注；更新 = 正文口径/结构有改动；归档 = `git mv` 到 `_archive/nightly-2026-11-26/`；新建 = 本轮新增。

### 3.1 原 39 份

| # | 文件 | 处置 | 权威 | 证据（行） | commit |
| --- | --- | --- | --- | --- | --- |
| 1 | `docs/DEPLOYER_AGENT.md` | 归档 | L4 | 归档头:1-7 | `75e4653` |
| 2 | `docs/DEPLOYMENT_RUNBOOK.md` | 保留 | L1 | — | — |
| 3 | `docs/IMPLEMENTATION_PLAN.md` | 保留（仅批注） | L2 | :3 | `439ca76` |
| 4 | `docs/IMPLEMENTATION_STATUS.md` | 保留（仅批注） | L1 | :9 | `439ca76` |
| 5 | `docs/KNOWLEDGE_BASE.md` | 保留（仅批注） | L1 | :3 | `439ca76` |
| 6 | `docs/KNOWLEDGE_REVIEW_CHECKLIST.md` | 保留 | L2 | — | — |
| 7 | `docs/LLM_SETUP.md` | 保留 | L1 | — | — |
| 8 | `docs/M7_SECURITY_CHECKLIST.md` | 保留 | L2 | — | — |
| 9 | `docs/M9_IMAGE_INTAKE.md` | 更新 | L1 | :5-12 | `197aaba` |
| 10 | `docs/MVP.md` | 保留（仅批注） | L3 | :3 | `439ca76` |
| 11 | `docs/PROD_UPDATE_ROUTE_DIAGNOSIS.md` | 归档 | L4 | 归档头:1-7 | `75e4653` |
| 12 | `docs/TOOL_CONTRACTS.md` | 更新 | L1 | :4,:7 | `439ca76` |
| 13 | `docs/UI_ACCEPTANCE_CHECKLIST.md` | 更新 | L2 | :9,:49,:63 | `439ca76`,`65e2776` |
| 14 | `docs/beishida-2024-teacher-review-checklist.md` | 保留 | L2 | — | — |
| 15 | `docs/eink/eink-frame-api.md` | 更新 | L1 | :8,:91,:110,:135 | `65e2776` |
| 16 | `docs/eink/服务端改造需求.md` | 归档 | L4 | 归档头:1-7 | `75e4653` |
| 17 | `docs/eink/服务端渲染-产品补充说明.md` | 更新 | L1 | :165 | `75e4653`,`439ca76`,`65e2776` |
| 18 | `docs/eink/电子墨水屏看板设计.md` | 更新 | L1 | :221 | `75e4653`,`65e2776` |
| 19 | `docs/eink/软件安装清单.md` | 归档 | L4 | 归档头:1-7 | `75e4653` |
| 20 | `docs/reports/eink-api-2026-11-17.md` | 保留 | L3 | — | — |
| 21 | `docs/reports/llm-self-test-2026-11-09T09-58-08-707Z.md` | 保留 | L3 | — | — |
| 22 | `docs/reports/m4-ui-validation-2026-11-09.md` | 保留 | L3 | — | — |
| 23 | `docs/reports/m5-acceptance-2026-11-10.md` | 保留 | L3 | — | — |
| 24 | `docs/reports/m5-knowledge-evaluation-2026-11-10.md` | 保留 | L3 | — | — |
| 25 | `docs/reports/m6-delivery-2026-11-10.md` | 保留 | L3 | — | — |
| 26 | `docs/reports/m7-evaluation-2026-11-10.md` | 保留 | L3 | — | — |
| 27 | `docs/reports/m7-stability-2026-11-10.md` | 保留 | L3 | — | — |
| 28 | `docs/reports/mistake-save-readability-2026-11-15.md` | 保留 | L3 | — | — |
| 29 | `docs/reports/qa-photo-quality-crop-reproduction-2026-11-22.md` | 保留 | L3 | — | — |
| 30 | `docs/reports/ui-readability-2026-11-10.md` | 更新（历史快照标注） | L3 | :7-9 | `439ca76` |
| 31 | `docs/textbook-switching.md` | 保留 | L1 | — | — |
| 32 | `docs/题库/01-产品需求-拍照批量识别与统一题库.md` | 更新 | L1 | :3-10 | `197aaba` |
| 33 | `docs/题库/02-题库产品设计.md` | 更新 | L2 | :3-9 | `197aaba` |
| 34 | `docs/题库/03-开发计划-拍照批量识别与统一题库.md` | 更新 | L2 | :3 | `439ca76`,`197aaba` |
| 35 | `docs/题库/04-QA验收计划-拍照批量识别与统一题库.md` | 保留（仅批注） | L2 | :41,:314 | `65e2776`,`197aaba` |
| 36 | `docs/题库/05-产品补充裁决与实施口径.md` | 更新 | L1 | :3-11 | `197aaba` |
| 37 | `docs/题库/06-统一题库重构夜跑计划.md` | 归档 | L4 | 归档头:1-7 | `75e4653` |
| 38 | `docs/题库/07-统一题库查询兼容说明.md` | 保留 | L1 | — | — |
| 39 | `docs/题库/README.md` | 更新 | L1 | :24-31,:42 | `197aaba`,`65e2776` |

### 3.2 新增 3 份

| # | 文件 | 处置 | 权威 | 证据（行） | commit |
| --- | --- | --- | --- | --- | --- |
| 40 | `docs/README.md` | 新建 | L0 | 全文（135 行，含本报告登记行） | `aca2f21`,`65e2776` |
| 41 | `docs/UI_DEVELOPMENT_SPEC.md` | 新建 | L1 | 全文（204 行） | `197aaba`,`65e2776` |
| 42 | `docs/题库/07-拍照选题最终流程.md` | 新建 | L1 | 全文（202 行） | `197aaba`,`65e2776` |

### 3.3 索引处置修正

Phase 6 复核发现 `docs/README.md` §2 中 7 行“处置”与最终 diff 不符，已在本报告 PR 内修正：`M9_IMAGE_INTAKE.md`、`eink/eink-frame-api.md`、`题库/01`、`题库/02`、`题库/05`、`题库/README.md` 改为“更新”；`题库/07-拍照选题最终流程.md` 改为“新建”。其余“保留”行均为“正文保留、仅加批注”，与处置定义一致。

## 4. 归档 5 份与还原

| 原路径 | 归档路径 | 原因 | 取代者 |
| --- | --- | --- | --- |
| `docs/eink/服务端改造需求.md` | `docs/_archive/nightly-2026-11-26/eink/服务端改造需求.md` | 只声明 3 接口，是 `eink-frame-api.md` 四接口的真子集 | `eink/eink-frame-api.md` |
| `docs/eink/软件安装清单.md` | `docs/_archive/nightly-2026-11-26/eink/软件安装清单.md` | 主体记录另一台机器 `D:\Andy\Projects\esp32` 的工具链 | 无；部署见 `DEPLOYMENT_RUNBOOK.md` |
| `docs/DEPLOYER_AGENT.md` | `docs/_archive/nightly-2026-11-26/DEPLOYER_AGENT.md` | Compose+deployer 手工路线与 CI（kustomize+self-hosted runner）冲突 | `DEPLOYMENT_RUNBOOK.md` |
| `docs/PROD_UPDATE_ROUTE_DIAGNOSIS.md` | `docs/_archive/nightly-2026-11-26/PROD_UPDATE_ROUTE_DIAGNOSIS.md` | 被 11-15 修复报告 §1 超集取代 | `reports/mistake-save-readability-2026-11-15.md` |
| `docs/题库/06-统一题库重构夜跑计划.md` | `docs/_archive/nightly-2026-11-26/题库/06-统一题库重构夜跑计划.md` | 一次性计划，执行日 11-25 已过，PR #59 已闭环 | `题库/05`、`IMPLEMENTATION_STATUS.md` |

每份归档文件头部含固定块（原因/取代者/批次/还原命令）。批量还原：

```bash
git mv docs/_archive/nightly-2026-11-26/eink/服务端改造需求.md docs/eink/服务端改造需求.md
git mv docs/_archive/nightly-2026-11-26/eink/软件安装清单.md docs/eink/软件安装清单.md
git mv docs/_archive/nightly-2026-11-26/DEPLOYER_AGENT.md docs/DEPLOYER_AGENT.md
git mv docs/_archive/nightly-2026-11-26/PROD_UPDATE_ROUTE_DIAGNOSIS.md docs/PROD_UPDATE_ROUTE_DIAGNOSIS.md
git mv docs/_archive/nightly-2026-11-26/题库/06-统一题库重构夜跑计划.md docs/题库/06-统一题库重构夜跑计划.md
```

校验：`git grep` 对上述 5 个原路径在 `docs/`（排除 `_archive/`）零命中；`docs/_archive/nightly-2026-11-26/` 下 5 个文件保持原层级。

## 5. 批注汇总

实际批注 10 条；`grep -rho "type=[^ ]*" docs` 原始计数为 11，其中 `docs/README.md:120` 是格式示例，不是实际批注，统计时应排除。

| 类型 | 数量 | 位置 |
| --- | --- | --- |
| 待更新 | 4 | `IMPLEMENTATION_PLAN.md:3`、`KNOWLEDGE_BASE.md:3`、`MVP.md:3`、`TOOL_CONTRACTS.md:7` |
| 待确认 | 4 | `IMPLEMENTATION_STATUS.md:9`、`eink/eink-frame-api.md:135`、`题库/04:314`、`题库/README.md:42` |
| 代码不一致 | 1 | `eink/服务端渲染-产品补充说明.md:165` |
| 后续优化 | 1 | `UI_ACCEPTANCE_CHECKLIST.md:9` |

逐条原文：

1. `docs/IMPLEMENTATION_PLAN.md:3`
   `<!-- NOTE type=待更新 ref=README.md:3 target=docs/IMPLEMENTATION_PLAN.md:1 owner=product :: 根 README 已声明“小学 3～6 年级与初中全学科”，本文范围仍为六年级数学；保留原文待产品更新。 -->`
2. `docs/IMPLEMENTATION_STATUS.md:9`
   `<!-- NOTE type=待确认 ref=docs/reports/m7-evaluation-2026-11-10.md:5 target=docs/IMPLEMENTATION_STATUS.md:4 owner=product :: M7 在本表为“待验收”，评测报告标注“发布门禁：通过”；两者不矛盾但易误读，需产品确认 M7 整体验收结论。 -->`
3. `docs/KNOWLEDGE_BASE.md:3`
   `<!-- NOTE type=待更新 ref=README.md:3 target=docs/KNOWLEDGE_BASE.md:4 owner=product :: 知识库当前仅覆盖人教版六年级数学，未覆盖根 README 声明的其他年级与学科；待产品排期扩容。 -->`
4. `docs/MVP.md:3`
   `<!-- NOTE type=待更新 ref=README.md:3 target=docs/MVP.md:1 owner=product :: 根 README 已声明“小学 3～6 年级与初中全学科”，本文仍为六年级数学单学科口径；保留原文待产品更新。 -->`
5. `docs/TOOL_CONTRACTS.md:7`
   `<!-- NOTE type=待更新 ref=README.md:3 target=docs/TOOL_CONTRACTS.md:1 owner=product :: 契约按六年级数学工具集编写，尚未覆盖根 README 声明的“小学 3～6 年级与初中全学科”范围；待产品与架构确认扩展口径。 -->`
6. `docs/UI_ACCEPTANCE_CHECKLIST.md:9`
   `<!-- NOTE type=后续优化 ref=docs/UI_DEVELOPMENT_SPEC.md:174 target=docs/UI_ACCEPTANCE_CHECKLIST.md:6 owner=next-round :: 字号 token 化、越界色收编、断点收敛、对比度修正等 B1–B7 属后续排期，不纳入本轮验收门禁。 -->`
7. `docs/eink/eink-frame-api.md:135`
   `<!-- NOTE type=待确认 ref=src/eink/render.js:115,225 target=docs/eink/eink-frame-api.md:132 owner=product :: 本文“20px 末行省略”与 题库/04 PD-12、QA-EINK-03“不得截断/显示旧版省略号”冲突；本轮不改 e-ink 代码，待产品裁决后转 dev-eink。 -->`
8. `docs/eink/服务端渲染-产品补充说明.md:165`
   `<!-- NOTE type=代码不一致 ref=src/server.js:1298 target=docs/eink/服务端渲染-产品补充说明.md:166 owner=next-round :: 本文称“三个只读接口”，代码实际提供四个：queue/dashboard/page/preview（src/server.js:1298,1309,1355,1356）；本次保留原文待下一轮修订。 -->`
9. `docs/题库/04-QA验收计划-拍照批量识别与统一题库.md:314`
   `<!-- NOTE type=待确认 ref=src/eink/render.js:115,225 target=docs/题库/04-QA验收计划-拍照批量识别与统一题库.md:307 owner=product :: QA-EINK-03/PD-12 要求“不适配、不得截断或省略号”，当前 e-ink 渲染仍按 eink-frame-api §8 追加省略号；本轮不改 e-ink，待产品裁决。 -->`
10. `docs/题库/README.md:42`
    `<!-- NOTE type=待确认 ref=src/eink/render.js:115,225 target=docs/题库/README.md:39 owner=product :: 现行 e-ink 渲染仍追加省略号，与“不适配、不静默截断”冲突；待产品裁决，本轮不改 e-ink。 -->`

## 6. dev1 删除与收敛清单

PR #67：6 文件，+3/−602；3 个 commit；每个 commit 后全量测试绿。

| 项 | 动作 | 零引用检查（最终 dev） | commit |
| --- | --- | --- | --- |
| `KNOWLEDGE_POINT_NAMES` | 删除 `src/agent.js` 导出（−3） | `git grep KNOWLEDGE_POINT_NAMES` 零命中 | `3d6d3b0` |
| `classifyUntrustedInput` | 删除 `src/security/guards.js` 导出与实现（−11） | `git grep classifyUntrustedInput` 零命中 | `3d6d3b0` |
| `detectPromptInjection` | 保留 | 命中 `src/security/guards.js:32`、`src/evaluation/m7-runner.js:8,129`、`test/m7-security-stability.test.js:10,98` | — |
| `MAX_SCAN_CANDIDATES` | 收敛到 `src/database.js:489` 单一定义；`src/question-bank/scanner.js:2,7` 改为 import + re-export | `git grep` 仅见 `database.js:489` 一处 `export const`；`public/app.js` 仅保留本地值与 1 行注释锚点 | `a41056c` |
| `scripts/qa-eink-container-smoke.mjs` | 删除（−206） | 全仓 `git grep` 零命中 | `e9b87ff` |
| `scripts/run-llm-self-check.mjs` | 删除（−381） | 全仓 `git grep` 零命中 | `e9b87ff` |
| `ensureEinkFonts` | **未删除**（计划假设零引用，实际有调用方） | `src/eink/render.js:2,417`、`scripts/generate-eink-previews.mjs:9,25` 共 4 处引用；保留空实现 | — |
| OpenAPI 路由 | 审计后未改 | `src/openapi.js` 64 个 path+method 与 `src/server.js` 路由集合完全一致：0 缺失、0 多余、0 方法不符 | — |

说明：`ensureEinkFonts` 是计划与实际不符的一项。删除它会破坏 e-ink 渲染与预览脚本，故按“以代码事实为准”保留，并在本报告登记为计划修正。

## 7. qa 删除、合并与测试门禁

PR #66：22 文件，+810/−868（含 docs 校准 `65e2776`）；3 个 commit。

### 7.1 文件与用例数

| 指标 | 基线 `619a088` | 任务 A 后 | 最终 `11f2fd9` |
| --- | --- | --- | --- |
| `.test.js` 文件 | 38 | 37 | 38 |
| `test/helpers/*.js` | 0 | 2 | 2 |
| Node 发现的测试模块 | 38 | 39 | 40 |
| Node 报告 tests | 244 | 246 | 252 |
| 显式 `test()` 用例 | 244 | 244 | 250 |
| pass / fail | 244 / 0 | 246 / 0 | 252 / 0 |

252 = 250 条显式用例 + 2 个 helper 文件级空节点（`test/helpers/http-fixture.js`、`test/helpers/ui-css.js` 被 Node 自动发现，各产生 1 个空节点）。用例总数相对基线 244 净增 6，未触发“下降 >12%”停止条件（下限 215）。

### 7.2 删除与合并

- 删除 `test/tool-contract-regressions.test.js`（3 例），合并进 `test/tools.test.js`（7→10 例），原用例名全部保留：
  - “公开契约中的可选参数可以省略”
  - “Agent 保存错题时只获得编号和保存状态”
  - “超时后恢复的异步处理不能继续写入数据库”
- 新增 `test/helpers/ui-css.js`：从 `test/ui-readability.test.js:10-52` 抽取 `parseBlocks/findDeclaration/cssVariables/resolvePixels`，CSS 路径参数化；`ui-readability.test.js` 改为 import，全部用例名与 16px 下限断言不变。
- 新增 `test/helpers/http-fixture.js`：为 `api-docs`、`eink-api`、`eink-dashboard`、`m9-http-integration`、`question-bank-m1-m2`、`textbook-switching-http` 六个真实启动 server 的测试共用 spawn/HTTP fixture；仅删除被完全覆盖的重复代码，`textbook-switching-http` 的 1 条黑盒用例保留。
- 新增 `test/ui-tokens.test.js`（410 行，6 条断言）：
  1. `styles.css` 非 token `font-size` ≤33（失败列行号）；
  2. 去重颜色字面量 ≤209，且内置 209 色允许清单，出现清单外新色即失败；
  3. 宽度断点集合 ⊆ `{389,560,820,900,980,1100}`；
  4. `index.html` 内联 `style=` 为 0；
  5. `--text-*` token 均 ≥16px；
  6. `api-docs.css` 独立基线 31 非 token / 33 色。
  第 7 条“棘轮只能改小”无法由单测证明，写在基线常量注释中，由 R19 评审核对 diff 执行，未加假断言。
- 实测基线：33 / 209 / 断点集合符合 / 内联 0 / `--text-*` = 16/16/17px / api-docs.css 31+33。

### 7.3 Phase 5 回归与黑盒

QA 分支 `codex/nightly-qa-findings-2026-11-26`，commit `b933a61`，仅新增 `docs/_notes/qa-findings.md`（129 行），未改代码、未部署、未建 PR。

- 全量：252 tests / 252 pass / 0 fail / 0 skipped。
- UI 定向：13/13 通过。
- 回归：`git diff --name-only 619a088..HEAD` 不含 `docker-compose.yml`、`public/styles.css`、`public/api-docs.css`、`src/migrations.js`。
- 黑盒：见 §8.4；未发现功能性阻断。

## 8. 测试、CI 与部署

### 8.1 测试

- 夜跑基线：38 个 `.test.js` / 244 条显式用例，244/244 通过（实测于 `619a088`；计划文档记录的 241/37 为旧口径，以实跑为准）。
- 最终 dev：252/252 通过（250 显式 + 2 helper 空节点），0 fail / 0 skipped / 0 todo。
- 协调者独立复核：在 `nightly-verify-dev` worktree 对 `11f2fd9` 再跑全量，252/252 通过。

### 8.2 CI 与三次 dev 部署

| 触发 | dev commit | run | Validate | Build | Deploy |
| --- | --- | --- | --- | --- | --- |
| PR #65 合并后 push | `619a088` | [45816727040](https://github.com/itrice/Student-Study-AI-Agent/actions/runs/45816727040) | success | success | success |
| PR #66 合并后 push | `2213f79` | [45825026708](https://github.com/itrice/Student-Study-AI-Agent/actions/runs/45825026708) | success | success | success |
| PR #67 合并后 push | `11f2fd9` | [45825724809](https://github.com/itrice/Student-Study-AI-Agent/actions/runs/45825724809) | success | success | success |

说明：计划原写“两次 dev 部署”，实际因 Phase 3 测试 PR 也 push 到 dev 而触发第 3 次；三次均在用户预授权的 3 次预算内，未执行手工部署。

### 8.2.1 第 4 次 dev 部署（合并本报告 PR #68）

| 项 | 结果 |
| --- | --- |
| 合并提交 | `e84bd13c1a4776e15a4d5a1c30f12bf00aadaf6c`（2026-11-26T14:21:12Z，用户授权） |
| run | [45838146641](https://github.com/itrice/Student-Study-AI-Agent/actions/runs/45838146641) |
| 第 1 次尝试 | Validate/Build 成功；Deploy 在 Set up job 失败，原因：GitHub codeload 下载 `actions/checkout` 连续 3 次 429（Too Many Requests），非代码/Runner 离线问题 |
| 修复 | 使用 API 重跑 failed jobs（run_attempt 2）；Validate/Build/Deploy 全部 success |
| 部署后黑盒 | `http://student-study-ai-agent-dev.home.arpa/api/health` = 200；`/api/eink/dashboard` = 200（`curl --noproxy '*'` 直连 ingress） |

### 8.3 最终部署状态

- namespace：`student-study-ai-agent-dev`；deployment/service：`student-study-ai-agent`。
- revision 44，ready 1/1；pod `student-study-ai-agent-77c57bbff8-cl7gm`。
- image：`ghcr.io/itrice/student-study-ai-agent:sha-11f2fd9e8fcb@sha256:f2615d43cd7e35d42bd2b657edb0f71652eee6aaff303ac908ccfc8275623313`。
- 集群内 smoke：`{"ok":true,"schemaVersion":16,"toolCount":9}`。

### 8.4 部署黑盒（port-forward）

| 请求 | 结果 |
| --- | --- |
| `GET /api/health` | 200；`ok=true`，`schemaVersion=16`，`toolCount=9` |
| `GET /api/questions?category=mistake` | 200；返回对象 `{questions,total}`，`questions` 为数组；total=1，count=1，首个 id=12 |
| `GET /api/eink/dashboard` | 200；`Content-Length: 48000`；ETag 存在；响应体 48000 字节；无 `Content-Encoding` |
| 同上 + `If-None-Match` | 304；响应体 0 字节 |
| `GET /api/eink/page?id=12&mode=question` | 200；48000 字节；无 `Content-Encoding`；ETag 存在 |

ingress：`http://student-study-ai-agent-dev.home.arpa/api/health` 经本机环境代理返回 503；`curl --noproxy '*'` 直连 ingress（`192.168.1.66:80`，带 Host 头）返回 200。结论为**本机代理链路问题**，不是 ingress/应用故障；未访问正式实例 `192.168.1.66:3000`。port-forward 已在测试后终止，18080 释放。

### 8.5 PR #64 状态观察

用户前提为“PR #64 Open”。实测 GitHub API：PR #64（base=main，head=dev）已于 **2026-11-26T06:08:22Z** 由 `itrice` 合入 main，merge commit `9ff569d250e36a6567bf87f219c05f8fc36b6c28`，发生在本轮开始前。本轮未对其合并、关闭或评论，也未验证 main 发布链；如需发布回滚/追踪，请以该 merge 为起点单独处理。

## 9. 遗留 backlog

### owner=next-round

- **B1**：新增标题 token `--text-h1/h2/h3/h4`（建议 `32/24/20/18`）与数据强调 token `--text-stat`，替换 §2.2 的 13 + 6 处；参考 `styles.css:416,1018,2358,2512,4841,3224`。
- **B2**：收编 §4.2 三组越界色为 `--focus-accent`/`--coral-dark`/`--gold-bright`；参考 `styles.css:5520,5591,838,5750,5793,421,520,558`。
- **B3**：断点从 6 个收敛为 4 个（`560/820/980/1100`），淘汰 `389`、合并 `900` 复合条件。
- **B4**：修正 §4.1 对比度不达标的 pale 文字组合（`--gold` 2.94、`--coral` 3.07、`--blue` 4.22），或明确其只用于大号文本。
- **B5**：`api-docs.css` 并入主 token 体系（或正式声明永久豁免并移出棘轮）。
- **B6**：触控目标统一 44px，清理 30/34/38/42 存量。
- **B7**：`app.js` 绘制层色值接入统一常量；参考 `app.js:546,1796`。
- 修正 `docs/eink/服务端渲染-产品补充说明.md:165` 的“三个只读接口”为四个（代码事实：`src/server.js:1298,1309,1355,1356`）。
- 消除 2 个 helper 空测试节点对计数的干扰（例如移出 Node 默认发现路径），使 tests 计数与显式用例数一致。
- B1–B7 已由用户裁决在下一轮启动（见 §12）。

### owner=product

- 统一产品范围口径（已裁决，下一轮执行）：统一为“小学 3～6 年级全学科”，暂不含初中；需改根 `README.md:3` 与 `IMPLEMENTATION_PLAN.md`、`KNOWLEDGE_BASE.md`、`MVP.md`、`TOOL_CONTRACTS.md` 的范围表述，并清理 4 条 `待更新` 批注；当前知识库数据覆盖（人教版六年级数学）作为现状另行标注，不等于目标范围。
- M7 整体验收结论（已裁决）：整体验收以 `IMPLEMENTATION_STATUS.md` 的“待验收”为准；`reports/m7-evaluation-2026-11-10.md` 的“发布门禁：通过”仅指 M7 评测/安全门禁，不是整体验收结论；下一轮修正双方措辞。
- 墨水屏 20px 末行省略与 `题库/04` PD-12/QA-EINK-03“不得截断/省略号”的冲突（已裁决）：以 PD-12 为准，转 dev-eink 修复 3 条 `待确认` 批注涉及的文档与实现。
- `/api/questions?category=mistake` 返回包装对象 `{questions,total}`（已裁决）：满足验收；`src/openapi.js` 的 `QuestionList` 契约要求 `total`+`questions` 且 `additionalProperties:false`，前端 `app.js:2599-2600` 按 `result.questions` 消费，`/api/mistakes` 保留裸数组兼容。
- B4 对比度修正涉及品牌色取舍，需在下一轮 B1–B7 内按 UI 规范 §4.1 定稿（默认采用提亮 pale 组合或限定大号文本，如无产品新指令即按规范执行）。

### owner=ops

- ingress 503 为本机代理链路问题；使用该环境验收时配置 `no_proxy` 或 `curl --noproxy '*'`，不要把 503 记为应用故障。
- dev ingress 的访问方式与证书/代理配置需在验收环境固化；本轮以 port-forward 作为黑盒证据。
- 第 4 次 dev 部署已由用户授权（合并本报告 PR）。
- PR #64 已在本轮前合入 main；如需生产发布追踪，请以 merge `9ff569d` 为起点单独核对。

## 10. 用户裁决项与状态

1. **e-ink 截断冲突**：已裁决——按 PD-12/QA-EINK-03 执行“不适配、不截断、不显示省略号”，转 dev-eink 修复。
2. **M7 验收口径**：已裁决——整体验收以 `IMPLEMENTATION_STATUS` 的“待验收”为准；评测报告的“发布门禁通过”仅为 M7 评测/安全门禁。
3. **产品范围**：已裁决——统一为“小学 3～6 年级全学科”，暂不含初中。
4. **`/api/questions` 响应形态**：已裁决——包装对象 `{questions,total}` 满足验收，无需裸数组。
5. **本报告 PR 的合并时机**：已裁决——合并（用户授权，触发第 4 次 dev 部署）。
6. **B1–B7 排期**：已裁决——下一轮启动。
7. **ingress 环境**：待办（owner=ops）——验收环境统一配置 `no_proxy`/直连，或修复本机代理链路。
8. **PR #64 已合入 main**：无需本轮动作；如需发布回滚或生产验证，请以 merge `9ff569d` 为起点另行给出范围。

## 11. 交付 PR 记录

| 阶段 | PR | URL | 状态 |
| --- | --- | --- | --- |
| 文档收敛 | #65 | https://github.com/itrice/Student-Study-AI-Agent/pull/65 | 已合并 `619a088` |
| 测试整理 + UI 棘轮 | #66 | https://github.com/itrice/Student-Study-AI-Agent/pull/66 | 已合并 `2213f79` |
| 代码清理 | #67 | https://github.com/itrice/Student-Study-AI-Agent/pull/67 | 已合并 `11f2fd9` |
| 夜跑交付报告 | #68 | https://github.com/itrice/Student-Study-AI-Agent/pull/68 | 已合并（用户授权，触发第 4 次 dev 部署） |

附：QA 发现全文见 `docs/_notes/qa-findings.md`。

## 12. 用户裁决记录（2026-11-26）

| # | 事项 | 裁决 | 后续动作 |
| --- | --- | --- | --- |
| 1 | 本报告 PR #68 | 合并 | 合并触发第 4 次 dev 部署，按 CI 结果记录 |
| 2 | e-ink 20px 末行省略与 题库/04 PD-12/QA-EINK-03“不得截断”冲突 | 以 PD-12/QA-EINK-03 为准，转 dev-eink 修正 | dev-eink 实现 `eink_fit_status=unfit`、队列排除、page 409 `EINK_UNFIT`、preview 标注“不适配墨水屏单页”，删除省略号路径；文档同步去掉 3 条 `待确认` 批注 |
| 3 | M7 整体验收口径 | 以 `IMPLEMENTATION_STATUS` 的“待验收”为准 | 下一轮修正 `reports/m7-evaluation-2026-11-10.md` 措辞，明确“发布门禁通过”仅指 M7 评测/安全门禁 |
| 4 | 产品范围 | 统一为“小学 3～6 年级全学科”，暂不考虑初中 | 下一轮更新根 `README.md:3` 及 `IMPLEMENTATION_PLAN.md`、`KNOWLEDGE_BASE.md`、`MVP.md`、`TOOL_CONTRACTS.md`，区分目标范围与当前知识库数据覆盖（人教版六年级数学），清理 4 条 `待更新` 批注 |
| 5 | `/api/questions?category=mistake` 包装对象 | 满足验收 | 契约见 `src/openapi.js` `QuestionList`（`total`+`questions`，`additionalProperties:false`）；前端 `public/app.js:2599-2600` 已按 `result.questions` 消费；`/api/mistakes` 保留裸数组兼容；接口作用为统一题库列表查询并按分类过滤，读取唯一 `mistakes` 事实表 |
| 6 | B1–B7 | 下一轮启动 | 按 `docs/UI_DEVELOPMENT_SPEC.md` §7 执行；B4 按规范 §4.1 定稿对比度方案 |