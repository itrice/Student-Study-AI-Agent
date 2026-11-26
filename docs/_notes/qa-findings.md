# Phase5 夜间 QA 发现（2026-11-26）

## 结论摘要

- 最终验证对象：`origin/dev` = `11f2fd9e8fcb589045df01dfe3f3b7d826d68858`（已含 PR #66、#67）。
- 全量自动化测试通过：252 tests / 252 pass / 0 fail / 0 skipped。
- 回归保护文件均未改动；UI 16px 门禁与 ui-tokens 棘轮通过。
- dev 部署黑盒（port-forward）全部通过，未发现功能性阻断。
- 唯一环境问题：本机经代理访问 ingress 返回 503；绕过代理直连 ingress 返回 200，非应用故障。
- 本轮未改业务代码、未部署、未创建 PR。

## 测试计数

执行环境：`ELECTRON_RUN_AS_NODE=1 "C:/Users/itric/AppData/Local/Programs/Qoder CN/Qoder CN.exe" --test`（Node 24.22.1），在最终 dev `11f2fd9` 上全量执行。

| 指标 | 数值 |
| --- | --- |
| 测试文件（`test/**/*.test.js`） | 38 |
| helper 模块（`test/helpers/*.js`） | 2（`http-fixture.js`、`ui-css.js`） |
| Node 报告 tests | 252 |
| pass / fail / skipped / todo | 252 / 0 / 0 / 0 |
| 实际显式用例数 | 250（基线 244 + 新增 ui-tokens 6） |
| 耗时 | 约 8.5s |

252 = 250 条显式用例 + 2 个 helper 文件级空测试节点。`test/helpers/*.js` 会被 Node test runner 按文件名自动发现，两个 helper 未声明任何 `test()`，因此各产生 1 个空的文件级测试节点。这不影响 pass/fail，但会让 tests 计数比实际用例多 2；属计数噪音，非测试失败。

UI 定向回归：

```text
node --test test/ui-readability.test.js test/ui-tokens.test.js
tests 13 / pass 13 / fail 0
```

## 回归断言

- `git diff --name-only 619a088..HEAD` 中以下受保护文件均未出现：
  - `docker-compose.yml`
  - `public/styles.css`
  - `public/api-docs.css`
  - `src/migrations.js`
- 16px 字号门禁与 ui-tokens 棘轮均通过，基线值：
  - `styles.css` 非 token font-size 33（上限 33）
  - `styles.css` 去重颜色字面量 209（上限 209，且无清单外新色）
  - 宽度断点集合 ⊆ `{389, 560, 820, 900, 980, 1100}`
  - `index.html` 内联 `style=` 为 0
  - `--text-*` token 均不低于 16px
  - `api-docs.css` 独立基线 31 非 token / 33 色

## 部署与黑盒证据

### 部署运行

| run id | run # | commit | 创建时间（UTC） | 结论 |
| --- | --- | --- | --- | --- |
| 45816727040 | 104 | `619a088` | 2026-11-26T12:07:28Z | success（Validate / Build / Deploy 全绿） |
| 45825026708 | 106 | `2213f79` | 2026-11-26T13:00:55Z | success（Validate / Build / Deploy 全绿） |
| 45825724809 | 108 | `11f2fd9` | 2026-11-26T13:05:15Z | success（Validate / Build / Deploy 全绿） |

最终 dev 集群状态：

- namespace：`student-study-ai-agent-dev`，deployment/service：`student-study-ai-agent`
- revision 44，ready 1/1
- image：`ghcr.io/itrice/student-study-ai-agent:sha-11f2fd9e8fcb@sha256:f2615d43cd7e35d42bd2b657edb0f71652eee6aaff303ac908ccfc8275623313`
- pod：`student-study-ai-agent-77c57bbff8-cl7gm`，started `2026-11-26T13:06:22Z`

### 集群内 smoke

```text
NAMESPACE=student-study-ai-agent-dev DEPLOYMENT=student-study-ai-agent bash scripts/smoke-test.sh
{"ok":true,"schemaVersion":16,"toolCount":9}
```

### port-forward 黑盒

