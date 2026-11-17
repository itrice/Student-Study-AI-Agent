# 正式环境“接口不存在”诊断与安全升级

## 现象

正式环境修改题目后保存提示“接口不存在”，而 localhost 同一提交下复习页、错题列表、文本题和图片题保存均成功。该提示来自应用服务 `HttpError(404, "接口不存在", { code: "ROUTE_NOT_FOUND" })`，说明请求到达了错误版本的应用服务或错误路由，而不是普通前端拼写错误。

## 本机最小复现（隔离数据库）

```bash
# 1. 修改错题：兼容 POST 路由
curl -i -X POST http://127.0.0.1:3000/api/mistakes/8/update \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: repro-post-update' \
  --data '{"analysis":"验收复现：POST update"}'

# 2. 修改错题：PATCH 路由
curl -i -X PATCH http://127.0.0.1:3000/api/mistakes/8 \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: repro-patch' \
  --data '{"analysis":"验收复现：PATCH"}'
```

当前代码的预期结果：两条请求均返回 `200 application/json`，响应包含 `mistakeId`、`revision`、`changedFields`、`learningReset` 和更新后的 `mistake`。若 localhost 通过而正式环境仍返回 404，优先检查下列版本错配。

## 只读诊断（不修改正式机）

```bash
curl -fsS http://127.0.0.1:3000/api/health
```

新版本健康检查应包含：

- `schemaVersion`：当前为 13。
- `capabilities.mistakeUpdate.postUpdate`：`/api/mistakes/:id/update`。
- `capabilities.mistakeUpdate.patch`：`/api/mistakes/:id`。
- `build.server`、`build.appJs`、`build.indexHtml`：各 12 位 SHA-256 指纹，可分别与服务器源码和静态文件比对。
- `startedAt`：服务进程启动时间；若早于最近一次部署时间，说明容器没有真正重建。

若缺少 `capabilities` 或 `build`，正式实例仍在运行旧版本服务端。若 `build.appJs` 与当前静态文件不一致，说明静态资源和容器版本错配。若 `startedAt` 早于部署时间，说明部署命令未替换运行中的容器。

```bash
# 只读查看容器、镜像和日志
docker compose ps
docker compose images app
docker inspect --format '{{.Created}} {{.Image}}' "$(docker compose ps -q app)"
docker compose logs --tail=100 app

# 比对静态资源版本
curl -fsS http://127.0.0.1:3000/ | grep -o 'app.js?v=[^"]*'
curl -fsS http://127.0.0.1:3000/app.js | head -20
```

同时确认 3000 端口确实映射到目标 compose 项目，而不是另一份旧容器或反向代理：

```bash
docker compose port app 3000
docker ps --filter 'publish=3000'
```

## 安全升级步骤（由正式环境负责人执行）

现有 `scripts/deploy-remote.ps1` 已包含部署前备份、Node 22 测试、构建、强制重建、健康检查和上一版镜像保留。优先使用该流程：

```powershell
npm run deploy:remote
```

手工等价步骤：

```bash
cd /var/www/student-start-ai-agent
docker compose exec -T app sh -c 'node scripts/backup-learning-data.mjs'
previous_image=$(docker compose images -q app | head -1)
docker tag "$previous_image" math-mistake-coach:previous
docker compose build
docker compose up -d --force-recreate
curl -fsS http://127.0.0.1:3000/api/health
```

升级后应能在 `/api/health` 看到 `capabilities.mistakeUpdate` 和新的 `build` 指纹，且 `startedAt` 为本次重启时间。

## 回滚步骤

如果升级后健康检查失败或出现数据异常：

```bash
cd /var/www/student-start-ai-agent
docker tag math-mistake-coach:previous math-mistake-coach:local
docker compose up -d --force-recreate
curl -fsS http://127.0.0.1:3000/api/health
```

仅在数据库也确实需要回退时，使用升级前自动生成的备份：

```bash
docker compose exec -T app node scripts/restore-learning-data.mjs <备份目录> --force
```

恢复前先保留当前数据副本。不要在不确认备份目录的情况下执行恢复。

## 前端兼容行为

- 保存修改先请求 `POST /api/mistakes/:id/update`。
- 任意 404/405 均回退到 `PATCH /api/mistakes/:id`，兼容旧服务端和代理返回的非 JSON 404。
- 两种接口都返回路由缺失时，页面提示“保存接口不可用，服务端版本可能不一致”，避免只显示原始“接口不存在”。
- 题目不存在等业务 404 仍保留“没有找到这道错题”。
