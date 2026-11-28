import { ensureEinkFonts } from "./fonts.js";
import {
  EINK_FRAME_BYTES,
  EINK_HEIGHT,
  EINK_WIDTH,
  rasterizeSvg,
  svgDocument,
  textElement
} from "./render.js";
import { measure, wrapText } from "./text-layout.js";

export const EINK_VOCAB_LAYOUT_VERSION = "eink-vocab-v1";

const HEADER = Object.freeze({ leftX: 24, rightX: 776, baseline: 42 });
const DIVIDER_Y = 64;
const TAG_BASELINE = 126;
const FOOTER_BASELINE = 464;
const FOOTER_TEXT = "写完后到网页或手机勾选";
const PROMPT_MAX_WIDTH = 640;
const PROMPT_SIZES = Object.freeze([72, 64, 56, 48, 40, 32, 28]);
const PROMPT_MAX_LINES = 3;
const PROMPT_MAX_HEIGHT = 270;
const PROMPT_CENTER_Y = 292;
const EMPTY_TITLE = "今天没有到期字词";
const EMPTY_HINT = "可到网页或手机查看今日字词计划";
const MISSING_PROMPT = "（该词条缺少提示内容）";

const SUBJECT_LABELS = Object.freeze({ chinese: "语文", english: "英语" });
const MODE_LABELS = Object.freeze({
  pinyin_to_hanzi: "看拼音写汉字",
  zh_to_en: "看中文写英文",
  en_to_zh: "看英文写中文"
});

function wrapPrompt(text, maxWidth, fontSize) {
  const words = text.split(/\s+/u).filter(Boolean);
  if (words.length <= 1) return wrapText(text, maxWidth, fontSize);
  const lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (!line || measure(candidate, fontSize) <= maxWidth) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  const wrapped = [];
  for (const value of lines) {
    wrapped.push(...wrapText(value, maxWidth, fontSize));
  }
  return wrapped;
}

function layoutPrompt(prompt) {
  const text = prompt || MISSING_PROMPT;
  for (const fontSize of PROMPT_SIZES) {
    const lineHeight = Math.round(fontSize * 1.4);
    const lines = wrapPrompt(text, PROMPT_MAX_WIDTH, fontSize);
    if (
      lines.length <= PROMPT_MAX_LINES &&
      lines.length * lineHeight <= PROMPT_MAX_HEIGHT
    ) {
      return { fontSize, lineHeight, lines };
    }
  }
  const fontSize = PROMPT_SIZES[PROMPT_SIZES.length - 1];
  return {
    fontSize,
    lineHeight: Math.round(fontSize * 1.4),
    lines: wrapPrompt(text, PROMPT_MAX_WIDTH, fontSize)
  };
}

function tagText(subject, mode) {
  const subjectLabel = SUBJECT_LABELS[subject] || "";
  const modeLabel = MODE_LABELS[mode] || "";
  if (!subjectLabel || !modeLabel) return subjectLabel || modeLabel;
  return `${subjectLabel} · ${modeLabel}`;
}

export function buildVocabFrameSvg(model) {
  const { subject, mode, index, total, prompt, empty } = model;
  const elements = [
    `<rect width="${EINK_WIDTH}" height="${EINK_HEIGHT}" fill="white"/>`,
    textElement({
      x: HEADER.leftX,
      y: HEADER.baseline,
      text: "字词听写",
      size: 26,
      weight: 700
    }),
    textElement({
      x: HEADER.rightX,
      y: HEADER.baseline,
      text: `${index}/${total}`,
      size: 24,
      anchor: "end"
    }),
    `<rect x="0" y="${DIVIDER_Y}" width="${EINK_WIDTH}" height="2" fill="black"/>`
  ];

  if (empty) {
    elements.push(
      textElement({
        x: EINK_WIDTH / 2,
        y: 252,
        text: EMPTY_TITLE,
        size: 44,
        weight: 700,
        anchor: "middle"
      }),
      textElement({
        x: EINK_WIDTH / 2,
        y: 310,
        text: EMPTY_HINT,
        size: 22,
        anchor: "middle"
      })
    );
    return svgDocument(elements);
  }

  const tag = tagText(subject, mode);
  if (tag) {
    elements.push(
      textElement({
        x: EINK_WIDTH / 2,
        y: TAG_BASELINE,
        text: tag,
        size: 24,
        anchor: "middle"
      })
    );
  }

  const { fontSize, lineHeight, lines } = layoutPrompt(prompt);
  const firstBaseline =
    PROMPT_CENTER_Y + fontSize * 0.35 - ((lines.length - 1) * lineHeight) / 2;
  for (const [lineIndex, line] of lines.entries()) {
    elements.push(
      textElement({
        x: EINK_WIDTH / 2,
        y: Math.round(firstBaseline + lineIndex * lineHeight),
        text: line,
        size: fontSize,
        weight: 700,
        anchor: "middle"
      })
    );
  }

  elements.push(
    textElement({
      x: HEADER.leftX,
      y: FOOTER_BASELINE,
      text: FOOTER_TEXT,
      size: 18
    })
  );
  return svgDocument(elements);
}

export async function renderEinkVocabFrame(model) {
  ensureEinkFonts();
  const rendered = await rasterizeSvg(buildVocabFrameSvg(model));
  if (rendered.frame.length !== EINK_FRAME_BYTES) {
    throw new Error("墨水屏帧长度错误");
  }
  return rendered;
}
