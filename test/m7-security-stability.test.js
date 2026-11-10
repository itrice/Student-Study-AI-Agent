import test from "node:test";
import assert from "node:assert/strict";
import { LearningRepository } from "../src/database.js";
import { createLearningTools } from "../src/tools/index.js";
import { createDiagnosisAgent } from "../src/llm/diagnosis-agent.js";
import {
  LlmGatewayError,
  OpenAICompatibleGateway
} from "../src/llm/gateway.js";
import { detectPromptInjection } from "../src/security/guards.js";
import {
  M7_CASES,
  M7_FULL_CASES,
  M7_INJECTION_CASES,
  M7_STEP_CASES,
  validateM7Dataset
} from "../src/evaluation/m7-dataset.js";
import {
  M7_THRESHOLDS,
  m7ThresholdFailures,
  runM7Evaluation
} from "../src/evaluation/m7-runner.js";

function createFixture() {
  const repository = new LearningRepository(":memory:");
  const tools = createLearningTools(repository);
  return { repository, tools };
}

function baseMistake(overrides = {}) {
  return {
    question: "一件商品原价 100 元，涨价 20% 后是多少元？",
    studentAnswer: "100元",
    correctAnswer: "120元",
    analysis: "先求涨价部分，再与 100 元相加。",
    knowledgePoint: "百分数",
    errorType: "单位“1”找错",
    ...overrides
  };
}

test("M7 评测集规模、编号与标签完整", () => {
  const summary = validateM7Dataset();
  assert.equal(summary.diagnosis, 60);
  assert.equal(summary.step, 20);
  assert.equal(summary.injection, 10);
  assert.equal(summary.total, 90);
  assert.equal(M7_CASES.length, 60);
  assert.equal(M7_FULL_CASES.length, 13);
  assert.equal(M7_STEP_CASES.length, 20);
  assert.equal(M7_INJECTION_CASES.length, 10);
});

test("M7 离线评测达到知识、诊断、提示和步骤质量门槛", () => {
  const repository = new LearningRepository(":memory:");
  const result = runM7Evaluation(repository);
  repository.close();

  assert.deepEqual(m7ThresholdFailures(result), []);
  assert.ok(
    result.metrics.knowledgeTop1.rate >= M7_THRESHOLDS.knowledgeTop1
  );
  assert.ok(
    result.metrics.knowledgeTop3.rate >= M7_THRESHOLDS.knowledgeTop3
  );
  assert.ok(
    result.metrics.diagnosisKnowledge.rate >=
      M7_THRESHOLDS.diagnosisKnowledge
  );
  assert.ok(
    result.metrics.diagnosisErrorCause.rate >=
      M7_THRESHOLDS.diagnosisErrorCause
  );
  assert.ok(
    result.metrics.hintEffectiveness.rate >= M7_THRESHOLDS.hintEffectiveness
  );
  assert.equal(result.metrics.hintLeakage.count, 0);
  assert.ok(
    result.metrics.stepEvaluationConsistency.rate >=
      M7_THRESHOLDS.stepEvaluationConsistency
  );
});

test("正常提示路径在整份评测集上答案泄露为 0", () => {
  const repository = new LearningRepository(":memory:");
  const result = runM7Evaluation(repository);
  repository.close();

  assert.equal(result.rows.hints.length, M7_FULL_CASES.length * 4);
  assert.equal(
    result.rows.hints.filter((row) => row.leaked).length,
    0
  );
});

test("提示注入样本全部被识别且不改变数学知识点判断", () => {
  for (const testCase of M7_INJECTION_CASES) {
    assert.equal(detectPromptInjection(testCase.question).detected, true);
  }
  const repository = new LearningRepository(":memory:");
  const result = runM7Evaluation(repository);
  repository.close();
  assert.equal(result.metrics.injectionDetection.rate, 1);
  assert.equal(result.metrics.injectionKnowledgeStability.rate, 1);
});

