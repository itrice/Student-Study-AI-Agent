# 教材切换（人教版 / 北师大版六年级）

本文件记录 M10 教材切换最小切片的数据契约、知识点映射、迁移、备份恢复、回滚演练和已知限制。实现分支：`codex/textbook-switching`。

## 1. 范围与原则

- 两套教材并存，不删除、不改写人教版知识库。
- 教材选择挂在 `students.textbook_id` 上，不做全局配置。
- 错题只保存当前 `textbook_id` / `curriculum_point_id`；切换前关系写入不可变审计日志。
- 不使用“圆（北师大）”这类名称后缀绕过唯一约束，教材、单元、编排知识点、映射分别建表。
- 北师大版新增编排内容 `review_status = 'unreviewed'`，不沿用人教版审核签字。
- 切换先预演，确认后在单个 `BEGIN IMMEDIATE` 事务内执行，失败完整回滚。

## 2. 教材目录

| textbook_key | 展示名称 | 可选 |
| --- | --- | --- |
| `renjiao-6-all` | 人教版六年级（上册/下册） | 是，旧数据默认 |
| `renjiao-6-upper` | 人教版六年级上册 | 是 |
| `renjiao-6-lower` | 人教版六年级下册 | 是 |
| `beishida-6-upper` | 北师大版六年级上册 | 是 |
| `beishida-6-lower` | 北师大版六年级下册 | 是 |

北师大目录与来源：

- 单元目录：`beishida-outline-v1`，人工核对单元名称与顺序。
- 知识摘要：`beishida-self-authored-summary-v1`，复用项目自编数学摘要并按北师大编排，待任课教师审核。
- `观察物体`、`图形的运动` 没有合适的人教版摘要复用，卡片明确显示“待教师审核、暂不提供自动知识讲解”，不伪造内容。

## 3. 12 个现有人教版知识点映射

状态定义：`exact` 精确、`renamed` 改名、`merged` 合并、`split` 拆分/需确认、`uncovered` 未覆盖。

| 人教版知识点 | 北师大六上 | 北师大六下 |
| --- | --- | --- |
| 分数乘除法 | 合并 → 分数混合运算 | 未覆盖 |
| 分数四则混合运算 | 合并 → 分数混合运算 | 未覆盖 |
| 比和比例 | 拆分 → 比的认识（需确认） | 拆分 → 比的认识、比例、正比例与反比例（需确认） |
| 比例与图形 | 未覆盖 | 拆分 → 比例尺、图形的放大与缩小（需确认） |
| 圆 | 精确 → 圆 | 未覆盖 |
| 圆柱与圆锥 | 未覆盖 | 精确 → 圆柱与圆锥 |
| 百分数 | 拆分 → 百分数、百分数的应用（需确认） | 未覆盖 |
| 统计与扇形统计图 | 改名 → 数据处理 | 未覆盖 |
| 数与形 | 改名 → 数学好玩 | 未覆盖 |
| 负数 | 未覆盖 | 未覆盖 |
| 位置与方向 | 未覆盖（不强行映射到观察物体） | 未覆盖 |
| 综合应用 | 改名 → 整理与复习 | 改名 → 整理与复习 |

映射版本：`2026.11.15-v1`。映射表由 `curriculum_mappings` 保存，可同时保存多套教材之间的有向映射。

## 4. 数据模型（迁移 v12）

新增表：

- `textbooks`：教材版本、年级、学期、审核状态、来源。
- `textbook_units`：教材单元顺序与来源。
- `curriculum_points`：教材编排知识点，含别名、语义键、来源知识摘要和审核状态。
- `curriculum_mappings`：来源知识点到目标知识点的映射、状态、置信度和是否需确认。
- `curriculum_switch_logs`：切换/人工归类审计主记录。
- `curriculum_switch_items`：逐题切换前后教材、知识点、映射状态、自动/人工、冲突/未映射。
- `report_snapshots`：切换前的日/周报快照，带教材标签和“按当时教材”。

`students` 新增 `textbook_id`、`textbook_selected_at`；`mistakes` 新增 `textbook_id`、`curriculum_point_id`、`curriculum_status`。

审计日志和明细都设置 `BEFORE UPDATE` 与 `BEFORE DELETE` 触发器，普通 SQL 不能修改或删除。

