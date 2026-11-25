import sharp from "sharp";
import { LearningValidationError } from "../domain/errors.js";
import { readAttachmentContent } from "../attachment-crop.js";

function failedScan(
  repository,
  attachmentIds,
  message,
  scanner = {},
  scanMode = "single"
) {
  return repository.createQuestionScanTask({
    attachmentIds,
    scanMode,
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
  scanMode = "single"
}) {
  const normalizedScanMode = scanMode === "multi" ? "multi" : "single";
  const ids = Array.isArray(attachmentIds) ? attachmentIds : [];
  if (!scanner?.isConfigured()) {
    return failedScan(
      repository,
      ids,
      "当前没有配置内部 OCR，图片已暂存；请改用手动录入或在配置后重试。",
      {},
      normalizedScanMode
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
      "图片读取失败，图片已暂存；请改用手动录入或重新上传。",
      {},
      normalizedScanMode
    );
  }

  try {
    const result = await scanner.scan({
      images,
      mode: normalizedScanMode
    });
    return repository.createQuestionScanTask({
      attachmentIds: ids,
      scanMode: normalizedScanMode,
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
      },
      normalizedScanMode
    );
  }
}

function scanImportError(code, message, status = 400) {
  const error = new LearningValidationError(code, message);
  error.status = status;
  return error;
}

function splitAcceptedAnswers(value) {
  return String(value || "")
    .split(/[或;；\n]/)
    .map((answer) => answer.trim())
    .filter(Boolean);
}

async function createCandidateAttachment({
  repository,
  attachmentStore,
  context,
  candidate
}) {
  const cropped = await cropScanContext(attachmentStore, context);
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

async function cropScanContext(attachmentStore, context) {
  const buffer = attachmentStore.read(context.storageKey);
  const width = Number(context.width);
  const height = Number(context.height);
  const region = context.region;
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
  return sharp(buffer)
    .rotate()
    .extract({
      left,
      top,
      width: cropWidth,
      height: cropHeight
    })
    .png()
    .toBuffer();
}

function analysisError(code, message, status = 400) {
  const error = new LearningValidationError(code, message);
  error.status = status;
  return error;
}

function translateAnalysisBlocks(blocks, sourceRegion, context) {
  const width = Number(context.width);
  const height = Number(context.height);
  const left = Math.round(sourceRegion.x * width);
  const top = Math.round(sourceRegion.y * height);
  return (Array.isArray(blocks) ? blocks : []).slice(0, 80).map((block) => {
    const region =
      block?.region && typeof block.region === "object"
        ? {
            x: sourceRegion.x + Number(block.region.x || 0) * sourceRegion.width,
            y: sourceRegion.y + Number(block.region.y || 0) * sourceRegion.height,
            width: Number(block.region.width || 0) * sourceRegion.width,
            height: Number(block.region.height || 0) * sourceRegion.height
          }
        : {};
    const bbox = Array.isArray(block?.bbox)
      ? [
          Number(block.bbox[0]) + left,
          Number(block.bbox[1]) + top,
          Number(block.bbox[2]) + left,
          Number(block.bbox[3]) + top
        ]
      : [];
    return {
      ...block,
      imageIndex: 0,
      region,
      bbox
    };
  });
}

function largestAnalyzedCandidate(candidates) {
  return [...candidates].sort((left, right) => {
    const area = (candidate) =>
      Math.max(0, Number(candidate.region?.width) || 0) *
      Math.max(0, Number(candidate.region?.height) || 0);
    return area(right) - area(left);
  })[0];
}

export async function analyzeQuestionScan({
  repository,
  attachmentStore,
  scanner,
  scanId,
  candidateIds
}) {
  const scan = repository.getQuestionScan(scanId);
  if (!scan) {
    throw analysisError("SCAN_NOT_FOUND", "没有找到这次扫描任务", 404);
  }
  if (scan.status === "expired") {
    throw analysisError("SCAN_EXPIRED", "扫描任务已失效，请重新扫描", 409);
  }
  if (scan.storedStatus !== "ready") {
    throw analysisError(
      "SCAN_NOT_ANALYZABLE",
      "这次扫描没有可分析的候选题目",
      409
    );
  }
  if (scan.scanMode !== "multi") {
    throw analysisError(
      "SCAN_SINGLE_ALREADY_ANALYZED",
      "单题扫描已经完成小问与答案分析",
      409
    );
  }
  if (!scanner?.isConfigured()) {
    throw analysisError(
      "SCAN_NOT_CONFIGURED",
      "当前没有配置内部 OCR，暂时不能分析所选题目",
      503
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
    throw analysisError("SCAN_SELECTION_REQUIRED", "请先勾选要分析的题目");
  }
  const candidates = scan.candidates.filter((candidate) =>
    ids.includes(candidate.id)
  );
  if (candidates.length !== ids.length) {
    throw analysisError(
      "SCAN_CANDIDATE_NOT_FOUND",
      "部分题目不属于这次扫描"
    );
  }
  if (candidates.some((candidate) => !candidate.selected)) {
    throw analysisError(
      "SCAN_CANDIDATE_NOT_SELECTED",
      "只能分析当前已勾选的题目"
    );
  }

  const results = [];
  for (const candidate of candidates) {
    if (
      candidate.analysisStage === "analyzed" ||
      candidate.importedQuestionId
    ) {
      results.push({
        candidateId: candidate.id,
        status: "already_analyzed"
      });
      continue;
    }
    try {
      const context = repository.getQuestionScanImageContext(
        scanId,
        candidate.id
      );
      if (!context) throw new Error("题目图片不存在");
      const cropped = await cropScanContext(attachmentStore, context);
      const result = await scanner.scan({
        images: [{ mimeType: "image/png", buffer: cropped }],
        mode: "single"
      });
      const analyzed = largestAnalyzedCandidate(result.candidates || []);
      if (!analyzed) {
        throw new Error("没有识别到题目内容");
      }
      repository.updateQuestionScanCandidate(scanId, candidate.id, {
        analysisStage: "analyzed",
        questionNo: candidate.questionNo,
        text: analyzed.text,
        questionType: analyzed.questionType,
        options: analyzed.options,
        studentAnswer: analyzed.studentAnswer,
        suggestedAnswer: analyzed.suggestedAnswer,
        parts: analyzed.parts,
        completenessStatus: analyzed.completenessStatus,
        suspectedWrong: analyzed.suspectedWrong,
        answerPending: analyzed.answerPending,
        confidence: analyzed.confidence,
        pendingReasons: analyzed.pendingReasons,
        sourceBlocks: translateAnalysisBlocks(
          analyzed.sourceBlocks,
          candidate.region,
          context
        ),
        region: candidate.region,
        recognitionError: ""
      });
      results.push({
        candidateId: candidate.id,
        status: "analyzed"
      });
    } catch (error) {
      repository.updateQuestionScanCandidate(scanId, candidate.id, {
        recognitionError: error?.message || "逐题识别失败，可重新勾选后再试"
      });
      results.push({
        candidateId: candidate.id,
        status: "failed",
        error: error?.message || "逐题识别失败"
      });
    }
  }
  const updated = repository.getQuestionScan(scanId);
  return {
    scan: updated,
    analyzedCount: results.filter((item) => item.status === "analyzed").length,
    failedCount: results.filter((item) => item.status === "failed").length,
    results
  };
}

const SCAN_BOX_REGION_EPSILON = 0.00025;

function normalizeScanBoxRegion(value, label = "题框区域") {
  const region = {
    x: Number(value?.x),
    y: Number(value?.y),
    width: Number(value?.width),
    height: Number(value?.height)
  };
  if (
    !Object.values(region).every(Number.isFinite) ||
    region.x < 0 ||
    region.y < 0 ||
    region.width <= 0 ||
    region.height <= 0 ||
    region.x + region.width > 1.000001 ||
    region.y + region.height > 1.000001
  ) {
    throw analysisError("SCAN_BOX_REGION_INVALID", `${label}无效`);
  }
  return region;
}

function scanBoxRegionsEqual(left, right) {
  return (
    Math.abs(left.x - right.x) <= SCAN_BOX_REGION_EPSILON &&
    Math.abs(left.y - right.y) <= SCAN_BOX_REGION_EPSILON &&
    Math.abs(left.width - right.width) <= SCAN_BOX_REGION_EPSILON &&
    Math.abs(left.height - right.height) <= SCAN_BOX_REGION_EPSILON
  );
}

function normalizeCachedOcrBoxes(ocr) {
  const width = Number(ocr?.width);
  const height = Number(ocr?.height);
  if (!(width > 0) || !(height > 0)) return null;
  const blocks = (Array.isArray(ocr?.blocks) ? ocr.blocks : [])
    .map((block, index) => {
      const region = {
        x: Number(block?.region?.x),
        y: Number(block?.region?.y),
        width: Number(block?.region?.width),
        height: Number(block?.region?.height)
      };
      if (
        !String(block?.id || "").trim() ||
        !String(block?.text || "").trim() ||
        !Object.values(region).every(Number.isFinite) ||
        region.width <= 0 ||
        region.height <= 0
      ) {
        return null;
      }
      const bbox = Array.isArray(block.bbox)
        ? block.bbox.map(Number)
        : [
            region.x * width,
            region.y * height,
            (region.x + region.width) * width,
            (region.y + region.height) * height
          ];
      if (bbox.length !== 4 || !bbox.every(Number.isFinite)) return null;
      return {
        id: String(block.id),
        imageIndex: 0,
        order: Number(block.order) || index + 1,
        text: String(block.text).trim(),
        bbox,
        confidence: Number.isFinite(Number(block.confidence))
          ? Number(block.confidence)
          : null,
        region
      };
    })
    .filter(Boolean)
    .slice(0, 120);
  return {
    provider: String(ocr?.provider || "internal-ocr"),
    model: String(ocr?.model || ocr?.engine || "ocr"),
    version: String(ocr?.version || ""),
    width,
    height,
    blocks
  };
}

function cachedOcrForScanBox(cachedOcr, region, lowConfidence) {
  if (!cachedOcr?.blocks?.length) return null;
  const selectedBlocks = cachedOcr.blocks.filter((block) => {
    const centerX = block.region.x + block.region.width / 2;
    const centerY = block.region.y + block.region.height / 2;
    return (
      centerX >= region.x &&
      centerX <= region.x + region.width &&
      centerY >= region.y &&
      centerY <= region.y + region.height
    );
  });
  if (
    !selectedBlocks.length ||
    selectedBlocks.some(
      (block) =>
        !block.text ||
        !Number.isFinite(block.confidence) ||
        block.confidence < lowConfidence
    )
  ) {
    return null;
  }

  const left = Math.max(
    0,
    Math.min(cachedOcr.width - 1, Math.round(region.x * cachedOcr.width))
  );
  const top = Math.max(
    0,
    Math.min(cachedOcr.height - 1, Math.round(region.y * cachedOcr.height))
  );
  const cropWidth = Math.max(
    1,
    Math.min(
      cachedOcr.width - left,
      Math.round(region.width * cachedOcr.width)
    )
  );
  const cropHeight = Math.max(
    1,
    Math.min(
      cachedOcr.height - top,
      Math.round(region.height * cachedOcr.height)
    )
  );
  const blocks = selectedBlocks.map((block) => {
    const bbox = [
      Math.max(0, Math.min(cropWidth, block.bbox[0] - left)),
      Math.max(0, Math.min(cropHeight, block.bbox[1] - top)),
      Math.max(0, Math.min(cropWidth, block.bbox[2] - left)),
      Math.max(0, Math.min(cropHeight, block.bbox[3] - top))
    ];
    return {
      ...block,
      imageIndex: 0,
      bbox,
      region: {
        x: bbox[0] / cropWidth,
        y: bbox[1] / cropHeight,
        width: Math.max(0, bbox[2] - bbox[0]) / cropWidth,
        height: Math.max(0, bbox[3] - bbox[1]) / cropHeight
      }
    };
  });
  if (
    blocks.some(
      (block) =>
        block.bbox[2] <= block.bbox[0] ||
        block.bbox[3] <= block.bbox[1] ||
        block.region.width <= 0 ||
        block.region.height <= 0
    )
  ) {
    return null;
  }
  return {
    provider: cachedOcr.provider,
    model: cachedOcr.model,
    version: cachedOcr.version,
    width: cropWidth,
    height: cropHeight,
    processingTimeMs: null,
    blocks
  };
}

export async function confirmQuestionScanBoxes({
  repository,
  attachmentStore,
  scanner,
  attachmentId,
  scanMode = "single",
  selections = [],
  ocr = {}
}) {
  const normalizedMode = scanMode === "multi" ? "multi" : "single";
  const attachment = repository.getAttachment(Number(attachmentId), {
    includeStorageKey: true
  });
  if (!attachment) {
    throw analysisError("ATTACHMENT_NOT_FOUND", "验证图片不存在或已被清理", 404);
  }
  const seen = new Set();
  const normalizedSelections = (Array.isArray(selections) ? selections : [])
    .slice(0, 20)
    .map((selection, index) => {
      const blockId = String(selection?.blockId || "").trim();
      if (!blockId || seen.has(blockId)) return null;
      seen.add(blockId);
      return {
        blockId,
        questionNo:
          Number.isInteger(Number(selection?.questionNo)) &&
          Number(selection.questionNo) > 0
            ? Number(selection.questionNo)
            : index + 1,
        region: normalizeScanBoxRegion(selection?.region)
      };
    })
    .filter(Boolean);
  if (
    !normalizedSelections.length ||
    (normalizedMode === "single" && normalizedSelections.length !== 1)
  ) {
    throw analysisError(
      "SCAN_BOX_SELECTION_REQUIRED",
      normalizedMode === "single"
        ? "单题模式必须确认一个题框"
        : "多题模式请至少勾选一个题框"
    );
  }

  const cachedOcr = normalizeCachedOcrBoxes(ocr);
  if (!cachedOcr?.blocks.length) {
    throw analysisError("SCAN_OCR_CACHE_INVALID", "OCR 结果已失效，请重新选择图片");
  }
  const lowConfidence = Number(scanner?.ocrClient?.lowConfidence) || 0.8;
  const sourceContext = {
    attachmentId: attachment.id,
    storageKey: attachment.storageKey,
    mimeType: attachment.originalMimeType,
    width: Number(attachment.width) || cachedOcr.width,
    height: Number(attachment.height) || cachedOcr.height
  };

  const taskCandidates = [];
  const results = [];
  let lastScanner = {};
  for (const selection of normalizedSelections) {
    const originalBlock = cachedOcr.blocks.find(
      (block) => block.id === selection.blockId
    );
    const regionChanged =
      !originalBlock ||
      !scanBoxRegionsEqual(originalBlock.region, selection.region);
    try {
      let analysis;
      let source = "re_ocr";
      const cachedResult = regionChanged
        ? null
        : cachedOcrForScanBox(cachedOcr, selection.region, lowConfidence);
      if (cachedResult) {
        source = "cache";
        analysis = await scanner.scan({
          mode: "single",
          ocrResults: [cachedResult]
        });
      } else {
        const cropped = await cropScanContext(attachmentStore, {
          ...sourceContext,
          region: selection.region
        });
        analysis = await scanner.scan({
          mode: "single",
          images: [{ mimeType: "image/png", buffer: cropped }]
        });
      }
      const candidate = largestAnalyzedCandidate(analysis.candidates || []);
      if (!candidate) throw new Error("没有识别到题目内容");
      lastScanner = {
        provider: analysis.provider,
        model: analysis.model,
        promptVersion: analysis.promptVersion
      };
      taskCandidates.push({
        status: "ready",
        analysisStage: "analyzed",
        questionNo: selection.questionNo,
        text: candidate.text,
        questionType: candidate.questionType,
        options: candidate.options,
        studentAnswer: candidate.studentAnswer,
        suggestedAnswer: candidate.suggestedAnswer,
        parts: candidate.parts,
        completenessStatus: candidate.completenessStatus,
        suspectedWrong: candidate.suspectedWrong,
        answerPending: candidate.answerPending,
        confidence: candidate.confidence,
        pendingReasons: candidate.pendingReasons,
        sourceBlocks: translateAnalysisBlocks(
          candidate.sourceBlocks,
          selection.region,
          sourceContext
        ),
        region: selection.region,
        recognitionError: ""
      });
      results.push({ blockId: selection.blockId, status: "analyzed", source });
    } catch (error) {
      taskCandidates.push({
        status: "failed",
        analysisStage: "discovered",
        questionNo: selection.questionNo,
        text: "",
        region: selection.region,
        recognitionError:
          error?.message || "题框识别失败，请调整题框后重试"
      });
      results.push({
        blockId: selection.blockId,
        status: "failed",
        source: regionChanged ? "re_ocr" : "cache_or_retry",
        error: error?.message || "题框识别失败"
      });
    }
  }

  const analyzedCount = results.filter(
    (result) => result.status === "analyzed"
  ).length;
  if (!analyzedCount) {
    throw analysisError(
      "SCAN_BOX_ANALYSIS_FAILED",
      results[0]?.error || "题框识别失败，请调整题框后重试",
      502
    );
  }
  const scan = repository.createQuestionScanTask({
    attachmentIds: [attachment.id],
    scanMode: normalizedMode,
    candidates: taskCandidates,
    scanner: lastScanner,
    ocr: {
      provider: cachedOcr.provider,
      model: cachedOcr.model,
      blocks: cachedOcr.blocks
    }
  });
  return {
    scan,
    analyzedCount,
    failedCount: results.length - analyzedCount,
    cachedCount: results.filter((result) => result.source === "cache").length,
    reOcrCount: results.filter((result) => result.source === "re_ocr").length,
    results
  };
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
    selected.some(
      (candidate) =>
        candidate.analysisStage !== "analyzed" ||
        candidate.importedQuestionId
    )
  ) {
    throw scanImportError(
      "SCAN_ANALYSIS_REQUIRED",
      "所选题目需要先完成逐题分析，再导入题库",
      409
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
      const parts = (
        candidate.parts?.length
          ? candidate.parts
          : [
              {
                label: "小问 1",
                prompt: candidate.text,
                studentAnswer: candidate.studentAnswer,
                suggestedAnswer: candidate.suggestedAnswer,
                answerType: "auto",
                pendingReasons: candidate.pendingReasons,
                answerSource: "system_suggested"
              }
            ]
      ).map((part, index) => ({
        label: part.label || `小问 ${index + 1}`,
        prompt: part.prompt || (index === 0 ? candidate.text : ""),
        studentAnswer: part.studentAnswer || "",
        answerType: part.answerType || "auto",
        comparisonRule: "auto",
        acceptedAnswers: splitAcceptedAnswers(part.suggestedAnswer)
      }));
      const studentAnswer = parts
        .map((part) => part.studentAnswer)
        .filter(Boolean)
        .join("；");
      const suggestedAnswer = parts
        .map((part) => part.acceptedAnswers[0] || "")
        .filter(Boolean)
        .join("；");
      const imported = repository.importQuestionScanCandidate({
        scanId,
        candidateId: candidate.id,
        input: {
          question: candidate.text,
          studentAnswer,
          correctAnswer: suggestedAnswer,
          analysis: "",
          knowledgePoint: "",
          errorType: candidate.suspectedWrong ? "扫描识别待确认" : "",
          attachmentIds: [attachment.id],
          parts
        },
        questionType: candidate.questionType,
        completenessStatus:
          candidate.completenessStatus === "complete"
            ? "confirmed"
            : candidate.completenessStatus,
        answerPending:
          candidate.answerPending ||
          candidate.pendingReasons.length > 0 ||
          candidate.parts?.some(
            (part) =>
              part.pendingReasons.length > 0 ||
              part.answerSource !== "user_confirmed" ||
              !part.suggestedAnswer
          ),
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
