# 子鱼学习AI · 全学科学习伙伴

子鱼学习AI 是面向小学 3～6 年级与初中的全学科 AI 学习伙伴。它不以“快速给答案”为目标，而是通过错题定位薄弱知识点，再让学生独立重做，直到能够稳定掌握。

## 当前版本

- 记录题目、原答案、正确答案、订正记录和主要错因。
- 根据题干关键词自动判断六年级数学知识点。
- 按“待复习 → 练习中 → 需巩固 → 已掌握”四状态管理错题。
- 每日优先安排当前不会的题；复习时先作答，卡住后再给提示和步骤。
- 连续两次独立答对后标记为掌握，并按 7/14/30 天间隔安排回顾。
- 提供日总结、家长可读周报、掌握变化和提示依赖统计。
- 按知识点聚合错题数量、复习状态与掌握度。
- 九个受控学习工具，支持权限、Schema、幂等、硬超时和调用审计。
- 支持修改录错的题目、答案、知识点和订正记录，并保留修订历史。
- 支持一道题包含多个小问，为每个小问保存独立答案、可接受答案变体和判题结果。
- 支持拍照、相册和桌面粘贴录入图片题；原图保存在本机，SQLite 只保存元数据。
- 提供可选图片文字识别，识别结果必须由学生核对确认，失败时仍可保存图片 + 文字。
- 建立 12 个六年级数学知识点卡片、84 个知识片段和可追溯来源，支持别名与全文检索。
- 诊断、提示和作答评价只引用检索到的知识来源；覆盖不足时明确提示，不编造来源。
- 建立 90 条 M7 评测与安全样本，覆盖知识点识别、错因诊断、提示有效性、步骤评价和提示注入。
- 提供上下文长度、限流、模型异常降级、运营指标和全量学习数据删除能力。
- 数据默认保存在本机 SQLite 文件，不依赖云服务。

M3 已接入 OpenAI-compatible LLM 网关、知识检索工具和结构化诊断，真实 DeepSeek 模型 30/30 题自测已通过并完成验收；
本地规则继续作为模型未配置或调用失败时的降级方案。

M4 已通过整体验收：安全复习、分级提示、追问和 LLM 步骤评价均已交付并验证。

M5 已加入可发布知识库与检索：12 个知识点、来源引用、覆盖不足提示和 48 题检索评测
（含 12 道留出改写题）。Top-3 命中率 100%，Top-1 命中率 97.9%，验收者-ark 已复验通过。
知识内容为项目自编摘要，任课教师最终签字仍待完成。

M6 已通过验收：四状态掌握度与学习反馈、可追溯掌握证据、复习队列、日总结和周报均已交付。

M7 已加入评测、安全与稳定性能力：90 条已标注评测样本、提示注入识别、答案泄露扫描、
上下文超限保护、本地限流、模型异常降级、运营指标接口和全量学习数据删除接口。

M9.1 + M9.2 最小切片已完成：图片附件、人工裁剪、可选文字识别、人工确认、附件清理和
包含原图与裁剪图的备份恢复已可用。本轮不包含图形推理、复杂手写公式识别和多图批注。

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

运行 M7 评测与安全门禁：

```powershell
npm run evaluate:m7
```

M7 报告会写入 `docs/reports/m7-evaluation-2026-11-10.md` 和对应 JSON；
稳定性与安全清单见 `docs/reports/m7-stability-2026-11-10.md` 和 `docs/M7_SECURITY_CHECKLIST.md`。

评测报告会写入 `docs/reports/m5-knowledge-evaluation-2026-11-10.md` 和对应 JSON。

## 图片录题

在“录入错题”弹窗中可以直接拍照、从相册选择，或在桌面端把剪贴板里的图片粘贴到弹窗。
每道题最多 6 张，单张不超过 8 MB，支持 JPG、PNG 和 WebP；题目文字与图片至少填写一项。

图片卡片上的“裁剪”可以框出真正需要查看和识别的题目区域，支持拖动、八方向手柄、
90° 旋转和重置；保存后可“重新裁剪”或“查看原图”，也可以“恢复原图”回到整张图片。
裁剪不会覆盖原图，也不会重置掌握进度。

图片默认只保存在本机。需要自动识别文字时，先勾选同意，再点击“识别文字”；图片才会发送到
已配置的 OpenAI-compatible 视觉模型。识别结果只是候选文字，必须由学生核对并点击
“使用这段文字”后才回填，保存错题时才会正式写入。存在裁剪时只发送裁剪区域。

