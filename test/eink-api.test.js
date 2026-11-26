import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { LearningRepository } from "../src/database.js";
import { AttachmentStore } from "../src/attachments.js";
import {
  EINK_FRAME_BYTES,
  EINK_HEIGHT,
  EINK_WIDTH,
  binarizeAndPack,
  buildAnswerText,
  buildQuestionText,
  renderEinkPage
} from "../src/eink/render.js";
import { EinkPageService } from "../src/eink/service.js";
import { PHOTO_AREA, prepareEinkPhoto } from "../src/eink/photo.js";
import { startServer, stopServer } from "./helpers/http-fixture.js";

async function makePhoto() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="480" height="260">
      <rect width="480" height="260" fill="#777"/>
      <rect x="18" y="14" width="444" height="232" fill="#eee"/>
      <g fill="#111" font-family="Noto Sans SC, sans-serif" font-size="28">
        <text x="46" y="76">圆的半径是 3 厘米</text>
        <text x="46" y="132">求圆的面积。</text>
      </g>
      <rect x="170" y="158" width="126" height="48"
        fill="none" stroke="#111" stroke-width="2"/>
    </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function makeOrientedJpeg() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="60" height="30">
      <rect width="60" height="30" fill="white"/>
      <rect width="30" height="30" fill="black"/>
    </svg>`;
  const jpeg = await sharp(Buffer.from(svg)).jpeg().toBuffer();
  const exif = Buffer.from([
    0x45, 0x78, 0x69, 0x66, 0, 0,
    0x49, 0x49, 0x2a, 0, 8, 0, 0, 0,
    1, 0,
    0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0,
    0, 0, 0, 0
  ]);
  const segment = Buffer.alloc(4);
  segment[0] = 0xff;
  segment[1] = 0xe1;
  segment.writeUInt16BE(exif.length + 2, 2);
  return Buffer.concat([
    jpeg.subarray(0, 2),
    segment,
    exif,
    jpeg.subarray(2)
  ]);
}

async function createMistake(baseUrl, input) {
  const response = await fetch(`${baseUrl}/api/mistakes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  assert.equal(response.status, 201);
  return response.json();
}

async function previewPixels(response) {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  const image = await sharp(Buffer.from(await response.arrayBuffer()))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    width: image.info.width,
    height: image.info.height,
    pixels: image.data
  };
}

function assertFrameMatchesPixels(frame, width, height, pixels) {
  assert.equal(frame.length, EINK_FRAME_BYTES);
  const rowBytes = width / 8;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const black = (frame[y * rowBytes + Math.floor(x / 8)] &
        (0x80 >> (x % 8))) === 0;
      const pixel = (y * width + x) * 4;
      const expected = black ? 0 : 255;
      assert.equal(pixels[pixel], expected);
      assert.equal(pixels[pixel + 1], expected);
      assert.equal(pixels[pixel + 2], expected);
      assert.equal(pixels[pixel + 3], 255);
    }
  }
}

function framePixelIsBlack(frame, width, x, y) {
  return (frame[y * Math.ceil(width / 8) + Math.floor(x / 8)] &
    (0x80 >> (x % 8))) === 0;
}

test("1bpp 打包使用每行 MSB 在左且 0 表示黑色", async () => {
  const pixels = Buffer.alloc(8 * 4, 255);
  pixels[0] = 0;
  pixels[1] = 0;
  pixels[2] = 0;
  const packed = await binarizeAndPack({
    data: pixels,
    width: 8,
    height: 1,
    channels: 4
  });
  assert.deepEqual([...packed.frame], [0x7f]);

  const rendered = await renderEinkPage({
    mistake: {
      question: "纯文字题",
      knowledgePoint: "圆"
    },
    mode: "question",
    index: 1,
    total: 1
  });
  assert.equal(rendered.frame.length, 48_000);
  assert.equal(rendered.frame instanceof Buffer, true);
  assert.deepEqual(PHOTO_AREA, {
    x: 6,
    y: 56,
    width: 788,
    height: 420
  });
  assert.equal(PHOTO_AREA.y + PHOTO_AREA.height, 476);
});

