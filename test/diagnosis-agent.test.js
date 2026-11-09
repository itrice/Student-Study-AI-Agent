import test from "node:test";
import assert from "node:assert/strict";
import { LearningRepository } from "../src/database.js";
import { createLearningTools } from "../src/tools/index.js";
import { createDiagnosisAgent } from "../src/llm/diagnosis-agent.js";
import { createGatewayFromEnvironment } from "../src/llm/gateway.js";

function validDiagnosis() {
  return {
    knowledgePoint: "百分数",
    errorType: "单位“1”找错",
    errorStep: "第二次降价使用了原价作为单位“1”",
    missingConcept: "连续变化中的单位“1”",
    initialHint: "先分别写出涨价后和降价前的单位“1”。",
    confidence: 0.86,
    evidence: ["题目包含两次百分比变化"],
    knowledgeSources: ["local_rule_profile:百分数"]
  };
}

test("未配置 LLM 时诊断自动使用本地规则降级", async () => {
  const repository = new LearningRepository();
  const tools = createLearningTools(repository);
  const gateway = {
    isConfigured: () => false,
    status: () => ({
      configured: false,
      provider: "openai-compatible",
      model: "",
      timeoutMs: 30_000
    }),
    provider: "openai-compatible",
    model: ""
  };
  const agent = createDiagnosisAgent({ repository, tools, gateway });
  const result = await agent.diagnose({
    question: "一件商品原价 100 元，涨价 20% 后是多少元？",
    correctAnswer: "120元"
  });
  assert.equal(result.source, "rules");
  assert.equal(result.knowledgePoint, "百分数");
  assert.ok(result.hint);
  repository.close();
});

test("诊断 Agent 串行执行知识工具和 LLM 结构化输出", async () => {
  const repository = new LearningRepository();
  const tools = createLearningTools(repository);
  let callCount = 0;
  const gateway = {
    isConfigured: () => true,
    status: () => ({
      configured: true,
      provider: "test-provider",
      model: "test-model",
      timeoutMs: 1000
    }),
    provider: "test-provider",
    model: "test-model",
    async chat({ messages }) {
      callCount += 1;
      if (callCount === 1) {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: {
                  name: "search_knowledge",
                  arguments: JSON.stringify({ query: "百分数", limit: 2 })
                }
              }
            ]
          },
          usage: { inputTokens: 20, outputTokens: 5 },
          latencyMs: 12,
          provider: "test-provider",
          model: "test-model"
        };
      }
      assert.ok(messages.some((message) => message.role === "tool"));
      return {
        message: {
          role: "assistant",
          content: JSON.stringify(validDiagnosis())
        },
        usage: { inputTokens: 30, outputTokens: 40 },
        latencyMs: 20,
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

  assert.equal(result.source, "llm");
  assert.equal(result.knowledgePoint, "百分数");
  assert.equal(result.provider, "test-provider");
  assert.equal(result.model, "test-model");
  assert.equal(callCount, 2);
  assert.equal(
    repository.db
      .prepare(
        "SELECT COUNT(*) AS count FROM llm_calls WHERE status = 'succeeded'"
      )
      .get().count,
    2
  );
  assert.equal(
    repository.db
      .prepare("SELECT status FROM agent_runs WHERE id = ?")
      .get(result.agentRunId).status,
    "completed"
  );
  repository.close();
});

test("含多小问的输入缺少有效分问分析时降级并使用规则", async () => {
  const repository = new LearningRepository();
  const tools = createLearningTools(repository);
  let calls = 0;
  const gateway = {
    isConfigured: () => true,
    status: () => ({ configured: true }),
    provider: "test-provider",
    model: "test-model",
    async chat() {
      calls += 1;
      return {
        message: {
          role: "assistant",
          content: JSON.stringify({
            ...validDiagnosis(),
            partAnalyses: [
              {
                partNo: 1,
                label: "工作效率比",
                errorType: "前后项顺序错误",
                initialHint: "先确认前后项。"
              }
            ]
          })
        },
        usage: { inputTokens: 1, outputTokens: 1 },
        latencyMs: 1,
        provider: "test-provider",
        model: "test-model"
      };
    }
  };
  const agent = createDiagnosisAgent({ repository, tools, gateway });
  const result = await agent.diagnose({
    question: "求工作效率比和时间比",
    parts: [
      {
        partNo: 1,
        label: "工作效率比",
        acceptedAnswers: ["1:6"]
      },
      {
        partNo: 2,
        label: "时间比",
        acceptedAnswers: ["6:1"]
      }
    ]
  });
  assert.equal(result.source, "rules");
  assert.equal(result.fallbackReason, "LLM_INVALID_RESPONSE");
  assert.equal(calls, 2);
  repository.close();
});

