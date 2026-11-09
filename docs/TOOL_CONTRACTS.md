# Agent 工具契约 v1

> 更新日期：2026-11-09
> 实现状态：M2、M2.2、M3 已完成；M4 待验收
> 代码入口：`src/tools/index.js`

## 1. 设计原则

- LLM 不直接访问 SQLite。
- 每次工具调用先校验调用者权限和 JSON Schema。
- 所有写入工具必须提供幂等键。
- 工具执行结果必须通过输出 Schema 校验。
- 每次工具执行有硬超时；超时返回 `TOOL_TIMEOUT`。
- 工具调用写入 `agent_runs` 和 `tool_calls` 审计记录。
- Agent 默认不能通过 `get_mistake` 获取完整答案和解析。
- 不知道历史提示次数或独立作答状态时使用 `NULL`，不得伪造成“无提示独立答对”。
- 完整答案回填必须经过一次性编辑授权；复习作答前不得通过编辑接口查看答案。

## 2. 调用约定

调用格式：

```text
tools.invoke(toolName, arguments, {
  caller: "agent" | "ui" | "system",
  runId?: number,
  idempotencyKey?: string
})
```

规则：

- 没有提供 `runId` 时，注册器自动创建一次工具运行记录。
- 提供 `runId` 时，该运行由上层 Agent 编排器负责结束。
- 相同的工具名和幂等键只能对应完全相同的参数。
- 相同调用重放返回首次成功结果，不再次执行写入。
- 相同幂等键使用不同参数时返回 `IDEMPOTENCY_CONFLICT`。
- 工具失败会记录状态、错误信息和执行耗时。

## 3. 调用者角色

| 角色 | 用途 |
|---|---|
| `agent` | LLM Agent 在教学流程中调用 |
| `ui` | 本地页面应用调用 |
| `system` | 领域服务、迁移、维护任务调用 |

`get_mistake` 仅在 `ui` 或 `system` 调用且显式请求时返回完整答案；`agent` 调用不返回完整解析。

## 4. 工具清单

| 工具 | 权限 | 允许调用者 | 幂等键 | 主要副作用 |
|---|---|---|---|---|
| `search_knowledge` | 只读 | agent、ui、system | 可选 | 无 |
| `get_mistake` | 只读 | agent、ui、system | 可选 | 无 |
| `get_due_reviews` | 只读 | agent、ui、system | 可选 | 无 |
| `create_mistake_draft` | 草稿写入 | agent、ui | 必须 | 创建待确认草稿 |
| `save_mistake` | 正式写入 | agent、ui | 必须 | 创建正式错题并关闭草稿 |
| `update_mistake` | 正式写入 | agent、ui | 必须 | 修改错题并记录修订历史 |
| `record_hint` | 证据写入 | agent、ui、system | 必须 | 保存提示事件 |
| `submit_attempt` | 受控执行 | agent、ui、system | 必须 | 保存作答并更新掌握进度 |
| `build_learning_summary` | 只读 | agent、ui、system | 可选 | 汇总学习情况 |

## 5. 工具输入与输出

### 5.1 `search_knowledge`

| 输入 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `query` | string | 是 | 1～500 字符 |
| `knowledgePoint` | string | 否 | 知识点标准名称，最多 100 字符 |
| `limit` | integer | 否 | 1～5，默认 3 |

输出：

- `items`：匹配的知识点、核心概念、提示、步骤、常见错误和来源。
- `count`：返回条数。

当前检索基于本地知识点目录和规则内容，后续 M5 替换为正式知识库检索。

### 5.2 `get_mistake`

| 输入 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `mistakeId` | integer | 是 | 正整数 |
| `includeSolution` | boolean | 否 | 默认 false；Agent 调用时强制不返回解析 |

输出：错题、状态、知识点、错误类型、复习信息和小问结构。Agent 调用时不包含小问标准答案与解析。

### 5.3 `get_due_reviews`

| 输入 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `limit` | integer | 否 | 1～20，默认 5 |

输出：

- `items`：到期错题列表，不包含完整答案。
- `count`：返回条数。

### 5.4 `create_mistake_draft`

