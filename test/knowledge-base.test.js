import test from "node:test";
import assert from "node:assert/strict";
import { LearningRepository } from "../src/database.js";
import { createLearningTools } from "../src/tools/index.js";
import { createDiagnosisAgent } from "../src/llm/diagnosis-agent.js";
import { evaluateKnowledgeRetrieval } from "../src/knowledge/search.js";

function createFixture() {
  const repository = new LearningRepository();
  return { repository, tools: createLearningTools(repository) };
}

function diagnosisGateway(payload) {
  return {
    isConfigured: () => true,
    status: () => ({ configured: true }),
    provider: "test-provider",
    model: "test-model",
    async chat() {
      return {
        message: {
          role: "assistant",
          content: JSON.stringify(payload)
        },
        usage: { inputTokens: 1, outputTokens: 1 },
        latencyMs: 1,
        provider: "test-provider",
        model: "test-model"
      };
    }
  };
}

function validDiagnosis(overrides = {}) {
  return {
    knowledgePoint: "圆",
    errorType: "混淆周长与面积公式",
    errorStep: "把面积公式写成了周长公式",
    missingConcept: "圆面积公式",
    initialHint: "先确认题目求的是周长还是面积。",
    confidence: 0.8,
    evidence: ["题目要求面积", "学生使用了周长公式"],
    knowledgeSources: ["项目自编六年级数学知识摘要 · 圆 / 核心概念"],
    ...overrides
  };
}

test("v7 知识库包含 12 张完整卡片和可追溯来源", () => {
  const { repository } = createFixture();
  assert.equal(repository.getSchemaVersion(), 7);

  const cards = repository.getKnowledgeCards();
  assert.equal(cards.length, 12);
  for (const card of cards) {
    assert.ok(card.name);
    assert.ok(card.slug);
    assert.ok(card.unit.includes("年级"));
    assert.ok(card.aliases.length >= 3, `${card.name} 缺少别名`);
    assert.ok(card.prerequisites.length >= 1, `${card.name} 缺少前置知识`);
    assert.ok(card.summary.length >= 20);
    assert.ok(card.hint.length >= 10);
    assert.ok(card.steps.length >= 3);
    assert.ok(card.commonErrors.length >= 3);
    assert.equal(card.reviewStatus, "self_reviewed");

    const kinds = new Set(card.chunks.map((chunk) => chunk.kind));
    for (const kind of [
      "concept",
      "method",
      "condition",
      "common_error",
      "example"
    ]) {
      assert.ok(kinds.has(kind), `${card.name} 缺少 ${kind} 片段`);
    }
    assert.ok(
      card.chunks.filter((chunk) => chunk.kind === "example").length >= 2,
      `${card.name} 至少需要两个典型例题`
    );
    for (const chunk of card.chunks) {
      assert.ok(chunk.citation.includes(card.name));
      assert.ok(chunk.citation.includes("self-authored-summary-v1"));
      assert.ok(chunk.source?.key);
    }
    const sourceKeys = new Set(card.sources.map((source) => source.key));
    assert.ok(sourceKeys.has("self-authored-summary-v1"));
    assert.ok(sourceKeys.has("renjiao-outline-v1"));
  }

  const reviewCount = repository.db
    .prepare("SELECT COUNT(*) AS count FROM knowledge_reviews")
    .get().count;
  assert.equal(reviewCount, 12);
  repository.close();
});

test("全文检索返回知识片段、来源引用和覆盖状态", async () => {
  const { repository, tools } = createFixture();
  const result = await tools.invoke(
    "search_knowledge",
    { query: "一个圆形花坛的半径是3米，面积是多少平方米？", limit: 3 },
    { caller: "agent" }
  );

  assert.equal(result.coverage.status, "covered");
  assert.ok(result.items.length >= 1);
  assert.equal(result.items[0].knowledgePoint, "圆");
  assert.ok(result.items[0].chunks.length >= 2);
  assert.ok(result.items[0].citations.length >= 2);
  for (const citation of result.items[0].citations) {
    assert.match(citation, /项目自编六年级数学知识摘要/);
    assert.doesNotMatch(citation, /\[undefined\]/);
  }

  const ftsCount = repository.db
    .prepare("SELECT COUNT(*) AS count FROM knowledge_chunks_fts")
    .get().count;
  const chunkCount = repository.db
    .prepare("SELECT COUNT(*) AS count FROM knowledge_chunks")
    .get().count;
  assert.equal(ftsCount, chunkCount);
  repository.close();
});

test("常见学生说法可以通过别名和关键词命中知识点", () => {
  const { repository } = createFixture();
  const cases = [
    ["比例尺是1比500000，图上4厘米，实际多少千米？", "比例与图形"],
    ["一件衣服打八折后多少钱？", "百分数"],
    ["B点在A点北偏东30度方向4千米处，是以哪个点为观测点？", "位置与方向"],
    ["连续奇数相加与正方形数有什么关系？", "数与形"],
    ["零下5摄氏度记作什么？", "负数"],
    ["圆柱的体积怎么算？", "圆柱与圆锥"],
    ["分数混合运算的运算顺序是什么？", "分数四则混合运算"]
  ];
  for (const [query, expected] of cases) {
    const result = repository.searchKnowledge({ query, limit: 3 });
    assert.ok(
      result.items.some((item) => item.knowledgePoint === expected),
      `${query} 未命中 ${expected}，实际为 ${result.items
        .map((item) => item.knowledgePoint)
        .join("、")}`
    );
  }
  repository.close();
});

