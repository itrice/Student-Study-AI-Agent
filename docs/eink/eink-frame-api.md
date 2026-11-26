# 电子墨水屏帧接口实现说明

> 状态：已实现，自动化与画面自测完成，待真机联调验收
> 日期：2026-11-17
> 范围：`GET /api/eink/queue`、`GET /api/eink/dashboard`、
> `GET /api/eink/page`、`GET /api/eink/preview`

首页看板服务端接口与自动化测试已实现，真机版面验收仍按下列设计执行：
[电子墨水屏看板设计](./电子墨水屏看板设计.md)，不得将本文的题目页排版规则
直接套用到看板。

## 1. 接口行为

### 到期队列

```http
GET /api/eink/queue?limit=20
```

- `limit` 只接受 1～20 的十进制整数；缺省为 20。
- `count` 是全部到期错题数，`items` 最多 `limit` 条。
- 排序与现有复习队列一致：状态优先级、到期时间、编号。
- 只返回 `id`、`index`、`kp`、`hasPhoto`、`partCount`，不返回题干、答案、提示或附件 URL。
- `hasPhoto` 表示该题存在附件记录。附件文件实际损坏或缺失时，由页面接口回退文字页。
- 没有小问的旧题按 1 个小问返回。

### 学习看板

```http
GET /api/eink/dashboard
```

- 返回固定 48000 字节的 800×480 看板设备帧；响应头、强 `ETag`、`If-None-Match`
  304 和 `Cache-Control: no-transform` 与题目页一致。
- 内容仅包含 `Asia/Shanghai` 当前日期、当前月学习日历、全部到期题数量和本地励志语。
- 当前月至少提交一条错题作答记录时，在日期格右下角绘制 2px 矢量勾号；
  不以答对为条件，仅打开或开始复习但不提交作答不显示勾号。
- 到期数使用全部到期题，不受队列 `limit` 影响。
- 励志语从项目内固定列表按日期稳定选择，不联网、不调用模型。
- 数据读取失败时不伪造零值：看板保留日期和日历骨架，到期区显示“数据暂不可用”。
- 看板不提供 preview、待办、AI 语录、灰阶或其他扩展功能。

样帧证据见
[`eink-dashboard-sample-2026-11-23.png`](../reports/eink-dashboard-sample-2026-11-23.png)
、[`48000 字节设备帧`](../reports/eink-dashboard-sample-2026-11-23.bin)
及[`evidence.json`](../reports/eink-dashboard-sample-2026-11-23.json)。

### 设备帧

```http
GET /api/eink/page?id=19&mode=question
GET /api/eink/page?id=19&mode=answer
```

- 成功响应固定为 48000 字节：800×480、每行 100 字节、MSB 在左、0=黑、1=白。
- `Content-Type: application/octet-stream`、`Content-Length: 48000`。
- 返回强校验 `ETag: "<64 位 SHA-256>"`，`X-Etag` 与其完全相同。
- `Cache-Control: no-transform`，不设置 `Content-Encoding`。
- `If-None-Match` 命中时返回 304，无 body，不带 48000 的 `Content-Length`。
- 非法 `id`、`mode` 返回 400 JSON；错题不存在返回 404 JSON。
- 有附件但读取、解码或照片渲染失败时记录 `EINK_PHOTO_FALLBACK`，仍返回文字页和 48000 字节帧。

### PNG 预览

```http
GET /api/eink/preview?id=19&mode=question
```

- 返回 800×480 PNG，`Cache-Control: no-store`。
- 与同参数设备帧共用同一份渲染对象；PNG 是由完成二值化后的画布导出。
- 无附件、附件损坏、参数错误和错题不存在的行为与 `page` 一致。

## 2. 排版口径

- 文字页保留页眉、2px 分隔线、正文和页脚。
- 正文从 28px 起排，按 26、24、22、20px 逐级尝试；最低 20px。
- 答案页按小问分组显示“你的答案 / 正确答案 / 错因或解析 / 知识点”。
- 题目页只显示题干和小问题干，不显示学生答案、正确答案、解析、错因或提示。
- 照片题只在 `question` 模式使用整图；`answer` 模式始终为文字页。
- 照片区固定为 `x=6、y=56、width=788、height=420`，只保留页眉，不画分隔线、页脚或电量区。
- 照片按比例缩放并居中，白底留边；任何内容不越过 `y=476`。

