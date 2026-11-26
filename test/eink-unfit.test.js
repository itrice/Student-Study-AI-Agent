import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { LearningRepository } from "../src/database.js";
import { AttachmentStore } from "../src/attachments.js";
import {
  EINK_HEIGHT,
  EINK_WIDTH,
  renderEinkPage
} from "../src/eink/render.js";
import {
  EINK_UNFIT_REASONS,
  evaluateEinkFit
} from "../src/eink/fit.js";
import { layoutTextPage } from "../src/eink/text-layout.js";
import { EinkPageService } from "../src/eink/service.js";
import { prepareEinkPhoto } from "../src/eink/photo.js";
import { startServer, stopServer } from "./helpers/http-fixture.js";

const LONG_TEXT = "长".repeat(600);

async function createMistake(baseUrl, input) {
  const response = await fetch(`${baseUrl}/api/mistakes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  assert.equal(response.status, 201);
  return response.json();
}

function countBlackPixels(image) {
  let black = 0;
  for (let offset = 0; offset < image.data.length; offset += 4) {
    if (image.data[offset] === 0) black += 1;
  }
  return black;
}

test("20px 仍放不下时判定不适配，不截断也不输出帧", async () => {
  const layout = layoutTextPage(LONG_TEXT);
  assert.equal(layout.fits, false);
  assert.equal(layout.fontSize, 20);
  assert.ok(layout.lines.length > layout.maxLines);

  const questionFit = evaluateEinkFit({ question: LONG_TEXT });
  assert.equal(questionFit.status, "unfit");
  assert.deepEqual(questionFit.reasons, [EINK_UNFIT_REASONS.TEXT]);

  const answerFit = evaluateEinkFit({
    question: "求圆的面积。",
    analysis: LONG_TEXT
  });
  assert.equal(answerFit.status, "unfit");
  assert.deepEqual(answerFit.reasons, [EINK_UNFIT_REASONS.ANSWER]);

  const questionPage = await renderEinkPage({
    mistake: { question: LONG_TEXT, knowledgePoint: "超长题干" },
    mode: "question",
    index: 1,
    total: 1
  });
  assert.equal(questionPage.unfit, true);
  assert.deepEqual(questionPage.reasons, [EINK_UNFIT_REASONS.TEXT]);
  assert.equal(questionPage.frame, undefined);

  const answerPage = await renderEinkPage({
    mistake: { question: "求圆的面积。", analysis: LONG_TEXT },
    mode: "answer",
    index: 1,
    total: 1
  });
  assert.equal(answerPage.unfit, true);
  assert.deepEqual(answerPage.reasons, [EINK_UNFIT_REASONS.ANSWER]);
});

test("照片题按尺寸和可辨认度判定不适配", async () => {
  const tiny = evaluateEinkFit({
    question: "看图答题",
    attachments: [{ width: 40, height: 30 }]
  });
  assert.equal(tiny.status, "unfit");
  assert.deepEqual(tiny.reasons, [EINK_UNFIT_REASONS.PHOTO]);

  const readable = evaluateEinkFit({
    question: "看图答题",
    correctAnswer: "28.26",
    attachments: [{ width: 480, height: 260 }]
  });
  assert.equal(readable.status, "fit");

  const blank = await sharp({
    create: {
      width: 480,
      height: 260,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 }
    }
  }).png().toBuffer();
  const photo = await prepareEinkPhoto(blank, { skipPaperCrop: true });
  const rendered = await renderEinkPage({
    mistake: { question: "", knowledgePoint: "圆" },
    mode: "question",
    index: 1,
    total: 1,
    photo
  });
  assert.equal(rendered.unfit, true);
  assert.deepEqual(rendered.reasons, [EINK_UNFIT_REASONS.PHOTO]);
});

test("队列排除不适配错题，只读懒判定不写库", async () => {
  const repository = new LearningRepository();
  const store = new AttachmentStore({
    directory: fs.mkdtempSync(
      path.join(os.tmpdir(), "math-coach-eink-unfit-")
    )
  });
  const fit = repository.createMistake({
    question: "求 1+1。",
    studentAnswer: "3",
    correctAnswer: "2",
    analysis: "个位相加。",
    knowledgePoint: "加法",
    errorType: "计算错误"
  });
  const unfit = repository.createMistake({
    question: LONG_TEXT,
    studentAnswer: "略",
    correctAnswer: "略",
    analysis: "",
    knowledgePoint: "超长题干",
    errorType: "其他"
  });
  const statusOf = (id) =>
    repository.db
      .prepare("SELECT eink_fit_status FROM mistakes WHERE id = ?")
      .get(id).eink_fit_status;
  assert.equal(statusOf(fit.id), "fit");
  assert.equal(statusOf(unfit.id), "unfit");

  // 模拟旧数据：状态未判定时由只读请求在内存中判定
  repository.db
    .prepare("UPDATE mistakes SET eink_fit_status = 'unchecked' WHERE id = ?")
    .run(unfit.id);

  const service = new EinkPageService({
    repository,
    attachmentStore: store
  });
  const queue = service.getQueue();
  assert.equal(queue.count, 1);
  assert.deepEqual(
    queue.items.map((item) => [item.id, item.index]),
    [[fit.id, 1]]
  );
  assert.deepEqual(service.getVisiblePosition(fit.id), {
    index: 1,
    total: 1
  });
  assert.deepEqual(service.getVisiblePosition(unfit.id), {
    index: 1,
    total: 1
  });
  assert.equal(statusOf(unfit.id), "unchecked");

  const page = await service.getPage({
    id: unfit.id,
    mode: "question"
  });
  assert.equal(page.unfit, true);
  assert.equal(page.code, "EINK_UNFIT");
  assert.deepEqual(page.reasons, [EINK_UNFIT_REASONS.TEXT]);
  assert.equal(statusOf(unfit.id), "unchecked");
  repository.close();
});

test(
  "不适配错题从队列排除，page 返回 409，preview 标注提示",
  { timeout: 60_000 },
  async () => {
    const server = await startServer({ prefix: "math-coach-eink-unfit-" });
    const { child, directory, baseUrl } = server;

    try {
      const fit = await createMistake(baseUrl, {
        question: "一个圆的半径是 3 厘米，求它的面积。",
        studentAnswer: "18.84 平方厘米",
        correctAnswer: "28.26 平方厘米",
        analysis: "使用圆面积公式 S = πr²。",
        knowledgePoint: "圆",
        errorType: "忘记平方"
      });
      const unfitText = await createMistake(baseUrl, {
        question: LONG_TEXT,
        studentAnswer: "略",
        correctAnswer: "略",
        analysis: "略",
        knowledgePoint: "超长题干",
        errorType: "其他"
      });
      const tinyPhoto = await sharp({
        create: {
          width: 40,
          height: 30,
          channels: 4,
          background: { r: 200, g: 200, b: 200, alpha: 1 }
        }
      }).png().toBuffer();
      const upload = await fetch(
        `${baseUrl}/api/attachments?kind=question`,
        {
          method: "POST",
          headers: { "Content-Type": "image/png" },
          body: tinyPhoto
        }
      );
      assert.equal(upload.status, 201);
      const attachment = await upload.json();
      const unfitPhoto = await createMistake(baseUrl, {
        question: "",
        correctAnswer: "略",
        knowledgePoint: "圆",
        errorType: "读题不完整",
        attachmentIds: [attachment.id]
      });

      const queue = await (
        await fetch(`${baseUrl}/api/eink/queue`)
      ).json();
      assert.equal(queue.count, 1);
      assert.deepEqual(
        queue.items.map((item) => [item.id, item.index]),
        [[fit.id, 1]]
      );

      const textPage = await fetch(
        `${baseUrl}/api/eink/page?id=${unfitText.id}`
      );
      assert.equal(textPage.status, 409);
      assert.match(
        textPage.headers.get("content-type"),
        /^application\/json/
      );
      assert.notEqual(textPage.headers.get("content-length"), "48000");
      const textBody = await textPage.json();
      assert.equal(textBody.code, "EINK_UNFIT");
      assert.equal(textBody.error, "不适配墨水屏单页");
      assert.deepEqual(textBody.reasons, [EINK_UNFIT_REASONS.TEXT]);

      const photoPage = await fetch(
        `${baseUrl}/api/eink/page?id=${unfitPhoto.id}`
      );
      assert.equal(photoPage.status, 409);
      assert.deepEqual(
        (await photoPage.json()).reasons,
        [EINK_UNFIT_REASONS.PHOTO]
      );

      const unfitPreview = await fetch(
        `${baseUrl}/api/eink/preview?id=${unfitText.id}`
      );
      assert.equal(unfitPreview.status, 200);
      assert.equal(
        unfitPreview.headers.get("content-type"),
        "image/png"
      );
      assert.equal(unfitPreview.headers.get("cache-control"), "no-store");
      assert.equal(unfitPreview.headers.get("x-eink-unfit"), "1");
      const notice = await sharp(
        Buffer.from(await unfitPreview.arrayBuffer())
      ).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      assert.equal(notice.info.width, EINK_WIDTH);
      assert.equal(notice.info.height, EINK_HEIGHT);
      assert.ok(countBlackPixels(notice) > 0);

      const fitPreview = await fetch(
        `${baseUrl}/api/eink/preview?id=${fit.id}`
      );
      assert.equal(fitPreview.status, 200);
      assert.equal(fitPreview.headers.get("x-eink-unfit"), null);
      await fitPreview.arrayBuffer();

      const fixed = await fetch(
        `${baseUrl}/api/mistakes/${unfitText.id}/update`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "eink-unfit-fix-1"
          },
          body: JSON.stringify({
            question: "短题干恢复显示。",
            studentAnswer: "略",
            correctAnswer: "略",
            analysis: "略",
            knowledgePoint: "圆",
            errorType: "其他"
          })
        }
      );
      assert.equal(fixed.status, 200);
      const queueAfter = await (
        await fetch(`${baseUrl}/api/eink/queue`)
      ).json();
      assert.equal(queueAfter.count, 2);
      assert.deepEqual(
        queueAfter.items.map((item) => item.id).sort(),
        [fit.id, unfitText.id].sort()
      );
      assert.deepEqual(
        queueAfter.items.map((item) => item.index),
        [1, 2]
      );
      const fixedPage = await fetch(
        `${baseUrl}/api/eink/page?id=${unfitText.id}`
      );
      assert.equal(fixedPage.status, 200);
      assert.equal(
        (await fixedPage.arrayBuffer()).byteLength,
        48_000
      );

      const logs = server.logs();
      assert.match(logs, /status=409/);
      assert.match(logs, /preview=unfit/);
    } finally {
      await stopServer(child);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
);