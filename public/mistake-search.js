export function normalizeSearchTerms(query = "") {
  return String(query)
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function partSearchText(part) {
  if (!part || typeof part !== "object") return "";
  return [part.label, part.prompt].filter(Boolean).join(" ");
}

function questionSearchText(mistake = {}) {
  const question =
    mistake.question ||
    (Array.isArray(mistake.attachments) && mistake.attachments.length
      ? "请查看题目图片"
      : "");
  return [question, mistake.knowledgePoint, mistake.errorType]
    .filter(Boolean)
    .join(" ");
}

export function mistakeSearchText(mistake = {}) {
  const parts = Array.isArray(mistake.parts)
    ? mistake.parts.map(partSearchText)
    : [];
  return [questionSearchText(mistake), ...parts]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function normalizeTerms(queryOrTerms = "") {
  return Array.isArray(queryOrTerms)
    ? queryOrTerms
        .map((term) => String(term).trim().toLowerCase())
        .filter(Boolean)
    : normalizeSearchTerms(queryOrTerms);
}

export function matchingMistakeParts(mistake = {}, queryOrTerms = "") {
  const terms = normalizeTerms(queryOrTerms);
  if (!terms.length) return [];
  const questionText = questionSearchText(mistake).toLowerCase();
  const uncoveredTerms = terms.filter((term) => !questionText.includes(term));
  if (!uncoveredTerms.length) return [];
  const parts = Array.isArray(mistake.parts) ? mistake.parts : [];
  return parts.filter((part) => {
    const text = partSearchText(part).toLowerCase();
    return uncoveredTerms.some((term) => text.includes(term));
  });
}

export function mistakeMatchesQuery(mistake, queryOrTerms = "") {
  const terms = normalizeTerms(queryOrTerms);
  if (!terms.length) return true;
  const haystack = mistakeSearchText(mistake);
  return terms.every((term) => haystack.includes(term));
}

export function filterMistakes(
  mistakes = [],
  { status = "all", query = "" } = {}
) {
  const terms = normalizeSearchTerms(query);
  return mistakes.filter(
    (mistake) =>
      (status === "all" || mistake.status === status) &&
      mistakeMatchesQuery(mistake, terms)
  );
}
