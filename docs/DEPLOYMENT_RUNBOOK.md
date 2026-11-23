# Docker 与 K3s 部署手册

本文说明本项目的 K3s CI/CD 部署，以及现有 Docker Compose 手工部署、数据备份和回滚。

核心原则：

- 应用以 Docker 镜像运行；
- SQLite 数据库和附件保存在持久卷；
- 升级只替换镜像和容器，不删除数据；
- 每次更新前生成可校验的一致性备份；
- 出现问题时优先保留现场，再按备份和旧镜像回滚。

## 0. GitHub Actions 部署到 K3s

仓库根目录的 `.github/workflows/ci-cd.yml` 按 Pull Request、构建和部署分阶段执行：

1. Pull Request 和 `dev`、`qa`、`main` 分支推送先验证三套 manifests 并运行 `pnpm test`。
2. `dev`、`qa`、`main` 推送均构建 Dockerfile，将镜像以提交 SHA 标签推送到 GHCR。
3. 自托管 Runner 按分支选择对应 K3s 环境，使用镜像 digest 部署，等待 Deployment rollout
   并运行健康检查。
4. 更新已有 Deployment 前，通过应用内备份脚本创建并校验学习数据备份；首次部署跳过。
5. rollout 或 smoke test 失败时，工作流尝试回滚 Deployment。

### 环境和分支

| Git 分支 | GitHub Environment | K3s Namespace | Ingress 主机名 | PVC |
| --- | --- | --- | --- | --- |
| `dev` | `dev` | `student-study-ai-agent-dev` | `student-study-ai-agent-dev.home.arpa` | 2Gi |
| `qa` | `qa` | `student-study-ai-agent-qa` | `student-study-ai-agent-qa.home.arpa` | 2Gi |
| `main` | `production` | `student-study-ai-agent` | `student-study-ai-agent.home.arpa` | 10Gi |

推荐变更路径为 feature 分支 → PR 到 `dev` → 验证后 PR 到 `qa` → 验收后 PR 到 `main`。
合并到对应分支会自动部署该环境。可在 GitHub 仓库的 Environments 中配置 `qa`、
`production` 的 required reviewers 和分支限制；`dev` 通常不需要人工审批。
Kustomize 共用 `deploy/k8s/base`，环境差异放在
`deploy/k8s/overlays/dev`、`qa`、`prod`。

### 首次启用前

1. 在 GitHub 仓库启用 Actions，并允许工作流使用 `GITHUB_TOKEN` 写入 Packages（镜像地址为
   `ghcr.io/itrice/student-study-ai-agent`）。工作流不需要额外的 registry 密码。
2. 在可以访问 K3s API 的 Linux 主机注册 GitHub Actions self-hosted Runner，标签需包含
   `Student-Study-AI-Agent-Runner`；Runner 上安装并配置支持 Kustomize 的 `kubectl` 和 `jq`，其 kubeconfig 身份
   需能创建 Namespace、Secret、PVC、Deployment、Service 和 Ingress。部署 Job 的标签可
   在 workflow 中调整。
3. 确认 K3s 有可用的默认 StorageClass。当前 PVC 请求 10Gi、`ReadWriteOnce`，未固定
   StorageClass；按本地存储容量和备份策略调整
   `deploy/k8s/base/pvc.yaml`。
4. Ingress 使用 K3s 默认 Traefik。让局域网 DNS/hosts 将以下三个主机名解析到 Ingress
   节点；若集群未启用 Traefik，请调整 Ingress class/入口配置：
   `student-study-ai-agent-dev.home.arpa`、`student-study-ai-agent-qa.home.arpa`、
   `student-study-ai-agent.home.arpa`。
