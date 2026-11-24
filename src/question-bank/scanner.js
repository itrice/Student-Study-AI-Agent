export const QUESTION_SCAN_PROMPT_VERSION = "m2-ocr-text-2";
export const INTERNAL_OCR_TEXT_VERSION = "internal-ocr-1";
export const MAX_SCAN_CANDIDATES = 20;

const QUESTION_TYPES = new Set([
  "general",
  "single_choice",
  "multiple_choice",
  "true_false",
  "fill_blank",
  "short_answer",
  "proof",
  "drawing",
  "composite"
]);

const SCAN_SYSTEM_PROMPT = [
  "你是六年级数学作业页的 OCR 文本整理器。",
  "只能使用输入的 OCR 文字块、坐标和置信度，不解题，不推测图像里没有的文字或几何关系。",
  "印刷题干、学生手写答案和标准答案必须分开；不确定的字段留空。",
  "学生手写答案只能根据文字块整理，不得把题目编号、批改符号或额外符号当作答案。",
  "返回严格 JSON：",
  "{\"candidates\":[{\"text\":\"题干\",\"options\":[{\"label\":\"A\",\"text\":\"选项内容\",\"sourceBlockIds\":[\"b2\"]}],\"questionType\":\"general|single_choice|multiple_choice|true_false|fill_blank|short_answer|proof|drawing|composite\",\"studentAnswer\":\"\",\"suggestedAnswer\":\"\",\"completeness\":\"complete|incomplete|unknown\",\"suspectedWrong\":false,\"answerPending\":false,\"confidence\":0.8,\"sourceBlockIds\":[\"b1\"],\"region\":{\"x\":0,\"y\":0,\"width\":1,\"height\":0.2},\"pendingReasons\":[]}]}",
  "候选题必须按阅读顺序，单次最多 20 道；region 是相对主图的 0～1 坐标。",
  "字块置信度低、字块被拆分或存在额外符号时，answerPending 必须为 true，并在 pendingReasons 说明原因。",
  "图形没有可识别结构时只保留题目图片关联，不编造几何信息。"
].join("\n");

export class QuestionScanError extends Error {
  constructor(code, message, { status = 422, details = null } = {}) {
    super(message);
    this.name = "QuestionScanError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class InternalOcrError extends QuestionScanError {
  constructor(code, message, options = {}) {
    super(code, message, { status: 502, ...options });
    this.name = "InternalOcrError";
  }
}

function compact(value, length = 400) {
  return String(value || "").replace(/\s+/g, " ").slice(0, length);
}

function responseContent(message) {
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) {
    return message.content
      .map((item) => (typeof item === "string" ? item : item?.text || ""))
      .join("");
  }
  return "";
}

function parseJson(value) {
  const text = String(value || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeRegion(value, index = 0, total = 1) {
  const fallback = {
    x: 0,
    y: total ? index / total : 0,
    width: 1,
    height: total ? 1 / total : 1
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallback;
  }
  const region = {
    x: Number(value.x),
    y: Number(value.y),
    width: Number(value.width),
    height: Number(value.height)
  };
  const valid =
    Object.values(region).every(Number.isFinite) &&
    region.x >= 0 &&
    region.y >= 0 &&
    region.width > 0 &&
    region.height > 0 &&
    region.x + region.width <= 1.000001 &&
    region.y + region.height <= 1.000001;
  return valid ? region : fallback;
}

function normalizeQuestionType(value) {
  const type = String(value || "general").trim();
  return QUESTION_TYPES.has(type) ? type : "general";
}

function uniqueStrings(values, max = 12) {
  return [
    ...new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => compact(value, 200))
        .filter(Boolean)
    )
  ].slice(0, max);
}

function bboxVerticalOverlap(left, right) {
  const leftTop = Number(left?.[1]);
  const leftBottom = Number(left?.[3]);
  const rightTop = Number(right?.[1]);
  const rightBottom = Number(right?.[3]);
  if (![leftTop, leftBottom, rightTop, rightBottom].every(Number.isFinite)) {
    return 0;
  }
  const overlap = Math.max(
    0,
    Math.min(leftBottom, rightBottom) - Math.max(leftTop, rightTop)
  );
  const shorter = Math.max(
    1,
    Math.min(leftBottom - leftTop, rightBottom - rightTop)
  );
  return overlap / shorter;
}