| 输入 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `question` | string | 是 | 1～3000 字符 |
| `studentAnswer` | string | 否 | 最多 1000 字符 |
| `correctAnswer` | string | 条件必填 | 单答案兼容字段，1～1000 字符 |
| `analysis` | string | 否 | 最多 3000 字符 |
| `knowledgePoint` | string | 否 | 必须存在于知识目录 |
| `errorType` | string | 否 | 最多 100 字符 |
| `parts` | array | 条件必填 | 多小问结构；与 `correctAnswer` 至少提供一个 |

输出：

- `draftId`
- `status`
- `knowledgePoint`
- `errorType`
- `diagnosis`
- `parts`
- `expiresAt`

草稿 24 小时后过期。

当调用者为 `agent` 时，返回的小问结构不包含 `acceptedAnswers` 和 `explanation`；只有 `ui` 调用者可以用于答案校对与表单回填。

### 5.5 `save_mistake`

| 输入 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `draftId` | string | 是 | 有效草稿编号 |
| `confirmed` | boolean | 是 | 必须为 true |

输出：

- `mistakeId`
- `alreadySaved`

`save_mistake` 不向 Agent 返回完整答案、解析或提示内容。调用方需要展示题目时，应再次调用受答案门控的 `get_mistake`。

同一草稿最多生成一道正式错题。草稿已经保存时再次调用返回同一错题。

`save_mistake` 不接受 `parts` 参数；它从已确认草稿继承完整小问结构，避免确认后又绕过草稿直接修改答案。

### 5.6 `record_hint`

| 输入 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `mistakeId` | integer | 是 | 正整数的有效错题 |
| `hintLevel` | integer | 是 | 0～4 |
| `content` | string | 是 | 1～3000 字符 |
| `source` | string | 否 | 最多 100 字符 |
| `partId` | integer | 否 | 必须属于当前错题的小问 |

输出：`hintEventId`、`mistakeId`、`hintLevel` 和时间。

传入 `partId` 时，服务端必须验证该小问属于 `mistakeId`；校验失败不会写入提示记录。

### 5.7 `submit_attempt`

| 输入 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `mistakeId` | integer | 是 | 正整数的有效错题 |
| `answer` | string | 条件必填 | 单答案兼容字段，可为空 |
| `answers` | array | 条件必填 | 每项包含 `partId` 和 `value`；与 `answer` 至少提供一个 |
| `independent` | boolean | 否 | 无法判断时省略并保存为 NULL |
| `hintLevel` | integer | 否 | 0～4 |

输出：

- `correct`
- `mastered`
- `feedback`
- `answer`
- `analysis`
- `partResults`：每个小问的作答、结果和可接受答案
- `correctPartCount`
- `totalPartCount`
- 整题 `outcome`：`correct`、`partial` 或 `incorrect`
- `nextReviewAt`
- 更新后的错题状态

最终答案由确定性规则校验；M3 后再增加 LLM 步骤评价。

服务端必须拒绝不属于当前错题或重复出现的 `partId`，且校验失败前不得写入作答记录。只有 `independent=true` 的全对作答才累计掌握次数。

### 5.8 `update_mistake`

| 输入 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `mistakeId` | integer | 是 | 正整数的有效错题 |
| `question` | string | 否 | 修改后的题目，1～3000 字符 |
| `studentAnswer` | string | 否 | 最多 1000 字符 |
| `correctAnswer` | string | 否 | 修改后的正确答案，1～1000 字符 |
| `analysis` | string | 否 | 最多 3000 字符 |
| `knowledgePoint` | string | 否 | 必须存在于知识目录 |
| `errorType` | string | 否 | 1～100 字符 |
| `parts` | array | 否 | 修改后的小问数组 |

至少提供一个需要修改的字段。输出仅包含：

- `mistakeId`
- 新修订版本 `revision`
- 实际变更字段 `changedFields`
- 是否重置学习进度 `learningReset`

修改 `question`、`correctAnswer` 或 `knowledgePoint` 时，将错题恢复为待复习，连续答对次数和当前复习计数归零。历史作答记录和修改前内容保留在审计表中。Agent 不会从该工具获得答案或解析。

HTTP 编辑流程使用以下门控：

