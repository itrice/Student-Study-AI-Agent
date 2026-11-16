import test from "node:test";
import assert from "node:assert/strict";
import { LearningRepository } from "../src/database.js";

function createMistake(repository, overrides = {}) {
  return repository.createMistake({
    question: "一件商品原价 100 元，涨价 20% 后是多少元？",
    studentAnswer: "100元",
    correctAnswer: "120元",
    analysis: "先求涨价部分，再与 100 元相加。",
    knowledgePoint: "百分数",
    errorType: "单位“1”找错",
    ...overrides
  });
}

function insertAttempt(
  repository,
  mistakeId,
  { at, outcome = "incorrect", correct = false, answer = "测试作答" }
) {
  repository.db
    .prepare(
      `INSERT INTO attempts (
        mistake_id, answer, is_correct, feedback, created_at, outcome
      ) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(mistakeId, answer, correct ? 1 : 0, "测试反馈", at, outcome);
}

function insertHint(repository, mistakeId, { at, level = 1, content = "提示正文" }) {
  repository.db
    .prepare(
      `INSERT INTO hint_events (
        mistake_id, attempt_id, agent_run_id, hint_level, content, source, created_at
      ) VALUES (?, NULL, NULL, ?, ?, ?, ?)`
    )
    .run(mistakeId, level, content, "test", at);
}

function dayOf(calendar, date) {
  return calendar.days.find((day) => day.date === date);
}

test("空月份的日历仍有完整日期且汇总为零", () => {
  const repository = new LearningRepository();
  const calendar = repository.buildFeedbackCalendar({ month: "2026-02" });
  assert.equal(calendar.month, "2026-02");
  assert.equal(calendar.days.length, 28);
  assert.equal(calendar.days[0].date, "2026-02-01");
  assert.equal(calendar.days.at(-1).date, "2026-02-28");
  for (const day of calendar.days) {
    assert.deepEqual(
      {
        completedCount: day.completedCount,
        correctCount: day.correctCount,
        attemptCount: day.attemptCount,
        hintCount: day.hintCount,
        hasActivity: day.hasActivity
      },
      {
        completedCount: 0,
        correctCount: 0,
        attemptCount: 0,
        hintCount: 0,
        hasActivity: false
      }
    );
  }
  assert.deepEqual(calendar.summary, {
    checkInDays: 0,
    completedCount: 0,
    correctCount: 0
  });
  assert.match(calendar.today, /^\d{4}-\d{2}-\d{2}$/);
  repository.close();
});

test("空日期明细返回零汇总和空列表", () => {
  const repository = new LearningRepository();
  const detail = repository.buildFeedbackDay({ date: "2026-02-28" });
  assert.equal(detail.date, "2026-02-28");
  assert.deepEqual(detail.summary, {
    completedCount: 0,
    attemptCount: 0,
    correctCount: 0,
    needsCorrectionCount: 0
  });
  assert.deepEqual(detail.items, []);
  repository.close();
});

test("跨月边界按 Asia/Shanghai 自然日切分", () => {
  const repository = new LearningRepository();
  const mistake = createMistake(repository);
  insertAttempt(repository, mistake.id, {
    at: "2026-10-31T15:59:59.999Z",
    outcome: "incorrect",
    correct: false
  });
  insertAttempt(repository, mistake.id, {
    at: "2026-10-31T16:00:00.000Z",
    outcome: "correct",
    correct: true
  });

  const october = repository.buildFeedbackCalendar({ month: "2026-10" });
  const october31 = dayOf(october, "2026-10-31");
  assert.equal(october31.attemptCount, 1);
  assert.equal(october31.completedCount, 1);
  assert.equal(october31.correctCount, 0);
  assert.equal(dayOf(october, "2026-11-01"), undefined);

  const november = repository.buildFeedbackCalendar({ month: "2026-11" });
  const november1 = dayOf(november, "2026-11-01");
  assert.equal(november1.attemptCount, 1);
  assert.equal(november1.completedCount, 1);
  assert.equal(november1.correctCount, 1);
  assert.equal(dayOf(november, "2026-10-31"), undefined);

  const octoberDetail = repository.buildFeedbackDay({ date: "2026-10-31" });
  assert.equal(octoberDetail.summary.attemptCount, 1);
  assert.equal(octoberDetail.summary.correctCount, 0);
  const novemberDetail = repository.buildFeedbackDay({ date: "2026-11-01" });
  assert.equal(novemberDetail.summary.attemptCount, 1);
  assert.equal(novemberDetail.summary.correctCount, 1);
  repository.close();
});

test("同题多次作答聚合为一行，最近一次决定是否正确", () => {
  const repository = new LearningRepository();
  const first = createMistake(repository, { question: "第一道测试题" });
  const second = createMistake(repository, {
    question: "第二道测试题",
    knowledgePoint: "比和比例"
  });
  insertAttempt(repository, first.id, {
    at: "2026-11-16T00:00:00.000Z",
    outcome: "incorrect",
    correct: false
  });
  insertAttempt(repository, first.id, {
    at: "2026-11-16T01:00:00.000Z",
    outcome: "partial",
    correct: false
  });
  insertAttempt(repository, first.id, {
    at: "2026-11-16T02:00:00.000Z",
    outcome: "correct",
    correct: true
  });
  insertAttempt(repository, second.id, {
    at: "2026-11-16T03:00:00.000Z",
    outcome: "partial",
    correct: false
  });
  insertAttempt(repository, second.id, {
    at: "2026-11-16T04:00:00.000Z",
    outcome: "partial",
    correct: false
  });
  insertHint(repository, first.id, { at: "2026-11-16T00:30:00.000Z" });
  insertHint(repository, first.id, { at: "2026-11-16T00:40:00.000Z", level: 2 });
  insertHint(repository, second.id, { at: "2026-11-16T03:30:00.000Z" });

  const calendar = repository.buildFeedbackCalendar({ month: "2026-11" });
  const day = dayOf(calendar, "2026-11-16");
  assert.equal(day.attemptCount, 5);
  assert.equal(day.completedCount, 2);
  assert.equal(day.correctCount, 1);
  assert.equal(day.hintCount, 3);
  assert.equal(day.hasActivity, true);

  const detail = repository.buildFeedbackDay({ date: "2026-11-16" });
  assert.equal(detail.summary.completedCount, day.completedCount);
  assert.equal(detail.summary.attemptCount, day.attemptCount);
  assert.equal(detail.summary.correctCount, day.correctCount);
  assert.equal(detail.summary.needsCorrectionCount, 1);
  assert.equal(detail.items.length, 2);
  const firstItem = detail.items.find((item) => item.mistakeId === first.id);
  const secondItem = detail.items.find((item) => item.mistakeId === second.id);
  assert.equal(firstItem.attemptCount, 3);
  assert.equal(firstItem.hintCount, 2);
  assert.equal(firstItem.lastOutcome, "correct");
  assert.equal(secondItem.attemptCount, 2);
  assert.equal(secondItem.hintCount, 1);
  assert.equal(secondItem.lastOutcome, "partial");
  assert.equal(detail.items[0].lastAt, "2026-11-16T04:00:00.000Z");
  repository.close();
});

test("日明细不返回正确答案、原始作答或提示正文", () => {
  const repository = new LearningRepository();
  const mistake = createMistake(repository, {
    question: "唯一题目文本",
    studentAnswer: "学生原始答案",
    correctAnswer: "正确答案文本",
    knowledgePoint: "百分数"
  });
  insertAttempt(repository, mistake.id, {
    at: "2026-11-16T02:00:00.000Z",
    outcome: "incorrect",
    correct: false,
    answer: "原始作答内容"
  });
  insertHint(repository, mistake.id, {
    at: "2026-11-16T02:30:00.000Z",
    content: "提示正文内容"
  });

  const detail = repository.buildFeedbackDay({ date: "2026-11-16" });
  const serialized = JSON.stringify(detail);
  assert.doesNotMatch(serialized, /正确答案文本/);
  assert.doesNotMatch(serialized, /学生原始答案/);
  assert.doesNotMatch(serialized, /原始作答内容/);
  assert.doesNotMatch(serialized, /提示正文内容/);
  assert.equal(detail.items[0].question, "唯一题目文本");
  repository.close();
});

test("映射失败的错题在日明细中标记为待归类", () => {
  const repository = new LearningRepository();
  const mistake = createMistake(repository, { question: "待归类测试题" });
  repository.db
    .prepare(
      "UPDATE mistakes SET curriculum_status='unmapped', curriculum_point_id=NULL WHERE id=?"
    )
    .run(mistake.id);
  insertAttempt(repository, mistake.id, {
    at: "2026-11-16T05:00:00.000Z",
    outcome: "incorrect",
    correct: false
  });
  const detail = repository.buildFeedbackDay({ date: "2026-11-16" });
  assert.equal(detail.items.length, 1);
  assert.equal(detail.items[0].unitMapped, false);
  assert.equal(detail.items[0].unitTitle, "");
  repository.close();
});