未配置视觉模型、识别失败或图片读取失败时，可以直接手动填写文字并保存图片，不阻断录题。
视觉模型配置、API 契约、文件限制和隐私边界见 [M9 图片录题说明](docs/M9_IMAGE_INTAKE.md)。

开发时自动重启：

```powershell
npm run dev
```

## Docker 部署

镜像只包含程序。SQLite 数据库不放进镜像，而是挂载到**运行容器的那台主机**的持久目录。
重建镜像、升级版本或删除容器都不会影响数据。

> 重要：SQLite 必须和容器运行在同一台主机上，并使用本地文件系统。不要把实时数据库
> 放在 SMB/NFS 网络共享、跨主机同步目录或另一台电脑的磁盘上。SQLite 的 WAL 和文件锁
> 在跨主机文件系统上不可靠，可能导致锁错误或数据损坏。
>
> 如果程序部署在服务器或 NAS 上，数据库就挂载在那台服务器/NAS 的本地磁盘。
> 本机可以通过备份文件获取数据，但不要直接挂载正在使用的数据库。

### 数据库放容器内还是容器外？

| 位置 | 升级/重建容器后 | 直接备份 | 结论 |
| --- | --- | --- | --- |
| 镜像层 | 丢失 | 不能 | 禁止 |
| 容器可写层 | 通常丢失 | 困难 | 不要 |
| Docker 命名卷 | 保留 | 需要 Docker 命令 | 可用 |
| 宿主机目录（bind mount） | 保留 | 直接复制或运行备份脚本 | 推荐 |

本项目默认使用宿主机目录：容器内路径是 `/app/data/learning.sqlite`，
实际文件在 `${DATA_DIR}/learning.sqlite`。升级时只替换镜像和容器，数据目录不动。

本项目只需要一个应用容器。SQLite 是嵌入式数据库，随 Node 进程运行，不需要再启动
MySQL/PostgreSQL 容器；数据库文件通过目录挂载放在容器外。

### 目标主机准备

1. 安装 Docker Engine 和 Docker Compose。Windows/macOS 可用 Docker Desktop，
   Linux 使用发行版仓库或 Docker 官方仓库。
2. 准备固定的数据目录，放在项目目录之外：
   - Linux：`/srv/math-coach-data`
   - Windows：`D:/math-coach-data`
3. Linux 主机需要让运行容器的 uid/gid 对数据目录可写。默认容器用户是 uid 1000；
   如果宿主机登录用户不是 1000（例如 `deployer` 是 1001），用 `id -u` / `id -g`
   查询后写入 `.env` 的 `APP_UID` / `APP_GID`：

   ```bash
   sudo mkdir -p /srv/math-coach-data
   sudo chown -R "$(id -u):$(id -g)" /srv/math-coach-data
   ```

4. 在目标主机的项目目录准备 `.env`（从 `.env.example` 复制），填写模型参数，
   再追加数据目录和端口配置：

   ```dotenv
   DATA_DIR=/srv/math-coach-data
   APP_PORT=3000
   BIND_ADDRESS=127.0.0.1
   IMAGE_TAG=0.9
   APP_UID=1000
   APP_GID=1000
   ```

   Windows 主机的路径写成 `D:/math-coach-data`。如果前面有反向代理，保持
   `BIND_ADDRESS=127.0.0.1`；需要局域网直接访问时改为 `0.0.0.0`，并确认网络可信。
   当前版本没有账号隔离，不建议直接暴露到公网。

   `IMAGE_TAG` 建议使用明确的版本号，不要长期使用 `latest`。升级时保留旧标签，
   回滚会更容易。

5. 在目标主机构建并启动：

   ```bash
   docker-compose up -d --build
   # 使用 Docker Compose v2 时：
   docker compose up -d --build
   ```

6. 访问 `http://<目标主机IP>:<APP_PORT>`，或通过反向代理访问。

容器内数据库固定为 `/app/data/learning.sqlite`，对应 `DATA_DIR/learning.sqlite`。
迁移前的一致性备份会写入 `DATA_DIR/backups/`。

### 把镜像带到另一台机器

按目标环境选择一种：

- 目标机可以访问代码仓库：`git clone` 或 `git pull` 后直接
  `docker compose up -d --build`。
- 目标机不能构建：在开发机执行 `docker build -t math-mistake-coach:0.9 .`，
  然后 `docker save -o math-coach-0.9.tar math-mistake-coach:0.9`；
  复制到目标机后执行 `docker load -i math-coach-0.9.tar`，再用 Compose 启动。
