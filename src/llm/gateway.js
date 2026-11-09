export class LlmGatewayError extends Error {
  constructor(code, message, { status = 500, retryable = false, cause = null } = {}) {
    super(message, { cause });
    this.name = "LlmGatewayError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeNumber(
  value,
  { name, fallback, min, max, integer = false, errors }
) {
  const number = Number(value);
  const valid =
    Number.isFinite(number) &&
    number >= min &&
    number <= max &&
    (!integer || Number.isInteger(number));
  if (!valid) {
    errors.push(
      `${name} 必须是 ${min}～${max} 之间的${integer ? "整数" : "数值"}`
    );
    return fallback;
  }
  return number;
}

function normalizeBoolean(value, fallback) {
  if (typeof value === "boolean") return { value, valid: true };
  if (value === "true" || value === "1") return { value: true, valid: true };
  if (value === "false" || value === "0" || value === "") {
    return { value: false, valid: true };
  }
  return { value: fallback, valid: false };
}

async function parseStreamingResponse(response) {
  if (!response.body) {
    throw new LlmGatewayError(
      "LLM_INVALID_RESPONSE",
      "LLM 流式响应缺少内容"
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let usage = { prompt_tokens: 0, completion_tokens: 0 };
  const toolCalls = [];

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      const chunk = parseJson(data);
      if (!chunk) continue;
      if (chunk.usage) usage = chunk.usage;
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) content += delta.content;
      for (const callDelta of delta.tool_calls || []) {
        const index = Number(callDelta.index || 0);
        const current = toolCalls[index] || {
          id: "",
          type: "function",
          function: { name: "", arguments: "" }
        };
        if (callDelta.id) current.id = callDelta.id;
        if (callDelta.function?.name) {
          current.function.name += callDelta.function.name;
        }
        if (callDelta.function?.arguments) {
          current.function.arguments += callDelta.function.arguments;
        }
        toolCalls[index] = current;
      }
    }
    if (done) break;
  }

  return {
    message: {
      role: "assistant",
      content: content || null,
      ...(toolCalls.length
        ? { tool_calls: toolCalls.filter(Boolean) }
        : {})
    },
    usage
  };
}

export class OpenAICompatibleGateway {
  constructor({
    baseUrl = "",
    apiKey = "",
    model = "",
    provider = "openai-compatible",
    timeoutMs = 30_000,
    maxRetries = 2,
    retryDelayMs = 300,
    maxOutputTokens = 1200,
    temperature = 0.2,
    stream = false,
    fetchImpl = globalThis.fetch,
    sleepImpl = sleep
  } = {}) {
    const errors = [];
    this.baseUrl = String(baseUrl || "").replace(/\/+$/, "");
    this.apiKey = String(apiKey || "");
    this.model = String(model || "");
    this.provider = provider;
    this.timeoutMs = normalizeNumber(timeoutMs, {
      name: "timeoutMs",
      fallback: 30_000,
      min: 1,
      max: 300_000,
      errors
    });
    this.maxRetries = normalizeNumber(maxRetries, {
      name: "maxRetries",
      fallback: 2,
      min: 0,
      max: 5,
      integer: true,
      errors
    });
    this.retryDelayMs = normalizeNumber(retryDelayMs, {
      name: "retryDelayMs",
      fallback: 300,
      min: 0,
      max: 30_000,
      errors
    });
    this.maxOutputTokens = normalizeNumber(maxOutputTokens, {
      name: "maxOutputTokens",
      fallback: 1200,
      min: 1,
      max: 8192,
      integer: true,
      errors
    });
    this.temperature = normalizeNumber(temperature, {
      name: "temperature",
      fallback: 0.2,
      min: 0,
      max: 2,
      errors
    });
    const normalizedStream = normalizeBoolean(stream, false);
    this.stream = normalizedStream.value;
    if (!normalizedStream.valid) {
      errors.push("stream 必须是 true/false 或 1/0");
    }
    this.configurationErrors = errors;
    this.fetchImpl = fetchImpl;
    this.sleepImpl = sleepImpl;
  }

  isConfigured() {
    return Boolean(
      this.baseUrl &&
        this.apiKey &&
        this.model &&
        !this.configurationErrors.length
    );
  }