5. 如需使用 LLM/视觉模型，分别在三个 namespace 创建独立的
   `student-study-ai-agent-secrets` Secret。可从权限为仅当前用户可读的临时 env 文件导入，
   不要提交真实密钥：

   ```bash
   kubectl apply -f deploy/k8s/overlays/dev/namespace.yaml
   kubectl apply -f deploy/k8s/overlays/qa/namespace.yaml
   kubectl apply -f deploy/k8s/overlays/prod/namespace.yaml
   for env in dev qa production; do
     case "$env" in
       dev) namespace=student-study-ai-agent-dev ;;
       qa) namespace=student-study-ai-agent-qa ;;
       production) namespace=student-study-ai-agent ;;
     esac
     kubectl -n "$namespace" create secret generic student-study-ai-agent-secrets \
       --from-env-file="/secure/path/${env}.env" \
       --dry-run=client -o yaml | kubectl apply -f -
   done
   ```

   将 `/secure/path/{dev,qa,production}.env` 替换成实际的受保护配置文件路径。未配置 Secret
   时应用仍可启动，但不会使用外部模型。GHCR 拉取凭据由部署工作流在每个 namespace
   自动创建/刷新为 `ghcr-pull` Secret。

### 部署约束与检查

- 应用固定为单副本：数据库是本地 SQLite，增加副本会造成多进程并发读写同一数据库。
- dev、QA、production 使用不同的 namespace 和 PVC，数据库、图片附件、备份均不共享。
  测试环境不应导入生产数据或生产密钥。
- 第一次部署会创建一块全新的 PVC，不会自动复制旧 Docker Compose 服务器上的数据库或附件。
  如需保留旧数据，先完成并校验迁移，再将流量切到 K3s；旧服务器数据不会被工作流删除。
- PVC 同时保存 SQLite、上传附件和备份。K3s 本地存储不等于备份；请另行设置定期异机备份，
  并验证恢复流程。流水线会在每次更新前生成一次备份，备份也会保留在 PVC 内；请监控
  容量并按需要配置清理/归档策略。
- 当前 Ingress 未配置 TLS，应用也没有内置账号体系。仅在可信局域网使用；不要直接暴露到公网。
- 合并/推送到 `dev`、`qa` 或 `main` 后，在 GitHub Actions 查看 Validate、Build、Deploy
  三个 Job。按目标环境检查：

  ```bash
  kubectl -n student-study-ai-agent-dev rollout status deployment/student-study-ai-agent
  kubectl -n student-study-ai-agent-dev get pods,svc,ingress,pvc
  kubectl -n student-study-ai-agent-dev port-forward service/student-study-ai-agent 3000:80
  ```

  然后访问 `http://127.0.0.1:3000/api/health`；QA、production 分别将命令中的 namespace
  换成 `student-study-ai-agent-qa`、`student-study-ai-agent`。也可通过对应 Ingress 主机名访问。

## 手工 Docker Compose 部署

以下章节保留既有单机 Compose/SSH 部署步骤；它与上面的 K3s CI/CD 是两种独立流程，
CI/CD 工作流不会调用 Compose 或 `scripts/deploy-remote.ps1`。

## 1. 部署架构

本项目只需要一个应用容器。SQLite 是随 Node 进程运行的嵌入式数据库，不需要再启动 MySQL/PostgreSQL 容器。

```text
宿主机
├── /var/www/student-start-ai-agent/     项目、Compose 配置、.env
│   └── data/
│       ├── learning.sqlite              生产数据库
│       ├── attachments/                 原图与裁剪派生图
│       └── backups/                     一致性备份
└── Docker 容器 student-start-ai-agent-app-1
    ├── /app/data <- bind mount 到宿主机 data/
    └── :3000
```

容器内数据库固定为 `/app/data/learning.sqlite`，实际文件位于 `DATA_DIR/learning.sqlite`。重建容器、更新镜像或删除容器都不会删除宿主机数据目录。

### 当前目标机配置

| 项目 | 当前值 |
| --- | --- |
| SSH 目标 | `deployer@192.168.1.66` |
| 项目目录 | `/var/www/student-start-ai-agent` |
| 数据目录 | `/var/www/student-start-ai-agent/data` |
| Compose 服务 | `app` |
| 容器名 | `student-start-ai-agent-app-1` |
| 应用地址 | `http://192.168.1.66:3000` |
| `DATA_DIR` | `/var/www/student-start-ai-agent/data` |
| `APP_PORT` | `3000` |
| `BIND_ADDRESS` | `0.0.0.0` |
| `APP_UID:APP_GID` | `1001:1001` |
| `IMAGE_TAG` | `3b4b2cc` |
| `APP_VERSION` | `package.json` 的 `version` | 可选覆盖；界面与健康接口显示此版本 |

