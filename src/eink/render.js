import sharp from "sharp";
import { EINK_FONT_FAMILY, ensureEinkFonts } from "./fonts.js";
import { EINK_UNFIT_REASONS } from "./fit.js";
import { adaptiveThreshold } from "./photo.js";
import {
  BODY,
  buildAnswerText,
  buildQuestionText,
  clean,
  layoutTextPage,
  measure,
  truncateWithEllipsis
} from "./text-layout.js";

export { buildAnswerText, buildQuestionText } from "./text-layout.js";

export const EINK_WIDTH = 800;
export const EINK_HEIGHT = 480;
export const EINK_FRAME_BYTES = EINK_WIDTH / 8 * EINK_HEIGHT;
export const EINK_LAYOUT_VERSION = "eink-layout-v2";

const HEADER = Object.freeze({ leftX: 24, rightX: 776, baseline: 42 });
const DIVIDER_Y = 64;
const FOOTER_BASELINE = 464;
const FOOTER_TEXT = "KEY1 < 上一题  KEY2 > 下一题  KEY3 答案";
const MONO_THRESHOLD = 160;
const PHOTO_PADDING = 8;
const PHOTO_MIN_INK_RATIO = 0.001;
const PHOTO_MAX_INK_RATIO = 0.6;
const FONT_STACK =
  `${EINK_FONT_FAMILY}, Microsoft YaHei, Noto Sans CJK SC, sans-serif`;

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

function textPageSvg(index, total, knowledgePoint, layout) {
  const { fontSize, lineHeight, lines } = layout;
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
    ...headerElements(index, total, knowledgePoint)
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

const UNFIT_REASON_TEXT = Object.freeze({
  [EINK_UNFIT_REASONS.TEXT]: "正文在 20px 字号下仍超出单页",
  [EINK_UNFIT_REASONS.ANSWER]: "答案在 20px 字号下仍超出单页",
  [EINK_UNFIT_REASONS.PHOTO]: "题图尺寸过小或内容无法辨认"
});

export async function renderEinkUnfitNotice({
  mistake = {},
  mode = "question",
  reasons = []
}) {
  ensureEinkFonts();
  const reasonText =
    reasons
      .map((reason) => UNFIT_REASON_TEXT[reason])
      .filter(Boolean)
      .join("；") || "内容超出墨水屏单页可读范围";
  const modeText = mode === "answer" ? "答案页" : "题目页";
  const elements = [
    `<rect width="${EINK_WIDTH}" height="${EINK_HEIGHT}" fill="white"/>`,
    `<rect x="8" y="8" width="${EINK_WIDTH - 16}" height="${
      EINK_HEIGHT - 16
    }" fill="none" stroke="black" stroke-width="2"/>`,
    textElement({
      x: EINK_WIDTH / 2,
      y: 200,
      text: "不适配墨水屏单页",
      size: 40,
      weight: 700,
      anchor: "middle"
    }),
    textElement({
      x: EINK_WIDTH / 2,
      y: 252,
      text: reasonText,
      size: 22,
      anchor: "middle"
    }),
    textElement({
      x: EINK_WIDTH / 2,
      y: 292,
      text: `错题 #${mistake.id ?? "-"} · ${modeText}`,
      size: 20,
      anchor: "middle"
    }),
    textElement({
      x: EINK_WIDTH / 2,
      y: 372,
      text: "请在手机端查看完整内容",
      size: 20,
      anchor: "middle"
    })
  ];
  const rendered = await rasterizeSvg(svgDocument(elements));
  return rendered.png;
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

export async function rasterizeSvg(svg) {
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

function photoInkRatio(pixels, contentWidth, contentHeight) {
  const stride = contentWidth + PHOTO_PADDING * 2;
  let black = 0;
  for (let y = 0; y < contentHeight; y += 1) {
    for (let x = 0; x < contentWidth; x += 1) {
      const offset = ((y + PHOTO_PADDING) * stride + (x + PHOTO_PADDING)) * 4;
      if (pixels[offset] === 0) black += 1;
    }
  }
  return black / (contentWidth * contentHeight);
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
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const bordered = await sharp(resized.data, {
    raw: {
      width: resized.info.width,
      height: resized.info.height,
      channels: resized.info.channels
    }
  })
    .extend({
      top: PHOTO_PADDING,
      bottom: PHOTO_PADDING,
      left: PHOTO_PADDING,
      right: PHOTO_PADDING,
      background: "white"
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  adaptiveThreshold(
    bordered.data,
    bordered.info.width,
    bordered.info.height
  );
  const inkRatio = photoInkRatio(
    bordered.data,
    resized.info.width,
    resized.info.height
  );
  if (
    inkRatio < PHOTO_MIN_INK_RATIO ||
    inkRatio > PHOTO_MAX_INK_RATIO
  ) {
    return {
      unfit: true,
      reasons: [EINK_UNFIT_REASONS.PHOTO],
      layoutVersion: EINK_LAYOUT_VERSION
    };
  }
  const thresholded = await sharp(bordered.data, {
    raw: {
      width: bordered.info.width,
      height: bordered.info.height,
      channels: bordered.info.channels
    }
  })
    .extract({
      left: PHOTO_PADDING,
      top: PHOTO_PADDING,
      width: resized.info.width,
      height: resized.info.height
    })
    .png()
    .toBuffer();
  const left = PHOTO_AREA.x +
    Math.floor((PHOTO_AREA.width - resized.info.width) / 2);
  const top = PHOTO_AREA.y +
    Math.floor((PHOTO_AREA.height - resized.info.height) / 2);
  const composited = await sharp(background)
    .composite([{ input: thresholded, left, top }])
    .ensureAlpha()
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
    : await renderTextPage(mistake, mode, index, total);
  if (rendered.unfit) return rendered;
  if (rendered.frame.length !== EINK_FRAME_BYTES) {
    throw new Error("墨水屏帧长度错误");
  }
  return rendered;
}

async function renderTextPage(mistake, mode, index, total) {
  const text = mode === "answer"
    ? buildAnswerText(mistake)
    : buildQuestionText(mistake);
  const layout = layoutTextPage(text);
  if (!layout.fits) {
    return {
      unfit: true,
      reasons: [
        mode === "answer"
          ? EINK_UNFIT_REASONS.ANSWER
          : EINK_UNFIT_REASONS.TEXT
      ],
      layoutVersion: EINK_LAYOUT_VERSION
    };
  }
  return rasterizeSvg(
    textPageSvg(index, total, mistake.knowledgePoint, layout)
  );
}