test("照片页不画分隔线，并对暗色页边使用局部自适应阈值", async () => {
  const source = await sharp(Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="400" height="200">
      <rect width="400" height="200" fill="#8c8c8c"/>
      <rect x="28" y="42" width="220" height="44" fill="black"/>
    </svg>
  `)).png().toBuffer();
  const photo = await prepareEinkPhoto(source, { skipPaperCrop: true });
  const rendered = await renderEinkPage({
    mistake: {
      question: "",
      knowledgePoint: "圆"
    },
    mode: "question",
    index: 1,
    total: 1,
    photo
  });
  assert.equal(framePixelIsBlack(rendered.frame, EINK_WIDTH, 2, 64), false);
  assert.equal(framePixelIsBlack(rendered.frame, EINK_WIDTH, 8, 60), false);
  assert.equal(framePixelIsBlack(rendered.frame, EINK_WIDTH, 30, 100), false);
  assert.equal(framePixelIsBlack(rendered.frame, EINK_WIDTH, 400, 250), false);
  assert.equal(framePixelIsBlack(rendered.frame, EINK_WIDTH, 100, 158), true);
  assert.equal(framePixelIsBlack(rendered.frame, EINK_WIDTH, 792, 472), false);
});

test("手机 JPEG 的 EXIF Orientation 只应用一次", async () => {
  const prepared = await prepareEinkPhoto(await makeOrientedJpeg(), {
    skipPaperCrop: true
  });
  assert.equal(prepared.width, 46);
  assert.equal(prepared.height, 76);
});

test("题目页不包含答案，答案页按小问组织完整信息", () => {
  const mistake = {
    question: "先求半径，再求面积。",
    studentAnswer: "18.84",
    correctAnswer: "28.26",
    analysis: "把半径平方后再乘圆周率。",
    errorType: "忘记平方",
    knowledgePoint: "圆",
    parts: [
      {
        partNo: 1,
        prompt: "圆的半径",
        studentAnswer: "3",
        knowledgePoint: "圆",
        acceptedAnswers: ["3"]
      },
      {
        partNo: 2,
        prompt: "圆的面积",
        studentAnswer: "18.84",
        knowledgePoint: "圆",
        acceptedAnswers: ["28.26"],
        explanation: "使用 S = πr²"
      }
    ]
  };
  const question = buildQuestionText(mistake);
  const answer = buildAnswerText(mistake);
  assert.match(question, /第1小问/);
  assert.match(question, /第2小问/);
  assert.doesNotMatch(question, /28\.26|18\.84|忘记平方/);
  assert.match(answer, /你的答案：18\.84/);
  assert.match(answer, /正确答案：28\.26/);
  assert.match(answer, /把半径平方后再乘圆周率/);
});

test(
  "电子墨水屏 HTTP 接口满足帧格式、缓存和照片回退契约",
  { timeout: 60_000 },
  async () => {
    const server = await startServer({ prefix: "math-coach-eink-api-" });
    const { child, directory, attachmentsDirectory, baseUrl } = server;

    try {
      const textMistake = await createMistake(baseUrl, {
        question: "一个圆的半径是 3 厘米，求它的面积。",
        studentAnswer: "18.84 平方厘米",
        correctAnswer: "28.26 平方厘米",
        analysis: "使用圆面积公式 S = πr²。",
        knowledgePoint: "圆",
        errorType: "忘记平方"
      });
      const multipart = await createMistake(baseUrl, {
        question: "计算下面各题。",
        correctAnswer: "答案一；答案二",
        knowledgePoint: "百分数",
        errorType: "计算错误",
        parts: [
          {
            label: "第1题",
            prompt: "把 3/4 化成百分数",
            studentAnswer: "70%",
            acceptedAnswers: ["75%"]
          },
          {
            label: "第2题",
            prompt: "计算 20% 的 50",
            studentAnswer: "5",
            acceptedAnswers: ["10"]
          }
        ]
      });

      const photo = await makePhoto();
      const upload = await fetch(
        `${baseUrl}/api/attachments?kind=question`,
        {
          method: "POST",
          headers: { "Content-Type": "image/png" },
          body: photo
        }
      );
      assert.equal(upload.status, 201);
      const attachment = await upload.json();
      const photoMistake = await createMistake(baseUrl, {
        question: "",
        correctAnswer: "28.26 平方厘米",
        knowledgePoint: "圆",
        errorType: "读题不完整",
        attachmentIds: [attachment.id]
      });

      const queueResponse = await fetch(`${baseUrl}/api/eink/queue`);
      assert.equal(queueResponse.status, 200);
      assert.equal(queueResponse.headers.get("content-encoding"), null);
      assert.equal(queueResponse.headers.get("x-content-type-options"), "nosniff");
      const queue = await queueResponse.json();
      assert.equal(queue.count, 3);
      assert.equal(queue.items.length, 3);
      assert.match(queue.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.deepEqual(
        queue.items.map((item) => item.index),
        [1, 2, 3]
      );
      assert.equal(
        queue.items.find((item) => item.id === multipart.id).partCount,
        2
      );
      assert.equal(
        queue.items.find((item) => item.id === photoMistake.id).hasPhoto,
        true
      );
      for (const item of queue.items) {
        assert.deepEqual(
          Object.keys(item).sort(),
          ["hasPhoto", "id", "index", "kp", "partCount"]
        );
      }

      const limited = await (
        await fetch(`${baseUrl}/api/eink/queue?limit=1`)
      ).json();
      assert.equal(limited.count, 3);
      assert.equal(limited.items.length, 1);
      assert.equal(limited.items[0].index, 1);
      for (const limit of ["0", "21", "abc", "1.5", ""]) {
        const response = await fetch(
          `${baseUrl}/api/eink/queue?limit=${limit}`
        );
        assert.equal(response.status, 400);
        assert.equal(response.headers.get("content-encoding"), null);
        assert.equal((await response.json()).error.length > 0, true);
      }

      const page = await fetch(
        `${baseUrl}/api/eink/page?id=${textMistake.id}`
      );
      assert.equal(page.status, 200);
      assert.equal(
        page.headers.get("content-type"),
        "application/octet-stream"
      );
      assert.equal(page.headers.get("content-length"), "48000");
      assert.equal(page.headers.get("content-encoding"), null);
      assert.equal(page.headers.get("cache-control"), "no-transform");
      assert.equal(page.headers.get("x-content-type-options"), "nosniff");
      const etag = page.headers.get("etag");
      assert.match(etag, /^"[0-9a-f]{64}"$/);
      assert.equal(page.headers.get("x-etag"), etag);
      const frame = Buffer.from(await page.arrayBuffer());
      assert.equal(frame.length, 48_000);

      const cached = await fetch(
        `${baseUrl}/api/eink/page?id=${textMistake.id}`,
        { headers: { "If-None-Match": etag } }
      );
      assert.equal(cached.status, 304);
      assert.equal(cached.headers.get("content-length"), null);
      assert.equal((await cached.arrayBuffer()).byteLength, 0);

      const previewResponse = await fetch(
        `${baseUrl}/api/eink/preview?id=${textMistake.id}`
      );
      assert.equal(previewResponse.headers.get("cache-control"), "no-store");
      const preview = await previewPixels(previewResponse);
      assert.equal(preview.width, EINK_WIDTH);
      assert.equal(preview.height, EINK_HEIGHT);
      assertFrameMatchesPixels(
        frame,
        preview.width,
        preview.height,
        preview.pixels
      );

      const update = await fetch(
        `${baseUrl}/api/mistakes/${textMistake.id}/update`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "eink-answer-change-1"
          },
          body: JSON.stringify({
            question: textMistake.question,
            studentAnswer: "18.84",
            correctAnswer: "28.26",
            analysis: "先平方半径，再乘圆周率。",
            knowledgePoint: "圆",
            errorType: "忘记平方"
          })
        }
      );
      assert.equal(update.status, 200);
      const answer = await fetch(
        `${baseUrl}/api/eink/page?id=${textMistake.id}&mode=answer`
      );
      assert.equal(answer.status, 200);
      assert.notEqual(answer.headers.get("etag"), etag);
      assert.equal((await answer.arrayBuffer()).byteLength, 48_000);

      const photoPage = await fetch(
        `${baseUrl}/api/eink/page?id=${photoMistake.id}`
      );
      assert.equal(photoPage.status, 200);
      const photoEtag = photoPage.headers.get("etag");
      assert.equal((await photoPage.arrayBuffer()).byteLength, 48_000);

      const cropBuffer = await sharp({
        create: {
          width: 120,
          height: 64,
          channels: 4,
          background: { r: 255, g: 255, b: 255, alpha: 1 }
        }
      }).png().toBuffer();
      const cropped = await fetch(
        `${baseUrl}/api/attachments/${attachment.id}/crop`,
        {
          method: "POST",
          headers: {
            "Content-Type": "image/png",
            "X-Crop-X": "20",
            "X-Crop-Y": "20",
            "X-Crop-Width": "240",
            "X-Crop-Height": "128",
            "X-Crop-Rotation": "0",
            "X-Crop-Source-Width": "480",
            "X-Crop-Source-Height": "260"
          },
          body: cropBuffer
        }
      );
      assert.equal(cropped.status, 200);
      const afterCrop = await fetch(
        `${baseUrl}/api/eink/page?id=${photoMistake.id}`
      );
      assert.equal(afterCrop.status, 200);
      assert.notEqual(afterCrop.headers.get("etag"), photoEtag);
      await afterCrop.arrayBuffer();

      const photoFiles = fs.readdirSync(attachmentsDirectory);
      for (const filename of photoFiles) {
        fs.unlinkSync(path.join(attachmentsDirectory, filename));
      }
      const invalidatePhotoPage = await fetch(
        `${baseUrl}/api/mistakes/${photoMistake.id}/update`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "eink-photo-fallback-1"
          },
          body: JSON.stringify({
            question: "附件缺失后的文字回退题",
            studentAnswer: "",
            correctAnswer: "28.26 平方厘米",
            analysis: "附件文件缺失时应继续显示文字页。",
            knowledgePoint: "圆",
            errorType: "读题不完整",
            attachmentIds: [attachment.id]
          })
        }
      );
      assert.equal(invalidatePhotoPage.status, 200);
      const fallback = await fetch(
        `${baseUrl}/api/eink/page?id=${photoMistake.id}`
      );
      assert.equal(fallback.status, 200);
      assert.equal(
        fallback.headers.get("content-type"),
        "application/octet-stream"
      );
      assert.equal((await fallback.arrayBuffer()).byteLength, 48_000);

      for (const query of [
        "id=abc",
        "id=0",
        `id=${textMistake.id}&mode=hint`,
        `id=${textMistake.id}&mode=QUESTION`
      ]) {
        const response = await fetch(`${baseUrl}/api/eink/page?${query}`);
        assert.equal(response.status, 400);
        assert.match(
          response.headers.get("content-type"),
          /^application\/json/
        );
        await response.arrayBuffer();
      }
      const missing = await fetch(`${baseUrl}/api/eink/page?id=999999`);
      assert.equal(missing.status, 404);
      assert.match(missing.headers.get("content-type"), /^application\/json/);
      assert.equal((await missing.json()).code, "MISTAKE_NOT_FOUND");

      const persistedLog = server.logs();
      assert.match(persistedLog, /\[eink\]/);
      assert.match(persistedLog, /warning=EINK_PHOTO_FALLBACK/);
      assert.doesNotMatch(persistedLog, /28\.26|18\.84/);
      assert.doesNotMatch(persistedLog, /storageKey|cropStorageKey/);
    } finally {
      await stopServer(child);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
);

test("服务从缓存复用同一帧，且只读请求不写入学习数据", async () => {
  const repository = new LearningRepository();
  const store = new AttachmentStore({
    directory: repository.attachmentDirectory || fs.mkdtempSync(
      path.join(os.tmpdir(), "math-coach-eink-store-")
    )
  });
  const mistake = repository.createMistake({
    question: "求 3/4 的 20%。",
    studentAnswer: "20%",
    correctAnswer: "15%",
    analysis: "先算 3/4，再乘 20%。",
    knowledgePoint: "百分数",
    errorType: "计算错误"
  });
  const before = repository.db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM attempts) AS attempts,
        (SELECT COUNT(*) FROM hint_events) AS hints,
        (SELECT COUNT(*) FROM review_schedule) AS schedules`
    )
    .get();
  const service = new EinkPageService({
    repository,
    attachmentStore: store
  });
  const first = await service.getPage({
    id: mistake.id,
    mode: "question"
  });
  const second = await service.getPage({
    id: mistake.id,
    mode: "question"
  });
  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  assert.equal(first.frame, second.frame);
  assert.equal(first.png, second.png);
  assert.equal(first.etag, second.etag);
  const after = repository.db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM attempts) AS attempts,
        (SELECT COUNT(*) FROM hint_events) AS hints,
        (SELECT COUNT(*) FROM review_schedule) AS schedules`
    )
    .get();
  assert.deepEqual(after, before);
  repository.close();
});
