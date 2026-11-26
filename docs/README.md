# 文档索引与权威分级

> 更新日期：2026-11-26（夜跑整理）
> 用途：docs/ 的唯一导航入口。新文档必须在此登记；冲突按本文分级裁决。
> 事实优先级：**代码与 CI 测试 > 本索引 L1 现行权威 > L2 计划/验收 > L3 历史快照 > L4 归档**。

## 1. 权威分级

| 级别 | 含义 | 冲突时如何处理 |
|---|---|---|
| L0 | 代码、迁移、CI 测试（`src/`、`public/`、`test/`、`.github/`） | 最终事实来源；文档与之不符时按"文档向代码对齐"修正 |
| L1 | 现行权威（需求、契约、规范、部署、进度） | 同类冲突以 L1 指定文档为准；L1 之间冲突需产品裁决并记录 |
| L2 | 现行计划与验收（实施计划、QA 计划、审核清单） | 不得覆盖 L1；进度状态一律回写 `IMPLEMENTATION_STATUS.md` |
| L3 | 历史快照（reports/、一次性记录） | 仅作证据，不作现行验收依据；不删不搬，头部标注"历史快照" |
| L4 | 归档（`docs/_archive/`） | 不再引用；需要时按归档块中的还原命令恢复 |

### 1.1 单点权威指定

| 主题 | 唯一权威 | 说明 |
|---|---|---|
| UI 字号/字体/颜色/尺寸取值 | [UI_DEVELOPMENT_SPEC.md](UI_DEVELOPMENT_SPEC.md) | **UI 取值唯一权威**；[UI_ACCEPTANCE_CHECKLIST.md](UI_ACCEPTANCE_CHECKLIST.md) 是其下游验收清单，冲突以本规范 + 代码为准 |
| 测试/验收事实 | `test/`（CI `node --test`） | 含 `test/ui-readability.test.js` 的 16px 下限；`test/ui-tokens.test.js` 棘轮本轮新增 |
| 实施进度 | [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) | 各文档不再内嵌进度；[TOOL_CONTRACTS.md](TOOL_CONTRACTS.md) 已改为链接本表 |
| 题库产品需求 | [题库/01](题库/01-产品需求-拍照批量识别与统一题库.md)（v1.4）+ [题库/05](题库/05-产品补充裁决与实施口径.md) | 05 为补充裁决；不得降低 PRD 第 13 节发布门槛 |
| 拍照选题现行 UI | [题库/07](题库/07-拍照选题最终流程.md) | 01/02/03/04 中旧图片列表、裁剪、识别范围按钮均为历史口径 |
| 工具契约 | [TOOL_CONTRACTS.md](TOOL_CONTRACTS.md) | 进度看 IMPLEMENTATION_STATUS.md |
| 墨水屏接口 | [eink/eink-frame-api.md](eink/eink-frame-api.md) | 四个接口：queue/dashboard/page/preview；`src/server.js:1298,1309,1355,1356` |
| 墨水屏看板版面 | [eink/电子墨水屏看板设计.md](eink/电子墨水屏看板设计.md) | 题目/答案页仍以 [eink/服务端渲染-产品补充说明.md](eink/服务端渲染-产品补充说明.md) 为准 |
| 部署 | [DEPLOYMENT_RUNBOOK.md](DEPLOYMENT_RUNBOOK.md) | K3s + self-hosted runner 为 CI 实际路线 |

## 2. 文档处置总表

处置取值：保留 / 更新（本轮改口径或加批注）/ 新建 / 归档。批注详见各文件内 `<!-- NOTE ... -->`。

### 2.1 docs/ 根目录

| 文件 | 处置 | 权威归属 | 说明 |
|---|---|---|---|
| [README.md](README.md) | 新建 | L0 导航 | 本索引页；替代根 README 中的零散文档列表 |
| [UI_DEVELOPMENT_SPEC.md](UI_DEVELOPMENT_SPEC.md) | 新建 | L1 | UI 取值唯一权威；R1–R19 + B1–B7 backlog + §6 棘轮基线 |
| [UI_ACCEPTANCE_CHECKLIST.md](UI_ACCEPTANCE_CHECKLIST.md) | 更新 | L2 | 字号口径 15px→16px，对齐 styles.css:20-22 与 ui-readability.test.js:54；头部登记上游规范 |
| [TOOL_CONTRACTS.md](TOOL_CONTRACTS.md) | 更新 | L1 | 第 4 行内嵌进度改为链接 IMPLEMENTATION_STATUS.md |
| [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) | 保留 | L1 | 实施进度唯一来源；M7 待验收口径见批注 |
| [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) | 保留 | L2 | 实施计划基线；范围口径见批注 |
| [MVP.md](MVP.md) | 保留 | L3 | 首版范围历史基线；范围扩展见批注 |
| [KNOWLEDGE_BASE.md](KNOWLEDGE_BASE.md) | 保留 | L1 | M5 知识库与检索说明；范围口径见批注 |
| [KNOWLEDGE_REVIEW_CHECKLIST.md](KNOWLEDGE_REVIEW_CHECKLIST.md) | 保留 | L2 | 知识内容审核流程 |
| [LLM_SETUP.md](LLM_SETUP.md) | 保留 | L1 | LLM 配置、诊断与降级 |
| [M7_SECURITY_CHECKLIST.md](M7_SECURITY_CHECKLIST.md) | 保留 | L2 | M7 安全测试清单 |
| [M9_IMAGE_INTAKE.md](M9_IMAGE_INTAKE.md) | 更新 | L1 | 图片录题契约；新增 2026-11-26 题框确认流程与历史口径边界（:5-12） |
| [DEPLOYMENT_RUNBOOK.md](DEPLOYMENT_RUNBOOK.md) | 保留 | L1 | Docker Compose 手工部署 + K3s CI/CD 手册 |
| [textbook-switching.md](textbook-switching.md) | 保留 | L1 | 教材切换数据契约与回滚 |
| [beishida-2024-teacher-review-checklist.md](beishida-2024-teacher-review-checklist.md) | 保留 | L2 | 北师大 2024 教材人工核对清单 |

