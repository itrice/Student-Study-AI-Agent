import { LearningValidationError } from "../domain/errors.js";

function failedScan(repository, attachmentIds, message, scanner = {}) {
  return repository.createQuestionScanTask({
    attachmentIds,
    status: "failed",
    errorMessage: message,
    scanner
  });
}

export async function createQuestionScan({
  repository,
  attachmentStore,
  scanner,
  attachmentIds,
  consent
}) {
  if (consent !== true) {
    throw new LearningValidationError(
      "VISION_CONSENT_REQUIRED",
      "发送图片到外部识别模型前需要明确同意；拒绝后可改用手动录入"
    );
  }
  const ids = Array.isArray(attachmentIds) ? attachmentIds : [];
  if (!scanner?.isConfigured()) {
    return failedScan(
      repository,
      ids,
      "当前没有配置视觉识别，图片已暂存；请改用手动录入或在配置后重试。"
    );
  }

  const images = [];
  try {
    for (const attachmentId of ids) {
      const attachment = repository.getAttachment(Number(attachmentId), {
        includeStorageKey: true
      });
      if (!attachment) {
        throw new LearningValidationError(
          "ATTACHMENT_NOT_FOUND",
          "扫描图片不存在或已被清理"
        );
      }
      images.push({
        mimeType: attachment.mimeType,
        buffer: attachmentStore.read(attachment.storageKey)
      });
    }
  } catch {
    return failedScan(
      repository,
      ids,
      "图片读取失败，图片已暂存；请改用手动录入或重新上传。"
    );
  }

  try {
    const result = await scanner.scan({ images });
    return repository.createQuestionScanTask({
      attachmentIds: ids,
      candidates: result.candidates,
      scanner: {
        provider: result.provider,
        model: result.model,
        promptVersion: result.promptVersion
      }
    });
  } catch (error) {
    return failedScan(
      repository,
      ids,
      error?.message || "视觉识别失败，可重拍或改用手动录入。",
      {
        provider: scanner.provider,
        model: scanner.model,
        promptVersion: scanner.promptVersion || ""
      }
    );
  }
}
