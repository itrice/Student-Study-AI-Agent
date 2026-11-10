import { answersMatch } from "../agent.js";

export const LEARNING_POLICY_VERSION = "m6-v1";

export const MASTERY_STREAK_REQUIRED = 2;

export const REVIEW_INTERVAL_DAYS = Object.freeze({
  newMistake: 0,
  consolidation: 1,
  mastery: 7,
  masteryReview: 14,
  masteryReviewLong: 30
});

export const LEARNING_STATUSES = Object.freeze([
  "new",
  "practicing",
  "mastered",
  "relearning"
]);

export function isLearningStatus(value) {
  return LEARNING_STATUSES.includes(value);
}

export function toIsoAfterDays(days, now = new Date()) {
  const date = new Date(now);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function resolveNextStatus({
  previousStatus,
  correct,
  independent,
  nextConsecutiveCorrect
}) {
  const masteryReached =
    correct &&
    independent === true &&
    nextConsecutiveCorrect >= MASTERY_STREAK_REQUIRED;
  if (masteryReached) return "mastered";
  if (previousStatus === "mastered") return "relearning";
  if (previousStatus === "relearning" && (!correct || independent !== true)) {
    return "relearning";
  }
  return "practicing";
}

function resolveIntervalDays({ nextStatus, nextConsecutiveCorrect }) {
  if (nextStatus !== "mastered") {
    return REVIEW_INTERVAL_DAYS.consolidation;
  }
  if (nextConsecutiveCorrect === MASTERY_STREAK_REQUIRED) {
    return REVIEW_INTERVAL_DAYS.mastery;
  }
  if (nextConsecutiveCorrect === MASTERY_STREAK_REQUIRED + 1) {
    return REVIEW_INTERVAL_DAYS.masteryReview;
  }
  return REVIEW_INTERVAL_DAYS.masteryReviewLong;
}

function resolveReviewReason({
  previousStatus,
  nextStatus,
  correct,
  independent,
  outcome
}) {
  if (nextStatus === "mastered") {
    return previousStatus === "mastered"
      ? "mastery_review"
      : "mastery_achieved";
  }
  if (nextStatus === "relearning") {
    return "mastery_lost";
  }
  if (!correct) {
    return outcome === "partial" ? "partial_attempt" : "incorrect_attempt";
  }
  if (independent !== true) {
    return "hint_assisted_correct";
  }
  return "independent_correct";
}

function resolveEvidenceType({
  previousStatus,
  nextStatus,
  correct,
  independent
}) {
  if (nextStatus === "mastered") {
    return previousStatus === "mastered"
      ? "mastery_review_confirmed"
      : "mastery_confirmed";
  }
  if (nextStatus === "relearning") {
    return "mastery_lost";
  }
  if (previousStatus === "relearning") {
    return correct ? "relearning_progress" : "relearning_failed";
  }
  if (!correct) return "practice_failed";
  if (independent !== true) return "hint_assisted_correct";
  return "practice_progress";
}

function buildFeedback({
  outcome,
  correct,
  independent,
  previousStatus,
  nextStatus,
  intervalDays,
  correctPartCount,
  totalPartCount
}) {
  if (outcome === "partial") {
    return `这次答对了 ${correctPartCount}/${totalPartCount} 个小问。补全错误小问后，${intervalDays} 天后再独立重做。`;
  }
  if (!correct) {
    return previousStatus === "mastered"
      ? `这次回顾没有独立做对，已回到巩固阶段。先补全缺失步骤，${intervalDays} 天后再独立重做。`
      : `这次还没做对。先对照讲解补全缺失步骤，${intervalDays} 天后再独立重做。`;
  }
  if (nextStatus === "mastered") {
    return previousStatus === "mastered"
      ? `这次独立回顾正确，掌握状态保持。${intervalDays} 天后再回顾一次。`
      : `连续两次独立做对，已标记为掌握。${intervalDays} 天后再回顾一次。`;
  }
  if (independent !== true) {
    return `这次在提示帮助下做对了。提示帮助不计入独立掌握，${intervalDays} 天后再独立完成整题。`;
  }
  return `这次独立做对了。${intervalDays} 天后再独立做一次，确认不是临时记住答案。`;
}

export function evaluateMistakeAttempt({
  mistake,
  answer,
  independent = null,
  hintLevel = null,
  now = new Date()
}) {
  const correct = answersMatch(answer, mistake.correctAnswer);
  return evaluateAttemptState({
    mistake,
    correct,
    outcome: correct ? "correct" : "incorrect",
    independent,
    hintLevel,
    now
  });
}

export function evaluateAttemptState({
  mistake,
  correct,
  outcome = correct ? "correct" : "incorrect",
  correctPartCount = null,
  totalPartCount = null,
  independent = null,
  hintLevel = null,
  now = new Date()
}) {
  const previousStatus = isLearningStatus(mistake.status)
    ? mistake.status
    : "new";
  const nextConsecutiveCorrect =
    correct && independent === true
      ? Number(mistake.consecutiveCorrect || 0) + 1
      : 0;
  const nextStatus = resolveNextStatus({
    previousStatus,
    correct,
    independent,
    nextConsecutiveCorrect
  });
  const intervalDays = resolveIntervalDays({
    nextStatus,
    nextConsecutiveCorrect
  });
  const dueAt = toIsoAfterDays(intervalDays, now);
  const reviewReason = resolveReviewReason({
    previousStatus,
    nextStatus,
    correct,
    independent,
    outcome
  });
  const evidenceType = resolveEvidenceType({
    previousStatus,
    nextStatus,
    correct,
    independent
  });

  return {
    correct,
    outcome,
    mastered: nextStatus === "mastered",
    previousStatus,
    nextStatus,
    statusChanged: nextStatus !== previousStatus,
    nextConsecutiveCorrect,
    dueAt,
    intervalDays,
    reviewReason,
    evidenceType,
    feedback: buildFeedback({
      outcome,
      correct,
      independent,
      previousStatus,
      nextStatus,
      intervalDays,
      correctPartCount,
      totalPartCount
    }),
    policyVersion: LEARNING_POLICY_VERSION,
    independentEvidence: independent === true,
    usedHint: independent === false || Number(hintLevel || 0) > 0
  };
}