### 2.2 docs/eink/

| 文件 | 处置 | 权威归属 | 说明 |
|---|---|---|---|
| [eink/eink-frame-api.md](eink/eink-frame-api.md) | 更新 | L1 | 四接口实现说明；首页看板已实现、依赖改 sharp、20px 省略号加批注（:8,91,110,135） |
| [eink/电子墨水屏看板设计.md](eink/电子墨水屏看板设计.md) | 更新 | L1 | 相关文档链接改指归档路径 |
| [eink/服务端渲染-产品补充说明.md](eink/服务端渲染-产品补充说明.md) | 更新 | L1 | 对《服务端改造需求》的引用改指归档路径 |

### 2.3 docs/题库/

| 文件 | 处置 | 权威归属 | 说明 |
|---|---|---|---|
| [题库/README.md](题库/README.md) | 更新 | L1 | 阅读顺序新增统一题库查询兼容说明；e-ink 冲突批注（:24-31,42） |
| [题库/01-产品需求-拍照批量识别与统一题库.md](题库/01-产品需求-拍照批量识别与统一题库.md) | 更新 | L1 | PRD v1.4，题框确认现行流程；正文已按 v1.4 更新（:3-10） |
| [题库/02-题库产品设计.md](题库/02-题库产品设计.md) | 更新 | L2 | 产品设计基线 v1.3；题框确认流程已并入（:3-9） |
| [题库/03-开发计划-拍照批量识别与统一题库.md](题库/03-开发计划-拍照批量识别与统一题库.md) | 更新 | L2 | 头部对应需求版本 v1.3→v1.4 |
| [题库/04-QA验收计划-拍照批量识别与统一题库.md](题库/04-QA验收计划-拍照批量识别与统一题库.md) | 保留 | L2 | QA 验收计划 v0.5 |
| [题库/05-产品补充裁决与实施口径.md](题库/05-产品补充裁决与实施口径.md) | 更新 | L1 | 补充裁决；入口与题框确认口径已更新（:3-11），冲突时优先于 01–04（不降 PRD 13 门槛） |
| [题库/07-拍照选题最终流程.md](题库/07-拍照选题最终流程.md) | 新建 | L1 | 本轮固化并纳入索引；拍照选题现行 UI/OCR 流程唯一说明 |
| [题库/07-统一题库查询兼容说明.md](题库/07-统一题库查询兼容说明.md) | 保留 | L1 | 统一题库查询、分类筛选与 `/api/mistakes` 兼容期说明 |

### 2.4 docs/reports/（历史证据，不删不搬）

