import test from "node:test";
import assert from "node:assert/strict";
import {
  LEARNING_POLICY_VERSION,
  REVIEW_INTERVAL_DAYS,
  evaluateAttemptState,
  evaluateMistakeAttempt
} from "../src/domain/learning-policy.js";

test("领域策略保持现有答题、复习和掌握规则", () => {
  const now = new Date("2026-11-09T00:00:00.000Z");
  const mistake = {
    correctAnswer: "120元",
    consecutiveCorrect: 1
  };

  const firstCorrect = evaluateMistakeAttempt({
    mistake: { ...mistake, consecutiveCorrect: 0 },
    answer: "120",
    independent: true,
    now
  });
  assert.equal(firstCorrect.correct, true);
  assert.equal(firstCorrect.mastered, false);
  assert.equal(firstCorrect.nextStatus, "practicing");
  assert.equal(firstCorrect.nextConsecutiveCorrect, 1);
  assert.equal(firstCorrect.dueAt, "2026-11-10T00:00:00.000Z");
  assert.equal(firstCorrect.independentEvidence, true);

  const secondCorrect = evaluateMistakeAttempt({
    mistake,
    answer: "120元",
    independent: false,
    hintLevel: 2,
    now
  });
  assert.equal(secondCorrect.correct, true);
  assert.equal(secondCorrect.mastered, false);
  assert.equal(secondCorrect.nextStatus, "practicing");
  assert.equal(secondCorrect.nextConsecutiveCorrect, 0);
  assert.equal(secondCorrect.dueAt, "2026-11-10T00:00:00.000Z");
  assert.equal(secondCorrect.independentEvidence, false);
  assert.equal(secondCorrect.usedHint, true);
  assert.equal(secondCorrect.policyVersion, LEARNING_POLICY_VERSION);

  const independentMastery = evaluateMistakeAttempt({
    mistake,
    answer: "120元",
    independent: true,
    now
  });
  assert.equal(independentMastery.mastered, true);
  assert.equal(independentMastery.nextStatus, "mastered");
  assert.equal(independentMastery.nextConsecutiveCorrect, 2);

  const wrong = evaluateMistakeAttempt({
    mistake,
    answer: "100元",
    now
  });
  assert.equal(wrong.correct, false);
  assert.equal(wrong.nextStatus, "practicing");
  assert.equal(wrong.nextConsecutiveCorrect, 0);
  assert.equal(wrong.dueAt, "2026-11-10T00:00:00.000Z");
});

test("掌握状态会因回顾失败回到巩固，并重新积累独立答对次数", () => {
  const now = new Date("2026-11-09T00:00:00.000Z");
  const masteredMistake = {
    correctAnswer: "120元",
    status: "mastered",
    consecutiveCorrect: 2
  };

  const failedReview = evaluateMistakeAttempt({
    mistake: masteredMistake,
    answer: "100元",
    independent: true,
    now
  });
  assert.equal(failedReview.nextStatus, "relearning");
  assert.equal(failedReview.previousStatus, "mastered");
  assert.equal(failedReview.nextConsecutiveCorrect, 0);
  assert.equal(failedReview.reviewReason, "mastery_lost");
  assert.equal(failedReview.evidenceType, "mastery_lost");

  const hintedReview = evaluateMistakeAttempt({
    mistake: masteredMistake,
    answer: "120元",
    independent: false,
    hintLevel: 2,
    now
  });
  assert.equal(hintedReview.nextStatus, "relearning");
  assert.equal(hintedReview.mastered, false);

  const firstRecovery = evaluateAttemptState({
    mistake: { ...masteredMistake, status: "relearning", consecutiveCorrect: 0 },
    correct: true,
    independent: true,
    now
  });
  assert.equal(firstRecovery.nextStatus, "practicing");
  assert.equal(firstRecovery.nextConsecutiveCorrect, 1);

  const secondRecovery = evaluateAttemptState({
    mistake: { ...masteredMistake, status: "relearning", consecutiveCorrect: 1 },
    correct: true,
    independent: true,
    now
  });
  assert.equal(secondRecovery.nextStatus, "mastered");
  assert.equal(secondRecovery.nextConsecutiveCorrect, 2);
});

test("已掌握题目的回顾间隔会逐步拉长", () => {
  const now = new Date("2026-11-09T00:00:00.000Z");
  const base = {
    correctAnswer: "120元",
    status: "mastered"
  };
  const firstReview = evaluateAttemptState({
    mistake: { ...base, consecutiveCorrect: 2 },
    correct: true,
    independent: true,
    now
  });
  assert.equal(firstReview.nextStatus, "mastered");
  assert.equal(firstReview.intervalDays, REVIEW_INTERVAL_DAYS.masteryReview);
  assert.equal(firstReview.evidenceType, "mastery_review_confirmed");

  const secondReview = evaluateAttemptState({
    mistake: { ...base, consecutiveCorrect: 3 },
    correct: true,
    independent: true,
    now
  });
  assert.equal(secondReview.intervalDays, REVIEW_INTERVAL_DAYS.masteryReviewLong);
});
