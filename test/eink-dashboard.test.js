import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { LearningRepository } from "../src/database.js";
import { AttachmentStore } from "../src/attachments.js";
import {
  EINK_QUOTES,
  buildDashboardCalendar,
  dashboardSvg,
  formatDashboardDate,
  formatDueCount,
  renderEinkDashboard,
  selectDailyQuote
} from "../src/eink/dashboard.js";
import {
  EinkPageService,
  dashboardEtag
} from "../src/eink/service.js";
import {
  EINK_FRAME_BYTES,
  EINK_HEIGHT,
  EINK_WIDTH
} from "../src/eink/render.js";
import { startServer, stopServer } from "./helpers/http-fixture.js";

function createMistake(repository) {
  return repository.createMistake({
    question: "看板测试题",
    studentAnswer: "1",
    correctAnswer: "2",
    analysis: "测试解析",
    knowledgePoint: "百分数",
    errorType: "计算错误"
  });
}

test("看板日期、周一起始日历、到期数和语录规则稳定", async () => {
  assert.equal(formatDashboardDate("2026-11-23"), "2026年11月23日  周一");
  assert.equal(formatDueCount(0), "0");
  assert.equal(formatDueCount(999), "999");
  assert.equal(formatDueCount(1000), "999+");

  const calendar = buildDashboardCalendar("2026-11", [
    { date: "2026-11-23", hasActivity: true }
  ]);
  assert.equal(calendar.length, 42);
  const firstDay = calendar.find((cell) => !cell.blank);
  assert.equal(calendar.indexOf(firstDay), 6);
  assert.equal(firstDay.day, 1);
  assert.equal(
    calendar.find((cell) => cell.date === "2026-11-23").hasActivity,
    true
  );

  const quote = selectDailyQuote("2026-11-23");
  assert.equal(quote, selectDailyQuote("2026-11-23"));
  assert.ok(EINK_QUOTES.includes(quote));

  const model = {
    dateKey: "2026-11-23",
    monthKey: "2026-11",
    dueCount: 12,
    dueAvailable: true,
    calendarAvailable: true,
    calendarDays: [
      { date: "2026-11-23", hasActivity: true }
    ],
    quote
  };
  const svg = dashboardSvg(model);
  assert.match(svg, /学习看板/);
  assert.match(svg, /2026年11月23日/);
  assert.match(svg, /11月学习日历/);
  assert.match(svg, />12</);
  assert.match(svg, /道题待复习/);
  assert.equal(
    [...svg.matchAll(/class="completion-check"/g)].length,
    1
  );
  assert.match(
    svg,
    /<path class="completion-check" d="M [\d.]+ [\d.]+ L [\d.]+ [\d.]+ L [\d.]+ [\d.]+"/
  );
  assert.doesNotMatch(svg, /<circle/);
  assert.doesNotMatch(svg, /✓|✔|😊|☺/);
  assert.doesNotMatch(
    dashboardSvg({ ...model, calendarDays: [] }),
    /class="completion-check"/
  );

  const rendered = await renderEinkDashboard(model);
  assert.equal(rendered.frame.length, EINK_FRAME_BYTES);
  assert.equal(rendered.frame.length, 48_000);
  const png = await sharp(rendered.png).metadata();
  assert.equal(png.width, EINK_WIDTH);
  assert.equal(png.height, EINK_HEIGHT);
  assert.notEqual(
    dashboardEtag(model, rendered.frame),
    dashboardEtag(
      { ...model, quoteVersion: "eink-quotes-next" },
      rendered.frame
    )
  );
});

