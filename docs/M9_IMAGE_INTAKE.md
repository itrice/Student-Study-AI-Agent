# M9.1 + M9.2 图片录题最小切片

> 状态：M9.1/M9.2 最小切片已验收；图片裁剪 P1 已实现待验收
> 2026-11-24 起使用内部 OCR，上传图片不再要求二次确认
> 2026-11-26 起拍照选题采用整题框确认流程
> 范围：图片附件闭环与内部 OCR 文字识别辅助；不包含 M9.3 图形推理

> 拍照选题现行实现以[拍照选题最终流程](题库/07-拍照选题最终流程.md)和提交 `a8542b1`
> 为准。旧图片列表、拍照选题裁剪、“识别题目范围”按钮和补充图流程仅保留历史兼容；
> 手工错题录入中的图片裁剪仍按本文附件与裁剪契约执行。

本文档冻结本轮图片录题的最小数据契约、API 契约、文件生命周期、隐私边界和备份恢复方式。
前端与后端都以此为准，后续扩展不应改变已有字段含义。

## 1. 产品范围

本轮目标是让图片题进入现有错题闭环：录入、查看、修改、删除、备份和恢复。

- 支持手机拍照、相册选择，以及桌面端从剪贴板粘贴图片。
- 原图保存在本机附件目录，SQLite 只保存元数据。
- 题目文字可手动录入和修改；文字与图片至少存在一项。
- 拍照选题一次只选择或拍摄一张作业页，图片加载后直接发起一次内部 OCR。
- OCR 返回原始字块，由纯文本模型聚合为整题框；页面不显示行级字块框。
- 默认单题；多题模式至少勾选一个题框后才能确认分析。
- 未修改题框复用全部缓存字块；移动、缩放或低置信题框按新区域重新 OCR。
- OCR 结果必须由学生核对后才回填题目文字，不会静默覆盖手工输入。
- OCR 服务不可用或图片读取失败时，仍可退回“图片 + 文字”保存。
- 不保存 OCR 候选为正式错题，只有正常保存错题请求才会创建错题。

本轮不包含：图形推理、复杂手写公式识别、多图批注、云端同步和多人协作。

## 2. 数据库契约

当前 schema 版本为 **v16**。图片相关迁移为 `image_attachments`（v10）、
`image_crops`（v11）、`question_bank_compatibility`（v14）、
`ocr_scan_candidates`（v15）和 `multi_question_scan`（v16）。

`question_scan_tasks.scan_mode` 保存 `single|multi`，继续用于兼容扫描任务和候选页。
当前拍照选题页面先调用 OCR 题框接口，确认分析后再进入这些扫描任务。

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

### `attachment_crops`

裁剪图是原图的派生文件，一张原图最多保存一条裁剪记录；原图记录和文件始终保留，
删除裁剪记录即可恢复默认展示。

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `attachment_id` | INTEGER | PK, FK `attachments(id)` | 一张原图最多一条裁剪；级联删除 |
| `storage_key` | TEXT | NOT NULL UNIQUE | 派生文件随机存储键，仅服务端使用 |
| `mime_type` | TEXT | NOT NULL | 裁剪图的 `image/jpeg`、`image/png` 或 `image/webp` |
| `byte_size` | INTEGER | NOT NULL, > 0 | 裁剪图字节数 |
| `width` / `height` | INTEGER | NOT NULL, > 0 | 裁剪图实际像素尺寸 |
| `sha256` | TEXT | NOT NULL | 裁剪图 SHA-256 |
| `crop_x` / `crop_y` | INTEGER | NOT NULL, >= 0 | 裁剪起点，坐标基于旋转后的图片 |
| `crop_width` / `crop_height` | INTEGER | NOT NULL, > 0 | 裁剪区域尺寸 |
| `rotation` | INTEGER | NOT NULL, CHECK | `0`、`90`、`180`、`270` |
| `source_width` / `source_height` | INTEGER | NOT NULL, > 0 | 保存时的原图尺寸，用于拒绝过期裁剪 |
| `created_at` / `updated_at` | TEXT | NOT NULL | ISO 8601 时间 |

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
  "displayUrl": "/api/attachments/12?v=crop-2026-11-12T08%3A00%3A00.000Z",
  "originalUrl": "/api/attachments/12?variant=original",
  "hasCrop": true,
  "crop": {
    "width": 640,
    "height": 480,
    "rotation": 0,
    "sourceWidth": 800,
    "sourceHeight": 600
  },
  "createdAt": "2026-11-11T08:00:00.000Z"
}
```

`url` 保留为兼容字段，含义与 `displayUrl` 相同：有裁剪时指向裁剪图，无裁剪时指向原图。
`originalUrl` 始终指向原图。`crop` 为 `null` 表示当前没有裁剪。

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
GET /api/attachments/:id?variant=original
```

