export const QUESTION_SCAN_PROMPT_VERSION = "m2-scan-1";
export const MAX_SCAN_CANDIDATES = 20;

const SCAN_SYSTEM_PROMPT = [
  "你是六年级数学作业页的候选题目识别器。",
  "只识别印刷体、单栏、单页中的题目边界，不解题、不补写。",
  "返回严格 JSON：{\"candidates\":[{\"text\":\"题干\",\"completeness\":\"complete|incomplete|unknown\",\"suspectedWrong\":true,\"answerPending\":false,\"confidence\":0.8,\"region\":{\"x\":0,\"y\":0,\"width\":1,\"height\":0.2}}]}。",
  "候选按阅读顺序编号，单次最多 20 道；区域使用 0～1 相对坐标。",
  "题干或关键图形无法确认时 completeness 填 incomplete；只有答案无法判断时填 answerPending。"
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

function responseContent(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => (typeof item === "string" ? item : item?.text || ""))
      .join("");
  }
  return "";
}

function parseJson(value) {
  const text = String(value || "").trim();
  const unfenced = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(unfenced);
  } catch {
    return null;
  }
}

function normalizeRegion(value, index, total) {
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

function normalizeCandidate(candidate, index, total) {
  const text = String(candidate?.text || "").trim();
  if (!text) return null;
  const completeness = ["complete", "incomplete", "unknown"].includes(
    candidate.completeness
  )
    ? candidate.completeness
    : "unknown";
  return {
    text,
    completenessStatus: completeness,
    suspectedWrong: candidate.suspectedWrong === true,
    answerPending: candidate.answerPending === true,
    confidence: Number.isFinite(Number(candidate.confidence))
      ? Number(candidate.confidence)
      : null,
    region: normalizeRegion(candidate.region, index, total)
  };
}

function parseNumberedText(text) {
  const lines = String(text || "").split(/\r?\n/);
  const blocks = [];
  let current = null;
  for (const line of lines) {
    const match = line.match(/^\s*(\d{1,2})\s*[.、．)）]\s*(.*)$/);
    if (match) {
      if (current) blocks.push(current);
      current = { text: match[2].trim() };
    } else if (current && line.trim()) {
      current.text += `\n${line.trim()}`;
    }
  }
  if (current) blocks.push(current);
  if (!blocks.length) {
    throw new QuestionScanError(
      "SCAN_EMPTY_RESULT",
      "没有识别到带题号的候选题，请重拍或改用手动录入"
    );
  }
  if (blocks.length > MAX_SCAN_CANDIDATES) {
    throw new QuestionScanError(
      "SCAN_TOO_MANY_CANDIDATES",
      `识别到 ${blocks.length} 道候选，超过单次 ${MAX_SCAN_CANDIDATES} 道，请分批扫描`
    );
  }
  return blocks.map((block, index) => ({
    text: block.text,
    completenessStatus:
      /【残缺】|\[残缺\]|无法完整|关键条件缺失/u.test(block.text)
        ? "incomplete"
        : "complete",
    suspectedWrong: /×|（错）|\(错\)|疑似错误/u.test(block.text),
    answerPending: /答案待确认/u.test(block.text),
    confidence: null,
    region: normalizeRegion(null, index, blocks.length)
  }));
}

