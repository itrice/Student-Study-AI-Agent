export const BODY = Object.freeze({
  x: 24,
  y: 76,
  width: 752,
  height: 350
});

export const FONT_SIZES = Object.freeze([28, 26, 24, 22, 20]);
export const LINE_HEIGHT_MULTIPLIER = 1.55;

export function clean(value) {
  return String(value || "").replace(/\r\n?/g, "\n").trim();
}

export function buildQuestionText(mistake) {
  const blocks = [];
  const question = clean(mistake.question);
  if (question) blocks.push(question);
  const parts = Array.isArray(mistake.parts) ? mistake.parts : [];
  if (parts.length > 1) {
    for (const part of parts) {
      const prompt = clean(part.prompt) || clean(part.label);
      blocks.push(`第${part.partNo}小问：${prompt || "（无文字题干）"}`);
    }
  } else if (parts.length === 1) {
    const prompt = clean(parts[0].prompt) || clean(parts[0].label);
    if (prompt && prompt !== question) blocks.push(prompt);
  }
  return blocks.join("\n\n") || "（暂无文字题干）";
}

export function buildAnswerText(mistake) {
  const parts = Array.isArray(mistake.parts) && mistake.parts.length
    ? mistake.parts
    : [{
        partNo: 1,
        label: "",
        prompt: "",
        studentAnswer: mistake.studentAnswer,
        acceptedAnswers: [],
        knowledgePoint: mistake.knowledgePoint,
        explanation: "",
        hint: ""
      }];
  const multiple = parts.length > 1;
  const blocks = parts.map((part) => {
    const lines = [];
    if (multiple) lines.push(`第${part.partNo}小问`);
    const studentAnswer =
      clean(part.studentAnswer) ||
      (parts.length === 1 ? clean(mistake.studentAnswer) : "") ||
      "未作答";
    const accepted = Array.isArray(part.acceptedAnswers)
      ? part.acceptedAnswers.map(clean).filter(Boolean)
      : [];
    const correctAnswer =
      accepted.join(" / ") ||
      (parts.length === 1 ? clean(mistake.correctAnswer) : "") ||
      "（暂无）";
    const reason =
      clean(part.explanation) ||
      clean(mistake.analysis) ||
      clean(mistake.errorType) ||
      clean(part.hint);
    const knowledgePoint =
      clean(part.knowledgePoint) || clean(mistake.knowledgePoint);
    lines.push(`你的答案：${studentAnswer}`);
    lines.push(`正确答案：${correctAnswer}`);
    lines.push(`错因或解析：${reason || "（暂无）"}`);
    lines.push(`知识点：${knowledgePoint || "（未标注）"}`);
    return lines.join("\n");
  });
  return blocks.join("\n\n");
}

function isFullWidth(character) {
  const codePoint = character.codePointAt(0);
  return (
    (codePoint >= 0x2e80 && codePoint <= 0x9fff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xff01 && codePoint <= 0xff60) ||
    codePoint >= 0x20000
  );
}

function characterWidth(character, fontSize) {
  if (/\s/u.test(character)) return fontSize * 0.32;
  if (isFullWidth(character)) return fontSize;
  if (/[A-Z]/u.test(character)) return fontSize * 0.66;
  if (/[a-z0-9]/u.test(character)) return fontSize * 0.56;
  return fontSize * 0.44;
}

export function measure(text, fontSize, weight = 400) {
  let width = 0;
  for (const character of Array.from(text)) {
    width += characterWidth(character, fontSize);
  }
  return weight >= 700 ? width * 1.04 : width;
}

export function truncateWithEllipsis(text, maxWidth, fontSize) {
  if (measure(text, fontSize) <= maxWidth) return text;
  const ellipsis = "…";
  let value = text;
  while (
    value &&
    measure(`${value}${ellipsis}`, fontSize) > maxWidth
  ) {
    value = value.slice(0, -1);
  }
  return value ? `${value}${ellipsis}` : ellipsis;
}

export function wrapParagraph(paragraph, maxWidth, fontSize) {
  const lines = [];
  let line = "";
  for (const character of Array.from(paragraph)) {
    if (character === "\r") continue;
    const candidate = `${line}${character}`;
    if (!line || measure(candidate, fontSize) <= maxWidth) {
      line = candidate;
      continue;
    }
    lines.push(line.replace(/\s+$/u, ""));
    line = character === " " ? "" : character;
  }
  lines.push(line.replace(/\s+$/u, ""));
  return lines;
}

export function wrapText(text, maxWidth, fontSize) {
  const lines = [];
  for (const paragraph of text.split("\n")) {
    if (!paragraph) {
      lines.push("");
      continue;
    }
    lines.push(...wrapParagraph(paragraph, maxWidth, fontSize));
  }
  return lines;
}

export function layoutTextPage(
  text,
  { width = BODY.width, height = BODY.height } = {}
) {
  for (const fontSize of FONT_SIZES) {
    const lineHeight = fontSize * LINE_HEIGHT_MULTIPLIER;
    const maxLines = Math.floor(height / lineHeight);
    const lines = wrapText(text, width, fontSize);
    if (lines.length <= maxLines) {
      return { fits: true, fontSize, lineHeight, maxLines, lines };
    }
  }
  const fontSize = FONT_SIZES[FONT_SIZES.length - 1];
  const lineHeight = fontSize * LINE_HEIGHT_MULTIPLIER;
  return {
    fits: false,
    fontSize,
    lineHeight,
    maxLines: Math.floor(height / lineHeight),
    lines: wrapText(text, width, fontSize)
  };
}