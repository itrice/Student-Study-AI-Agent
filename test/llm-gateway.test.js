import test from "node:test";
import assert from "node:assert/strict";
import {
  LlmGatewayError,
  OpenAICompatibleGateway,
  createGatewayFromEnvironment
} from "../src/llm/gateway.js";

test("OpenAI-compatible 网关发送结构化请求并解析消息", async () => {
  let request = null;
  const gateway = new OpenAICompatibleGateway({
    baseUrl: "https://example.test/v1/",
    apiKey: "secret-key",
    model: "test-model",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: '{"ok":true}' } }],
          usage: { prompt_tokens: 12, completion_tokens: 7 }
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
  });

  const result = await gateway.chat({
    messages: [{ role: "user", content: "诊断这道题" }],
    tools: [
      {
        type: "function",
        function: {
          name: "search_knowledge",
          description: "检索知识",
          parameters: { type: "object", properties: {} }
        }
      }
    ]
  });
  assert.equal(request.url, "https://example.test/v1/chat/completions");
  assert.equal(request.options.headers.Authorization, "Bearer secret-key");
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, "test-model");
  assert.equal(body.max_tokens, 1200);
  assert.equal(body.stream, false);
  assert.equal(body.response_format.type, "json_object");
  assert.equal(body.tool_choice, "auto");
  assert.equal(result.message.content, '{"ok":true}');
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 7 });
});

test("网关对可重试错误进行有限重试", async () => {
  let attempts = 0;
  const gateway = new OpenAICompatibleGateway({
    baseUrl: "https://example.test/v1",
    apiKey: "secret-key",
    model: "test-model",
    maxRetries: 1,
    retryDelayMs: 0,
    sleepImpl: async () => {},
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response("busy", { status: 500 });
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"ok":true}' } }],
          usage: {}
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
  });

  const result = await gateway.chat({
    messages: [{ role: "user", content: "test" }]
  });
  assert.equal(attempts, 2);
  assert.equal(result.message.content, '{"ok":true}');
});

test("网关把请求超时转换成可识别错误", async () => {
  const gateway = new OpenAICompatibleGateway({
    baseUrl: "https://example.test/v1",
    apiKey: "secret-key",
    model: "test-model",
    timeoutMs: 5,
    maxRetries: 0,
    fetchImpl: async (_url, { signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      })
  });

  await assert.rejects(
    gateway.chat({ messages: [{ role: "user", content: "test" }] }),
    (error) =>
      error instanceof LlmGatewayError && error.code === "LLM_TIMEOUT"
  );
});

test("网关校验超时、重试、输出长度、温度和流式配置", () => {
  const gateway = createGatewayFromEnvironment({
    LLM_BASE_URL: "https://example.test/v1",
    LLM_API_KEY: "secret",
    LLM_MODEL: "test-model",
    LLM_TIMEOUT_MS: "-1",
    LLM_MAX_RETRIES: "-1",
    LLM_MAX_OUTPUT_TOKENS: "0",
    LLM_TEMPERATURE: "3",
    LLM_STREAM: "maybe"
  });
  assert.equal(gateway.isConfigured(), false);
  assert.equal(gateway.status().configurationErrors.length, 5);
  assert.equal(gateway.timeoutMs, 30_000);
  assert.equal(gateway.maxRetries, 2);
});

test("网关可以解析 OpenAI-compatible SSE 流", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          'data: {"choices":[{"delta":{"content":"{\\"ok\\":"}}]}\n\n' +
            'data: {"choices":[{"delta":{"content":"true}"}}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n' +
            "data: [DONE]\n\n"
        )
      );
      controller.close();
    }
  });
  const gateway = new OpenAICompatibleGateway({
    baseUrl: "https://example.test/v1",
    apiKey: "secret",
    model: "test-model",
    stream: true,
    fetchImpl: async () =>
      new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      })
  });
  const result = await gateway.chat({
    messages: [{ role: "user", content: "test" }]
  });
  assert.equal(result.message.content, '{"ok":true}');
  assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 2 });
});