  status() {
    return {
      configured: this.isConfigured(),
      provider: this.provider,
      model: this.model,
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries,
      maxOutputTokens: this.maxOutputTokens,
      temperature: this.temperature,
      stream: this.stream,
      configurationErrors: [...this.configurationErrors]
    };
  }

  async chat({
    messages,
    tools = [],
    temperature = this.temperature,
    responseFormat = { type: "json_object" }
  }) {
    if (!this.isConfigured()) {
      throw new LlmGatewayError(
        "LLM_NOT_CONFIGURED",
        "LLM 尚未配置 API Key、模型或 Base URL",
        { status: 503, retryable: false }
      );
    }

    const body = {
      model: this.model,
      messages,
      temperature,
      max_tokens: this.maxOutputTokens,
      stream: this.stream
    };
    if (this.stream) {
      body.stream_options = { include_usage: true };
    }
    if (responseFormat) body.response_format = responseFormat;
    if (tools.length) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    let lastError = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      const startedAt = performance.now();
      try {
        const response = await this.fetchImpl(
          `${this.baseUrl}/chat/completions`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${this.apiKey}`
            },
            body: JSON.stringify(body),
            signal: controller.signal
          }
        );
        if (!response.ok) {
          const retryable = response.status === 429 || response.status >= 500;
          throw new LlmGatewayError(
            retryable ? "LLM_RATE_LIMITED" : "LLM_REQUEST_FAILED",
            `LLM 请求失败（HTTP ${response.status}）`,
            { status: response.status, retryable }
          );
        }
        const isStreaming = response.headers
          .get("content-type")
          ?.includes("text/event-stream");
        const parsed = isStreaming
          ? await parseStreamingResponse(response)
          : (() => {
              return response
                .text()
                .then((responseText) => {
                  const payload = parseJson(responseText);
                  return {
                    message: payload?.choices?.[0]?.message,
                    usage: {
                      inputTokens: Number(
                        payload?.usage?.prompt_tokens || 0
                      ),
                      outputTokens: Number(
                        payload?.usage?.completion_tokens || 0
                      )
                    },
                    raw: payload
                  };
                });
            })();
        const resolved = await parsed;
        const message = resolved.message;
        if (!message) {
          throw new LlmGatewayError(
            "LLM_INVALID_RESPONSE",
            "LLM 未返回有效消息"
          );
        }
        return {
          message,
          usage: {
            inputTokens: Number(
              resolved.usage?.prompt_tokens ||
                resolved.usage?.inputTokens ||
                0
            ),
            outputTokens: Number(
              resolved.usage?.completion_tokens ||
                resolved.usage?.outputTokens ||
                0
            )
          },
          latencyMs: Math.round(performance.now() - startedAt),
          provider: this.provider,
          model: this.model,
          raw: resolved.raw || resolved
        };
      } catch (error) {
        const normalized =
          error?.name === "AbortError"
            ? new LlmGatewayError(
                "LLM_TIMEOUT",
                `LLM 请求超过 ${this.timeoutMs}ms`,
                { status: 504, retryable: true, cause: error }
              )
            : error instanceof LlmGatewayError
              ? error
              : new LlmGatewayError(
                  "LLM_NETWORK_ERROR",
                  "LLM 网络请求失败",
                  { status: 502, retryable: true, cause: error }
                );
        lastError = normalized;
        if (!normalized.retryable || attempt === this.maxRetries) {
          throw normalized;
        }
        await this.sleepImpl(this.retryDelayMs * 2 ** attempt);
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError;
  }
}

export function createGatewayFromEnvironment(environment = process.env) {
  return new OpenAICompatibleGateway({
    baseUrl: environment.LLM_BASE_URL || "",
    apiKey: environment.LLM_API_KEY || "",
    model: environment.LLM_MODEL || "",
    provider: environment.LLM_PROVIDER || "openai-compatible",
    timeoutMs: Number(environment.LLM_TIMEOUT_MS || 30_000),
    maxRetries: Number(environment.LLM_MAX_RETRIES || 2),
    maxOutputTokens: Number(environment.LLM_MAX_OUTPUT_TOKENS || 1200),
    temperature: Number(environment.LLM_TEMPERATURE ?? 0.2),
    stream: environment.LLM_STREAM ?? false
  });
}