已确认“页码”口径：页面序号取该错题在全部到期题中的现有队列位置，分母为全部到期数；非到期错题用于人工预览时显示 `1/1`。

## 3. 多图选择

现有数据模型允许一道题最多绑定 6 张图片，单张屏幕只能显示一张。本实现按附件创建顺序使用第一张题目图片，其他图片仍由原手机页面正常查看。若后续需要在终端切换多张图片，应另加页面参数，不改变本轮接口。

## 4. 照片处理

1. `sharp` 的 `rotate()` 按 EXIF Orientation 自动旋转；代码不再二次旋转。
2. 已有人工裁剪时直接读取派生裁剪图，跳过硬裁；随后执行白边和局部阈值。
3. 原图缩到 120×90，按亮度 ≥195 的白纸区域求包围盒；面积不足 55% 时退回墨迹包围盒。
4. 裁出的图片四周增加 8px 白边。
5. 使用 11×11 局部均值，像素低于局部均值 10 时判黑，其余判白。
6. 不使用全局阈值、Bayer 抖动或独立 Python 服务。

## 5. 缓存与失效

- 进程内 LRU 最多保存 32 个页面结果。
- 缓存源指纹包含布局版本、错题修订号与更新时间、题干、答案、解析、所有小问、附件元数据和裁剪更新时间。
- ETag 直接由最终 48000 字节帧计算 SHA-256，因此正文、答案、小问、附件、裁剪或布局变化都会改变校验值。
- `preview` 和 `page` 共用缓存；先打开预览后，设备帧不需要重新渲染。
- 缺图回退结果也会缓存，直到题目源指纹变化或服务重启。

## 6. 依赖、许可与平台

| 组件 | 版本 | 许可 | 平台 |
|---|---|---|---|
| `sharp` | 0.34.5 | Apache-2.0 | Windows x64/arm64；Linux x64/arm64 的 glibc 与 musl；macOS x64/arm64 |
| Noto Sans SC Regular | 随仓库打包 | SIL OFL 1.1 | 文本渲染，不依赖容器系统字体 |
| Noto Sans SC Bold | 随仓库打包 | SIL OFL 1.1 | 页眉粗体 |
| `lru-cache` | 11.5.3 | Blue Oak 1.0.0 | 纯 JavaScript，进程内页面缓存 |

字体许可证随字体保存在 `src/eink/fonts/OFL-1.1.txt`。Docker 基础镜像使用 `node:22-alpine`，对应 Linux x64 musl 预编译包；容器构建时不再依赖系统图形库或编译器。

## 7. 运行与验证

```powershell
pnpm install --frozen-lockfile
node --test
node scripts/generate-eink-previews.mjs
```

预览验收材料位于 `docs/reports/eink-previews/`，包括纯文字、长文字、多小问题目/答案、照片、照片加多小问、附件缺失回退和空队列证据。

## 8. 已知限制

- 本轮只验证 Node 服务和 HTTP 响应，尚未在 ESP32-S3 真机上逐页翻页验收。
- 当前开发机没有 Docker 命令，未能实际构建 Alpine 镜像；依赖元数据和 musl 预编译包已核对。
- 多附件时固定显示第一张，不支持终端多图切换。
- 单页只支持 20px 以上正文；极端长答案会按既定规则在 20px 最后一行的行末省略。
- 接口沿用产品要求，匿名只读；只适合现有家庭局域网部署，不应直接暴露到公网。

<!-- NOTE type=待确认 ref=src/eink/render.js:115,225 target=docs/eink/eink-frame-api.md:132 owner=product :: 本文“20px 末行省略”与 题库/04 PD-12、QA-EINK-03“不得截断/显示旧版省略号”冲突；本轮不改 e-ink 代码，待产品裁决后转 dev-eink。 -->
