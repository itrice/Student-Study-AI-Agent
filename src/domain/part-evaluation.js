import { answersMatch, parseAnswerValue } from "../agent.js";

function normalizeText(value = "") {
  return String(value)
    .trim()
    .replace(/\s+/g, "")
    .replace(/[∶：]/g, ":");
}

function parseRatio(value) {
  const parts = normalizeText(value).split(":");
  if (parts.length !== 2) return null;
  const left = parseAnswerValue(parts[0]);
  const right = parseAnswerValue(parts[1]);
  if (!left || !right || right.number === 0) return null;
  if (
    left.unit &&
    right.unit &&
    left.unit !== right.unit
  ) {
    return null;
  }
  return { left: left.number, right: right.number };
}

function ratiosMatch(studentAnswer, acceptedAnswer) {
  const student = parseRatio(studentAnswer);
  const accepted = parseRatio(acceptedAnswer);
  if (!student || !accepted) return false;
  return (
    Math.abs(student.left * accepted.right - student.right * accepted.left) <
    1e-9
  );
}

export function comparePartAnswer({
  rawAnswer,
  acceptedAnswers,
  answerType = "auto",
  comparisonRule = "auto"
}) {
  const answer = String(rawAnswer || "").trim();
  if (!answer) return false;
  const rule =
    comparisonRule && comparisonRule !== "auto"
      ? comparisonRule
      : answerType;

  return acceptedAnswers.some((acceptedAnswer) => {
    if (rule === "ratio") {
      return ratiosMatch(answer, acceptedAnswer);
    }
    if (rule === "exact" || rule === "text") {
      return normalizeText(answer) === normalizeText(acceptedAnswer);
    }
    return answersMatch(answer, acceptedAnswer);
  });
}

export function evaluatePartResponses(parts, submittedAnswers = []) {
  const byId = new Map();
  const byNumber = new Map();
  for (const submitted of submittedAnswers) {
    if (submitted.partId !== undefined) {
      byId.set(Number(submitted.partId), String(submitted.value ?? ""));
    }
    if (submitted.partNo !== undefined) {
      byNumber.set(Number(submitted.partNo), String(submitted.value ?? ""));
    }
  }

  const results = parts.map((part) => {
    const rawAnswer =
      byId.get(Number(part.id)) ??
      byNumber.get(Number(part.partNo)) ??
      "";
    const correct = comparePartAnswer({
      rawAnswer,
      acceptedAnswers: part.acceptedAnswers || [],
      answerType: part.answerType,
      comparisonRule: part.comparisonRule
    });
    return {
      partId: part.id,
      partNo: part.partNo,
      label: part.label || `小问 ${part.partNo}`,
      prompt: part.prompt || "",
      rawAnswer,
      outcome: correct ? "correct" : "incorrect",
      acceptedAnswers: [...(part.acceptedAnswers || [])]
    };
  });

  const correctPartCount = results.filter(
    (result) => result.outcome === "correct"
  ).length;
  const totalPartCount = results.length;
  const outcome =
    totalPartCount > 0 && correctPartCount === totalPartCount
      ? "correct"
      : correctPartCount > 0
        ? "partial"
        : "incorrect";

  return {
    results,
    correctPartCount,
    totalPartCount,
    outcome,
    allCorrect: outcome === "correct"
  };
}
