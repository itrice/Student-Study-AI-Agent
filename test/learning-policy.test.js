import test from "node:test";
import assert from "node:assert/strict";
import {
  LEARNING_POLICY_VERSION,
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
