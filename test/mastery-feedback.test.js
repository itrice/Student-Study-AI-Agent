import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LearningRepository } from "../src/database.js";
import {
  LEARNING_POLICY_VERSION,
  REVIEW_INTERVAL_DAYS
} from "../src/domain/learning-policy.js";

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

function withTemporaryDirectory(callback) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "math-coach-m6-")
  );
  try {
    return callback(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("每次状态变化都有可追溯到作答或内容变更的证据", () => {
  const repository = new LearningRepository();
  const mistake = createMistake(repository);

  const createdEvidence = repository.getMasteryEvidence(mistake.id);
  assert.equal(createdEvidence.length, 1);
  assert.equal(createdEvidence[0].evidenceType, "created");
  assert.equal(createdEvidence[0].nextStatus, "new");
  assert.equal(createdEvidence[0].attemptId, null);
  assert.ok(repository.getActiveReviewSchedule(mistake.id));

  const wrong = repository.recordAttempt(mistake.id, "100元", {
    independent: true
  });
  assert.equal(wrong.nextStatus, "practicing");
  assert.equal(wrong.previousStatus, "new");
  assert.equal(wrong.statusChanged, true);

  const firstCorrect = repository.recordAttempt(mistake.id, "120元", {
    independent: true
  });
  assert.equal(firstCorrect.nextStatus, "practicing");
  assert.equal(firstCorrect.mastered, false);

  const mastered = repository.recordAttempt(mistake.id, "120元", {
    independent: true
  });
  assert.equal(mastered.nextStatus, "mastered");
  assert.equal(mastered.statusChanged, true);
  assert.equal(mastered.intervalDays, REVIEW_INTERVAL_DAYS.mastery);

  const lost = repository.recordAttempt(mistake.id, "100元", {
    independent: true
  });
  assert.equal(lost.nextStatus, "relearning");
  assert.equal(lost.reviewReason, "mastery_lost");

  const evidence = repository.getMasteryEvidence(mistake.id);
  assert.equal(evidence.length, 5);
  const attemptEvidence = evidence.filter((item) => item.attemptId !== null);
  assert.equal(attemptEvidence.length, 4);
  for (const item of attemptEvidence) {
    assert.equal(item.ruleVersion, LEARNING_POLICY_VERSION);
    assert.ok(item.attempt);
    assert.ok(item.previousStatus);
    assert.ok(item.nextStatus);
  }
  const latest = evidence.at(-1);
  assert.equal(latest.attemptId, lost.attemptId);
  assert.equal(latest.previousStatus, "mastered");
  assert.equal(latest.nextStatus, "relearning");
  assert.equal(repository.getMistake(mistake.id).status, latest.nextStatus);

  const schedule = repository.getActiveReviewSchedule(mistake.id);
  assert.equal(schedule.mistakeId, mistake.id);
  assert.equal(schedule.active, true);
  assert.equal(schedule.id, latest.reviewScheduleId);
  assert.equal(schedule.intervalDays, REVIEW_INTERVAL_DAYS.consolidation);
  repository.close();
});

test("已掌握题目到期后进入复习队列，重启后顺序保持一致", () => {
  withTemporaryDirectory((directory) => {
    const databasePath = path.join(directory, "learning.sqlite");
    const repository = new LearningRepository(databasePath);
    const mistake = createMistake(repository);
    repository.recordAttempt(mistake.id, "120元", { independent: true });
    repository.recordAttempt(mistake.id, "120元", { independent: true });

    assert.equal(repository.getMistake(mistake.id).status, "mastered");
    assert.equal(repository.getNextReview(), null);

    const past = "2026-01-01T00:00:00.000Z";
    repository.db
      .prepare(
        `UPDATE review_schedule
         SET next_review_at = ?
         WHERE mistake_id = ? AND active = 1`
      )
      .run(past, mistake.id);
    repository.db
      .prepare("UPDATE mistakes SET due_at = ? WHERE id = ?")
      .run(past, mistake.id);
    assert.equal(repository.getNextReview().id, mistake.id);
    assert.equal(repository.listDueReviews({ limit: 5 }).length, 1);
    const before = repository.getActiveReviewSchedule(mistake.id);
    repository.close();

    const reopened = new LearningRepository(databasePath);
    assert.equal(reopened.getNextReview().id, mistake.id);
    assert.deepEqual(
      reopened.listDueReviews({ limit: 5 }).map((item) => item.id),
      [mistake.id]
    );
    assert.deepEqual(
      reopened.getActiveReviewSchedule(mistake.id),
      before
    );
    assert.equal(
      reopened.db
        .prepare(
          `SELECT COUNT(*) AS count FROM review_schedule
           WHERE mistake_id = ? AND active = 1`
        )
        .get(mistake.id).count,
      1
    );
    reopened.close();
  });
});

test("修改关键题目字段会回到巩固流程并记录重置证据", () => {
  const repository = new LearningRepository();
  const mistake = createMistake(repository);
  repository.recordAttempt(mistake.id, "120元", { independent: true });
  repository.recordAttempt(mistake.id, "120元", { independent: true });
  assert.equal(repository.getMistake(mistake.id).status, "mastered");

  const result = repository.updateMistake(mistake.id, {
    question: "一件商品原价 200 元，涨价 20% 后是多少元？",
    correctAnswer: "240元"
  });
  assert.equal(result.learningReset, true);
  const updated = repository.getMistake(mistake.id);
  assert.equal(updated.status, "new");
  assert.equal(updated.attemptCount, 0);
  assert.ok(updated.dueAt);

  const evidence = repository.getMasteryEvidence(mistake.id).at(-1);
  assert.equal(evidence.evidenceType, "learning_reset");
  assert.equal(evidence.previousStatus, "mastered");
  assert.equal(evidence.nextStatus, "new");
  assert.equal(evidence.attemptId, null);
  assert.deepEqual(evidence.detail.changedFields.sort(), [
    "correctAnswer",
    "question"
  ]);
  assert.equal(repository.getNextReview().id, mistake.id);
  repository.close();
});

test("模型评价只能补充说明，不能直接改掌握状态", () => {
  const repository = new LearningRepository();
  const mistake = createMistake(repository);
  const attempt = repository.recordAttempt(mistake.id, "100元", {
    independent: true
  });
  assert.equal(attempt.nextStatus, "practicing");

  repository.saveAttemptEvaluation({
    attemptId: attempt.attemptId,
    outcome: "correct",
    finalAnswerAssessment: "模型认为可以标记掌握",
    masteryEvidence: ["模型希望直接改成 mastered"],
    feedback: "模型评价",
    provider: "test",
    model: "test-model",
    promptVersion: "test"
  });

  const stored = repository.getMistake(mistake.id);
  assert.equal(stored.status, "practicing");
  assert.equal(stored.consecutiveCorrect, 0);
  assert.equal(repository.getMasteryEvidence(mistake.id).at(-1).nextStatus, "practicing");
  repository.close();
});

test("学习统计与底层作答事实一致，并明确数据不足", () => {
  const repository = new LearningRepository();
  const mistake = createMistake(repository);
  repository.recordAttempt(mistake.id, "100元", { independent: true });
  repository.recordHint({
    mistakeId: mistake.id,
    hintLevel: 1,
    content: "先圈出单位“1”。",
    source: "test"
  });
  repository.recordAttempt(mistake.id, "120元", {
    independent: false,
    hintLevel: 1
  });

  const summary = repository.buildLearningSummary({
    from: "2026-01-01T00:00:00.000Z",
    to: "2027-01-01T00:00:00.000Z"
  });
  const sqlTotals = repository.db
    .prepare(
      `SELECT
        COUNT(*) AS attempts,
        SUM(CASE WHEN outcome = 'correct' THEN 1 ELSE 0 END) AS correct,
        SUM(CASE WHEN independent = 1 THEN 1 ELSE 0 END) AS independent,
        SUM(CASE WHEN independent = 0 THEN 1 ELSE 0 END) AS hint_dependent
       FROM attempts`
    )
    .get();
  assert.equal(summary.totals.attempts, sqlTotals.attempts);
  assert.equal(summary.totals.correctAttempts, sqlTotals.correct);
  assert.equal(summary.dependency.independentAttempts, sqlTotals.independent);
  assert.equal(
    summary.dependency.hintDependentAttempts,
    sqlTotals.hint_dependent
  );
  assert.equal(summary.totals.hints, 1);
  assert.equal(summary.rates.hintDependencyRate, 0.5);
  assert.equal(summary.dataStatus.hasData, true);

  const daily = repository.buildDailySummary({
    from: "2026-01-01T00:00:00.000Z",
    to: "2027-01-01T00:00:00.000Z",
    at: "2026-11-10T00:00:00.000Z"
  });
  assert.equal(daily.childSummary.headline, "今天完成了 2 次作答");
  assert.ok(daily.childSummary.sentences.some((line) => line.includes("1 次提示")));

  const emptyRepository = new LearningRepository();
  const emptyWeekly = emptyRepository.buildWeeklyReport({
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-01-07T23:59:59.999Z",
    at: "2026-11-10T00:00:00.000Z"
  });
  assert.equal(emptyWeekly.hasData, false);
  assert.equal(emptyWeekly.insufficientData, true);
  assert.deepEqual(emptyWeekly.parentReport.statements, []);
  assert.ok(
    emptyWeekly.parentReport.limitations.includes(
      "本周没有作答记录，无法判断掌握变化。"
    )
  );
  emptyRepository.close();
  repository.close();
});

test("历史回填证据不计入掌握变化，并明确历史导入边界", () => {
  const repository = new LearningRepository();
  const mistake = createMistake(repository);
  repository.insertMasteryEvidence({
    mistakeId: mistake.id,
    evidenceType: "legacy_backfill",
    ruleVersion: "legacy",
    previousStatus: "",
    nextStatus: "mastered",
    outcome: "correct",
    consecutiveIndependentCorrect: 2,
    reason: "legacy_attempt",
    createdAt: "2026-11-10T02:00:00.000Z"
  });

  const summary = repository.buildLearningSummary({
    from: "2026-11-03T00:00:00.000Z",
    to: "2026-11-10T23:59:59.999Z"
  });
  assert.equal(summary.masteryChanges.toMastered, 0);
  assert.equal(summary.masteryChanges.toRelearning, 0);
  assert.deepEqual(summary.masteryChanges.items, []);
  assert.equal(summary.dataStatus.hasLegacyEvidence, true);

  const weekly = repository.buildWeeklyReport({
    from: "2026-11-03T00:00:00.000Z",
    to: "2026-11-10T23:59:59.999Z",
    at: "2026-11-10T23:59:59.999Z"
  });
  assert.equal(weekly.masteryChanges.toMastered, 0);
  assert.ok(
    weekly.parentReport.limitations.includes(
      "历史导入的掌握证据不计入本周掌握变化统计。"
    )
  );
  assert.ok(
    weekly.parentReport.statements.every(
      (statement) => !statement.text.includes("进入已掌握状态")
    )
  );
  repository.close();
});

test("只改整题解析不会重置掌握，并保留小问提示与解析", () => {
  const repository = new LearningRepository();
  const mistake = createMistake(repository, {
    question: "甲队工作效率是1/5，乙队工作效率是1/6，求工作效率比和时间比。",
    knowledgePoint: "比和比例",
    correctAnswer: "6:5；5:6",
    parts: [
      {
        label: "工作效率比",
        prompt: "甲队和乙队的工作效率比",
        answerType: "ratio",
        knowledgePoint: "比和比例",
        acceptedAnswers: ["6:5"],
        hint: "先分别写出两队效率，再化成最简整数比。",
        explanation: "1/5:1/6=6:5。"
      },
      {
        label: "工作时间比",
        prompt: "甲队和乙队的工作时间比",
        answerType: "ratio",
        knowledgePoint: "比和比例",
        acceptedAnswers: ["5:6"],
        hint: "工作量相同时，时间比与效率比相反。",
        explanation: "时间比=1÷1/5:1÷1/6=5:6。"
      }
    ]
  });
  const beforeParts = repository.getMistake(mistake.id, {
    includeSolution: true
  }).parts;
  const answers = beforeParts.map((part) => ({
    partId: part.id,
    value: part.acceptedAnswers[0]
  }));
  repository.recordAttempt(mistake.id, "", {
    independent: true,
    answers
  });
  const mastered = repository.recordAttempt(mistake.id, "", {
    independent: true,
    answers
  });
  assert.equal(mastered.mastered, true);

  const updated = repository.updateMistake(mistake.id, {
    analysis: "修改后的整题解析，只补充说明，不改变题目内容。",
    parts: beforeParts.map((part) => ({
      label: part.label,
      prompt: part.prompt,
      studentAnswer: part.studentAnswer,
      answerType: part.answerType,
      comparisonRule: part.comparisonRule,
      knowledgePoint: part.knowledgePoint,
      acceptedAnswers: part.acceptedAnswers
    }))
  });
  assert.equal(updated.learningReset, false);
  assert.deepEqual(updated.changedFields, ["analysis"]);

  const after = repository.getMistake(mistake.id, { includeSolution: true });
  assert.equal(after.status, "mastered");
  assert.equal(after.attemptCount, 2);
  assert.equal(after.parts.length, 2);
  for (let index = 0; index < after.parts.length; index += 1) {
    assert.equal(after.parts[index].id, beforeParts[index].id);
    assert.equal(after.parts[index].hint, beforeParts[index].hint);
    assert.equal(
      after.parts[index].explanation,
      beforeParts[index].explanation
    );
  }
  repository.close();
});
