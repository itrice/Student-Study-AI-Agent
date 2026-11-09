# 小步数学 · 六年级错题教练

一个面向六年级学生的数学错题学习 MVP。它不以“快速给答案”为目标，而是通过错题定位薄弱知识点，再让学生独立重做，直到能够稳定掌握。

## 当前版本

- 记录题目、原答案、正确答案、订正记录和主要错因。
- 根据题干关键词自动判断六年级数学知识点。
- 按“未复习 → 练习中 → 已掌握”管理错题。
- 每日优先安排当前不会的题；复习时先作答，卡住后再给提示和步骤。
- 连续两次独立答对后标记为掌握，并安排 7 天后回顾。
- 按知识点聚合错题数量、复习状态与掌握度。
- 九个受控学习工具，支持权限、Schema、幂等、硬超时和调用审计。
- 支持修改录错的题目、答案、知识点和订正记录，并保留修订历史。
- 支持一道题包含多个小问，为每个小问保存独立答案、可接受答案变体和判题结果。
- 建立 12 个六年级数学知识点卡片、84 个知识片段和可追溯来源，支持别名与全文检索。
- 诊断、提示和作答评价只引用检索到的知识来源；覆盖不足时明确提示，不编造来源。
- 数据默认保存在本机 SQLite 文件，不依赖云服务。

M3 已接入 OpenAI-compatible LLM 网关、知识检索工具和结构化诊断，真实 DeepSeek 模型 30/30 题自测已通过并完成验收；
本地规则继续作为模型未配置或调用失败时的降级方案。

M4 已加入安全复习、分级提示、追问和 LLM 步骤评价，当前等待验收。

M5 已加入可发布知识库与检索：12 个知识点、来源引用、覆盖不足提示和 48 题检索评测
（含 12 道留出改写题）。Top-3 命中率 100%，Top-1 命中率 97.9%，验收者-ark 已复验通过。
知识内容为项目自编摘要，任课教师最终签字仍待完成。

LLM 未配置时系统自动使用本地规则；配置方式、诊断链路和安全边界见
[LLM 接入说明](docs/LLM_SETUP.md)。

根目录存在 `.env` 时，服务启动会自动加载；已有系统环境变量优先。

各阶段完成情况、完成日期和验证证据见
[实施进度表](docs/IMPLEMENTATION_STATUS.md)。

## 运行

需要 Node.js 22.5 或更高版本。

```powershell
npm start
```

打开 <http://127.0.0.1:3000>。项目没有第三方运行时依赖，不需要先执行 `npm install`。

如果当前环境没有提供 `npm` 命令，也可以直接运行：

```powershell
node src/server.js
```

运行测试：

```powershell
npm test
```

等价的直接运行方式是 `node --test`。

运行知识库检索评测：

```powershell
npm run evaluate:knowledge
```

评测报告会写入 `docs/reports/m5-knowledge-evaluation-2026-11-10.md` 和对应 JSON。

开发时自动重启：

```powershell
npm run dev
```

## 数据位置

默认数据库为 `data/learning.sqlite`，已加入 `.gitignore`。可通过环境变量覆盖：

```powershell
$env:DB_PATH = "D:\learning-data\math.sqlite"
npm start
```

当已有数据库需要升级时，程序会在执行迁移前将一致性备份写入
`data/backups/`，并对备份执行 SQLite 完整性检查。迁移按版本执行，重复启动不会重复变更数据库。

首次进入空错题库时，页面可载入 5 道六年级数学示例题，便于体验完整复习流程。

## 项目结构

```text
public/              无构建步骤的网页界面
src/agent.js         知识点识别、错因诊断与答案等价判断
src/database.js      错题、复习记录、学习统计和 SQLite 访问
src/migrations.js    版本化数据库迁移、基线和完整性校验
src/knowledge/       知识点内容卡片、全文检索、覆盖判断和检索评测
src/server.js        零依赖 HTTP API 与静态页面服务
src/tools/           工具注册、Schema 校验、权限、幂等和审计
test/                规则与学习数据流程测试
docs/MVP.md          首版产品范围与验收标准
docs/TOOL_CONTRACTS.md
                     九项受控工具的输入、输出、权限和错误契约
docs/LLM_SETUP.md    LLM 环境配置、诊断链路和降级策略
docs/KNOWLEDGE_BASE.md
                     知识库结构、来源、检索策略和扩展方式
docs/KNOWLEDGE_REVIEW_CHECKLIST.md
                     知识内容审核清单与逐知识点审核登记
docs/reports/m5-knowledge-evaluation-2026-11-10.md
                     M5 知识点 Top-3 命中率和来源覆盖评测
docs/reports/m4-ui-validation-2026-11-09.md
                     M4 真实模型教学闭环验证记录
docs/IMPLEMENTATION_PLAN.md
                     项目实施基线、阶段计划与验收门禁
docs/IMPLEMENTATION_STATUS.md
                     表格化实施进度、完成日期和验证证据
```

## 重要限制

- 目前是单学生、本机应用，没有账号和权限隔离。
- 错题需要手动录入，暂未接入拍照识别。
- 规则诊断依赖常见题干关键词，复杂应用题可能归入“综合应用”。
- 知识库内容为项目自编摘要，不是教材原文；任课教师最终复核尚未完成。
- 答案判断支持精确文本、简单数值、分数、小数和百分数互换，尚不能检查完整解题过程。
- 真实模型自测已完成；多供应商兼容性和成本仍需在 M7 评测阶段继续验证。

后续开发严格按 [实施计划](docs/IMPLEMENTATION_PLAN.md) 分阶段推进。当前规则诊断会保留为模型失败时的降级方案和可确定性验证器。
