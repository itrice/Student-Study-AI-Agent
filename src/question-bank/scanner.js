export const QUESTION_SCAN_PROMPT_VERSION = "m2-ocr-parts-4";
export const QUESTION_DISCOVERY_PROMPT_VERSION = "m2-ocr-boundaries-1";
export const INTERNAL_OCR_TEXT_VERSION = "internal-ocr-1";
export const MAX_SCAN_CANDIDATES = 20;
export const MAX_OCR_IMAGE_BYTES = 900 * 1024;

const OCR_JPEG_QUALITIES = [88, 80, 72, 64, 56];
const OCR_MAX_DIMENSIONS = [2400, 2000, 1600, 1280];

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

const ANSWER_TYPES = new Set([
  "auto",
  "text",
  "number",
  "fraction",
  "percent",
  "ratio"
]);

const SCAN_SYSTEM_PROMPT = [
  "你是六年级数学作业页的 OCR 文本整理器。",
  "只能使用输入的 OCR 文字块、坐标和置信度，不推测图像里没有的文字或几何关系。",
  "印刷题干、学生手写答案和标准答案必须分开；不确定的字段留空，不得编造答案。",
  "学生手写答案只能根据文字块整理，不得把题目编号、批改符号或额外符号当作答案。",
  "识别题目中的全部小问；没有明确小问时只生成 1 个默认小问。",
  "必须返回 parts 数组；一个题干中每个独立问句都要成为单独小问，不能只把整题填成一个小问。",
  "标准答案建议只能在题意完整、公式和几何关系足够时给出；信息不足时留空并标记 FORMULA_UNCERTAIN 或 GEOMETRY_UNCERTAIN。",
  "题意完整且可通过六年级数学计算得到时，必须给出 suggestedAnswer；不得因为需要计算而留空。",
  "同一小问的等价标准答案用中文分号“；”分隔。",
  "返回严格 JSON：",
  "{\"candidates\":[{\"text\":\"整题题干\",\"options\":[{\"label\":\"A\",\"text\":\"选项内容\",\"sourceBlockIds\":[\"b2\"]}],\"questionType\":\"general|single_choice|multiple_choice|true_false|fill_blank|short_answer|proof|drawing|composite\",\"parts\":[{\"partNo\":1,\"label\":\"小问 1\",\"prompt\":\"小问文字\",\"studentAnswer\":\"\",\"suggestedAnswer\":\"\",\"answerType\":\"auto|text|number|fraction|percent|ratio\",\"confidence\":0.8,\"sourceBlockIds\":[\"b1\"],\"pendingReasons\":[]}],\"completeness\":\"complete|incomplete|unknown\",\"suspectedWrong\":false,\"answerPending\":false,\"confidence\":0.8,\"sourceBlockIds\":[\"b1\"],\"region\":{\"x\":0,\"y\":0,\"width\":1,\"height\":0.2},\"pendingReasons\":[]}]}",
  "候选题必须按阅读顺序，单次最多 20 道；region 是相对主图的 0～1 坐标。",
  "字块置信度低、字块被拆分、存在额外符号、公式或几何关系不足时，answerPending 必须为 true，并在对应 pendingReasons 说明原因。",
  "图形没有可识别结构时只保留题目图片关联，不编造几何信息。"
].join("\n");

const SCAN_PART_REPAIR_PROMPT = [
  "你是六年级数学题结构化助手。",
  "严格依据 OCR 文字和候选题干，只返回 JSON：{\"candidates\":[{\"candidateNo\":1,\"parts\":[{\"label\":\"小问 1\",\"prompt\":\"小问文字\",\"studentAnswer\":\"\",\"suggestedAnswer\":\"\",\"answerType\":\"auto|text|number|fraction|percent|ratio\",\"confidence\":0.8,\"pendingReasons\":[]}]}]}。",
  "题干中每个独立问句都必须是单独小问；家长式或复合题保留原顺序。",
  "学生答案只能来自 OCR 文字；不确定就留空并标记待确认。",
  "信息完整且可计算时必须给出标准答案建议，等价答案用中文分号分隔；公式或几何关系不足时留空并标记 FORMULA_UNCERTAIN 或 GEOMETRY_UNCERTAIN。"
].join("\n");