test("看板服务缓存、到期变化和数据不可用状态", async () => {
  const repository = new LearningRepository();
  const store = new AttachmentStore({
    directory: repository.attachmentDirectory || fs.mkdtempSync(
      path.join(os.tmpdir(), "math-coach-eink-dashboard-store-")
    )
  });
  const mistake = createMistake(repository);
  repository.db
    .prepare(
      `UPDATE review_schedule
       SET next_review_at = '2026-11-20T00:00:00.000Z'
       WHERE mistake_id = ? AND active = 1`
    )
    .run(mistake.id);
  repository.db
    .prepare(
      "UPDATE mistakes SET due_at = '2026-11-20T00:00:00.000Z' WHERE id = ?"
    )
    .run(mistake.id);
  repository.db
    .prepare(
      `INSERT INTO attempts (
        mistake_id, answer, is_correct, feedback, created_at, outcome
      ) VALUES (?, '1', 0, '测试', ?, 'incorrect')`
    )
    .run(mistake.id, "2026-11-23T01:00:00.000Z");
  const service = new EinkPageService({
    repository,
    attachmentStore: store
  });
  const readOnlyBefore = repository.db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM attempts) AS attempts,
        (SELECT COUNT(*) FROM hint_events) AS hints,
        (SELECT COUNT(*) FROM review_schedule) AS schedules`
    )
    .get();
  const now = new Date("2026-11-23T04:00:00.000Z");
  const first = await service.getDashboard({ now });
  const second = await service.getDashboard({ now });
  const readOnlyAfter = repository.db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM attempts) AS attempts,
        (SELECT COUNT(*) FROM hint_events) AS hints,
        (SELECT COUNT(*) FROM review_schedule) AS schedules`
    )
    .get();
  assert.deepEqual(readOnlyAfter, readOnlyBefore);
  assert.equal(first.model.dueCount, 1);
  assert.equal(first.model.dueAvailable, true);
  assert.equal(
    first.model.calendarDays.find(
      (day) => day.date === "2026-11-23"
    ).hasActivity,
    true
  );
  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  assert.equal(first.etag, second.etag);

  repository.db
    .prepare(
      `INSERT INTO attempts (
        mistake_id, answer, is_correct, feedback, created_at, outcome
      ) VALUES (?, '1', 0, '测试', ?, 'incorrect')`
    )
    .run(mistake.id, "2026-11-22T01:00:00.000Z");
  const activityChanged = await service.getDashboard({ now });
  assert.notEqual(activityChanged.etag, first.etag);

  const secondMistake = createMistake(repository);
  repository.db
    .prepare(
      `UPDATE review_schedule
       SET next_review_at = '2026-11-20T00:00:00.000Z'
       WHERE mistake_id = ? AND active = 1`
    )
    .run(secondMistake.id);
  repository.db
    .prepare(
      "UPDATE mistakes SET due_at = '2026-11-20T00:00:00.000Z' WHERE id = ?"
    )
    .run(secondMistake.id);
  const changed = await service.getDashboard({ now });
  assert.equal(changed.model.dueCount, 2);
  assert.notEqual(changed.etag, first.etag);
  repository.close();

  const unavailableService = new EinkPageService({
    repository: {
      getStudent() {
        throw new Error("database unavailable");
      },
      countDueReviews() {
        throw new Error("database unavailable");
      },
      buildFeedbackCalendar() {
        throw new Error("database unavailable");
      }
    },
    attachmentStore: store
  });
  const unavailable = await unavailableService.getDashboard({ now });
  assert.equal(unavailable.frame.length, 48_000);
  assert.equal(unavailable.model.dueAvailable, false);
  assert.equal(unavailable.model.calendarAvailable, false);
  assert.equal(unavailable.model.calendarDays.length, 0);
  assert.match(dashboardSvg(unavailable.model), /数据暂不可用/);
});

test(
  "HTTP 看板返回 48000 字节、强 ETag、304 且无 preview",
  { timeout: 30_000 },
  async () => {
    const { child, directory, baseUrl } = await startServer({
      prefix: "math-coach-eink-dashboard-http-"
    });
    try {
      const create = await fetch(`${baseUrl}/api/mistakes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: "HTTP 看板测试题",
          studentAnswer: "1",
          correctAnswer: "2",
          analysis: "测试",
          knowledgePoint: "百分数",
          errorType: "计算错误"
        })
      });
      assert.equal(create.status, 201);
      const mistake = await create.json();
      const attempt = await fetch(
        `${baseUrl}/api/mistakes/${mistake.id}/attempts`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            answer: "1",
            independent: true,
            hintLevel: 0
          })
        }
      );
      assert.equal(attempt.status, 200);
      await attempt.arrayBuffer();

      const dashboard = await fetch(`${baseUrl}/api/eink/dashboard`);
      assert.equal(dashboard.status, 200);
      assert.equal(
        dashboard.headers.get("content-type"),
        "application/octet-stream"
      );
      assert.equal(dashboard.headers.get("content-length"), "48000");
      assert.equal(dashboard.headers.get("content-encoding"), null);
      assert.equal(dashboard.headers.get("cache-control"), "no-transform");
      assert.equal(
        dashboard.headers.get("x-content-type-options"),
        "nosniff"
      );
      const etag = dashboard.headers.get("etag");
      assert.match(etag, /^"[0-9a-f]{64}"$/);
      assert.equal(dashboard.headers.get("x-etag"), etag);
      assert.equal((await dashboard.arrayBuffer()).byteLength, 48_000);

      const cached = await fetch(`${baseUrl}/api/eink/dashboard`, {
        headers: { "If-None-Match": etag }
      });
      assert.equal(cached.status, 304);
      assert.equal(cached.headers.get("content-length"), null);
      assert.equal((await cached.arrayBuffer()).byteLength, 0);

      const secondCreate = await fetch(`${baseUrl}/api/mistakes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: "第二道到期题",
          correctAnswer: "3",
          knowledgePoint: "圆",
          errorType: "不会做"
        })
      });
      assert.equal(secondCreate.status, 201);
      await secondCreate.arrayBuffer();
      const changed = await fetch(`${baseUrl}/api/eink/dashboard`);
      assert.equal(changed.status, 200);
      assert.notEqual(changed.headers.get("etag"), etag);
      assert.equal((await changed.arrayBuffer()).byteLength, 48_000);

      const preview = await fetch(
        `${baseUrl}/api/eink/dashboard/preview`
      );
      assert.equal(preview.status, 404);
      await preview.arrayBuffer();
    } finally {
      await stopServer(child);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
);