## 5. API 契约

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/curriculum` | 当前学生、当前教材、可选教材、单元和编排知识点 |
| GET | `/api/curriculum/unmapped` | 当前学生“未覆盖/待归类”错题与目标教材知识点 |
| POST | `/api/curriculum/switch/preview` | 请求体 `{ targetTextbookId }`，只读预演 |
| POST | `/api/curriculum/switch/execute` | 需 `Idempotency-Key`；请求体 `{ targetTextbookId, previewToken, mappingChoices, confirmUnmapped }` |
| GET | `/api/curriculum/switches?mistakeId=&limit=` | 审计记录；可按错题追溯 |
| POST | `/api/curriculum/mistakes/:id/resolve` | 需 `Idempotency-Key`；请求体 `{ targetCurriculumPointId }`，人工归类 |

`mappingChoices` 以预演返回的 `resolutionKey` 为键，值为目标 `curriculumPointId`；`null` 或 `"unmapped"` 表示保留待归类。拆分/冲突必须显式选择；未覆盖项必须 `confirmUnmapped: true`。

## 6. 切换行为

1. 预演读取当前学生错题、当前教材编排、映射表、附件/作答/提示/掌握证据/复习队列计数和历史报告天数，不写数据库。
2. 确认执行时，先按历史审计尝试还原 A→B→A 关系，再按映射结果生成逐题计划。
3. 单个事务内依次：更新错题当前教材与知识点、写审计主记录和明细、写历史报告快照、更新学生当前教材。
4. 任一步失败执行 `ROLLBACK`，学生教材、错题、审计和快照均不留下部分写入。
5. 相同 `Idempotency-Key` 重放返回原审计记录，不重复执行。
6. 切换不修改题目、答案、附件、作答历史、提示、掌握证据、掌握状态和复习到期时间。
7. 历史日/周报读取切换前快照，显示 `按当时教材`，不追溯重算。

## 7. 备份与恢复

使用现有 `scripts/learning-backup.mjs`：

```powershell
npm run backup
npm run restore -- <备份目录>
```

备份包含 SQLite 数据库和附件目录，manifest 记录数据库版本、附件 SHA-256 与字节数。恢复前校验数据库版本、附件清单和哈希；教材选择、错题当前映射、审计日志、报告快照和附件一起恢复。

专项测试 `备份与恢复保留教材选择、错题映射、审计和附件` 覆盖切换后的备份恢复一致性。

## 8. 回滚演练

### 事务内失败回滚

测试 `切换中途失败会完整回滚，不留下部分教材、错题或审计写入` 在 `mistakes` 上临时创建 `BEFORE UPDATE` 触发器强制中止切换，验证：

- 学生教材未改变；
- 15 条/测试错题逐字段未改变；
- `curriculum_switch_logs`、`curriculum_switch_items`、`report_snapshots` 均为 0；
- 移除故障触发器后可正常重新切换。

运行：

```powershell
node --test test/textbook-switching.test.js
```

### 提交后的业务回滚

执行结果和 `rollback_json` 保存原教材、原知识点和原状态。需要回到之前教材时，重新选择原教材执行切换；系统优先读取 `curriculum_switch_items` 还原 A→B 前的关系，并生成新的审计记录，不删除原记录。

## 9. 测试证据

| 场景 | 结果 |
| --- | --- |
| 5 本教材目录、12 个知识点映射、北师大新增卡片 | 通过 |
| 预演取消不写数据 | 通过 |
| 15 条现有数据、附件、作答、提示、掌握证据、复习队列保真 | 通过 |
| 双学生隔离，另一个学生数据完全不变 | 通过 |
| A→B→A 审计还原与逐题追溯 | 通过 |
| 未映射保留待归类、人工归类、审计不可改/删 | 通过 |
| 事务失败完整回滚 | 通过 |
| 历史日/周报快照标注“按当时教材” | 通过 |
| 北师大知识地图与别名搜索、无覆盖不伪造 | 通过 |
| 100 条样本预演 + 执行性能 | 通过（测试阈值 8 秒） |
| 备份恢复一致性 | 通过 |
| v11→v12 迁移与旧数据绑定人教版 | 通过 |
| HTTP 预演/执行/幂等/审计/知识地图 | 通过 |
| 全量 `node --test` | 通过 |

## 10. 已知限制

- 本轮只做当前单学生选择入口，多学生账号/切换 UI 不在范围。
- 北师大六上、六下分别选择；未选择的另一册内容会显示“当前教材未覆盖/待归类”，可通过切换或人工归类处理。
- 北师大新增内容尚未取得任课教师签字，检索结果保持 `unreviewed`。
- 不做图形推理、复杂手写公式识别、多图批注和云端同步（M9.3 范围）。
- M7/M5 门禁与 M9 验收状态不因本切片改变。

## 11. UI 截图

| 场景 | 截图 |
| --- | --- |
| 教材切换入口（1280×900） | `assets/textbook-switching/textbook-dialog-1280.png` |
| 切换预演（1280×900） | `assets/textbook-switching/textbook-preview-1280.png` |
| 切换预演（834×1194） | `assets/textbook-switching/textbook-preview-834.png` |
| 切换预演（390×844） | `assets/textbook-switching/textbook-preview-390.png` |
| 执行结果（834×1194） | `assets/textbook-switching/textbook-result-834.png` |
| 历史报告"按当时教材"（1280×900） | `assets/textbook-switching/textbook-feedback-scope-1280.png` |