const MULTI_QUESTION_DISCOVERY_PROMPT = [
  "你是作业页题目边界整理助手。",
  "只根据输入的 OCR 文字块、坐标和置信度确定每道题的边界与可见题号。",
  "这一步只做题目分组，不分析小问，不识别学生答案，不建议标准答案，不判断题型。",
  "每道题必须包含该题从题号开始的全部 OCR 字块，按页面阅读顺序返回。",
  "不得把同一题拆成多道，也不得把不同题合并；无法确认边界时仍返回最保守的单题范围。",
  "返回严格 JSON：",
  "{\"questions\":[{\"questionNo\":7,\"sourceBlockIds\":[\"i1b2\",\"i1b3\"]}]}",
  "questionNo 使用页面上可见的题号；看不清题号时按阅读顺序使用 1、2、3。",
  "sourceBlockIds 只能引用输入中实际存在的字块，单次最多 20 道题。"
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

async function prepareImageForOcr({ buffer }) {
  const metadata = await sharp(buffer).metadata();
  const swapsAxes = Number(metadata.orientation) >= 5;
  const sourceWidth = swapsAxes ? metadata.height : metadata.width;
  const sourceHeight = swapsAxes ? metadata.width : metadata.height;
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) {
    throw new QuestionScanError(
      "OCR_IMAGE_INVALID",
      "扫描图片尺寸无效，请重新拍照或改用手动录入"
    );
  }
  for (const maxDimension of OCR_MAX_DIMENSIONS) {
    for (const quality of OCR_JPEG_QUALITIES) {
      const prepared = await sharp(buffer)
        .rotate()
        .resize({
          width: maxDimension,
          height: maxDimension,
          fit: "inside",
          withoutEnlargement: true
        })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality })
        .toBuffer();
      if (prepared.length <= MAX_OCR_IMAGE_BYTES) {
        return {
          buffer: prepared,
          mimeType: "image/jpeg",
          sourceWidth,
          sourceHeight
        };
      }
    }
  }
  throw new QuestionScanError(
    "OCR_IMAGE_TOO_LARGE",
    "扫描图片压缩后仍过大，请缩小裁剪区域后重试"
  );
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

function normalizeAnswerType(value) {
  const type = String(value || "auto").trim();
  return ANSWER_TYPES.has(type) ? type : "auto";
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
  const explicit = ids
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((block) => ({
      ...block,
      warnings: warningsByBlock.get(block.id) || []
    }));
  if (explicit.length) return explicit;

  const sourceTexts = [
    candidate?.text,
    candidate?.question,
    candidate?.prompt
  ]
    .map((text) => compact(text, 5000))
    .filter((text) => text.length >= 4);
  if (!sourceTexts.length) return [];

  return allBlocks
    .filter((block) => {
      const blockText = compact(block.text, 5000);
      if (blockText.length < 2) return false;
      return sourceTexts.some((sourceText) => {
        if (
          sourceText.includes(blockText) ||
          blockText.includes(sourceText)
        ) {
          return true;
        }
        if (blockText.length < 4) return false;
        let matched = 0;
        let cursor = 0;
        for (const character of blockText) {
          const index = sourceText.indexOf(character, cursor);
          if (index < 0) continue;
          matched += 1;
          cursor = index + 1;
        }
        return matched / blockText.length >= 0.75;
      });
    })
    .sort((left, right) => left.order - right.order)
    .map((block) => ({
      ...block,
      warnings: warningsByBlock.get(block.id) || []
    }));
}

