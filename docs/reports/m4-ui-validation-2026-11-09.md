# M4 教学闭环验证记录

> 日期：2026-11-09
> 验收状态：M4 待验收
> 模型：DeepSeek `deepseek-chat`
> 证据数据库：[m4-evidence.sqlite](m4-evidence.sqlite)

## 本轮验收缺陷关闭情况

上一轮验收提出的问题均已补充实现和回归测试：

1. `/api/mistakes/:id` 和 `/api/review/:id` 不再返回标准答案、解析、提示步骤或小问答案变体；编辑流程单独使用受控会话。
2. 答案泄露检测扫描整段提示中的短答案、单字符文本、分数/小数/百分数等价表达、等比、比的前后顺序和常见长度单位别名，不再依赖“答案/结果/等于”等固定触发词。
3. 非数字单字符文本采用默认安全策略：出现答案字符时，除非当前分句明确只是在复述题目、已知、条件、图形、场地、队伍等信息，否则一律拦截。该策略不依赖“填写/写/选/是”等完成短语白名单。
4. 题目条件和解题过程中的数字会用于消歧，不会因答案恰好与已知条件相同而误判泄露。
5. `/api/mistakes/:id/edit` 必须携带服务端签发的一次性编辑会话令牌；未授权请求返回 403。
6. 复习页在作答前隐藏“修改题目”入口；复习上下文中的编辑会话要求至少完成一次作答，否则返回 409。
7. 错题列表的显式修正流程会先申请一次性授权，再回填答案；浏览器中已验证可正常打开编辑对话框。
8. 追问等级由服务端根据已记录提示计算，客户端传入的 `hintLevel` 不能提前解锁高级提示。
9. 作答的独立性和实际提示等级由服务端推导；存在未关联提示时，客户端伪造 `independent=true` 和 `hintLevel=0` 无效。
10. 最终答案正误、最终评价、逐小问状态和掌握证据以确定性校验器为准；模型冲突反馈会被丢弃。
11. 首次作答会在同一事务中关联此前的提示事件，`hint_events.attempt_id` 可追溯到具体作答。
12. 安全接口验证使用证据库临时副本，原始证据库在验证前后字节哈希保持一致。

## 可复核证据库

证据库使用合成测试数据，保留用于验收复核，不包含 API Key。

| 项目 | 实际值 |
|---|---|
| 数据库 | `docs/reports/m4-evidence.sqlite` |
| SHA-256（checkpoint 后） | `f226b59e6b5aae64b0ba7d00041b2ddf74db7044e34fd2dd629baafed82a59fb` |
| 错题 | `mistake_id = 1` |
| 提示事件 | `1, 2, 3, 4, 5` |
| 作答 | `attempt_id = 1` |
| 作答评价 | `attempt_evaluation_id = 1` |
| 模型 | `deepseek / deepseek-chat` |
| 提示版本 | `hint-v1`、`follow-up-v1` |
| 作答评价版本 | `attempt-evaluation-v1` |
| SQLite 完整性 | `ok` |

关键关联结果：

| 记录 | 结果 |
|---|---|
| 提示 1～4 | 等级为 1～4，来源均为 `llm` |
| 提示 5 | 追问记录，来源为 `follow_up` |
| 所有提示的 `attempt_id` | 均为 `1` |
| attempt 1 | `outcome=incorrect`、`hint_level=4`、`independent=0`、`evaluation_source=hybrid` |
| evaluation 1 | `outcome=incorrect`、`provider=deepseek`、`mastery_evidence=[]` |
| 六次 LLM 审计 | 全部为 `status=succeeded` |

## 复现命令

生成证据库（若文件已存在，脚本拒绝覆盖）：

```powershell
node scripts/m4-evidence.js
```

复核关键记录：

```powershell
node --input-type=module -e "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync('docs/reports/m4-evidence.sqlite',{readOnly:true}); console.log(db.prepare('SELECT id,mistake_id,attempt_id,hint_level,source FROM hint_events ORDER BY id').all()); console.log(db.prepare('SELECT id,outcome,hint_level,independent,evaluation_source FROM attempts').all()); console.log(db.prepare('SELECT id,attempt_id,outcome,provider,model,prompt_version,mastery_evidence_json FROM attempt_evaluations').all()); db.close();"
```

实际输出的核心字段：

```text
hint_events: (1,1,1,1,"llm"), (2,1,1,2,"llm"), (3,1,1,3,"llm"),
             (4,1,1,4,"llm"), (5,1,1,4,"follow_up")
attempts:    (1,"incorrect",4,0,"hybrid")
evaluations: (1,1,"incorrect","deepseek","deepseek-chat",
              "attempt-evaluation-v1","[]")
```

## HTTP 安全接口验证

运行：

```powershell
node scripts/verify-m4-api.js
```

实际结果：

```json
{
  "originalHashBefore": "f226b59e6b5aae64b0ba7d00041b2ddf74db7044e34fd2dd629baafed82a59fb",
  "originalHashAfter": "f226b59e6b5aae64b0ba7d00041b2ddf74db7044e34fd2dd629baafed82a59fb",
  "originalHashUnchanged": true,
  "healthSchemaVersion": 6,
  "reviewMistakeId": 1,
  "reviewLeakFields": [],
  "detailLeakFields": [],
  "listLeakFields": [],
  "editWithoutSession": {
    "status": 403
  },
  "reviewBeforeAttemptEdit": {
    "status": 409
  },
  "historicalAttemptDoesNotUnlockCurrentReview": {
    "status": 409
  },
  "authorizedEditHasCorrectAnswer": true,
  "editSessionIsSingleUse": true
}
```

验证脚本复制证据库到系统临时目录，HTTP 服务只打开副本；脚本还会比较验证前后原文件 SHA-256，确认证据库未被修改。验证结束后清理临时副本。

## 最新 3000 服务与浏览器验证

已停止占用 3000 端口的旧 Node 进程，并启动当前代码的新进程 `12100`。

- `/api/health` 返回 schema v6、9 个工具。
- 未带编辑会话请求 `/api/mistakes/4/edit` 返回 403；令牌重复使用同样返回 403。
- 即使该错题以前完成过作答，当前复习在提交前申请编辑会话仍返回 409。
- 显式申请编辑会话后可读取答案，令牌第二次使用返回 403。
- 页面加载 `/app.js?v=20261109-6`。
- 浏览器刷新后，复习页作答前不显示“修改题目”。
- 从错题列表点击“修改”可正常打开对话框，题目和可接受答案均已回填。

## 自动化验证

- `node --test`：60/60 通过。
- 覆盖“最后一格填写 2 / 0.75 / 2:12”等自然表述泄露，以及题目正常条件中的数字不误判。
- 覆盖文本单字符答案“圆”和“A”的默认安全策略，包括“写/选/是/最后空”及“题目最后一个空选 A”等表述，以及题目条件中同一字符不误判。
- 覆盖安全接口、错序比误判、提示顺序、追问等级伪造、独立掌握绕过、提示与作答关联、模型反馈冲突仲裁、模型失败降级和评价持久化。
- `git diff --check`：通过。

结论：M4 实现与自测完成，等待验收；M5 尚未开始。