当前版本没有内置账号隔离。`0.0.0.0:3000` 只适合可信局域网；公网访问必须经过带 TLS、鉴权和限流的反向代理或 API 网关。

## 2. 前置条件

1. 目标机已安装 Docker Engine 和 Docker Compose v2。
2. 部署账号 `deployer` 具备 Docker 权限。
3. 本地持有 SSH 私钥，通常为 `$HOME\.ssh\id_rsa_agent_deployer`。
4. 目标机项目目录和数据目录已创建。
5. 目标机 `.env` 已单独配置；它不进入镜像，也不会被部署脚本覆盖。

验证连接：

```powershell
ssh -i "$HOME\.ssh\id_rsa_agent_deployer" -o BatchMode=yes `
  deployer@192.168.1.66 "docker compose version"
```

首次准备目录和权限：

```bash
sudo mkdir -p /var/www/student-start-ai-agent/data
sudo chown -R deployer:deployer /var/www/student-start-ai-agent
sudo chmod 750 /var/www/student-start-ai-agent
```

容器用户必须能写入数据目录。查询宿主机部署用户 UID/GID：

```bash
id -u
id -g
```

目标机 `.env` 中的非敏感配置应为：

```dotenv
DATA_DIR=/var/www/student-start-ai-agent/data
APP_UID=1001
APP_GID=1001
APP_PORT=3000
BIND_ADDRESS=0.0.0.0
IMAGE_TAG=0.9
```

模型密钥等敏感配置只放在 `.env`，不得提交 Git、上传聊天或打印到日志。

## 3. 首次部署

目标机可访问代码仓库时：

```bash
cd /var/www/student-start-ai-agent
git clone https://github.com/itrice/Student-Study-AI-Agent.git .
```

目标机不能访问仓库时，使用本文第 4 节的部署脚本上传源码。脚本会排除 `.env`、`data`、`.git` 和 `node_modules`。

检查 Compose 展开结果：

```bash
cd /var/www/student-start-ai-agent
docker compose config
```

重点确认：

- 镜像为 `math-mistake-coach:0.9`；
- 容器用户为 `1001:1001`；
- `data/` bind mount 到 `/app/data`；
- 端口为 `0.0.0.0:3000 -> 3000`。

构建并启动：

```bash
docker compose build
docker compose up -d
curl -fsS http://127.0.0.1:3000/api/health
```

首次部署没有旧容器时不会自动备份；启动前应确认数据目录状态符合预期。

## 4. 日常更新部署

不要在目标机容器内直接改文件，也不要把生产数据库复制到本地后覆盖回去。部署使用 `origin/main` 的明确提交号，不使用浮动 `latest`。

### 4.1 本地获取并测试版本

```powershell
git fetch origin --prune
git log --oneline <上次部署提交>..origin/main
git diff --stat <上次部署提交>..origin/main
```

创建干净临时工作区，避免本地未提交文件进入部署包：

```powershell
$commit = git rev-parse origin/main
$worktree = Join-Path $env:TEMP "deploy-$($commit.Substring(0,7))"
git worktree add --detach $worktree origin/main
Set-Location $worktree
node --test
```

### 4.2 记录部署前数据基线

```bash
cd /var/www/student-start-ai-agent
docker compose exec -T app node -e \
  'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync("/app/data/learning.sqlite", { readOnly: true }); console.log(JSON.stringify({ mistakes: db.prepare("select count(*) c from mistakes").get().c, attachments: db.prepare("select count(*) c from attachments").get().c, attempts: db.prepare("select count(*) c from attempts").get().c, latest: db.prepare("select id, created_at from mistakes order by id desc limit 1").get() }));'