function warningReasonsForAnswers(candidate, allBlocks, warningsByBlock) {
  const answers = [
    candidate?.studentAnswer,
    candidate?.suggestedAnswer,
    ...(Array.isArray(candidate?.parts)
      ? candidate.parts.flatMap((part) => [
          part?.studentAnswer,
          part?.suggestedAnswer,
          part?.correctAnswer,
          ...(Array.isArray(part?.acceptedAnswers)
            ? part.acceptedAnswers
            : [])
        ])
      : [])
  ]
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

function normalizePartFromLlm(
  part,
  partIndex,
  partCount,
  candidate,
  allBlocks,
  warningsByBlock,
  lowConfidence
) {
  const sourceBlocks = resolveCandidateBlocks(
    part,
    allBlocks,
    warningsByBlock
  );
  const suggestedAnswer = String(
    part?.suggestedAnswer ||
      part?.correctAnswer ||
      (Array.isArray(part?.acceptedAnswers)
        ? part.acceptedAnswers.join("；")
        : "")
  )
    .trim()
    .slice(0, 2000);
  const prompt =
    String(
      part?.prompt ||
        part?.text ||
        (partCount === 1 ? candidate?.text || candidate?.question || "" : "")
    )
      .trim()
      .slice(0, 2000);
  const confidenceValues = [
    Number(part?.confidence),
    ...sourceBlocks.map((block) => Number(block.confidence))
  ].filter(Number.isFinite);
  const confidence = confidenceValues.length
    ? Math.min(...confidenceValues)
    : null;
  const pendingReasons = uniqueStrings([
    ...sourceBlocks.flatMap((block) => block.warnings),
    ...warningReasonsForAnswers(part, allBlocks, warningsByBlock),
    ...(Array.isArray(part?.pendingReasons)
      ? part.pendingReasons
      : part?.pendingReasons
        ? [part.pendingReasons]
        : []),
    ...(confidence !== null && confidence < lowConfidence
      ? ["LOW_CONFIDENCE"]
      : []),
    ...(!suggestedAnswer ? ["ANSWER_PENDING"] : []),
    ...(!prompt ? ["PART_PROMPT_MISSING"] : [])
  ]);
  return {
    partNo: partIndex + 1,
    label: String(part?.label || `小问 ${partIndex + 1}`)
      .trim()
      .slice(0, 50),
    prompt,
    studentAnswer: String(
      part?.studentAnswer ||
        (partCount === 1 ? candidate?.studentAnswer || "" : "")
    )
      .trim()
      .slice(0, 2000),
    suggestedAnswer,
    answerType: normalizeAnswerType(part?.answerType),
    confidence,
    sourceBlockIds: sourceBlocks.map((block) => block.id),
    pendingReasons,
    answerSource: "system_suggested"
  };
}

function inferPartPrompts(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return [""];

  const markers = [
    ...normalized.matchAll(/(?:^|\s)(?:\((\d{1,2})\)|(\d{1,2})[.、．])\s*/gu)
  ];
  if (markers.length >= 2) {
    return markers.map((marker, index) => {
      const start = marker.index + marker[0].length;
      const end =
        index + 1 < markers.length ? markers[index + 1].index : normalized.length;
      return normalized.slice(start, end).trim();
    });
  }

  const questions = normalized
    .split(/(?<=？)/u)
    .map((question) => question.trim())
    .filter(Boolean);
  if (questions.length > 1) return questions;
  return [normalized.replace(/^\s*\d{1,2}\s*[.、．]\s*/u, "")];
}

function inferAnswerType(prompt) {
  if (/[%％]/u.test(prompt)) return "percent";
  if (/比|比例/u.test(prompt)) return "ratio";
  if (/几分之几|分数/u.test(prompt)) return "fraction";
  if (/多少|求|计算/u.test(prompt)) return "number";
  return "auto";
}

function normalizeCandidateParts(
  candidate,
  allBlocks,
  warningsByBlock,
  lowConfidence
) {
  const inferredPrompts = inferPartPrompts(
    candidate?.text || candidate?.question || ""
  );
  const rawParts =
    Array.isArray(candidate?.parts) && candidate.parts.length
      ? candidate.parts
      : inferredPrompts.map((prompt, index) => ({
          partNo: index + 1,
          label: `小问 ${index + 1}`,
          prompt,
          studentAnswer:
            inferredPrompts.length === 1 ? candidate?.studentAnswer || "" : "",
          suggestedAnswer:
            inferredPrompts.length === 1
              ? candidate?.suggestedAnswer || candidate?.correctAnswer || ""
              : "",
          answerType:
            candidate?.answerType || inferAnswerType(prompt),
          confidence: candidate?.confidence,
          sourceBlockIds: candidate?.sourceBlockIds,
          pendingReasons: uniqueStrings([
            ...(Array.isArray(candidate?.pendingReasons)
              ? candidate.pendingReasons
              : candidate?.pendingReasons
                ? [candidate.pendingReasons]
                : []),
            ...(inferredPrompts.length > 1 ? ["PART_SPLIT_INFERRED"] : [])
          ])
        }));
  return rawParts
    .slice(0, 20)
    .map((part, partIndex) =>
      normalizePartFromLlm(
        part,
        partIndex,
        rawParts.length,
        candidate,
        allBlocks,
        warningsByBlock,
        lowConfidence
      )
    );
}

function candidateFromLlm(
  candidate,
  index,
  total,
  allBlocks,
  warningsByBlock,
  lowConfidence
) {
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
  const parts = normalizeCandidateParts(
    candidate,
    allBlocks,
    warningsByBlock,
    lowConfidence
  );
  const partPending = parts.some((part) => part.pendingReasons.length > 0);
  const studentAnswer = String(
    parts.map((part) => part.studentAnswer).filter(Boolean).join("；")
  )
    .trim()
    .slice(0, 2000);
  const suggestedAnswer = String(
    parts.map((part) => part.suggestedAnswer).filter(Boolean).join("；")
  )
    .trim()
    .slice(0, 2000);
  return {
    text,
    options,
    questionType: normalizeQuestionType(candidate.questionType),
    studentAnswer,
    suggestedAnswer,
    parts,
    completenessStatus: ["complete", "incomplete", "unknown"].includes(
      candidate.completeness
    )
      ? candidate.completeness
      : "unknown",
    suspectedWrong: candidate.suspectedWrong === true,
    answerPending:
      candidate.answerPending === true ||
      pendingReasons.length > 0 ||
      partPending,
    confidence,
    region: unionBlockRegion(
      sourceBlocks,
      normalizeRegion(candidate.region, index, total)
    ),
    pendingReasons,
    sourceBlocks: sourceBlocks.map(publicSourceBlock)
  };
}

function normalizeLlmCandidates(
  rawOutput,
  allBlocks,
  warningsByBlock,
  lowConfidence
) {
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
        warningsByBlock,
        lowConfidence
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

function candidateNeedsPartRepair(rawOutput) {
  const parsed = parseJson(rawOutput);
  const candidates = Array.isArray(parsed?.candidates)
    ? parsed.candidates
    : Array.isArray(parsed?.questions)
      ? parsed.questions
      : [];
  return candidates.some((candidate) => {
    const inferredCount = inferPartPrompts(
      candidate?.text || candidate?.question || ""
    ).length;
    return (
      !Array.isArray(candidate?.parts) ||
      candidate.parts.length === 0 ||
      (inferredCount > 1 && candidate.parts.length < inferredCount)
    );
  });
}

function mergePartRepair(rawOutput, repairOutput) {
  const original = parseJson(rawOutput);
  const repaired = parseJson(repairOutput);
  const originalCandidates = Array.isArray(original?.candidates)
    ? original.candidates
    : Array.isArray(original?.questions)
      ? original.questions
      : [];
  const repairedCandidates = Array.isArray(repaired?.candidates)
    ? repaired.candidates
    : Array.isArray(repaired?.questions)
      ? repaired.questions
      : repaired?.parts
        ? [{ candidateNo: 1, parts: repaired.parts }]
        : [];
  if (!originalCandidates.length || !repairedCandidates.length) return null;
  const hasExplicitCandidateIds = repairedCandidates.some((item) =>
    Number.isInteger(
      Number(item?.candidateNo ?? item?.index ?? item?.no)
    )
  );
  return JSON.stringify({
    candidates: originalCandidates.map((candidate, index) => {
      const repairedCandidate = hasExplicitCandidateIds
        ? repairedCandidates.find(
            (item) =>
              Number(item?.candidateNo ?? item?.index ?? item?.no) === index + 1
          )
        : repairedCandidates[index];
      return Array.isArray(repairedCandidate?.parts) &&
        repairedCandidate.parts.length
        ? { ...candidate, parts: repairedCandidate.parts }
        : candidate;
    })
  });
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
    const pendingReasons = uniqueStrings([
      fallbackReason,
      "ANSWER_PENDING",
      ...blockWarnings
    ]);
    const confidence = confidenceValues.length
      ? Math.min(...confidenceValues)
      : null;
    const parts = [
      {
        partNo: 1,
        label: "小问 1",
        prompt: sourceBlocks.map((block) => block.text.trim()).join("\n"),
        studentAnswer: "",
        suggestedAnswer: "",
        answerType: "auto",
        confidence,
        sourceBlockIds: sourceBlocks.map((block) => block.id),
        pendingReasons,
        answerSource: "system_suggested"
      }
    ];
    return {
      text: sourceBlocks.map((block) => block.text.trim()).join("\n"),
      options,
      questionType: "general",
      studentAnswer: "",
      suggestedAnswer: "",
      parts,
      completenessStatus: "complete",
      suspectedWrong: false,
      answerPending: true,
      confidence,
      region: unionBlockRegion(
        sourceBlocks,
        normalizeRegion(null, index, groups.length)
      ),
      pendingReasons,
      sourceBlocks: sourceBlocks.map(publicSourceBlock)
    };
  });
}

