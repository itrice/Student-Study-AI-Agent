# M9.1 + M9.2 图片录题最小切片

> 状态：待验收
> 范围：图片附件闭环与可选文字识别辅助；不包含 M9.3 图形推理

本文档冻结本轮图片录题的最小数据契约、API 契约、文件生命周期、隐私边界和备份恢复方式。
前端与后端都以此为准，后续扩展不应改变已有字段含义。

## 1. 产品范围

本轮目标是让图片题进入现有错题闭环：录入、查看、修改、删除、备份和恢复。

- 支持手机拍照、相册选择，以及桌面端从剪贴板粘贴图片。
- 原图保存在本机附件目录，SQLite 只保存元数据。
- 题目文字可手动录入和修改；文字与图片至少存在一项。
- OCR/视觉识别是可选辅助，必须由学生明确同意并核对后才回填文字。
- 识别失败、未配置视觉模型或图片读取失败时，仍可退回“图片 + 文字”保存。
- 不保存视觉识别结果为正式错题，只有正常保存错题请求才会创建错题。

本轮不包含：图形推理、复杂手写公式识别、多图批注、云端同步和多人协作。

## 2. 数据库契约

当前 schema 版本为 **v10**。迁移名称：`image_attachments`。

### `attachments`

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | INTEGER | PK AUTOINCREMENT | 附件编号 |
| `mistake_id` | INTEGER | NULL, FK `mistakes(id)` | 未绑定时为 NULL |
| `kind` | TEXT | NOT NULL, CHECK | 预留 `question`、`part`、`draft`、`answer`；本轮只使用 `question` |
| `storage_key` | TEXT | NOT NULL UNIQUE | 随机 UUID + 扩展名，仅服务端使用 |
| `mime_type` | TEXT | NOT NULL | 由文件魔数确定：`image/jpeg`、`image/png`、`image/webp` |
| `byte_size` | INTEGER | NOT NULL, > 0 | 原图字节数 |
| `width` / `height` | INTEGER | NOT NULL, > 0 | 图片像素尺寸 |
| `sha256` | TEXT | NOT NULL | 原图 SHA-256，用于完整性校验 |
| `original_name` | TEXT | NOT NULL | 清洗后的原始文件名，仅保存在数据库，不返回前端 |
| `created_at` | TEXT | NOT NULL | ISO 8601 时间 |

外键使用 `ON DELETE CASCADE`：删除错题时自动删除附件和识别记录元数据。

索引：`(mistake_id, created_at)`、`created_at`。

### `attachment_extractions`

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER | 主键 |
| `attachment_id` | INTEGER | FK `attachments(id)`，级联删除 |
| `raw_output` | TEXT | 模型原始输出，用于审计和排查 |
| `normalized_text` | TEXT | 规范化后的文字候选 |
| `confidence` | REAL NULL | 模型未提供时为 NULL |
| `provider` / `model` | TEXT | 识别供应方和模型名 |
| `prompt_version` | TEXT | 提示词版本 |
| `created_at` | TEXT | 创建时间 |

### 前端可见附件字段

普通错题、列表、复习和仪表盘接口只返回：

```json
{
  "id": 12,
  "kind": "question",
  "mimeType": "image/png",
  "byteSize": 34567,
  "width": 800,
  "height": 600,
  "url": "/api/attachments/12",
  "createdAt": "2026-11-11T08:00:00.000Z"
}
```

`storage_key`、`original_name`、`sha256` 和磁盘路径不得出现在普通 API、页面或日志中。

## 3. HTTP API 契约

### 上传附件

```http
POST /api/attachments?kind=question
Content-Type: image/png
X-Original-Name: <URL 编码后的文件名，可选>
<原始图片二进制>
```

成功返回 `201` 和前端可见附件字段。上传时 `mistake_id` 为 NULL，保存错题时再绑定。

错误：

- `400 INVALID_IMAGE`：空文件、不支持格式、损坏图片、声明 MIME 与内容不一致或尺寸无效。
- `413`：请求体超过 8 MiB。

### 读取附件

```http
GET /api/attachments/:id
```

成功返回图片二进制，响应头包含：

```text
Cache-Control: private, no-store
X-Content-Type-Options: nosniff
```

不存在或文件缺失返回 `404`。

### 删除未绑定附件

```http
DELETE /api/attachments/:id
```

只允许删除 `mistake_id IS NULL` 的附件。已绑定附件返回 `409`，应从错题修改请求中移除。

### 可选文字识别

```http
POST /api/attachments/:id/extract
Content-Type: application/json

{"consent": true}
```

`consent` 必须严格为布尔值 `true` 才会调用外部视觉模型。识别不会创建错题，也不会自动覆盖题目文字。

成功：

```json
{
  "available": true,
  "requiresConfirmation": true,
  "text": "识别出的题目文字",
  "confidence": null,
  "provider": "openai-compatible",
  "model": "vision-model"
}
```

未配置、未读取到文字或调用失败：