- `POST /api/mistakes/:id/edit-session`：显式确认后签发两分钟有效、只可使用一次的编辑令牌。
- `GET /api/mistakes/:id/edit`：必须携带 `X-Edit-Session`，否则返回 403。
- `GET /api/review/:id` 和 `GET /api/review/next` 会签发本轮复习会话。
- 复习上下文申请令牌时，本轮复习会话必须已提交作答；历史作答不能解锁当前复习，否则返回 409。
- 复习页在本次作答完成前不显示“修改题目”入口。

### 5.9 `build_learning_summary`

| 输入 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `from` | string | 否 | ISO 时间，默认最近 7 天 |
| `to` | string | 否 | ISO 时间，默认当前时间 |
| `knowledgePoint` | string | 否 | 只汇总指定知识点 |

输出：

- 汇总时间范围
- 错题、活跃错题和已掌握错题数量
- 作答、正确作答和独立正确作答数量
- 查看提示次数
- 按知识点拆分的统计

该工具不返回正确答案、解析或具体作答文本。

## 6. M2.2 多小问与多答案契约

本节描述已完成验收的工具契约。单答案字符串继续作为兼容路径保留。

### 6.1 数据结构

一道题的数据由整题和多个小问组成：

```text
mistake
  ├── part 1：名称、题干、答案类型、比较规则
  │     └── accepted answers：该小问的等价答案变体
  └── part 2：名称、题干、答案类型、比较规则
        └── accepted answers：该小问的等价答案变体
```

必须区分：

- 不同小问：具有独立的空位、答案和判题结果。
- 答案变体：同一个空位可接受的等价表达，例如 `3/4`、`0.75`、`75%`。

不能继续使用 `答案A或答案B` 同时表达多个小问。

### 6.2 小问字段

`create_mistake_draft` 和 `update_mistake` 接收 `parts` 数组。`save_mistake` 不接收 `parts`，而是从通过确认的草稿继承小问结构。

客户端输入的每个小问至少包括：

- `label`：例如“工作效率比”
- `prompt`：小问题干
- `answerType`：文本、数值、分数、百分数、比等
- `comparisonRule`：精确匹配、数值等价、比等价、单位处理
- `knowledgePoint`
- `acceptedAnswers`

客户端不得传入 `partNo` 或 `partId`。服务端根据 `parts` 数组顺序生成 `partNo`，并在持久化后返回 `partId`；这些是输出字段，不是输入字段。

### 6.3 `submit_attempt` 分项作答

单答案兼容输入：

```text
answer: string
```

分项答案输入：

```text
answers: [
  { partId, value },
  { partId, value }
]
```

返回结果增加：

- `partResults`：每个小问是否正确、学生原答案和反馈
- `correctPartCount`
- `totalPartCount`
- 整题 `outcome`：`correct`、`partial` 或 `incorrect`

规则：

- 全部小问正确：`correct`
- 至少一个小问正确但并非全部：`partial`
- 全部错误：`incorrect`
- 整题连续两次所有小问独立答对，才标记为掌握

### 6.4 兼容规则

- 现有单答案错题迁移为一个默认小问。
- 新工具契约正式启用前，旧的单答案接口继续可用。
- 旧作答记录保留为整题作答；新分项记录写入 `attempt_part_results`。
- Agent 在作答前只能看到小问结构和提示，不能看到任一小问的标准答案。

## 7. 错误码

| 错误码 | 含义 |
|---|---|
| `TOOL_NOT_FOUND` | 工具名称不存在 |
| `PERMISSION_DENIED` | 调用者没有权限 |
| `INVALID_ARGUMENTS` | 输入或输出不符合 Schema |
| `IDEMPOTENCY_REQUIRED` | 写入工具缺少幂等键 |
| `IDEMPOTENCY_CONFLICT` | 相同幂等键使用了不同参数 |
| `NOT_FOUND` | 指定实体不存在 |
| `DRAFT_EXPIRED` | 草稿已过期 |
| `CONFLICT` | 相同调用正在执行或此前失败 |
| `TOOL_TIMEOUT` | 工具执行超过配置时限 |
| `INTERNAL_ERROR` | 未预期的内部错误 |

## 8. 审计字段

每次工具执行记录：

- Agent 运行编号
- 工具名称
- 参数 JSON
- 结果 JSON
- 执行状态
- 延迟毫秒数
- 错误信息
- 幂等键
- 创建和更新时间

工具日志保存在本地 SQLite，不包含 API Key。图片和文件内容将在 M9 按附件规则单独处理。