function discoveredCandidateNo(value, sourceBlocks, fallback) {
  const explicit = Number(value?.questionNo ?? value?.number ?? value?.no);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  const match = /^\s*(\d{1,3})\s*[.、．)）]/u.exec(
    String(sourceBlocks[0]?.text || "")
  );
  const visible = Number(match?.[1]);
  return Number.isInteger(visible) && visible > 0 ? visible : fallback;
}

function discoveredCandidate(
  value,
  index,
  total,
  allBlocks,
  warningsByBlock,
  fallbackReason = ""
) {
  const byId = new Map(allBlocks.map((block) => [block.id, block]));
  const explicitIds = uniqueStrings(
    value?.sourceBlockIds,
    MAX_SCAN_CANDIDATES * 8
  );
  let sourceBlocks = explicitIds
    .map((id) => byId.get(id))
    .filter(Boolean)
    .sort((left, right) => left.order - right.order);
  if (!sourceBlocks.length) {
    const questionNo = discoveredCandidateNo(value, [], index + 1);
    const primaryBlocks = allBlocks.filter((block) => block.imageIndex === 0);
    const startIndex = primaryBlocks.findIndex((block) =>
      new RegExp(`^\\s*${questionNo}\\s*[.、．)）]`, "u").test(block.text)
    );
    if (startIndex >= 0) {
      const nextIndex = primaryBlocks.findIndex(
        (block, blockIndex) =>
          blockIndex > startIndex &&
          /^\s*\d{1,3}\s*[.、．)）]/u.test(block.text)
      );
      sourceBlocks = primaryBlocks.slice(
        startIndex,
        nextIndex < 0 ? undefined : nextIndex
      );
    } else {
      sourceBlocks = primaryBlocks.slice(0, 1);
    }
  }
  sourceBlocks = sourceBlocks.map((block) => ({
    ...block,
    warnings: warningsByBlock.get(block.id) || block.warnings || []
  }));
  const confidenceValues = sourceBlocks
    .map((block) => Number(block.confidence))
    .filter(Number.isFinite);
  return {
    text: sourceBlocks.map((block) => block.text.trim()).join("\n"),
    options: [],
    questionType: "general",
    studentAnswer: "",
    suggestedAnswer: "",
    parts: [],
    analysisStage: "discovered",
    questionNo: discoveredCandidateNo(value, sourceBlocks, index + 1),
    completenessStatus: "unknown",
    suspectedWrong: false,
    answerPending: true,
    confidence: confidenceValues.length
      ? Math.min(...confidenceValues)
      : null,
    region: unionBlockRegion(
      sourceBlocks,
      normalizeRegion(null, index, total)
    ),
    pendingReasons: uniqueStrings([
      ...sourceBlocks.flatMap((block) => block.warnings),
      ...(fallbackReason ? [fallbackReason] : [])
    ]),
    sourceBlocks: sourceBlocks.map(publicSourceBlock)
  };
}

