import { LearningValidationError } from "./domain/errors.js";
import { readAttachmentContent } from "./attachment-crop.js";

export async function extractAttachmentText({
  repository,
  attachmentStore,
  extractor,
  attachmentId,
  consent
}) {
  if (consent !== true) {
    throw new LearningValidationError(
      "VISION_CONSENT_REQUIRED",
      "发送图片前需要先明确同意"
    );
  }
  const attachment = repository.getAttachment(attachmentId, {
    includeStorageKey: true
  });
  if (!attachment) {
    throw new LearningValidationError(
      "ATTACHMENT_NOT_FOUND",
      "没有找到这张题目图片"
    );
  }
  if (!extractor?.isConfigured()) {
    return {
      available: false,
      requiresConfirmation: true,
      message: "当前没有配置视觉识别，可直接填写题目文字并使用图片保存。"
    };
  }

  let content;
  try {
    content = readAttachmentContent(attachment, attachmentStore);
  } catch {
    return {
      available: false,
      requiresConfirmation: true,
      message: "图片读取失败，可直接填写题目文字并使用图片保存。"
    };
  }

  try {
    const result = await extractor.extract({
      buffer: content.buffer,
      mimeType: content.mimeType
    });
    const text = String(result.normalizedText || "").trim();
    if (!text) {
      return {
        available: false,
        requiresConfirmation: true,
        message: "没有识别到清晰文字，可直接填写题目文字并使用图片保存。"
      };
    }
    repository.saveAttachmentExtraction({
      attachmentId,
      rawOutput: result.rawOutput,
      normalizedText: text,
      confidence: result.confidence,
      provider: result.provider,
      model: result.model,
      promptVersion: result.promptVersion
    });
    return {
      available: true,
      requiresConfirmation: true,
      text,
      confidence: result.confidence,
      provider: result.provider,
      model: result.model,
      usedCrop: content.usedCrop
    };
  } catch {
    return {
      available: false,
      requiresConfirmation: true,
      message: "识别失败，可直接填写题目文字并使用图片保存。"
    };
  }
}