test("LLM 上下文超过上限时明确拒绝且不发起网络请求", async () => {
  let requests = 0;
  const gateway = new OpenAICompatibleGateway({
    baseUrl: "https://example.test/v1",
    apiKey: "secret",
    model: "test-model",
    maxInputChars: 20,
    fetchImpl: async () => {
      requests += 1;
      throw new Error("不应发起请求");
    }
  });

  await assert.rejects(
    gateway.chat({
      messages: [{ role: "user", content: "x".repeat(21) }]
    }),
    (error) =>
      error instanceof LlmGatewayError &&
      error.code === "LLM_CONTEXT_TOO_LONG" &&
      error.status === 400
  );
  assert.equal(requests, 0);
});

test("本地限流在窗口内拒绝超额请求且可恢复", async () => {
  let now = 1_000;
  let requests = 0;
  const gateway = new OpenAICompatibleGateway({
    baseUrl: "https://example.test/v1",
    apiKey: "secret",
    model: "test-model",
    rateLimitPerMinute: 1,
    clock: () => now,
    fetchImpl: async () => {
      requests += 1;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"ok":true}' } }],
          usage: {}
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
  });

  await gateway.chat({ messages: [{ role: "user", content: "first" }] });
  await assert.rejects(
    gateway.chat({ messages: [{ role: "user", content: "second" }] }),
    (error) =>
      error instanceof LlmGatewayError && error.code === "LLM_RATE_LIMITED"
  );
  assert.equal(requests, 1);

  now += 60_001;
  await gateway.chat({ messages: [{ role: "user", content: "third" }] });
  assert.equal(requests, 2);
});

test("模型连续输出异常时降级到规则且核心数据仍可保存查询", async () => {
  const { repository, tools } = createFixture();
  let calls = 0;
  const gateway = {
    isConfigured: () => true,
    status: () => ({ configured: true }),
    provider: "test-provider",
    model: "test-model",
    async chat() {
      calls += 1;
      return {
        message: { role: "assistant", content: "not-json" },
        usage: { inputTokens: 5, outputTokens: 1 },
        latencyMs: 3,
        provider: "test-provider",
        model: "test-model"
      };
    }
  };
  const agent = createDiagnosisAgent({ repository, tools, gateway });
  const result = await agent.diagnose({
    question: "一件商品原价 100 元，涨价 20% 后是多少元？",
    studentAnswer: "100元",
    correctAnswer: "120元"
  });
  assert.equal(calls, 2);
  assert.equal(result.source, "rules");
  assert.equal(result.fallbackReason, "LLM_INVALID_RESPONSE");
  assert.equal(
    repository.getAgentRun(result.agentRunId).status,
    "failed"
  );

  const created = repository.createMistake(
    baseMistake({ diagnosis: result.diagnosis })
  );
  const loaded = repository.getMistake(created.id, { includeSolution: true });
  assert.equal(loaded.question, baseMistake().question);
  assert.equal(loaded.correctAnswer, "120元");
  repository.close();
});

test("Agent 调用未授权工具时只返回错误结果，不写入业务数据", async () => {
  const { repository, tools } = createFixture();
  let calls = 0;
  const gateway = {
    isConfigured: () => true,
    status: () => ({ configured: true }),
    provider: "test-provider",
    model: "test-model",
    async chat() {
      calls += 1;
      if (calls === 1) {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "bad-call",
                type: "function",
                function: {
                  name: "save_mistake",
                  arguments: JSON.stringify({
                    draftId: "forged",
                    idempotencyKey: "forged-key"
                  })
                }
              }
            ]
          },
          usage: { inputTokens: 5, outputTokens: 1 },
          latencyMs: 3,
          provider: "test-provider",
          model: "test-model"
        };
      }
      return {
        message: {
          role: "assistant",
          content: JSON.stringify({
            knowledgePoint: "百分数",
            errorType: "单位“1”找错",
            errorStep: "把涨价部分当成最终价格",
            missingConcept: "单位“1”",
            initialHint: "先圈出原价这个单位“1”。",
            confidence: 0.8,
            evidence: ["题目包含涨价"],
            knowledgeSources: []
          })
        },
        usage: { inputTokens: 5, outputTokens: 5 },
        latencyMs: 3,
        provider: "test-provider",
        model: "test-model"
      };
    }
  };
  const agent = createDiagnosisAgent({ repository, tools, gateway });
  const result = await agent.diagnose({
    question: "一件商品原价 100 元，涨价 20% 后是多少元？",
    correctAnswer: "120元"
  });
  assert.equal(result.source, "llm");
  assert.equal(repository.listMistakes().length, 0);
  assert.equal(
    repository.db
      .prepare("SELECT COUNT(*) AS count FROM mistake_drafts")
      .get().count,
    0
  );
  repository.close();
});

