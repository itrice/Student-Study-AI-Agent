import { answersMatch } from "../agent.js";

export const LEARNING_POLICY_VERSION = "v0.1-legacy-compatible";

export function toIsoAfterDays(days, now = new Date()) {
  const date = new Date(now);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
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
  const nextConsecutiveCorrect = correct && independent === true
    ? mistake.consecutiveCorrect + 1
    : 0;
  const mastered =
    correct && independent === true && nextConsecutiveCorrect >= 2;
  const nextStatus = mastered ? "mastered" : "practicing";
  const dueDays = correct ? (mastered ? 7 : 1) : 1;
  const dueAt = toIsoAfterDays(dueDays, now);
  const feedback =
    outcome === "partial"
      ? `这次答对了 ${correctPartCount}/${totalPartCount} 个小问。补全错误小问后，明天再独立重做。`
      : correct
        ? mastered
          ? "连续两次独立做对，已标记为掌握。7 天后再回顾一次。"
          : independent === true
            ? "这次独立做对了。明天再独立做一次，确认不是临时记住答案。"
            : "这次在提示帮助下做对了。掌握次数未增加，明天需要独立完成整题。"
        : "这次还没做对。先对照讲解补全缺失步骤，明天再独立重做。";

  return {
    correct,
    outcome,
    mastered,
    nextStatus,
    nextConsecutiveCorrect,
    dueAt,
    feedback,
    policyVersion: LEARNING_POLICY_VERSION,
    independentEvidence: independent === true,
    usedHint: independent === false || Number(hintLevel || 0) > 0
  };
}
