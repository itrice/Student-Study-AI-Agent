import {
  buildAnswerText,
  buildQuestionText,
  layoutTextPage
} from "./text-layout.js";

// 小于该尺寸的题图在 788×420 单页上无法辨认，按 PD-12 判为不适配。
export const EINK_MIN_PHOTO_WIDTH = 96;
export const EINK_MIN_PHOTO_HEIGHT = 64;

export const EINK_UNFIT_REASONS = Object.freeze({
  TEXT: "EINK_UNFIT_TEXT",
  ANSWER: "EINK_UNFIT_ANSWER",
  PHOTO: "EINK_UNFIT_PHOTO"
});

export function photoSizeIsReadable(attachment) {
  if (!attachment) return false;
  const width = Number(attachment.width);
  const height = Number(attachment.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
  return width >= EINK_MIN_PHOTO_WIDTH && height >= EINK_MIN_PHOTO_HEIGHT;
}

export function evaluateEinkFit(mistake) {
  const reasons = [];
  const attachments = Array.isArray(mistake.attachments)
    ? mistake.attachments
    : [];
  if (attachments.length > 0) {
    if (!photoSizeIsReadable(attachments[0])) {
      reasons.push(EINK_UNFIT_REASONS.PHOTO);
    }
  } else if (!layoutTextPage(buildQuestionText(mistake)).fits) {
    reasons.push(EINK_UNFIT_REASONS.TEXT);
  }
  if (!layoutTextPage(buildAnswerText(mistake)).fits) {
    reasons.push(EINK_UNFIT_REASONS.ANSWER);
  }
  return {
    status: reasons.length ? "unfit" : "fit",
    reasons
  };
}