默认返回当前展示图：有裁剪时为裁剪图，否则为原图。`variant=original` 始终返回原图。
成功返回图片二进制，响应头包含：

```text
Cache-Control: private, no-store
X-Content-Type-Options: nosniff
```

不存在或文件缺失返回 `404`。

### 保存、替换与删除裁剪

```http
POST /api/attachments/:id/crop
Content-Type: image/png
X-Crop-X: 40
X-Crop-Y: 20
X-Crop-Width: 640
X-Crop-Height: 480
X-Crop-Rotation: 0
X-Crop-Source-Width: 800
X-Crop-Source-Height: 600
<裁剪后的图片二进制>
```

成功返回 `200` 和更新后的前端可见附件字段。约束：

- 裁剪图片与上传图片使用相同的格式、单张 8 MiB 和像素上限校验。
- 裁剪矩形坐标基于旋转后的图片；`rotation` 只能是 0/90/180/270。
- `X-Crop-Source-Width/Height` 必须等于当前原图元数据尺寸，否则返回 `400 INVALID_CROP`，
  前端应提示重新打开裁剪编辑器。
- 裁剪区域必须完整落在旋转后的图片范围内。
- 原图永远不会被覆盖；新裁剪图先写入磁盘，元数据更新成功后才删除旧裁剪图。
- 写入或元数据更新失败时清理新文件，原图和旧裁剪保持不变。
- 修改裁剪不属于题目内容变更，不重置掌握度。

```http
DELETE /api/attachments/:id/crop
```

删除裁剪图和裁剪元数据，恢复默认展示原图。原图不受影响；没有裁剪时仍返回 `200`。

### 删除未绑定附件

```http
DELETE /api/attachments/:id
```

只允许删除 `mistake_id IS NULL` 的附件。已绑定附件返回 `409`，应从错题修改请求中移除。

### 可选文字识别

```http
POST /api/attachments/:id/extract
Content-Type: application/json

{}
```

该接口不再接收或要求 `consent`。学生主动上传图片后即可调用部署在同一环境内的
内部 OCR 服务，不弹出二次确认。存在裁剪时只读取裁剪图；没有裁剪时读取原图。
识别不会创建错题，也不会自动覆盖题目文字。

成功：