- 有镜像仓库：把镜像推送到 GHCR/私有 registry，目标机执行
  `docker compose pull` 后 `docker compose up -d`。

`.env` 不会进入镜像（`.dockerignore` 已排除），需要在目标主机单独提供并妥善保管。

### 升级

```bash
git pull
docker-compose build
docker-compose up -d --force-recreate
```

重建同一镜像标签后，Compose 不一定会自动替换正在运行的容器；`--force-recreate`
确保新镜像生效。如果每次发布使用新的 `IMAGE_TAG`，执行 `docker compose up -d`
即可，因为镜像名已变化。使用镜像仓库或离线 tar 包时同理。
数据库文件在宿主机目录中，重建镜像和容器不会删除。启动时程序按版本执行迁移，
迁移前会自动把一致性备份写入 `DATA_DIR/backups/`。不要使用
`docker-compose down -v`，也不要删除数据目录。

升级前建议做包含原图的完整备份：

```bash
docker-compose exec app node scripts/backup-learning-data.mjs
```

本地运行时等价命令是 `npm run backup`。完整备份包含 SQLite `VACUUM INTO` 一致性快照、
附件目录和带 SHA-256 的 `manifest.json`。只需要数据库、不需要原图时，可使用
`npm run backup:db` 或 `node scripts/backup-database.mjs`。

恢复前必须停止服务。完整恢复命令为：

```powershell
npm run restore -- <备份目录>
npm run restore -- <备份目录> --force
```

`--force` 会覆盖现有数据库和附件目录。恢复脚本会先校验数据库和每个附件，再执行替换。

### Windows 一键更新

在项目根目录执行：

```powershell
.\scripts\deploy-remote.ps1
# 如果本机有 npm，也可以：
npm run deploy:remote
```

脚本会依次执行：本地测试 → 打包（排除 `.env`、`data`、`.git`）→ 上传 →
目标机部署前备份 → 构建镜像 → `up -d --force-recreate` → 健康检查。
默认目标是 `deployer@192.168.1.66:/var/www/student-start-ai-agent`，
可用参数覆盖：

```powershell
.\scripts\deploy-remote.ps1 `
  -Target deployer@host `
  -RemoteDir /srv/math-coach-app `
  -AppUrl http://host:3000
```

只同步代码、跳过本地测试时加 `-SkipTests`。脚本会把上一版镜像标记为
`math-mistake-coach:previous`，便于应急回滚。

### 回滚

数据库迁移是单向的：新版本数据库不能再被旧版本程序打开，旧镜像会拒绝启动。
需要回滚时：

1. 停止容器：`docker-compose down`
2. 把 `DATA_DIR/backups/` 中升级前的备份复制为 `learning.sqlite`
3. 删除同目录下的 `learning.sqlite-wal` 和 `learning.sqlite-shm`
4. 使用旧版本镜像启动

### 与本地 node 启动共存

开发时也可以不用 Docker：`git pull` 后直接运行 `node src/server.js`。两种方式可以
共用同一个数据目录，但不要同时启动，避免两个进程同时写同一个 SQLite 文件。

## 数据位置

默认数据库为 `data/learning.sqlite`，已加入 `.gitignore`。可通过环境变量覆盖：

```powershell
$env:DB_PATH = "D:\learning-data\math.sqlite"
npm start
```

原图默认保存在数据库同级的 `data/attachments/`，只保存随机文件名，不把磁盘路径写入数据库或
普通日志。可以用 `ATTACHMENTS_DIR` 指定附件目录，用 `BACKUP_DIR` 指定完整备份根目录；
三个目录都应在本地文件系统上，并随数据库一起保护和备份。

当已有数据库需要升级时，程序会在执行迁移前将一致性备份写入
`data/backups/`，并对备份执行 SQLite 完整性检查。迁移按版本执行，重复启动不会重复变更数据库。
Docker 部署时数据库位置由 `docker-compose.yml` 中的 `DB_PATH` 和
`${DATA_DIR:-./data}:/app/data` 挂载共同决定，数据实际保存在宿主机的 `DATA_DIR` 中。

首次进入空错题库时，页面可载入 5 道六年级数学示例题，便于体验完整复习流程。

## 错题搜索

- “我的错题”页顶部支持即时搜索，匹配题干、知识点、错因以及小问名称/小问题干。
- 多个关键词用空格分隔，全部命中才显示；英文搜索忽略大小写。
- 搜索与状态筛选联动，筛选计数按搜索结果更新；搜索或清除后自动回到第 1 页。
- 搜索在已加载的错题数据上完成，不额外请求服务端；单学生错题超过 500 条时评估服务端搜索与分页。

## 错题列表分页

- 手机（≤560px）每页 5 条，平板（≤1100px）每页 8 条，桌面每页 10 条。
- 翻页后焦点落在首条错题；页码变化通过 `aria-live` 播报；禁用按钮同时设置
  `disabled` 与 `aria-disabled`。
- 吸底分页栏在宽度 ≤900px 或高度 ≤860px 时启用，并为列表预留等高的底部空白。
- 页面尺寸变化时按“当前首条错题”换算页码；切换筛选、删除错题后自动收敛到有效页。
- 当前为客户端分页，一次加载全部错题。单学生错题超过 500 条时评估服务端分页；
  超过 1000 条必须改为服务端分页。

## 项目结构

```text
public/              无构建步骤的网页界面
src/agent.js         知识点识别、错因诊断与答案等价判断
src/attachments.js   图片魔数校验、限制、文件存储和孤儿文件清理
src/attachment-service.js
                     可选视觉识别、同意校验和失败降级