```json
{
  "available": false,
  "requiresConfirmation": true,
  "message": "识别失败，可直接填写题目文字并使用图片保存。"
}
```

前端必须把 `text` 放入可编辑候选框，学生点击“使用这段文字”后才回填题目输入框。

### 创建和修改错题

`POST /api/mistakes` 和 `PATCH /api/mistakes/:id` 接受可选字段：

```json
{
  "question": "可直接留空",
  "attachmentIds": [12, 13],
  "correctAnswer": "42",
  "knowledgePoint": "百分数",
  "errorType": "不会做"
}
```

约束：

- 新建时 `question` 与 `attachmentIds` 至少一项非空。
- 附件必须存在且未绑定到其他错题。
- 每道题最多 6 张，总字节数不超过 30 MiB。
- 修改时 `attachmentIds` 表示最终完整集合；未包含的旧附件会被删除。
- 修改附件集合视为题目内容变更，会按既有学习规则重置掌握进度并保留历史作答。
- 错题、附件绑定和修订记录在同一 SQLite 事务中提交；绑定失败时不会留下空壳错题。

## 4. 文件限制与存储

- 格式：JPG/JPEG、PNG、WebP；以文件魔数为准，不信任扩展名或客户端 MIME。
- 单张：不超过 8 MiB。
- 数量：每道错题最多 6 张。
- 单题总量：不超过 30 MiB。
- 单边像素：不超过 12000。
- 文件名：随机 UUID，例如 `550e8400-e29b-41d4-a716-446655440000.png`。
- 默认目录：数据库同级的 `attachments/`。
- 自定义目录：`ATTACHMENTS_DIR`，必须是服务进程可读写的本地文件系统目录。

## 5. 附件生命周期

1. 上传后写入磁盘并插入未绑定元数据。
2. 保存错题时在同一事务内绑定 `mistake_id`。
3. 未绑定附件超过 24 小时会在服务启动时及之后每小时清理元数据和文件。
4. 修改错题移除的附件在事务提交后删除文件。
5. 删除错题时数据库级联删除元数据，提交后删除原图。
6. 删除全部学习数据时清空附件、识别记录和对应文件。
7. 文件删除采用尽力而为策略；如果运行中删除失败，后续孤儿文件清理会重试。

孤儿文件清理只删除超过 TTL 且不在 `attachments.storage_key` 集合中的文件，不删除仍被错题引用的图片。

## 6. 隐私边界

- 图片默认只保存在本机，不会因上传而自动发送到外部。
- 只有学生勾选同意并点击“识别文字”后，当前图片才以 base64 发送给配置的 OpenAI-compatible 视觉模型。
- 未设置 `VISION_MODEL` 时视觉识别不可用，不影响手工文字 + 图片保存。
- 普通日志只记录数据库路径，不记录附件文件名、存储键或磁盘路径。
- 原图保留原始 EXIF；备份也是未加密文件，应按本机隐私数据保护。
- 当前为单学生、无账号隔离应用，不应直接暴露到公网。

## 7. 视觉识别配置

可选环境变量：

```dotenv
VISION_BASE_URL=https://api.openai.com/v1
VISION_API_KEY=replace-with-your-api-key
VISION_MODEL=replace-with-a-vision-model
VISION_PROVIDER=openai-compatible
VISION_TIMEOUT_MS=30000
```

未单独设置时，`VISION_BASE_URL`、`VISION_API_KEY`、`VISION_PROVIDER` 回退到对应 `LLM_*` 配置；`VISION_MODEL` 必须显式设置，避免把纯文本模型误用于图片。

## 8. 备份与恢复

完整备份包含数据库一致性快照、数据库引用的全部原图和 `manifest.json`：

```powershell
npm run backup
# 或
node scripts/backup-learning-data.mjs
```

仅备份数据库（不含附件）使用：

```powershell
npm run backup:db
```

恢复：

```powershell
npm run restore -- <备份目录>
npm run restore -- <备份目录> --force
```

恢复前必须停止服务，避免 SQLite WAL 和附件目录被同时改写。恢复会校验数据库和每个附件的 SHA-256，再整体替换目标数据库和附件目录。

配置：

- `DB_PATH`：SQLite 路径。
- `ATTACHMENTS_DIR`：附件目录；默认 `DB_PATH` 同级 `attachments/`。
- `BACKUP_DIR`：备份根目录；默认数据库同级 `backups/`。

## 9. 已知限制

- 无账号与权限隔离；能访问页面的人可以读取附件 URL。
- 视觉识别只做文字转录，不保证公式、表格、几何图形或手写内容的结构化还原。
- 纯图片且没有文字时，知识点判断和提示质量受可选知识点与图片内容限制。
- iPhone 的 HEIC/HEIF 照片需先转换为 JPG、PNG 或 WebP；本轮不内置 HEIC 转码。
- 不支持多图批注、图形推理、PDF 导入、云端同步或跨设备迁移。
- 恢复需要停服，不是在线热恢复。
- 备份未加密，原图可能含 EXIF 位置等隐私信息。
