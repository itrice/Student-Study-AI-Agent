# 小步数学 · 六年级错题教练

一个面向六年级学生的数学错题学习 MVP。它不以“快速给答案”为目标，而是通过错题定位薄弱知识点，再让学生独立重做，直到能够稳定掌握。

## 当前版本

- 记录题目、原答案、正确答案、订正记录和主要错因。
- 根据题干关键词自动判断六年级数学知识点。
- 按“未复习 → 练习中 → 已掌握”管理错题。
- 每日优先安排当前不会的题；复习时先作答，卡住后再给提示和步骤。
- 连续两次独立答对后标记为掌握，并安排 7 天后回顾。
- 按知识点聚合错题数量、复习状态与掌握度。
- 数据默认保存在本机 SQLite 文件，不依赖云服务。

当前诊断由可解释的本地规则完成，适合验证学习闭环。项目下一阶段将按照
[实施计划](docs/IMPLEMENTATION_PLAN.md)逐步接入 LLM、受控工具调用和可检索知识库。

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
src/server.js        零依赖 HTTP API 与静态页面服务
test/                规则与学习数据流程测试
docs/MVP.md          首版产品范围与验收标准
docs/IMPLEMENTATION_PLAN.md
                     项目实施基线、阶段计划与验收门禁
docs/IMPLEMENTATION_STATUS.md
                     表格化实施进度、完成日期和验证证据
```

## 重要限制

- 目前是单学生、本机应用，没有账号和权限隔离。
- 错题需要手动录入，暂未接入拍照识别。
- 规则诊断依赖常见题干关键词，复杂应用题可能归入“综合应用”。
- 答案判断支持精确文本、简单数值、分数、小数和百分数互换，尚不能检查完整解题过程。

后续开发严格按 [实施计划](docs/IMPLEMENTATION_PLAN.md) 分阶段推进。当前规则诊断会保留为模型失败时的降级方案和可确定性验证器。