function normalizeCandidates(rawOutput) {
  const parsed = parseJson(rawOutput);
  const rawCandidates = Array.isArray(parsed?.candidates)
    ? parsed.candidates
    : Array.isArray(parsed?.questions)
      ? parsed.questions
      : null;
  if (rawCandidates) {
    if (rawCandidates.length > MAX_SCAN_CANDIDATES) {
      throw new QuestionScanError(
        "SCAN_TOO_MANY_CANDIDATES",
        `识别到 ${rawCandidates.length} 道候选，超过单次 ${MAX_SCAN_CANDIDATES} 道，请分批扫描`
      );
    }
    const candidates = rawCandidates
      .map((candidate, index) =>
        normalizeCandidate(candidate, index, rawCandidates.length)
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
  return parseNumberedText(rawOutput);
}

export class OpenAICompatibleQuestionScanner {
  constructor({
    baseUrl = "",
    apiKey = "",
    model = "",
    provider = "openai-compatible",
    timeoutMs = 30_000,
    fetchImpl = globalThis.fetch
  } = {}) {
    this.baseUrl = String(baseUrl || "").replace(/\/+$/, "");
    this.apiKey = String(apiKey || "");
    this.model = String(model || "");
    this.provider = provider;
    this.timeoutMs = Number(timeoutMs) || 30_000;
    this.fetchImpl = fetchImpl;
  }

  isConfigured() {
    return Boolean(this.baseUrl && this.apiKey && this.model && this.fetchImpl);
  }

  async scan({ images }) {
    if (!this.isConfigured()) {
      throw new QuestionScanError("SCAN_NOT_CONFIGURED", "视觉识别未配置");
    }
    if (!Array.isArray(images) || !images.length) {
      throw new QuestionScanError("SCAN_IMAGE_REQUIRED", "请先选择扫描图片", {
        status: 400
      });
    }
    console.log(
      `[question-scan] 请求视觉模型 model=${this.model} images=${images.length} base=${this.baseUrl}`
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(
        `${this.baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`
          },
          body: JSON.stringify({
            model: this.model,
            temperature: 0,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: SCAN_SYSTEM_PROMPT },
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: "识别这页作业中的全部候选题，按题号顺序返回 JSON。"
                  },
                  ...images.map((image) => ({
                    type: "image_url",
                    image_url: {
                      url: `data:${image.mimeType};base64,${image.buffer.toString("base64")}`
                    }
                  }))
                ]
              }
            ]
          }),
          signal: controller.signal
        }
      );
      if (!response.ok) {
        let upstreamBody = "";
        try {
          upstreamBody = (await response.text())
            .replace(/\s+/g, " ")
            .slice(0, 400);
        } catch {
          upstreamBody = "";
        }
        throw new QuestionScanError(
          "SCAN_MODEL_FAILED",
          "视觉模型请求失败，可重拍或改用手动录入",
          {
            status: 502,
            details: { upstreamStatus: response.status, upstreamBody }
          }
        );
      }
      const data = await response.json();
      const rawOutput = responseContent(data.choices?.[0]?.message);
      return {
        candidates: normalizeCandidates(rawOutput),
        rawOutput,
        provider: this.provider,
        model: this.model,
        promptVersion: QUESTION_SCAN_PROMPT_VERSION
      };
    } catch (error) {
      if (error instanceof QuestionScanError) throw error;
      throw new QuestionScanError(
        error.name === "AbortError" ? "SCAN_MODEL_TIMEOUT" : "SCAN_MODEL_FAILED",
        error.name === "AbortError"
          ? "视觉识别超时，可重拍或改用手动录入"
          : "视觉识别失败，可重拍或改用手动录入",
        { status: 502, details: { cause: error.name || "Error" } }
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createQuestionScannerFromEnvironment(
  environment = process.env
) {
  return new OpenAICompatibleQuestionScanner({
    baseUrl:
      environment.SCAN_BASE_URL ||
      environment.VISION_BASE_URL ||
      environment.LLM_BASE_URL ||
      "",
    apiKey:
      environment.SCAN_API_KEY ||
      environment.VISION_API_KEY ||
      environment.LLM_API_KEY ||
      "",
    model:
      environment.SCAN_MODEL || environment.VISION_MODEL || "",
    provider:
      environment.SCAN_PROVIDER ||
      environment.VISION_PROVIDER ||
      environment.LLM_PROVIDER ||
      "openai-compatible",
    timeoutMs: Number(
      environment.SCAN_TIMEOUT_MS ||
        environment.VISION_TIMEOUT_MS ||
        30_000
    )
  });
}