```json
{
  "available": true,
  "requiresConfirmation": true,
  "text": "识别出的题目文字",
  "confidence": null,
  "provider": "rapidocr",
  "model": "PP-OCRv6-small"
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

### 现行拍照选题：OCR 题框确认

当前页面只保留“选择或拍摄图片”入口，一次一张作业页：

1. 原图加载并显示。
2. 内部 OCR 只识别一次，返回原始字块。
3. 纯文本模型聚合完整题框，页面只显示整题框。
4. 用户调整题框并点击“确认分析”。
5. 未修改题框复用缓存字块；移动、缩放、低置信或缓存不足时重新 OCR。
6. 分析结果进入现有候选页，用户再次确认后才能导入。

首次 OCR：

```http
POST /api/attachments/:id/ocr-boxes
```

响应包含仅用于缓存的 `blocks[]` 和界面使用的 `questions[]`：

- `id`
- `questionNo`
- `text`
- `confidence`
- `region`
- `pendingReasons`
- `sourceBlockIds`

确认分析：

```http
POST /api/attachments/:id/ocr-boxes/confirm
```

请求包含 `scanMode`、`selections[]` 和首次 OCR 元数据；响应返回现有 `scan`、
`analyzedCount`、`failedCount`、`cachedCount`、`reOcrCount` 和逐题 `results`。

蒙层、题框焦点、拖动缩放、编号、OCR 复用和导入成功重置规则详见
[拍照选题最终流程](题库/07-拍照选题最终流程.md)。

### 历史兼容：旧批量扫描 API

以下接口和候选状态继续保留，用于兼容和确认分析后的候选流程，但不再是拍照选题页面的
唯一入口。旧待识别图片列表、拍照选题裁剪和“识别题目范围”按钮不得重新出现在当前 UI。

兼容接口流程：

纯文本 LLM 只接收 OCR 文字、坐标和置信度。完成分析的候选在 `parts[]` 中保存小问；
没有明确小问时返回 1 个默认小问，不得把整页其他题目当作该候选的小问。

扫描创建：

```http
POST /api/questions/scans
Content-Type: application/json

{"attachmentIds":[12,13],"scanMode":"multi"}
```

`scanMode` 只允许 `single|multi`，缺省为 `single`。单题模式直接分析并返回
`analysisStage=analyzed` 的候选；多题模式首轮返回 `analysisStage=discovered` 的边界候选。

多题逐题分析：

```http
POST /api/questions/scans/{id}/analyze
Content-Type: application/json

{"candidateIds":[31,33]}
```

接口只分析已勾选的 `discovered` 候选，逐题返回成功或失败。成功的候选变为
`analysisStage=analyzed`；失败项保留原题目区域、错误信息和重新分析能力。

导入：

```http
POST /api/questions/scans/{id}/import
Content-Type: application/json