test("宽容规范化模型的数组字符串和分问字段变体", async () => {
  const repository = new LearningRepository();
  const tools = createLearningTools(repository);
  const gateway = {
    isConfigured: () => true,
    status: () => ({ configured: true }),
    provider: "test-provider",
    model: "test-model",
    async chat() {
      return {
        message: {
          role: "assistant",
          content: JSON.stringify({
            knowledgePoint: "按比分配（比的应用）",
            errorType: "前后项顺序错误",
            errorStep: "把甲乙顺序写反",
            missingConcept: "比的对应关系",
            initialHint: "先确认每个量对应的份数。",
            confidence: "0.88",
            evidence: "学生答案与正确答案不一致",
            knowledgeSources: "本地比和比例知识片段",
            partAnalyses: [
              {
                partNo: 1,
                label: "效率比",
                hint: "先确认甲、乙的顺序。",
                errorType: "顺序错误",
                confidence: 0.8
              },
              {
                partNo: 2,
                label: "时间比",
                hint: "先算两队时间。",
                errorType: "概念错误",
                confidence: 0.8
              }
            ]
          })
        },
        usage: { inputTokens: 1, outputTokens: 1 },
        latencyMs: 1,
        provider: "test-provider",
        model: "test-model"
      };
    }
  };
  const agent = createDiagnosisAgent({ repository, tools, gateway });
  const result = await agent.diagnose({
    question: "一项工程，求两队工作效率比和时间比。",
    parts: [
      { partNo: 1, label: "效率比", acceptedAnswers: ["2:3"] },
      { partNo: 2, label: "时间比", acceptedAnswers: ["3:2"] }
    ]
  });
  assert.equal(result.source, "llm");
  assert.equal(result.knowledgePoint, "比和比例");
  assert.equal(result.confidence, 0.88);
  assert.deepEqual(result.evidence, ["学生答案与正确答案不一致"]);
  assert.deepEqual(result.knowledgeSources, ["本地比和比例知识片段"]);
  assert.equal(result.partAnalyses.length, 2);
  assert.equal(result.partAnalyses[0].initialHint, "先确认甲、乙的顺序。");
  repository.close();
});

test("用户确认的 LLM 诊断会保存到 diagnoses 审计记录", async () => {
  const repository = new LearningRepository();
  const diagnosis = {
    ...validDiagnosis(),
    source: "llm",
    provider: "test-provider",
    model: "test-model",
    promptVersion: "diagnosis-v1",
    agentRunId: null,
    rawOutput: validDiagnosis()
  };
  const mistake = repository.createMistake({
    question: "一件商品原价 100 元，涨价 20% 后是多少元？",
    studentAnswer: "100元",
    correctAnswer: "120元",
    knowledgePoint: "百分数",
    confirmedDiagnosis: diagnosis
  });
  const stored = repository.db
    .prepare("SELECT * FROM diagnoses WHERE mistake_id = ?")
    .get(mistake.id);
  assert.equal(stored.accepted_by_user, 1);
  assert.equal(stored.provider, "test-provider");
  assert.equal(stored.model, "test-model");
  assert.equal(stored.prompt_version, "diagnosis-v1");
  assert.ok(stored.accepted_at);
  repository.close();
});

test("LLM 连接测试在未配置时返回明确状态", async () => {
  const repository = new LearningRepository();
  const tools = createLearningTools(repository);
  const agent = createDiagnosisAgent({
    repository,
    tools,
    gateway: {
      isConfigured: () => false,
      status: () => ({ configured: false }),
      provider: "openai-compatible",
      model: ""
    }
  });
  const result = await agent.testConnection();
  assert.equal(result.ok, false);
  assert.equal(result.error, "LLM_NOT_CONFIGURED");
  repository.close();
});

test("LLM 配置非法时诊断安全降级而不是抛出空错误", async () => {
  const repository = new LearningRepository();
  const tools = createLearningTools(repository);
  const gateway = createGatewayFromEnvironment({
    LLM_BASE_URL: "https://example.test/v1",
    LLM_API_KEY: "secret",
    LLM_MODEL: "test-model",
    LLM_MAX_RETRIES: "-1"
  });
  const agent = createDiagnosisAgent({ repository, tools, gateway });
  const result = await agent.diagnose({
    question: "一件商品原价100元，涨价20%后是多少元？",
    correctAnswer: "120元"
  });
  assert.equal(result.source, "rules");
  assert.equal(result.fallbackReason, "LLM_NOT_CONFIGURED");
  assert.equal(gateway.status().configurationErrors.length, 1);
  repository.close();
});
