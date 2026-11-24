import sharp from "sharp";
import { LearningValidationError } from "../domain/errors.js";
import { readAttachmentContent } from "../attachment-crop.js";

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
  attachmentIds
}) {
  const ids = Array.isArray(attachmentIds) ? attachmentIds : [];
  if (!scanner?.isConfigured()) {
    return failedScan(
      repository,
      ids,
      "当前没有配置内部 OCR，图片已暂存；请改用手动录入或在配置后重试。"
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
      const content = readAttachmentContent(attachment, attachmentStore);
      images.push({
        mimeType: content.mimeType,
        buffer: content.buffer
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
      },
      ocr: result.ocr
    });
  } catch (error) {
    console.warn("[question-scan] 识别失败", {
      code: error?.code || "UNKNOWN",
      provider: scanner.provider || "",
      model: scanner.model || "",
      ...(error?.details ? { details: error.details } : {})
    });
    return failedScan(
      repository,
      ids,
      error?.message || "OCR 识别失败，可重拍或改用手动录入。",
      {
        provider: scanner.provider,
        model: scanner.model,
        promptVersion: scanner.promptVersion || ""
      }
    );
  }
}

function scanImportError(code, message, status = 400) {
  const error = new LearningValidationError(code, message);
  error.status = status;
  return error;
}

async function createCandidateAttachment({
  repository,
  attachmentStore,
  context,
  candidate
}) {
  const buffer = attachmentStore.read(context.storageKey);
  const width = Number(context.width);
  const height = Number(context.height);
  const region = candidate.region;
  const left = Math.max(
    0,
    Math.min(width - 1, Math.round(region.x * width))
  );
  const top = Math.max(
    0,
    Math.min(height - 1, Math.round(region.y * height))
  );
  const cropWidth = Math.max(
    1,
    Math.min(width - left, Math.round(region.width * width))
  );
  const cropHeight = Math.max(
    1,
    Math.min(height - top, Math.round(region.height * height))
  );
  const cropped = await sharp(buffer)
    .rotate()
    .extract({
      left,
      top,
      width: cropWidth,
      height: cropHeight
    })
    .png()
    .toBuffer();
  const saved = attachmentStore.save(cropped, {
    declaredMime: "image/png",
    originalName: `scan-${candidate.candidateNo}.png`,
    kind: "question"
  });
  try {
    return repository.insertAttachment(saved);
  } catch (error) {
    try {
      attachmentStore.delete(saved.storageKey);
    } catch {
      // Orphan cleanup handles a file that cannot be removed immediately.
    }
    throw error;
  }
}

export async function importQuestionScan({
  repository,
  attachmentStore,
  scanId,
  candidateIds,
  confirmIncomplete = false
}) {
  const scan = repository.getQuestionScan(scanId);
  if (!scan) {
    throw scanImportError("SCAN_NOT_FOUND", "没有找到这次扫描任务", 404);
  }
  if (scan.status === "expired") {
    throw scanImportError("SCAN_EXPIRED", "扫描任务已失效，请重新扫描", 409);
  }
  if (scan.storedStatus !== "ready") {
    throw scanImportError(
      "SCAN_NOT_IMPORTABLE",
      "这次扫描没有可导入的候选题目",
      409
    );
  }
  const ids = [
    ...new Set(
      (Array.isArray(candidateIds) ? candidateIds : [])
        .map(Number)
        .filter((id) => Number.isInteger(id) && id > 0)
    )
  ];
  if (!ids.length) {
    throw scanImportError("SCAN_SELECTION_REQUIRED", "请先选择要导入的题目");
  }
  const selected = scan.candidates.filter((candidate) =>
    ids.includes(candidate.id)
  );
  if (selected.length !== ids.length) {
    throw scanImportError(
      "SCAN_CANDIDATE_NOT_FOUND",
      "部分候选题不属于这次扫描"
    );
  }
  if (selected.some((candidate) => !candidate.selected)) {
    throw scanImportError(
      "SCAN_CANDIDATE_NOT_SELECTED",
      "只能导入当前已选择的候选题"
    );
  }
  if (
    selected.some((candidate) => candidate.completenessStatus !== "complete") &&
    confirmIncomplete !== true
  ) {
    throw scanImportError(
      "SCAN_INCOMPLETE_CONFIRMATION_REQUIRED",
      "所选题目可能不完整，请确认后继续"
    );
  }

  const results = [];
  for (const candidate of selected) {
    if (candidate.importedQuestionId) {
      results.push({
        candidateId: candidate.id,
        status: "already_imported",
        questionId: candidate.importedQuestionId
      });
      continue;
    }
    if (!String(candidate.text || "").trim()) {
      results.push({
        candidateId: candidate.id,
        status: "failed",
        error: "题干为空"
      });
      continue;
    }
    let attachment = null;
    try {
      const context = repository.getQuestionScanImageContext(
        scanId,
        candidate.id
      );
      if (!context) throw new Error("扫描图片不存在");
      attachment = await createCandidateAttachment({
        repository,
        attachmentStore,
        context,
        candidate
      });
      const imported = repository.importQuestionScanCandidate({
        scanId,
        candidateId: candidate.id,
        input: {
          question: candidate.text,
          studentAnswer: candidate.studentAnswer || "",
          correctAnswer: candidate.suggestedAnswer || "",
          analysis: "",
          knowledgePoint: "",
          errorType: candidate.suspectedWrong ? "扫描识别待确认" : "",
          attachmentIds: [attachment.id]
        },
        questionType: candidate.questionType,
        completenessStatus:
          candidate.completenessStatus === "complete"
            ? "confirmed"
            : candidate.completenessStatus,
        answerPending:
          candidate.answerPending ||
          candidate.pendingReasons.length > 0 ||
          !candidate.suggestedAnswer,
        suspectedWrong: candidate.suspectedWrong,
        options: candidate.options
      });
      if (imported.alreadyImported) {
        const removed = repository.deleteUnboundAttachment(attachment.id);
        if (!removed.bound) {
          for (const storageKey of removed.storageKeys || []) {
            attachmentStore.delete(storageKey);
          }
        }
        results.push({
          candidateId: candidate.id,
          status: "already_imported",
          questionId: imported.question.id
        });
        continue;
      }
      results.push({
        candidateId: candidate.id,
        status: "imported",
        questionId: imported.question.id
      });
    } catch (error) {
      if (attachment) {
        try {
          const removed = repository.deleteUnboundAttachment(attachment.id);
          if (!removed.bound) {
            for (const storageKey of removed.storageKeys || []) {
              attachmentStore.delete(storageKey);
            }
          }
        } catch {
          // A retained attachment can be removed by the next cleanup pass.
        }
      }
      results.push({
        candidateId: candidate.id,
        status: "failed",
        error: error.message || "导入失败"
      });
    }
  }
  const updated = repository.getQuestionScan(scanId);
  return {
    scan: updated,
    successCount: results.filter(
      (item) => item.status === "imported" || item.status === "already_imported"
    ).length,
    failedCount: results.filter((item) => item.status === "failed").length,
    results
  };
}