function bboxHorizontalGap(left, right) {
  const leftStart = Number(left?.[0]);
  const leftEnd = Number(left?.[2]);
  const rightStart = Number(right?.[0]);
  const rightEnd = Number(right?.[2]);
  if (![leftStart, leftEnd, rightStart, rightEnd].every(Number.isFinite)) {
    return Infinity;
  }
  if (leftEnd < rightStart) return rightStart - leftEnd;
  if (rightEnd < leftStart) return leftStart - rightEnd;
  return 0;
}

function isNumericBlock(text) {
  return /[\d]/u.test(text) && /^[=+\-×÷＜＞<>()（）\d.,，。%:/；;\s]+$/u.test(text);
}

function isIsolatedSymbol(text) {
  return /^[=+\-×÷二三四五六七八九十]$/u.test(String(text || "").trim());
}

export function detectOcrBlockWarnings(blocks, lowConfidence = 0.8) {
  const reasons = new Map(blocks.map((block) => [block.id, []]));
  for (const block of blocks) {
    if (
      Number.isFinite(Number(block.confidence)) &&
      Number(block.confidence) < lowConfidence
    ) {
      reasons.get(block.id).push("LOW_CONFIDENCE");
    }
    if (!isIsolatedSymbol(block.text) && !/^[=+\-×÷]$/u.test(block.text.trim())) {
      continue;
    }
    const nearby = blocks.find((candidate) => {
      if (candidate.id === block.id || !isNumericBlock(candidate.text)) {
        return false;
      }
      return (
        bboxVerticalOverlap(block.bbox, candidate.bbox) >= 0.45 &&
        bboxHorizontalGap(block.bbox, candidate.bbox) <= 24
      );
    });
    if (!nearby) continue;
    const reason = /^[=+\-×÷]$/u.test(block.text.trim())
      ? "SPLIT_TEXT_BLOCK"
      : "EXTRA_SYMBOL";
    reasons.get(block.id).push(reason);
    reasons.get(nearby.id).push(reason);
  }
  return new Map(
    [...reasons.entries()].map(([id, values]) => [id, uniqueStrings(values)])
  );
}

function unionBlockRegion(blocks, fallback) {
  const primary = blocks.filter((block) => block.imageIndex === 0);
  if (!primary.length) return fallback;
  const x = Math.min(...primary.map((block) => block.region.x));
  const y = Math.min(...primary.map((block) => block.region.y));
  const right = Math.max(
    ...primary.map((block) => block.region.x + block.region.width)
  );
  const bottom = Math.max(
    ...primary.map((block) => block.region.y + block.region.height)
  );
  return normalizeRegion({
    x,
    y,
    width: right - x,
    height: bottom - y
  });
}

function publicSourceBlock(block) {
  return {
    id: block.id,
    imageIndex: block.imageIndex,
    order: block.order,
    text: block.text,
    bbox: block.bbox,
    confidence: block.confidence,
    region: block.region,
    warnings: block.warnings
  };
}

function resolveCandidateBlocks(candidate, allBlocks, warningsByBlock) {
  const ids = uniqueStrings(candidate?.sourceBlockIds, MAX_SCAN_CANDIDATES * 8);
  const byId = new Map(allBlocks.map((block) => [block.id, block]));
  return ids
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((block) => ({
      ...block,
      warnings: warningsByBlock.get(block.id) || []
    }));
}

function warningReasonsForAnswers(candidate, allBlocks, warningsByBlock) {
  const answers = [candidate?.studentAnswer, candidate?.suggestedAnswer]
    .map((answer) => compact(answer, 2000))
    .filter(Boolean);
  if (!answers.length) return [];
  return uniqueStrings(
    allBlocks
      .filter((block) => warningsByBlock.get(block.id)?.length)
      .filter((block) => {
        const text = compact(block.text, 2000);
        return answers.some(
          (answer) =>
            answer === text ||
            (text.length >= 2 && answer.includes(text)) ||
            (answer.length >= 2 && text.includes(answer))
        );
      })
      .flatMap((block) => warningsByBlock.get(block.id))
  );
}