| 文件 | 处置 | 权威归属 | 说明 |
|---|---|---|---|
| [reports/docs-alignment-nightly-2026-11-26.md](reports/docs-alignment-nightly-2026-11-26.md) | 新建 | L3 | 2026-11-26 夜跑交付报告：三 PR、回滚 SHA、文档处置、批注与 backlog |
| [reports/ui-readability-2026-11-10.md](reports/ui-readability-2026-11-10.md) | 更新 | L3 | 头部加"历史快照"；14/12px 口径已过时，现行见 UI_DEVELOPMENT_SPEC |
| [reports/mistake-save-readability-2026-11-15.md](reports/mistake-save-readability-2026-11-15.md) | 保留 | L3 | 错题保存与字号修复记录（现行参考） |
| [reports/m4-ui-validation-2026-11-09.md](reports/m4-ui-validation-2026-11-09.md) | 保留 | L3 | M4 验收证据 |
| [reports/m5-acceptance-2026-11-10.md](reports/m5-acceptance-2026-11-10.md) | 保留 | L3 | M5 验收记录（条件通过） |
| [reports/m5-knowledge-evaluation-2026-11-10.md](reports/m5-knowledge-evaluation-2026-11-10.md) | 保留 | L3 | M5 检索评测 |
| [reports/m6-delivery-2026-11-10.md](reports/m6-delivery-2026-11-10.md) | 保留 | L3 | M6 交付记录 |
| [reports/m7-evaluation-2026-11-10.md](reports/m7-evaluation-2026-11-10.md) | 保留 | L3 | M7 评测（发布门禁通过）；整体验收状态以 IMPLEMENTATION_STATUS 为准 |
| [reports/m7-stability-2026-11-10.md](reports/m7-stability-2026-11-10.md) | 保留 | L3 | M7 稳定性 97/97 |
| [reports/eink-api-2026-11-17.md](reports/eink-api-2026-11-17.md) | 保留 | L3 | 墨水屏接口自测证据 |
| [reports/qa-photo-quality-crop-reproduction-2026-11-22.md](reports/qa-photo-quality-crop-reproduction-2026-11-22.md) | 保留 | L3 | 照片清晰度/裁剪问题复现 |
| [reports/llm-self-test-2026-11-09T09-58-08-707Z.md](reports/llm-self-test-2026-11-09T09-58-08-707Z.md) | 保留 | L3 | LLM 自测 30/30 |

`reports/` 下的 JSON/SQLite/PNG/BIN 均为证据附件，不单独登记，随所属报告引用。

## 3. 归档清单（batch=nightly-2026-11-26）

| 原路径 | 归档路径 | 原因 | 取代者 |
|---|---|---|---|
| `docs/eink/服务端改造需求.md` | `docs/_archive/nightly-2026-11-26/eink/服务端改造需求.md` | 只声明 3 接口，是 eink-frame-api 四接口真子集（实际路由 `src/server.js:1298,1309,1355,1356`） | [eink/eink-frame-api.md](eink/eink-frame-api.md) |
| `docs/eink/软件安装清单.md` | `docs/_archive/nightly-2026-11-26/eink/软件安装清单.md` | 主体记录另一台机器 `D:\Andy\Projects\esp32` 的工具链 | 无（部署见 [DEPLOYMENT_RUNBOOK.md](DEPLOYMENT_RUNBOOK.md)） |
| `docs/DEPLOYER_AGENT.md` | `docs/_archive/nightly-2026-11-26/DEPLOYER_AGENT.md` | Compose+deployer 手工路线与 CI（kustomize+self-hosted runner）冲突 | [DEPLOYMENT_RUNBOOK.md](DEPLOYMENT_RUNBOOK.md) |
| `docs/PROD_UPDATE_ROUTE_DIAGNOSIS.md` | `docs/_archive/nightly-2026-11-26/PROD_UPDATE_ROUTE_DIAGNOSIS.md` | 被 11-15 修复报告 §1 超集取代 | [reports/mistake-save-readability-2026-11-15.md](reports/mistake-save-readability-2026-11-15.md) |
| `docs/题库/06-统一题库重构夜跑计划.md` | `docs/_archive/nightly-2026-11-26/题库/06-统一题库重构夜跑计划.md` | 一次性计划，执行日 11-25 已过，PR #59 已闭环 | [题库/05](题库/05-产品补充裁决与实施口径.md)、[IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) |

每份归档文件头部含固定块（原因/取代者/还原命令）。批量还原：

```bash
git mv docs/_archive/nightly-2026-11-26/eink/服务端改造需求.md docs/eink/服务端改造需求.md
git mv docs/_archive/nightly-2026-11-26/eink/软件安装清单.md docs/eink/软件安装清单.md
git mv docs/_archive/nightly-2026-11-26/DEPLOYER_AGENT.md docs/DEPLOYER_AGENT.md
git mv docs/_archive/nightly-2026-11-26/PROD_UPDATE_ROUTE_DIAGNOSIS.md docs/PROD_UPDATE_ROUTE_DIAGNOSIS.md
git mv docs/_archive/nightly-2026-11-26/题库/06-统一题库重构夜跑计划.md docs/题库/06-统一题库重构夜跑计划.md
```

## 4. 批注入口

批注为 HTML 注释，渲染不可见，格式：

```text
<!-- NOTE type=待更新|待确认|代码不一致|后续优化 ref=<文件:行> target=<文件:行> owner=<next-round|product|ops> :: 说明 -->
```

统计：

```bash
grep -rho "type=[^ ]*" docs | sort | uniq -c
```


## 5. 维护约定

1. 新增文档必须在本页登记（文件、级别、权威归属）。
2. 进度只写 [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md)，其他文档只链接，不复制状态。
3. `reports/` 只增不改；确需标注时只允许在头部加"历史快照"说明。
4. 归档必须使用 `_archive/<batch>/<原相对路径>` 结构，并在头部写原因/取代者/还原命令。
5. UI 取值先查 [UI_DEVELOPMENT_SPEC.md](UI_DEVELOPMENT_SPEC.md)，再查 `public/styles.css` 与 CI 门禁。