建立 `kubectl -n student-study-ai-agent-dev port-forward svc/student-study-ai-agent 18080:80`，日志确认 `Forwarding from 127.0.0.1:18080 -> 3000`，测试完成后已终止转发进程，18080 已释放。

| 请求 | 结果 |
| --- | --- |
| `GET /api/health` | 200；`{"ok":true,"schemaVersion":16,"toolCount":9}` |
| `GET /api/questions?category=mistake` | 200；返回对象 `{questions,total}`，`questions` 为数组；total=1，count=1，首个 id=12 |
| `GET /api/eink/dashboard` | 200；`Content-Length: 48000`；ETag 存在（`"d3e57fae...4f90ad0"`）；响应体 48000 字节；无 `Content-Encoding` |
| 同上 + `If-None-Match: <ETag>` | 304；响应体 0 字节；无 `Content-Length` |
| `GET /api/eink/page?id=12&mode=question` | 200；`Content-Length: 48000`；响应体 48000 字节；无 `Content-Encoding`；ETag 存在 |

说明：`/api/questions?category=mistake` 实测为包装对象而非裸数组，数组位于 `questions` 字段。任务只要求记录“是否数组”，此处按实测记录；若验收口径要求裸数组，需产品/开发确认，但不属于本轮功能性失败。

### ingress 503 归因

对 `http://student-study-ai-agent-dev.home.arpa/api/health`：

| 访问方式 | 结果 |
| --- | --- |
| 默认环境代理（`HTTP_PROXY`/`HTTPS_PROXY`，remote_ip=127.0.0.1） | 503 |
| `curl --noproxy '*'`（remote_ip=192.168.1.66） | 200 |
| `curl --noproxy '*' -H 'Host: student-study-ai-agent-dev.home.arpa' http://192.168.1.66/api/health` | 200 |

结论：503 来自本机环境代理链路，不是 ingress/应用功能故障；绕过代理后 ingress 正常返回 200。按任务要求将 ingress 503 记为环境问题，部署黑盒以 port-forward 结果为准。全程未访问正式实例 `192.168.1.66:3000`。

## 发现项

1. **ingress 503 为环境代理问题**：代理链路返回 503，直连 ingress 返回 200；不构成功能失败，但使用该环境的验收需配置 `no_proxy` 或直连。
2. **2 个 helper 空测试计数**：`test/helpers/http-fixture.js`、`test/helpers/ui-css.js` 被 Node 自动发现为测试文件，各产生 1 个空文件级节点，使 tests 计数为 252 而非实际 250。非失败，属计数噪音；本轮按要求未调整。
3. **PR #64 已在本轮前合入 main**：`Dev` → `main`，合入时间 2026-11-26T06:08:22Z，merge commit `9ff569d250e36a6567bf87f219c05f8fc36b6c28`。本轮验证基于 dev，未重复验证 main 上的发布链。
4. **questions 接口返回包装对象**：mistake 分类返回 `{questions,total}`，非裸数组；见上文说明，待验收口径确认。

## 未覆盖项

- 未使用正式实例 `192.168.1.66:3000`，也未验证生产环境。
- ingress 仅做健康探测；因本机代理 503，未将 ingress 作为功能验收证据。
- 未验证真实墨水屏设备、浏览器视觉回归、移动端/局域网多端。
- 未验证外部 OCR/大模型服务的真实接入与失败注入、备份恢复、并发/压力、写操作与破坏性场景。
- 部署黑盒数据集仅有 1 条 mistake 题目，eink page 仅验证 id=12。
- 本轮未执行部署、未创建/合入 PR。

## 复现命令

```bash
git rev-parse HEAD
# 11f2fd9e8fcb589045df01dfe3f3b7d826d68858

ELECTRON_RUN_AS_NODE=1 "C:/Users/itric/AppData/Local/Programs/Qoder CN/Qoder CN.exe" --test
# tests 252 / pass 252 / fail 0

git diff --name-only 619a088..HEAD | grep -E '^(docker-compose\.yml|public/styles\.css|public/api-docs\.css|src/migrations\.js)$'
# 无输出

NAMESPACE=student-study-ai-agent-dev DEPLOYMENT=student-study-ai-agent bash scripts/smoke-test.sh
# {"ok":true,"schemaVersion":16,"toolCount":9}
```