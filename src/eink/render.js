import sharp from "sharp";
import { EINK_FONT_FAMILY, ensureEinkFonts } from "./fonts.js";

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
const FONT_STACK =
  `${EINK_FONT_FAMILY}, Microsoft YaHei, Noto Sans CJK SC, sans-serif`;

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

function measure(text, fontSize, weight = 400) {
  let width = 0;
  for (const character of Array.from(text)) {
    width += characterWidth(character, fontSize);
  }
  return weight >= 700 ? width * 1.04 : width;
}

function truncateWithEllipsis(text, maxWidth, fontSize) {
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

function wrapParagraph(paragraph, maxWidth, fontSize) {
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

function wrapText(text, maxWidth, fontSize) {
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

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function textElement({
  x,
  y,
  text,
  size,
  weight = 400,
  anchor = "start"
}) {
  return (
    `<text x="${x}" y="${y}" font-size="${size}" ` +
    `font-weight="${weight}" text-anchor="${anchor}">` +
    `${escapeXml(text)}</text>`
  );
}

function headerElements(index, total, knowledgePoint) {
  const elements = [
    textElement({
      x: HEADER.leftX,
      y: HEADER.baseline,
      text: `错题 ${index}/${total}`,
      size: 26,
      weight: 700
    })
  ];
  const right = clean(knowledgePoint);
  if (!right) return elements;
  const left = `错题 ${index}/${total}`;
  const available = Math.max(
    0,
    HEADER.rightX - (HEADER.leftX + measure(left, 26, 700)) - 24
  );
  if (available < 24) return elements;
  elements.push(
    textElement({
      x: HEADER.rightX,
      y: HEADER.baseline,
      text: truncateWithEllipsis(right, available, 24),
      size: 24,
      anchor: "end"
    })
  );
  return elements;
}

function textPageSvg(index, total, knowledgePoint, text) {
  let fontSize = FONT_SIZES[FONT_SIZES.length - 1];
  let lines = [];
  for (const candidateSize of FONT_SIZES) {
    const lineHeight = candidateSize * LINE_HEIGHT_MULTIPLIER;
    const maxLines = Math.floor(BODY.height / lineHeight);
    const candidateLines = wrapText(text, BODY.width, candidateSize);
    if (candidateLines.length <= maxLines) {
      fontSize = candidateSize;
      lines = candidateLines;
      break;
    }
    fontSize = candidateSize;
    lines = candidateLines.slice(0, maxLines);
    if (candidateSize === FONT_SIZES[FONT_SIZES.length - 1]) {
      lines[lines.length - 1] = truncateWithEllipsis(
        `${lines[lines.length - 1]}…`,
        BODY.width,
        candidateSize
      );
    }
  }

  const lineHeight = fontSize * LINE_HEIGHT_MULTIPLIER;
  const firstBaseline = BODY.y + fontSize * 1.05;
  const body = lines.map((line, lineIndex) =>
    textElement({
      x: BODY.x,
      y: firstBaseline + lineIndex * lineHeight,
      text: line,
      size: fontSize
    })
  );
  const elements = [
    `<rect width="${EINK_WIDTH}" height="${EINK_HEIGHT}" fill="white"/>`,
    ...headerElements(index, total, knowledgePoint),
    `<rect x="0" y="${DIVIDER_Y}" width="${EINK_WIDTH}" height="2" fill="black"/>`,
    ...body,
    textElement({
      x: BODY.x,
      y: FOOTER_BASELINE,
      text: FOOTER_TEXT,
      size: 18
    })
  ];
  return svgDocument(elements);
}

function photoPageSvg(index, total, knowledgePoint) {
  return svgDocument([
    `<rect width="${EINK_WIDTH}" height="${EINK_HEIGHT}" fill="white"/>`,
    ...headerElements(index, total, knowledgePoint),
    `<rect x="0" y="${DIVIDER_Y}" width="${EINK_WIDTH}" height="2" fill="black"/>`
  ]);
}

function svgDocument(elements) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `width="${EINK_WIDTH}" height="${EINK_HEIGHT}" ` +
    `viewBox="0 0 ${EINK_WIDTH} ${EINK_HEIGHT}" ` +
    `font-family="${escapeXml(FONT_STACK)}" fill="black">` +
    `${elements.join("")}</svg>`
  );
}

export function binarizePixels(
  pixels,
  width = EINK_WIDTH,
  height = EINK_HEIGHT,
  channels = 4
) {
  const rowBytes = Math.ceil(width / 8);
  const frame = Buffer.alloc(rowBytes * height, 0xff);
  const output = Buffer.alloc(width * height * 4, 0xff);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceOffset = (y * width + x) * channels;
      const targetOffset = (y * width + x) * 4;
      const luminance =
        pixels[sourceOffset] * 0.299 +
        pixels[sourceOffset + 1] * 0.587 +
        pixels[sourceOffset + 2] * 0.114;
      const value = luminance < MONO_THRESHOLD ? 0 : 255;
      output[targetOffset] = value;
      output[targetOffset + 1] = value;
      output[targetOffset + 2] = value;
      output[targetOffset + 3] = 255;
      if (value === 0) {
        frame[y * rowBytes + Math.floor(x / 8)] &= ~(0x80 >> (x % 8));
      }
    }
  }
  return { frame, pixels: output };
}

export async function binarizeAndPack(
  input,
  width = input.width,
  height = input.height,
  channels = input.channels || 4
) {
  const binary = binarizePixels(input.data, width, height, channels);
  const png = await sharp(binary.pixels, {
    raw: { width, height, channels: 4 }
  }).png().toBuffer();
  return { ...binary, png };
}

async function rasterizeSvg(svg) {
  const { data, info } = await sharp(Buffer.from(svg))
    .flatten({ background: "white" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return binarizeAndPack({
    data,
    width: info.width,
    height: info.height,
    channels: info.channels
  });
}

async function renderPhotoPage(
  index,
  total,
  knowledgePoint,
  photo
) {
  const background = await sharp(Buffer.from(
    photoPageSvg(index, total, knowledgePoint)
  )).png().toBuffer();
  const resized = await sharp(photo.buffer)
    .resize({
      width: 788,
      height: 420,
      fit: "contain",
      background: "white"
    })
    .png()
    .toBuffer({ resolveWithObject: true });
  const left = PHOTO_AREA.x +
    Math.floor((PHOTO_AREA.width - resized.info.width) / 2);
  const top = PHOTO_AREA.y +
    Math.floor((PHOTO_AREA.height - resized.info.height) / 2);
  const composited = await sharp(background)
    .composite([{ input: resized.data, left, top }])
    .raw()
    .toBuffer({ resolveWithObject: true });
  return binarizeAndPack({
    data: composited.data,
    width: composited.info.width,
    height: composited.info.height,
    channels: composited.info.channels
  });
}

const PHOTO_AREA = Object.freeze({
  x: 6,
  y: 56,
  width: 788,
  height: 420
});

export async function renderEinkPage({
  mistake,
  mode,
  index,
  total,
  photo = null
}) {
  ensureEinkFonts();
  const rendered = mode === "question" && photo
    ? await renderPhotoPage(index, total, mistake.knowledgePoint, photo)
    : await rasterizeSvg(textPageSvg(
        index,
        total,
        mistake.knowledgePoint,
        mode === "answer"
          ? buildAnswerText(mistake)
          : buildQuestionText(mistake)
      ));
  if (rendered.frame.length !== EINK_FRAME_BYTES) {
    throw new Error("墨水屏帧长度错误");
  }
  return rendered;
}