{"candidateIds":[31,33],"confirmIncomplete":false}
```

只有 `analysisStage=analyzed`、任务未过期且用户确认的候选可以导入。`discovered`
边界候选即使由客户端直接提交也必须被服务端拒绝。

```json
{
  "parts": [
    {
      "partNo": 1,
      "label": "（1）",
      "prompt": "求圆的面积",
      "studentAnswer": "28.26",
      "suggestedAnswer": "28.26平方厘米；9π平方厘米",
      "answerType": "number",
      "confidence": 0.92,
      "pendingReasons": [],
      "answerSource": "system_suggested"
    }
  ]
}
```

- `suggestedAnswer` 是系统标准答案建议，等价答案继续用中文分号分隔。
- 低置信度、公式信息不足或几何关系不足时，对应小问必须带 `pendingReasons`；
  标准答案无法可靠确定时留空，不得编造。
- 用户可以修改小问文字、学生答案、标准答案和答案类型，并增加、删除或调整顺序。
- 修改标准答案后 `answerSource` 变为 `user_confirmed`；未修改的系统答案保持
  `system_suggested`。
- 只有用户选择并确认候选后才导入。导入与正式题目创建处于同一 SQLite 事务，
  小问写入现有 `mistake_parts`，标准答案变体写入现有 `accepted_answers`；
  不新增正式小问事实表。

### 创建和修改错题

`POST /api/mistakes`、`POST /api/mistakes/:id/update` 和兼容保留的
`PATCH /api/mistakes/:id` 接受可选字段：

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
- 前端修改错题优先使用 `POST /api/mistakes/:id/update`，避免代理拦截 PATCH；
  遇到旧后端返回“接口不存在”时自动回退到 `PATCH /api/mistakes/:id`。
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
- 裁剪图沿用上述格式、单张 8 MiB 和单边像素限制，且最多与原图一一对应。
- 文件名：随机 UUID，例如 `550e8400-e29b-41d4-a716-446655440000.png`。
- 默认目录：数据库同级的 `attachments/`。
- 自定义目录：`ATTACHMENTS_DIR`，必须是服务进程可读写的本地文件系统目录。

## 5. 附件生命周期

1. 上传后写入磁盘并插入未绑定元数据。
2. 保存错题时在同一事务内绑定 `mistake_id`。
3. 未绑定附件超过 24 小时会在服务启动时及之后每小时清理元数据和文件。
4. 修改错题移除的附件在事务提交后删除文件。
5. 删除错题时数据库级联删除元数据，提交后删除原图。
6. 删除或替换裁剪时删除旧派生文件；删除原图或错题时同时删除裁剪元数据和文件。
7. 删除全部学习数据时清空附件、裁剪、识别记录和对应文件。
8. 文件删除采用尽力而为策略；如果运行中删除失败，后续孤儿文件清理会重试。

孤儿文件清理只删除超过 TTL 且不在 `attachments.storage_key` 或
`attachment_crops.storage_key` 集合中的文件，不删除仍被引用的原图或裁剪图。

## 6. 隐私边界

- 图片上传是用户发起的本地录题操作，不再要求额外的同意勾选或二次确认。
- 图片只发送到同一部署环境内的 OCR Service，不发送给外部多模态模型。
- OCR 后的纯文本模型只接收文字、坐标和置信度，不接收图片。
- 存在裁剪时 OCR 只读取裁剪区域，不读取整张原图；页面上的说明文字必须与此一致。
- OCR 服务不可用时不影响手工文字 + 图片保存。
- 普通日志只记录数据库路径，不记录附件文件名、存储键或磁盘路径。
- 原图保留原始 EXIF；备份也是未加密文件，应按本机隐私数据保护。
- 当前为单学生、无账号隔离应用，不应直接暴露到公网。

## 7. 内部 OCR 配置

内部服务地址与超时配置：

```dotenv
OCR_BASE_URL=http://student-study-ai-agent-ocr.student-study-ai-agent-ocr.svc.cluster.local:8000
OCR_TIMEOUT_MS=60000
```

OCR Service 必须部署在内部集群网络，不配置公网入口。OCR 结果仅作为可编辑候选；
题目拆分、学生答案和标准答案建议由纯文本模型根据 OCR 字块生成。

## 8. 备份与恢复

完整备份包含数据库一致性快照、数据库引用的全部原图、全部裁剪图和 `manifest.json`：

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

恢复前必须停止服务，避免 SQLite WAL 和附件目录被同时改写。恢复会校验数据库、
每个原图和每个裁剪图的 SHA-256 与字节数，再整体替换目标数据库和附件目录。

配置：

- `DB_PATH`：SQLite 路径。
- `ATTACHMENTS_DIR`：附件目录；默认 `DB_PATH` 同级 `attachments/`。
- `BACKUP_DIR`：备份根目录；默认数据库同级 `backups/`。

## 9. 已知限制

- 无账号与权限隔离；能访问页面的人可以读取附件 URL。
- 视觉识别只做文字转录，不保证公式、表格、几何图形或手写内容的结构化还原。
- 纯图片且没有文字时，知识点判断和提示质量受可选知识点与图片内容限制。
- 拍照选题页面不提供拍照流程中的图片裁剪；手工错题录入仍保留人工裁剪。
- 拍照选题的 OCR 缓存只服务当前扫描；全部导入成功后即清空题框、字块和选择状态。
- iPhone 的 HEIC/HEIF 照片需先转换为 JPG、PNG 或 WebP；本轮不内置 HEIC 转码。
- 不支持多图批注、图形推理、PDF 导入、云端同步或跨设备迁移。
- 恢复需要停服，不是在线热恢复。
- 备份未加密，原图可能含 EXIF 位置等隐私信息。
