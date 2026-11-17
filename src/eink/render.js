import { createCanvas } from "@napi-rs/canvas";
import { EINK_FONT_FAMILY, ensureEinkFonts } from "./fonts.js";
import { drawPhoto } from "./photo.js";

export const EINK_WIDTH = 800;
export const EINK_HEIGHT = 480;
export const EINK_FRAME_BYTES = EINK_WIDTH / 8 * EINK_HEIGHT;
export const EINK_LAYOUT_VERSION = "eink-layout-v1";

const BODY = Object.freeze({ x: 24, y: 76, width: 752, height: 350 });
const HEADER = Object.freeze({ leftX: 24, rightX: 776, baseline: 42 });
const DIVIDER_Y = 64;
const FOOTER_BASELINE = 464;
const FOOTER_TEXT = "KEY1 < 上一题  KEY2 > 下一题  KEY3 答案";
const FONT_SIZES = [28, 26, 24, 22, 20];
const LINE_HEIGHT_MULTIPLIER = 1.55;
const MONO_THRESHOLD = 160;

function clean(value) {
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

function measure(ctx, text) {
  return ctx.measureText(text).width;
}

function truncateWithEllipsis(ctx, text, maxWidth) {
  if (measure(ctx, text) <= maxWidth) return text;
  const ellipsis = "…";
  let value = text;
  while (value && measure(ctx, `${value}${ellipsis}`) > maxWidth) {
    value = value.slice(0, -1);
  }
  return value ? `${value}${ellipsis}` : ellipsis;
}

function wrapParagraph(ctx, paragraph, maxWidth) {
  const lines = [];
  let line = "";
  for (const character of Array.from(paragraph)) {
    if (character === "\r") continue;
    const candidate = `${line}${character}`;
    if (!line || measure(ctx, candidate) <= maxWidth) {
      line = candidate;
      continue;
    }
    lines.push(line.replace(/\s+$/u, ""));
    line = character === " " ? "" : character;
  }
  lines.push(line.replace(/\s+$/u, ""));
  return lines;
}

function wrapText(ctx, text, maxWidth) {
  const lines = [];
  for (const paragraph of text.split("\n")) {
    if (!paragraph) {
      lines.push("");
      continue;
    }
    lines.push(...wrapParagraph(ctx, paragraph, maxWidth));
  }
  return lines;
}

function drawHeader(ctx, index, total, knowledgePoint) {
  ctx.fillStyle = "black";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.font = `700 26px "${EINK_FONT_FAMILY}"`;
  const left = `错题 ${index}/${total}`;
  ctx.fillText(left, HEADER.leftX, HEADER.baseline);
  const right = clean(knowledgePoint);
  if (!right) return;
  const available = Math.max(
    0,
    HEADER.rightX - (HEADER.leftX + measure(ctx, left)) - 24
  );
  if (available < 24) return;
  ctx.textAlign = "right";
  ctx.font = `400 24px "${EINK_FONT_FAMILY}"`;
  ctx.fillText(
    truncateWithEllipsis(ctx, right, available),
    HEADER.rightX,
    HEADER.baseline
  );
}

function drawTextPage(ctx, text) {
  ctx.fillStyle = "black";
  ctx.fillRect(0, DIVIDER_Y, EINK_WIDTH, 2);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  let fontSize = FONT_SIZES[FONT_SIZES.length - 1];
  let lines = [];
  for (const candidateSize of FONT_SIZES) {
    ctx.font = `400 ${candidateSize}px "${EINK_FONT_FAMILY}"`;
    const lineHeight = candidateSize * LINE_HEIGHT_MULTIPLIER;
    const maxLines = Math.floor(BODY.height / lineHeight);
    const candidateLines = wrapText(ctx, text, BODY.width);
    if (candidateLines.length <= maxLines) {
      fontSize = candidateSize;
      lines = candidateLines;
      break;
    }
    fontSize = candidateSize;
    lines = candidateLines.slice(0, maxLines);
    if (candidateSize === FONT_SIZES[FONT_SIZES.length - 1]) {
      lines[lines.length - 1] = truncateWithEllipsis(
        ctx,
        `${lines[lines.length - 1]}…`,
        BODY.width
      );
    }
  }

  ctx.font = `400 ${fontSize}px "${EINK_FONT_FAMILY}"`;
  const lineHeight = fontSize * LINE_HEIGHT_MULTIPLIER;
  const firstBaseline = BODY.y + fontSize * 1.05;
  for (let index = 0; index < lines.length; index += 1) {
    ctx.fillText(lines[index], BODY.x, firstBaseline + index * lineHeight);
  }

  ctx.font = `400 18px "${EINK_FONT_FAMILY}"`;
  ctx.fillText(FOOTER_TEXT, BODY.x, FOOTER_BASELINE);
}

export function binarizeAndPack(canvas, width = canvas.width, height = canvas.height) {
  const context = canvas.getContext("2d");
  const image = context.getImageData(0, 0, width, height);
  const pixels = image.data;
  const rowBytes = Math.ceil(width / 8);
  const frame = Buffer.alloc(rowBytes * height, 0xff);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const luminance =
        pixels[offset] * 0.299 +
        pixels[offset + 1] * 0.587 +
        pixels[offset + 2] * 0.114;
      const black = luminance < MONO_THRESHOLD;
      const value = black ? 0 : 255;
      pixels[offset] = value;
      pixels[offset + 1] = value;
      pixels[offset + 2] = value;
      pixels[offset + 3] = 255;
      if (black) {
        frame[y * rowBytes + Math.floor(x / 8)] &= ~(0x80 >> (x % 8));
      }
    }
  }
  context.putImageData(image, 0, 0);
  return frame;
}

export function renderEinkPage({ mistake, mode, index, total, photo = null }) {
  ensureEinkFonts();
  const canvas = createCanvas(EINK_WIDTH, EINK_HEIGHT);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, EINK_WIDTH, EINK_HEIGHT);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  drawHeader(ctx, index, total, mistake.knowledgePoint);

  if (mode === "question" && photo) {
    drawPhoto(ctx, photo);
  } else {
    const text = mode === "answer"
      ? buildAnswerText(mistake)
      : buildQuestionText(mistake);
    drawTextPage(ctx, text);
  }

  const frame = binarizeAndPack(canvas, EINK_WIDTH, EINK_HEIGHT);
  if (frame.length !== EINK_FRAME_BYTES) {
    throw new Error("墨水屏帧长度错误");
  }
  return {
    frame,
    png: canvas.toBuffer("image/png")
  };
}