function normalizeDiscoveredCandidates(
  rawOutput,
  allBlocks,
  warningsByBlock
) {
  const parsed = parseJson(rawOutput);
  const rawCandidates = Array.isArray(parsed?.questions)
    ? parsed.questions
    : Array.isArray(parsed?.candidates)
      ? parsed.candidates
      : null;
  if (!rawCandidates?.length) {
    throw new QuestionScanError(
      "SCAN_DISCOVERY_INVALID_OUTPUT",
      "文本模型没有返回有效的题目边界"
    );
  }
  if (rawCandidates.length > MAX_SCAN_CANDIDATES) {
    throw new QuestionScanError(
      "SCAN_TOO_MANY_CANDIDATES",
      `识别到 ${rawCandidates.length} 道题，超过单次 ${MAX_SCAN_CANDIDATES} 道，请分批扫描`
    );
  }
  return rawCandidates.map((candidate, index) =>
    discoveredCandidate(
      candidate,
      index,
      rawCandidates.length,
      allBlocks,
      warningsByBlock
    )
  );
}

function fallbackDiscoveredCandidates(
  blocks,
  warningsByBlock,
  fallbackReason
) {
  const groups = [];
  let current = null;
  for (const block of blocks.filter((item) => item.imageIndex === 0)) {
    if (/^\s*\d{1,3}\s*[.、．)）]/u.test(block.text)) {
      if (current) groups.push(current);
      current = [block];
    } else if (current) {
      current.push(block);
    }
  }
  if (current) groups.push(current);
  const sourceGroups = groups.length ? groups : [blocks];
  if (sourceGroups.length > MAX_SCAN_CANDIDATES) {
    throw new QuestionScanError(
      "SCAN_TOO_MANY_CANDIDATES",
      `识别到 ${sourceGroups.length} 道题，超过单次 ${MAX_SCAN_CANDIDATES} 道，请分批扫描`
    );
  }
  return sourceGroups.map((sourceBlocks, index) =>
    discoveredCandidate(
      { sourceBlockIds: sourceBlocks.map((block) => block.id) },
      index,
      sourceGroups.length,
      blocks,
      warningsByBlock,
      fallbackReason
    )
  );
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

  async recognize({
    buffer,
    mimeType,
    imageIndex = 0,
    sourceWidth,
    sourceHeight
  }) {
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
            const coordinateWidth = Number(sourceWidth) || width;
            const coordinateHeight = Number(sourceHeight) || height;
            if (
              !bbox ||
              bbox.length !== 4 ||
              !bbox.every(Number.isFinite) ||
              !(width > 0) ||
              !(height > 0)
            ) {
              return null;
            }
            const mappedBbox = [
              (bbox[0] / width) * coordinateWidth,
              (bbox[1] / height) * coordinateHeight,
              (bbox[2] / width) * coordinateWidth,
              (bbox[3] / height) * coordinateHeight
            ];
            return {
              id: `i${imageIndex + 1}b${index + 1}`,
              imageIndex,
              order: Number(block.order) || index + 1,
              text: String(block.text || "").trim(),
              bbox: mappedBbox,
              confidence: Number.isFinite(Number(block.confidence))
                ? Number(block.confidence)
                : null,
              region: normalizeRegion({
                x: mappedBbox[0] / coordinateWidth,
                y: mappedBbox[1] / coordinateHeight,
                width: (mappedBbox[2] - mappedBbox[0]) / coordinateWidth,
                height: (mappedBbox[3] - mappedBbox[1]) / coordinateHeight
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

  async scan({ images, mode = "single" }) {
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
        const prepared = await prepareImageForOcr(image);
        ocrResults.push(
          await this.ocrClient.recognize({
            buffer: prepared.buffer,
            mimeType: prepared.mimeType,
            imageIndex: index,
            sourceWidth: prepared.sourceWidth,
            sourceHeight: prepared.sourceHeight
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
    if (mode === "multi") {
      let rawOutput = "";
      let fallbackReason = null;
      let candidates;
      let provider = "internal-ocr+rules";
      let model = "rules";
      if (this.llmGateway?.isConfigured?.()) {
        try {
          const result = await this.llmGateway.chat({
            messages: [
              { role: "system", content: MULTI_QUESTION_DISCOVERY_PROMPT },
              {
                role: "user",
                content:
                  "请仅整理以下 OCR 字块所属的题目边界，只返回严格 JSON：\n" +
                  ocrText
              }
            ],
            responseFormat: { type: "json_object" }
          });
          rawOutput = responseContent(result.message);
          candidates = normalizeDiscoveredCandidates(
            rawOutput,
            withWarnings,
            warningsByBlock
          );
          provider = `${this.ocrClient.provider || "ocr"}+${
            result.provider || "llm"
          }`;
          model = result.model || this.llmGateway.model;
        } catch {
          fallbackReason = "BOUNDARY_FROM_RULES";
        }
      } else {
        fallbackReason = "LLM_NOT_CONFIGURED";
      }
      if (!candidates) {
        candidates = fallbackDiscoveredCandidates(
          withWarnings,
          warningsByBlock,
          fallbackReason
        );
      }
      console.log(
        `[question-scan] 多题边界完成 blocks=${blocks.length} ` +
          `questions=${candidates.length} images=${images.length} provider=${provider}`
      );
      return {
        candidates,
        rawOutput,
        provider,
        model,
        promptVersion: QUESTION_DISCOVERY_PROMPT_VERSION,
        ocr: {
          provider: ocrResults[0]?.provider || "internal-ocr",
          model: ocrResults[0]?.model || "ocr",
          version: ocrResults[0]?.version || "",
          blocks: withWarnings
        }
      };
    }
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
        if (candidateNeedsPartRepair(rawOutput)) {
          try {
            const parsed = parseJson(rawOutput);
            const candidateText = (
              Array.isArray(parsed?.candidates)
                ? parsed.candidates
                : parsed?.questions || []
            )
              .map(
                (candidate, index) =>
                  `候选 ${index + 1}：${String(
                    candidate?.text || candidate?.question || ""
                  ).trim()}`
              )
              .join("\n");
            const repaired = await this.llmGateway.chat({
              messages: [
                { role: "system", content: SCAN_PART_REPAIR_PROMPT },
                {
                  role: "user",
                  content:
                    "OCR 字块：\n" +
                    ocrText +
                    "\n候选题干：\n" +
                    candidateText
                }
              ],
              responseFormat: { type: "json_object" }
            });
            const merged = mergePartRepair(
              rawOutput,
              responseContent(repaired.message)
            );
            if (merged) rawOutput = merged;
          } catch {
            // Structural splitting below remains available if repair fails.
          }
        }
        candidates = normalizeLlmCandidates(
          rawOutput,
          withWarnings,
          warningsByBlock,
          Number(this.ocrClient.lowConfidence) || 0.8
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