src/attachment-crop.js
                     裁剪元数据校验、派生图落盘和失败回滚
src/database.js      错题、复习记录、学习统计和 SQLite 访问
src/migrations.js    版本化数据库迁移、基线和完整性校验
src/knowledge/       知识点内容卡片、全文检索、覆盖判断和检索评测
src/evaluation/      M7 评测集、离线评测运行器和质量门槛
src/security/        不可信输入识别与提示注入检测
src/llm/vision.js    OpenAI-compatible 视觉文字转录适配器
src/server.js        零依赖 HTTP API 与静态页面服务
src/tools/           工具注册、Schema 校验、权限、幂等和审计
test/                规则与学习数据流程测试
docs/MVP.md          首版产品范围与验收标准
docs/TOOL_CONTRACTS.md
                     九项受控工具的输入、输出、权限和错误契约
docs/M9_IMAGE_INTAKE.md
                     图片附件、人工裁剪、识别确认、附件生命周期和备份恢复契约
docs/LLM_SETUP.md    LLM 环境配置、诊断链路和降级策略
docs/KNOWLEDGE_BASE.md
                     知识库结构、来源、检索策略和扩展方式
docs/KNOWLEDGE_REVIEW_CHECKLIST.md
                     知识内容审核清单与逐知识点审核登记
docs/UI_ACCEPTANCE_CHECKLIST.md
                     UI 字号、可读性、缩放和交互验收清单
docs/M7_SECURITY_CHECKLIST.md
                     M7 安全测试清单与发布门禁
docs/reports/m7-evaluation-2026-11-10.md
                     M7 质量指标、评测明细和发布门禁
docs/reports/m7-stability-2026-11-10.md
                     M7 稳定性、运营指标和数据删除报告
docs/reports/m5-knowledge-evaluation-2026-11-10.md
                     M5 知识点 Top-3 命中率和来源覆盖评测
docs/reports/ui-readability-2026-11-10.md
                     UI 字号与缩放可读性自测记录
docs/reports/m4-ui-validation-2026-11-09.md
                     M4 真实模型教学闭环验证记录
docs/IMPLEMENTATION_PLAN.md
                     项目实施基线、阶段计划与验收门禁
docs/IMPLEMENTATION_STATUS.md
                     表格化实施进度、完成日期和验证证据
scripts/learning-backup.mjs
                     数据库 + 附件一致性备份与恢复实现
```

## 重要限制

- 目前是单学生、本机应用，没有账号和权限隔离。
- 图片题支持原图保存、人工矩形裁剪和可选文字转录，尚不做图形推理、复杂手写公式识别或多图批注。
- 规则诊断依赖常见题干关键词，复杂应用题可能归入“综合应用”。
- 知识库内容为项目自编摘要，不是教材原文；任课教师最终复核尚未完成。
- 答案判断支持精确文本、简单数值、分数、小数和百分数互换，尚不能检查完整解题过程。
- 真实模型自测已完成；多供应商兼容性和成本仍需在 M7 评测阶段继续验证。

后续开发严格按 [实施计划](docs/IMPLEMENTATION_PLAN.md) 分阶段推进。当前规则诊断会保留为模型失败时的降级方案和可确定性验证器。