function candidateFromLlm(candidate, index, total, allBlocks, warningsByBlock) {
  const text = String(candidate?.text || candidate?.question || "").trim();
  if (!text) return null;
  const sourceBlocks = resolveCandidateBlocks(
    candidate,
    allBlocks,
    warningsByBlock
  );
  const blockWarnings = uniqueStrings(
    sourceBlocks.flatMap((block) => block.warnings)
  );
  const pendingReasons = uniqueStrings([
    ...blockWarnings,
    ...warningReasonsForAnswers(candidate, allBlocks, warningsByBlock),
    ...(Array.isArray(candidate.pendingReasons)
      ? candidate.pendingReasons
      : candidate.pendingReasons
        ? [candidate.pendingReasons]
        : []),
    ...(!sourceBlocks.length ? ["MISSING_SOURCE_BLOCKS"] : []),
    ...(sourceBlocks.some((block) => block.imageIndex > 0)
      ? ["SUPPLEMENT_IMAGE_REGION"]
      : [])
  ]);
  const confidenceValues = [
    Number(candidate.confidence),
    ...sourceBlocks.map((block) => Number(block.confidence))
  ].filter(Number.isFinite);
  const confidence = confidenceValues.length
    ? Math.min(...confidenceValues)
    : null;
  const rawOptions = Array.isArray(candidate.options)
    ? candidate.options
    : Array.isArray(candidate.choices)
      ? candidate.choices
      : [];
  const options = rawOptions
    .slice(0, 20)
    .map((option, optionIndex) => {
      const optionText = String(option?.text || option?.content || "").trim();
      if (!optionText) return null;
      const optionBlocks = resolveCandidateBlocks(
        option,
        allBlocks,
        warningsByBlock
      );
      return {
        position: optionIndex + 1,
        label: String(option?.label || "").trim().slice(0, 20),
        text: optionText.slice(0, 2000),
        sourceBlockIds: optionBlocks.map((block) => block.id),
        pendingReasons: uniqueStrings(
          optionBlocks.flatMap((block) => block.warnings)
        )
      };
    })
    .filter(Boolean);
  return {
    text,
    options,
    questionType: normalizeQuestionType(candidate.questionType),
    studentAnswer: String(candidate.studentAnswer || "").trim().slice(0, 2000),
    suggestedAnswer: String(
      candidate.suggestedAnswer || candidate.correctAnswer || ""
    ).trim().slice(0, 2000),
    completenessStatus: ["complete", "incomplete", "unknown"].includes(
      candidate.completeness
    )
      ? candidate.completeness
      : "unknown",
    suspectedWrong: candidate.suspectedWrong === true,
    answerPending:
      candidate.answerPending === true || pendingReasons.length > 0,
    confidence,
    region: unionBlockRegion(
      sourceBlocks,
      normalizeRegion(candidate.region, index, total)
    ),
    pendingReasons,
    sourceBlocks: sourceBlocks.map(publicSourceBlock)
  };
}

function normalizeLlmCandidates(rawOutput, allBlocks, warningsByBlock) {
  const parsed = parseJson(rawOutput);
  const rawCandidates = Array.isArray(parsed?.candidates)
    ? parsed.candidates
    : Array.isArray(parsed?.questions)
      ? parsed.questions
      : null;
  if (!rawCandidates?.length) {
    throw new QuestionScanError(
      "SCAN_MODEL_INVALID_OUTPUT",
      "文本模型没有返回有效候选结构"
    );
  }
  if (rawCandidates.length > MAX_SCAN_CANDIDATES) {
    throw new QuestionScanError(
      "SCAN_TOO_MANY_CANDIDATES",
      `识别到 ${rawCandidates.length} 道候选，超过单次 ${MAX_SCAN_CANDIDATES} 道，请分批扫描`
    );
  }
  const candidates = rawCandidates
    .map((candidate, index) =>
      candidateFromLlm(
        candidate,
        index,
        rawCandidates.length,
        allBlocks,
        warningsByBlock
      )
    )
    .filter(Boolean);
  if (!candidates.length) {
    throw new QuestionScanError(
      "SCAN_EMPTY_RESULT",
      "没有识别到候选题，请重拍或改用手动录入"
    );
  }
  return candidates;
}