test("知识库评测集 Top-3 命中率达到 M5 验收线", () => {
  const { repository } = createFixture();
  const evaluation = evaluateKnowledgeRetrieval(repository, { limit: 3 });

  assert.equal(evaluation.total, 48);
  assert.ok(
    evaluation.accuracy >= 0.9,
    `Top-3 命中率 ${evaluation.accuracy} 低于 90%`
  );
  assert.ok(
    evaluation.top1Accuracy >= 0.75,
    `Top-1 命中率 ${evaluation.top1Accuracy} 低于 75%`
  );
  assert.equal(evaluation.sourceCoverage, 1);
  assert.equal(evaluation.misses.length, 0);
  assert.equal(evaluation.heldOut.total, 12);
  assert.equal(evaluation.heldOut.misses.length, 0);
  assert.ok(
    evaluation.heldOut.accuracy >= 0.9,
    `留出集 Top-3 命中率 ${evaluation.heldOut.accuracy} 低于 90%`
  );
  for (const point of evaluation.perPoint) {
    assert.ok(point.accuracy >= 0.9, `${point.knowledgePoint} 命中率不足`);
  }
  repository.close();
});

test("验收修复：单字别名、单字名称排序、覆盖判断和利息检索", () => {
  const { repository } = createFixture();
  const exactCases = [
    ["π", "圆", "covered"],
    ["比", "比和比例", "covered"],
    ["比例", "比和比例", "covered"],
    ["利息怎么算", "百分数", "covered"],
    [
      "圆柱底面半径2分米高5分米，体积是多少立方分米？",
      "圆柱与圆锥",
      "covered"
    ]
  ];
  for (const [query, expected, status] of exactCases) {
    const result = repository.searchKnowledge({ query, limit: 3 });
    assert.equal(result.coverage.status, status, `${query} 的覆盖状态不符`);
    assert.equal(
      result.items[0]?.knowledgePoint,
      expected,
      `${query} 的 Top-1 应为 ${expected}，实际为 ${result.items
        .map((item) => item.knowledgePoint)
        .join("、")}`
    );
  }

  const average = repository.searchKnowledge({
    query: "平均数怎么求",
    limit: 3
  });
  assert.equal(average.coverage.status, "not_covered");
  assert.equal(average.items.length, 0);
  repository.close();
});

test("知识卡片内容与教材结构一致且无已知数学错误", () => {
  const { repository } = createFixture();
  const cards = repository.getKnowledgeCards();
  const byName = new Map(cards.map((card) => [card.name, card]));
  const text = (card) => JSON.stringify(card);

  assert.doesNotMatch(
    text(byName.get("分数四则混合运算")),
    /把\(a\+b\)÷c误写成a÷c\+b÷c/
  );
  assert.doesNotMatch(text(byName.get("统计与扇形统计图")), /平均数/);
  assert.ok(byName.get("百分数").aliases.includes("利息"));

  const position = byName.get("位置与方向");
  assert.ok(!text(position).includes("数对"));
  assert.ok(position.prerequisites.includes("位置与方向（一）"));

  const shape = byName.get("数与形");
  assert.ok(!text(shape).includes("火柴棒"));
  assert.ok(!text(shape).includes("点阵"));
  repository.close();
});

test("知识库未覆盖时明确返回不足且不伪造来源", () => {
  const { repository } = createFixture();
  const result = repository.searchKnowledge({
    query: "请帮我写一首关于春天的诗",
    limit: 3
  });
  assert.equal(result.coverage.status, "not_covered");
  assert.equal(result.items.length, 0);
  assert.match(result.coverage.note, /未覆盖/);
  assert.match(result.coverage.note, /不要编造/);
  repository.close();
});

test("LLM 诊断只能引用检索到的可审计来源", async () => {
  const { repository, tools } = createFixture();
  const agent = createDiagnosisAgent({
    repository,
    tools,
    gateway: diagnosisGateway(
      validDiagnosis({ knowledgeSources: ["某本不存在的教材第99页"] })
    )
  });
  const result = await agent.diagnose({
    question: "一个圆形花坛的半径是3米，面积是多少平方米？",
    correctAnswer: "28.26平方米"
  });
  assert.equal(result.knowledgePoint, "圆");
  assert.ok(result.knowledgeSources.length >= 1);
  for (const source of result.knowledgeSources) {
    assert.match(source, /项目自编六年级数学知识摘要/);
  }
  assert.equal(result.knowledgeSources.includes("某本不存在的教材第99页"), false);

  const uncoveredAgent = createDiagnosisAgent({
    repository,
    tools,
    gateway: diagnosisGateway(
      validDiagnosis({
        knowledgePoint: "综合应用",
        knowledgeSources: ["某本不存在的教材第99页"]
      })
    )
  });
  const uncovered = await uncoveredAgent.diagnose({
    question: "请帮我写一首关于春天的诗"
  });
  assert.deepEqual(uncovered.knowledgeSources, []);
  assert.ok(uncovered.evidence.some((item) => item.includes("未覆盖")));
  repository.close();
});

test("知识库同步幂等且内容版本稳定", () => {
  const { repository } = createFixture();
  const before = repository.db
    .prepare("SELECT COUNT(*) AS count FROM knowledge_chunks")
    .get().count;
  const versions = repository
    .getKnowledgeCards()
    .map((card) => card.contentVersion);
  const first = repository.syncKnowledgeBase();
  const second = repository.syncKnowledgeBase();

  assert.equal(first.changedPoints, 0);
  assert.equal(second.changedPoints, 0);
  assert.equal(
    repository.db
      .prepare("SELECT COUNT(*) AS count FROM knowledge_chunks")
      .get().count,
    before
  );
  assert.deepEqual(
    repository.getKnowledgeCards().map((card) => card.contentVersion),
    versions
  );
  repository.close();
});