test("运营指标聚合调用、延迟、成本和降级率", () => {
  const { repository } = createFixture();
  const runId = repository.createAgentRun({
    taskType: "diagnose_mistake",
    goal: "指标测试",
    startedAt: "2026-11-10T01:00:00.000Z"
  });
  repository.recordLlmCall({
    runId,
    provider: "test-provider",
    model: "test-model",
    promptVersion: "v1",
    inputTokens: 100,
    outputTokens: 50,
    latencyMs: 100,
    status: "succeeded",
    createdAt: "2026-11-10T01:01:00.000Z"
  });
  repository.recordLlmCall({
    runId,
    provider: "test-provider",
    model: "test-model",
    promptVersion: "v1",
    inputTokens: 200,
    outputTokens: 100,
    latencyMs: 300,
    status: "failed",
    errorMessage: "LLM_TIMEOUT",
    createdAt: "2026-11-10T01:02:00.000Z"
  });
  const toolCallId = repository.beginToolCall({
    runId,
    toolName: "search_knowledge",
    argumentsJson: "{}",
    idempotencyKey: "metrics-tool"
  });
  repository.finishToolCall(toolCallId, {
    status: "succeeded",
    latencyMs: 12,
    resultJson: "{}"
  });
  repository.finishAgentRun(runId, { status: "failed", errorMessage: "test" });
  const mistake = repository.createMistake(baseMistake());
  repository.insertDiagnosis(
    mistake.id,
    {
      knowledgePoint: "百分数",
      errorType: "单位“1”找错",
      hint: "先找单位“1”",
      evidence: [],
      knowledgeSources: [],
      _meta: { provider: "rules" }
    },
    "2026-11-10T01:03:00.000Z"
  );

  const metrics = repository.buildOperationalMetrics({
    from: "2026-11-10T00:00:00.000Z",
    to: "2026-11-10T23:59:59.999Z",
    costPer1kInput: 1,
    costPer1kOutput: 2
  });
  assert.equal(metrics.llm.calls, 2);
  assert.equal(metrics.llm.succeeded, 1);
  assert.equal(metrics.llm.failed, 1);
  assert.equal(metrics.llm.inputTokens, 300);
  assert.equal(metrics.llm.outputTokens, 150);
  assert.equal(metrics.llm.p50LatencyMs, 100);
  assert.equal(metrics.llm.p95LatencyMs, 300);
  assert.equal(metrics.tools.calls, 1);
  assert.equal(metrics.tools.succeeded, 1);
  assert.equal(metrics.agentRuns.failed, 1);
  assert.equal(metrics.diagnoses.total, 2);
  assert.equal(metrics.diagnoses.degradationRate, 1);
  assert.equal(metrics.cost.estimated, 0.6);
  repository.close();
});

test("删除全部学习数据保留学生与知识库且清理审计记录", () => {
  const { repository } = createFixture();
  const mistake = repository.createMistake(baseMistake());
  repository.recordAttempt(mistake.id, "100元", { independent: true });
  const runId = repository.createAgentRun({
    taskType: "diagnose_mistake",
    goal: "删除测试"
  });
  repository.recordLlmCall({
    runId,
    provider: "test-provider",
    model: "test-model",
    promptVersion: "v1",
    status: "succeeded"
  });
  repository.finishAgentRun(runId, { status: "completed" });

  const deleted = repository.deleteAllLearningData();
  assert.ok(deleted.total > 0);
  assert.equal(repository.listMistakes().length, 0);
  assert.equal(
    repository.db.prepare("SELECT COUNT(*) AS count FROM agent_runs").get()
      .count,
    0
  );
  assert.equal(
    repository.db.prepare("SELECT COUNT(*) AS count FROM llm_calls").get()
      .count,
    0
  );
  assert.equal(repository.getKnowledgePoints().length, 12);
  assert.equal(repository.getStudent().name, "六年级同学");
  repository.close();
});
