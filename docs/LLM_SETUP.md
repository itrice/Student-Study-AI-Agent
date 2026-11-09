# LLM 接入与诊断

> 实现状态：M3 待验收：真实模型 30 题自测已完成
> 接口形态：OpenAI-compatible Chat Completions
> 降级策略：本地可解释规则

## 1. 配置

项目不保存 API Key。运行前通过环境变量配置：

| 变量 | 必填 | 说明 |
|---|---|---|
| `LLM_BASE_URL` | 是 | 兼容接口地址，不包含 `/chat/completions` |
| `LLM_API_KEY` | 是 | API Key，不得写入仓库或日志 |
| `LLM_MODEL` | 是 | 支持 Chat Completions 和工具调用的模型名称 |
| `LLM_PROVIDER` | 否 | 供应商标识，默认 `openai-compatible` |
| `LLM_TIMEOUT_MS` | 否 | 单次请求超时，默认 30000 |
| `LLM_MAX_RETRIES` | 否 | 可重试错误的最大重试次数，默认 2 |
| `LLM_MAX_OUTPUT_TOKENS` | 否 | 最大输出 Token，默认 1200，范围 1～8192 |
| `LLM_TEMPERATURE` | 否 | 温度，默认 0.2，范围 0～2 |
| `LLM_STREAM` | 否 | 是否启用 SSE 流式响应，默认 false |

PowerShell 示例：

```powershell
$env:LLM_BASE_URL = "https://api.openai.com/v1"
$env:LLM_API_KEY = "<your-api-key>"
$env:LLM_MODEL = "<your-model>"
node src/server.js
```

启动时项目会自动读取根目录 `.env`，已有系统环境变量优先，不会被文件覆盖。`.env` 已加入 `.gitignore`；`.env.example` 只包含占位符，不应填写真实密钥后提交。

## 2. 诊断链路

```text
录题页面
  → 调用 search_knowledge 工具
  → LLM 可继续请求知识工具
  → 输出结构化诊断 JSON
  → Schema 校验和最多一次格式修复
  → 页面展示知识点、错因和一级提示
  → 学生修改并确认
  → 保存错题和 diagnoses 审计记录
```

结构化诊断包含：

- 知识点
- 错误类型
- 可能出错步骤
- 缺失概念
- 初始提示
- 置信度
- 诊断依据
- 知识来源
- 多小问逐项分析

当输入包含多个小问时，`partAnalyses` 必须与小问数量一致，`partNo` 必须唯一且覆盖全部输入小问；缺失或错配时模型结果不能保存。

## 3. 接口

### `GET /api/ai/status`

返回模型是否配置、供应商、模型名称和超时。不会返回 API Key。

配置值超出范围时不会启动外部请求，状态接口会返回 `configurationErrors` 并使诊断自动降级。

### `POST /api/ai/test`

向模型发送最小连接测试。未配置时返回 `LLM_NOT_CONFIGURED`。

### `POST /api/diagnose`

执行知识检索和诊断。模型不可用时返回本地规则诊断，响应中的 `source` 标识为 `rules`。

## 4. 安全与失败边界

- 题目内容作为不可信数据传给模型，不能覆盖系统指令。
- 默认只为诊断发送当前题目、答案、订正记录和最多 3 条知识片段。
- 不把 API Key 写入数据库、前端或普通日志。
- 请求有超时、有限重试和最多 4 次工具轮次。
- 超时、重试、最大输出、温度和流式配置均有范围校验；非法配置不发起外部请求。
- 模型结果必须通过严格 JSON Schema。
- 模型不可用、限流、超时或格式错误时自动降级到本地规则。
- `llm_calls` 保存模型、提示版本、Token、延迟、状态和错误摘要。
- 只有学生确认并保存后，诊断才写入正式 `diagnoses` 记录。
- 诊断带有题目、答案、订正记录和小问结构的上下文哈希；输入变化后旧诊断不能保存。

## 5. 真实模型自测

- 供应商：DeepSeek
- 模型：`deepseek-chat`
- 题目：30 道六年级数学诊断题
- 通过：30/30
- 平均耗时：4732ms
- 报告：[JSON](reports/llm-self-test-2026-11-09T09-58-08-707Z.json) / [Markdown](reports/llm-self-test-2026-11-09T09-58-08-707Z.md)

## 6. 当前限制

- 未验证具体供应商的兼容性差异。
- 官方 OpenAI 文档在当前环境被 403/Cloudflare 拦截，兼容性结论不能在无凭据环境中最终确认。
- 模型选择、成本预算和真实诊断准确率需要在 M7 评测阶段完成。