function fallbackCandidates(blocks, warningsByBlock, fallbackReason) {
  const groups = [];
  let current = null;
  for (const block of blocks) {
    const text = block.text.trim();
    const startsQuestion = /^\s*\d{1,2}\s*[.、．)）]/u.test(text);
    if (startsQuestion) {
      if (current) groups.push(current);
      current = [block];
    } else if (current) {
      current.push(block);
    }
  }
  if (current) groups.push(current);
  if (!groups.length) {
    throw new QuestionScanError(
      "SCAN_EMPTY_RESULT",
      "没有识别到带题号的候选题，请重拍或改用手动录入"
    );
  }
  if (groups.length > MAX_SCAN_CANDIDATES) {
    throw new QuestionScanError(
      "SCAN_TOO_MANY_CANDIDATES",
      `识别到 ${groups.length} 道候选，超过单次 ${MAX_SCAN_CANDIDATES} 道，请分批扫描`
    );
  }
  return groups.map((sourceBlocks, index) => {
    const blockWarnings = uniqueStrings(
      sourceBlocks.flatMap(
        (block) => warningsByBlock.get(block.id) || []
      )
    );
    const confidenceValues = sourceBlocks
      .map((block) => Number(block.confidence))
      .filter(Number.isFinite);
    const options = sourceBlocks
      .map((block, optionIndex) => {
        const match = /^\s*([A-H])[.、．)）]\s*(.+)$/u.exec(block.text.trim());
        return match
          ? {
              position: optionIndex + 1,
              label: match[1],
              text: match[2].trim(),
              sourceBlockIds: [block.id],
              pendingReasons: warningsByBlock.get(block.id) || []
            }
          : null;
      })
      .filter(Boolean);
    return {
      text: sourceBlocks.map((block) => block.text.trim()).join("\n"),
      options,
      questionType: "general",
      studentAnswer: "",
      suggestedAnswer: "",
      completenessStatus: "complete",
      suspectedWrong: false,
      answerPending: true,
      confidence: confidenceValues.length
        ? Math.min(...confidenceValues)
        : null,
      region: unionBlockRegion(
        sourceBlocks,
        normalizeRegion(null, index, groups.length)
      ),
      pendingReasons: uniqueStrings([
        fallbackReason,
        "ANSWER_PENDING",
        ...blockWarnings
      ]),
      sourceBlocks: sourceBlocks.map(publicSourceBlock)
    };
  });
}

export class InternalOcrClient {
  constructor({
    baseUrl = "",
    timeoutMs = 60_000,
    lowConfidence = 0.8,
    fetchImpl = globalThis.fetch
  } = {}) {
    this.baseUrl = String(baseUrl || "").replace(/\/+$/, "");
    this.provider = "internal-ocr";
    this.timeoutMs = Number(timeoutMs) || 60_000;
    this.lowConfidence = Number(lowConfidence) || 0.8;
    this.fetchImpl = fetchImpl;
  }

  isConfigured() {
    return Boolean(this.baseUrl && this.fetchImpl);
  }

