import { answersMatch, parseAnswerValue } from "../agent.js";
import { LearningValidationError } from "./errors.js";

function normalizeText(value = "") {
  return String(value)
    .trim()
    .replace(/\s+/g, "")
    .replace(/[∶：]/g, ":");
}

const UNIT_ALIASES = new Map([
  ["cm", "cm"],
  ["厘米", "cm"],
  ["mm", "mm"],
  ["毫米", "mm"],
  ["dm", "dm"],
  ["分米", "dm"],
  ["m", "m"],
  ["米", "m"],
  ["km", "km"],
  ["千米", "km"],
  ["公里", "km"],
  ["cm2", "cm²"],
  ["cm²", "cm²"],
  ["平方厘米", "cm²"],
  ["m2", "m²"],
  ["m²", "m²"],
  ["平方米", "m²"]
]);

function normalizeUnit(unit = "") {
  const normalizedUnit = String(unit).replace(/\s+/g, "").toLowerCase();
  return UNIT_ALIASES.get(normalizedUnit) || normalizedUnit;
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
    if (answersMatch(answer, acceptedAnswer)) return true;
    const studentValue = parseAnswerValue(answer);
    const acceptedValue = parseAnswerValue(acceptedAnswer);
    return Boolean(
      studentValue &&
        acceptedValue &&
        studentValue.unit &&
        acceptedValue.unit &&
        normalizeUnit(studentValue.unit) === normalizeUnit(acceptedValue.unit) &&
        Math.abs(studentValue.number - acceptedValue.number) < 1e-9
    );
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

export function validateSubmittedPartAnswers(parts, answers) {
  if (!Array.isArray(answers)) return;
  const partIds = new Set((parts || []).map((part) => Number(part.id)));
  const seen = new Set();
  for (const answer of answers) {
    const partId = Number(answer?.partId);
    if (!Number.isInteger(partId) || partId <= 0) {
      throw new LearningValidationError(
        "INVALID_ARGUMENTS",
        "作答中的 partId 无效"
      );
    }
    if (seen.has(partId)) {
      throw new LearningValidationError(
        "INVALID_ARGUMENTS",
        "同一个小问不能重复提交"
      );
    }
    if (!partIds.has(partId)) {
      throw new LearningValidationError(
        "INVALID_ARGUMENTS",
        "作答包含不属于当前错题的小问"
      );
    }
    seen.add(partId);
  }
}