find data/attachments -type f | wc -l
```

保存错题数、附件记录数、附件文件数、作答数和最新错题 ID，部署后用于对比。

### 4.3 执行自动部署

在干净工作区执行：

```powershell
.\scripts\deploy-remote.ps1 `
  -SshKey "$HOME\.ssh\id_rsa_agent_deployer" `
  -Target deployer@192.168.1.66 `
  -RemoteDir /var/www/student-start-ai-agent `
  -AppUrl http://192.168.1.66:3000
```

有 npm 时可使用：

```powershell
npm run deploy:remote
```

脚本依次执行：

1. 本地 `node --test`；
2. 打包源码，排除 `.env`、`data`、`.git`、`node_modules`；
3. 上传目标机；
4. 对现有容器执行完整一致性备份；
5. 将旧镜像标记为 `math-mistake-coach:previous`；
6. 解压源码；
7. 构建新镜像，并允许构建阶段通过宿主网络访问 npm 源；
8. 使用新镜像的 Node 22 生产依赖运行完整测试；
9. `docker compose up -d --force-recreate`；
10. 等待健康检查通过。

### 4.4 标记新镜像

```bash
cd /var/www/student-start-ai-agent
docker tag math-mistake-coach:0.9 math-mistake-coach:<提交号前7位>
docker images --format '{{.Repository}}:{{.Tag}} {{.ID}}' \
  | grep -E 'math-mistake-coach:(0.9|previous|<提交号前7位>)'
```

约定：

- `0.9`：Compose 当前使用镜像；
- `<commit>`：本次部署的版本标签；
- `previous`：上一版镜像，用于应急回滚。

## 5. 部署后验证

### 5.1 容器和健康检查

```bash
cd /var/www/student-start-ai-agent
docker compose ps
curl -fsS http://127.0.0.1:3000/api/health
```

通过条件：

- 容器为 `healthy`；
- 健康接口返回 `ok: true`；
- `schemaVersion` 与数据库版本一致；
- `toolCount` 非零；
- 新增能力标志符合该版本预期；
- `build.version` 与 `package.json` 或 `APP_VERSION` 一致，
  `appVersion` 非空；
- 页面侧边栏和“系统配置 → 版本信息”显示同一版本与构建指纹。

### 5.2 数据一致性

重新执行 4.2 的查询。要求：

- 错题数量未减少；
- 附件记录和附件文件数量未减少；
- 最新错题 ID 和创建时间未异常变化；
- 无数据库迁移时，`schemaVersion` 与升级前一致；
- 如发生迁移，确认迁移前备份和迁移后完整性检查均成功。

### 5.3 API 和页面冒烟检查

```bash
for p in \
  /api/health \
  /api/health/ \
  /api/mistakes \
  /api/feedback/calendar?month=2026-11 \
  /api \
  /api-docs \
  /docs \
  /openapi.json; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:3000$p")
  printf '%s %s\n' "$code" "$p"
done
```

预期：

- 真实 API 路径返回 `200`；
- API 路径带尾斜杠也返回 `200`；
- `/api`、`/api-docs`、`/docs` 返回 `308` 并跳转到 `/api/docs`；
- `/openapi.json` 返回 `308` 并跳转到 `/api/openapi.json`；
- `/api/docs` 正常显示接口文档，接口数量与该版本 OpenAPI 契约一致。

页面检查地址：

- 首页：`http://192.168.1.66:3000`
- 错题：`http://192.168.1.66:3000/#mistakes`
- 学习反馈：`http://192.168.1.66:3000/#feedback`
- API 文档：`http://192.168.1.66:3000/api/docs`

浏览器冒烟检查只做页面加载和控制台错误检查，不提交真实作答，不调用写接口。

### 5.4 日志和备份

```bash
docker compose logs --since 5m --no-color 2>&1 \
  | grep -Ei 'error|exception|failed|unhandled' || true
ls -1dt data/backups/learning-backup-* | head -1
```

最新备份应包含 `manifest.json`、`learning.sqlite`、`attachments/` 及 SHA-256 校验信息。Node 的 `ExperimentalWarning: SQLite` 不是应用失败。