  async recognize({ buffer, mimeType, imageIndex = 0 }) {
    if (!this.isConfigured()) {
      throw new InternalOcrError("OCR_NOT_CONFIGURED", "内部 OCR 未配置");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/ocr/raw`, {
        method: "POST",
        headers: { "Content-Type": mimeType },
        body: buffer,
        signal: controller.signal
      });
      if (!response.ok) {
        let body = "";
        try {
          body = compact(await response.text(), 600);
        } catch {
          body = "";
        }
        throw new InternalOcrError(
          "OCR_PROCESSING_FAILED",
          "OCR 服务识别失败，可重拍或改用手动录入",
          {
            details: { upstreamStatus: response.status, upstreamBody: body }
          }
        );
      }
      const data = await response.json();
      if (!Array.isArray(data.blocks)) {
        throw new InternalOcrError(
          "OCR_INVALID_RESPONSE",
          "OCR 服务返回结构无效"
        );
      }
      return {
        provider: "internal-ocr",
        model: String(data.modelVersion || data.engine || "ocr"),
        engine: String(data.engine || "ocr"),
        version: String(data.modelVersion || ""),
        width: Number(data.width) || 0,
        height: Number(data.height) || 0,
        processingTimeMs: Number(data.processingTimeMs) || null,
        blocks: data.blocks
          .map((block, index) => {
            const bbox = Array.isArray(block.bbox)
              ? block.bbox.map(Number)
              : null;
            const width = Number(data.width);
            const height = Number(data.height);
            if (
              !bbox ||
              bbox.length !== 4 ||
              !bbox.every(Number.isFinite) ||
              !(width > 0) ||
              !(height > 0)
            ) {
              return null;
            }
            return {
              id: `i${imageIndex + 1}b${index + 1}`,
              imageIndex,
              order: Number(block.order) || index + 1,
              text: String(block.text || "").trim(),
              bbox,
              confidence: Number.isFinite(Number(block.confidence))
                ? Number(block.confidence)
                : null,
              region: normalizeRegion({
                x: bbox[0] / width,
                y: bbox[1] / height,
                width: (bbox[2] - bbox[0]) / width,
                height: (bbox[3] - bbox[1]) / height
              })
            };
          })
          .filter((block) => block?.text)
      };
    } catch (error) {
      if (error instanceof QuestionScanError) throw error;
      throw new InternalOcrError(
        error.name === "AbortError"
          ? "OCR_TIMEOUT"
          : "OCR_NETWORK_ERROR",
        error.name === "AbortError"
          ? "OCR 服务响应超时，可重拍或改用手动录入"
          : "无法连接内部 OCR 服务，可重拍或改用手动录入",
        { details: { cause: error.name || "Error" } }
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

export class OcrTextQuestionScanner {
  constructor({
    ocrClient,
    llmGateway = null,
    provider = "internal-ocr+llm",
    timeoutMs = 120_000
  } = {}) {
    this.ocrClient = ocrClient;
    this.llmGateway = llmGateway;
    this.provider = provider;
    this.model = llmGateway?.model || "rules";
    this.timeoutMs = timeoutMs;
  }

  isConfigured() {
    return this.ocrClient?.isConfigured() === true;
  }

  async scan({ images }) {
    if (!this.isConfigured()) {
      throw new QuestionScanError(
        "SCAN_NOT_CONFIGURED",
        "内部 OCR 未配置，图片已暂存；请改用手动录入或配置后重试。"
      );
    }
    if (!Array.isArray(images) || !images.length) {
      throw new QuestionScanError(
        "SCAN_IMAGE_REQUIRED",
        "请先选择扫描图片",
        { status: 400 }
      );
    }
    const ocrResults = [];
    try {
      for (const [index, image] of images.entries()) {
        ocrResults.push(
          await this.ocrClient.recognize({
            buffer: image.buffer,
            mimeType: image.mimeType,
            imageIndex: index
          })
        );
      }
    } catch (error) {
      if (error instanceof QuestionScanError) throw error;
      throw new QuestionScanError(
        "SCAN_OCR_FAILED",
        "OCR 识别失败，可重拍或改用手动录入",
        { status: 502, details: { cause: error.name || "Error" } }
      );
    }
    const blocks = ocrResults
      .flatMap((result) => result.blocks)
      .sort(
        (left, right) =>
          left.imageIndex - right.imageIndex || left.order - right.order
      );
    if (!blocks.length) {
      throw new QuestionScanError(
        "SCAN_EMPTY_RESULT",
        "OCR 没有识别到文字，可重拍或改用手动录入"
      );
    }
    const warningsByBlock = detectOcrBlockWarnings(
      blocks,
      this.ocrClient.lowConfidence
    );
    const withWarnings = blocks.map((block) => ({
      ...block,
      warnings: warningsByBlock.get(block.id) || []
    }));
    const ocrText = withWarnings
      .map(
        (block) =>
          `[${block.id}] image=${block.imageIndex + 1} ` +
          `bbox=${block.bbox.join(",")} confidence=${block.confidence ?? "unknown"} ` +
          `text=${block.text}`
      )
      .join("\n");
    let rawOutput = "";
    let fallbackReason = null;
    let candidates;
    let provider = "internal-ocr+rules";
    let model = "rules";
    if (this.llmGateway?.isConfigured?.()) {
      try {
        const result = await this.llmGateway.chat({
          messages: [
            { role: "system", content: SCAN_SYSTEM_PROMPT },
            {
              role: "user",
              content:
                "请根据以下 OCR 字块整理候选题，只返回严格 JSON：\n" +
                ocrText
            }
          ],
          responseFormat: { type: "json_object" }
        });
        rawOutput = responseContent(result.message);
        candidates = normalizeLlmCandidates(
          rawOutput,
          withWarnings,
          warningsByBlock
        );
        provider = `${this.ocrClient.provider || "ocr"}+${result.provider || "llm"}`;
        model = result.model || this.llmGateway.model;
      } catch (error) {
        fallbackReason =
          error?.code === "LLM_TIMEOUT"
            ? "LLM_TIMEOUT"
            : "LLM_UNAVAILABLE";
      }
    } else {
      fallbackReason = "LLM_NOT_CONFIGURED";
    }
    if (!candidates) {
      candidates = fallbackCandidates(
        withWarnings,
        warningsByBlock,
        fallbackReason
      );
    }
    console.log(
      `[question-scan] OCR 完成 blocks=${blocks.length} ` +
        `images=${images.length} provider=${provider}`
    );
    return {
      candidates,
      rawOutput,
      provider,
      model,
      promptVersion: QUESTION_SCAN_PROMPT_VERSION,
      ocr: {
        provider: ocrResults[0]?.provider || "internal-ocr",
        model: ocrResults[0]?.model || "ocr",
        version: ocrResults[0]?.version || "",
        blocks: withWarnings
      }
    };
  }
}

export class InternalOcrTextExtractor {
  constructor({ ocrClient }) {
    this.ocrClient = ocrClient;
  }

  isConfigured() {
    return this.ocrClient?.isConfigured() === true;
  }

  async extract({ buffer, mimeType }) {
    const result = await this.ocrClient.recognize({
      buffer,
      mimeType,
      imageIndex: 0
    });
    return {
      rawOutput: JSON.stringify(result.blocks),
      normalizedText: result.blocks
        .map((block) => String(block.text || "").trim())
        .filter(Boolean)
        .join("\n"),
      confidence: null,
      provider: result.engine || result.provider || "internal-ocr",
      model: result.model,
      promptVersion: INTERNAL_OCR_TEXT_VERSION
    };
  }
}

export function createInternalOcrTextExtractorFromEnvironment(
  environment = process.env
) {
  return new InternalOcrTextExtractor({
    ocrClient: new InternalOcrClient({
      baseUrl: environment.OCR_BASE_URL || "",
      timeoutMs: Number(environment.OCR_TIMEOUT_MS || 60_000)
    })
  });
}

export function createQuestionScannerFromEnvironment(
  environment = process.env,
  { gateway = null } = {}
) {
  return new OcrTextQuestionScanner({
    ocrClient: new InternalOcrClient({
      baseUrl: environment.OCR_BASE_URL || "",
      timeoutMs: Number(environment.OCR_TIMEOUT_MS || 60_000),
      lowConfidence: Number(environment.OCR_LOW_CONFIDENCE || 0.8)
    }),
    llmGateway: gateway,
    provider: "internal-ocr+llm",
    timeoutMs: Number(environment.OCR_SCAN_TIMEOUT_MS || 120_000)
  });
}
