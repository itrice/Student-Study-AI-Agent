export const VISION_PROMPT_VERSION = "m9-vision-1";

const VISION_SYSTEM_PROMPT =
  "你是题目文字转录助手。只转录图片中可见的题目文字和必要的图形标注，" +
  "不要解题、不要补写图片中没有的内容。只返回 JSON：{\"text\":\"转录文字\"}。";

function normalizeOutputText(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.text === "string") {
      return parsed.text.trim();
    }
  } catch {
    // Some compatible providers return plain text instead of JSON.
  }
  return text;
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

export class OpenAICompatibleVisionExtractor {
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
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  isConfigured() {
    return Boolean(this.baseUrl && this.apiKey && this.model && this.fetchImpl);
  }

  async extract({ buffer, mimeType }) {
    if (!this.isConfigured()) {
      throw new Error("视觉识别未配置");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          messages: [
            { role: "system", content: VISION_SYSTEM_PROMPT },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "请转录这张图片中的题目文字，保留数字、单位和必要的图形标注。"
                },
                {
                  type: "image_url",
                  image_url: {
                    url: `data:${mimeType};base64,${buffer.toString("base64")}`
                  }
                }
              ]
            }
          ]
        }),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error("视觉模型请求失败");
      }
      const data = await response.json();
      const rawOutput = responseContent(data.choices?.[0]?.message);
      return {
        rawOutput,
        normalizedText: normalizeOutputText(rawOutput),
        confidence: null,
        provider: this.provider,
        model: this.model,
        promptVersion: VISION_PROMPT_VERSION
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createVisionExtractorFromEnvironment(environment = process.env) {
  return new OpenAICompatibleVisionExtractor({
    baseUrl: environment.VISION_BASE_URL || environment.LLM_BASE_URL || "",
    apiKey: environment.VISION_API_KEY || environment.LLM_API_KEY || "",
    model: environment.VISION_MODEL || "",
    provider:
      environment.VISION_PROVIDER ||
      environment.LLM_PROVIDER ||
      "openai-compatible",
    timeoutMs: Number(environment.VISION_TIMEOUT_MS || 30_000)
  });
}