## 6. 手动备份

未使用自动部署脚本时，升级前手动执行：

```bash
cd /var/www/student-start-ai-agent
docker compose exec -T app node scripts/backup-learning-data.mjs
```

只备份数据库、不备份附件：

```bash
docker compose exec -T app node scripts/backup-database.mjs
```

不要直接复制正在写入的 `learning.sqlite`。完整备份脚本使用 SQLite 一致性快照，并校验附件和数据库记录是否一致。

## 7. 回滚

### 7.1 仅回滚程序镜像

适用于无数据库迁移、仅新版本程序存在缺陷的情况：

```bash
cd /var/www/student-start-ai-agent
docker tag math-mistake-coach:previous math-mistake-coach:0.9
docker compose up -d --force-recreate --no-build
curl -fsS http://127.0.0.1:3000/api/health
```

数据目录不动，不需要恢复数据库。

### 7.2 回滚程序并恢复数据

适用于迁移失败、数据异常或需要回到升级前完整状态。恢复会覆盖当前数据库和附件，执行前必须确认备份目录，并先保留当前数据副本。

```bash
cd /var/www/student-start-ai-agent
docker compose stop app
docker compose run --rm --no-deps app \
  node scripts/restore-learning-data.mjs \
  "/app/data/backups/<备份目录名>" --force
docker tag math-mistake-coach:previous math-mistake-coach:0.9
docker compose up -d --force-recreate --no-build
curl -fsS http://127.0.0.1:3000/api/health
```

恢复后重新执行第 5 节的数据和页面验证。

## 8. 禁止事项

- 禁止执行 `docker compose down -v`；
- 禁止删除 `/var/www/student-start-ai-agent/data`；
- 禁止提交或泄露 `.env`、SSH 私钥、模型密钥；
- 禁止用本地旧数据库覆盖生产数据库；
- 禁止同时运行 Docker 容器和直接 `node src/server.js` 写同一个 SQLite 文件；
- 禁止把正在使用的 SQLite 放在 SMB/NFS 网络共享或其他主机磁盘；
- 禁止未备份就执行恢复或破坏性接口。

## 9. 常见问题

### API 404

优先使用正式路径：

- `/api/docs`
- `/api/openapi.json`
- `/api/health`

`dbcc96f` 及之后版本已兼容 API 尾斜杠，并将 `/api`、`/api-docs`、`/docs` 重定向到 `/api/docs`。如果仍为 404，检查请求方法：写接口必须使用 `POST`/`PATCH`，不能使用浏览器默认的 `GET`。

### 容器不是 healthy

```bash
docker compose ps
docker compose logs --tail=100 --no-color
curl -v http://127.0.0.1:3000/api/health
```

健康检查失败时停止继续发布，保留日志和当前镜像，再按第 7 节回滚。

### 容器无法写入数据

```bash
id -u
id -g
ls -ld data data/attachments data/backups
```

确保 `.env` 的 `APP_UID`/`APP_GID` 与数据目录所有者一致，修正后重建容器。不要用 root 运行应用容器。

### 数据看似丢失

先停止写入并检查最新备份，不要重新初始化数据库，也不要先删除 WAL/SHM。确认备份目录后按 7.2 恢复。

## 10. 部署记录

| 日期 | Git 提交 | 镜像标签 | schemaVersion | 部署前数据 | 备份目录 | 结果 |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-11-18 | `3b4b2cc` + `sharp` 软件渲染修复 | `math-mistake-coach:3b4b2cc-swrender` | 13 | 23 错题 / 7 附件记录 / 8 附件文件 / 47 作答 | `learning-backup-2026-11-18T13-11-52-086Z-3150b8a5` | 217 项测试通过；健康、数据、版本显示与墨水屏检查通过 |
| 2026-11-17 | `dbcc96f` | `math-mistake-coach:dbcc96f` | 13 | 23 错题 / 7 附件 / 36 作答 | `learning-backup-2026-11-17T08-31-53-275Z-3df46386` | 健康检查通过 |
