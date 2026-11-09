import test from "node:test";
import assert from "node:assert/strict";
import { LearningRepository } from "../src/database.js";
import {
  TOOL_ERROR_CODES,
  ToolError,
  createLearningTools
} from "../src/tools/index.js";
import { createToolRegistry } from "../src/tools/registry.js";

function createFixture() {
  const repository = new LearningRepository();
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

async function expectToolError(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.code, code);
    return true;
  });
}

test("工具目录公开输入输出契约并执行权限检查", async () => {
  const { repository, tools } = createFixture();
  const catalog = tools.listTools("agent");

  assert.equal(catalog.length, 9);
  for (const tool of catalog) {
    assert.ok(tool.name);
    assert.ok(tool.inputSchema);
    assert.ok(tool.outputSchema);
  }
  assert.equal(
    catalog.find((tool) => tool.name === "submit_attempt")
      .requiresIdempotencyKey,
    true
  );

  await expectToolError(
    tools.invoke(
      "search_knowledge",
      { query: "百分数" },
      { caller: "guest" }
    ),
    TOOL_ERROR_CODES.PERMISSION_DENIED
  );
  await expectToolError(
    tools.invoke(
      "search_knowledge",
      { query: "" },
      { caller: "agent" }
    ),
    TOOL_ERROR_CODES.INVALID_ARGUMENTS
  );
  await expectToolError(
    tools.invoke("missing_tool", {}, { caller: "agent" }),
    TOOL_ERROR_CODES.TOOL_NOT_FOUND
  );
  repository.close();
});

test("知识检索、错题读取和到期复习工具可用", async () => {
  const { repository, tools } = createFixture();
  const first = repository.createMistake(baseMistake());
  repository.createMistake(
    baseMistake({
      question: "圆的半径是 3 米，面积是多少？",
      correctAnswer: "28.26平方米",
      knowledgePoint: "圆"
    })
  );

  const knowledge = await tools.invoke(
    "search_knowledge",
    { query: "单位1", knowledgePoint: "百分数", limit: 2 },
    { caller: "agent" }
  );
  assert.equal(knowledge.items[0].knowledgePoint, "百分数");
  assert.ok(knowledge.items[0].steps.length >= 3);
  const optionalKnowledge = await tools.invoke(
    "search_knowledge",
    { query: "百分数" },
    { caller: "agent" }
  );
  assert.equal(optionalKnowledge.items[0].knowledgePoint, "百分数");

  const mistakeForAgent = await tools.invoke(
    "get_mistake",
    { mistakeId: first.id, includeSolution: true },
    { caller: "agent" }
  );
  assert.equal(mistakeForAgent.question, first.question);
  assert.equal(mistakeForAgent.correctAnswer, undefined);
  assert.equal(mistakeForAgent.diagnosis, "");

  const mistakeForUi = await tools.invoke(
    "get_mistake",
    { mistakeId: first.id, includeSolution: true },
    { caller: "ui" }
  );
  assert.equal(mistakeForUi.correctAnswer, "120元");

  const due = await tools.invoke(
    "get_due_reviews",
    { limit: 5 },
    { caller: "agent" }
  );
  assert.equal(due.count, 2);
  assert.equal(due.items[0].correctAnswer, undefined);
  repository.close();
});

test("错题草稿需要确认后才能保存，并支持幂等重放", async () => {
  const { repository, tools } = createFixture();
  const draftArguments = baseMistake();
  const draft = await tools.invoke(
    "create_mistake_draft",
    draftArguments,
    { caller: "agent", idempotencyKey: "draft-key-1" }
  );
  assert.equal(draft.status, "draft");
  assert.equal(draft.knowledgePoint, "百分数");

  const replayedDraft = await tools.invoke(
    "create_mistake_draft",
    draftArguments,
    { caller: "agent", idempotencyKey: "draft-key-1" }
  );
  assert.equal(replayedDraft.draftId, draft.draftId);
  assert.equal(
    repository.db
      .prepare("SELECT COUNT(*) AS count FROM mistake_drafts")
      .get().count,
    1
  );
  assert.equal(
    repository.db.prepare("SELECT COUNT(*) AS count FROM tool_calls").get()
      .count,
    1
  );

  const minimalDraft = await tools.invoke(
    "create_mistake_draft",
    { question: "1+1=?", correctAnswer: "2" },
    { caller: "agent", idempotencyKey: "minimal-draft-key" }
  );
  assert.ok(minimalDraft.draftId);

  await expectToolError(
    tools.invoke(
      "create_mistake_draft",
      { ...draftArguments, question: "另一道题" },
      { caller: "agent", idempotencyKey: "draft-key-1" }
    ),
    TOOL_ERROR_CODES.IDEMPOTENCY_CONFLICT
  );
  await expectToolError(
    tools.invoke(
      "save_mistake",
      { draftId: draft.draftId, confirmed: false },
      { caller: "agent", idempotencyKey: "save-invalid" }
    ),
    TOOL_ERROR_CODES.INVALID_ARGUMENTS
  );

  const saved = await tools.invoke(
    "save_mistake",
    { draftId: draft.draftId, confirmed: true },
    { caller: "agent", idempotencyKey: "save-key-1" }
  );
  assert.ok(saved.mistakeId > 0);
  assert.equal(saved.alreadySaved, false);
  assert.equal(Object.hasOwn(saved, "mistake"), false);
  assert.equal(Object.hasOwn(saved, "correctAnswer"), false);
  assert.equal(Object.hasOwn(saved, "analysis"), false);
  assert.equal(Object.hasOwn(saved, "hint"), false);
  assert.equal(repository.listMistakes().length, 1);

  const replayedSave = await tools.invoke(
    "save_mistake",
    { draftId: draft.draftId, confirmed: true },
    { caller: "agent", idempotencyKey: "save-key-1" }
  );
  assert.equal(replayedSave.mistakeId, saved.mistakeId);

  const savedWithNewKey = await tools.invoke(
    "save_mistake",
    { draftId: draft.draftId, confirmed: true },
    { caller: "agent", idempotencyKey: "save-key-2" }
  );
  assert.equal(savedWithNewKey.mistakeId, saved.mistakeId);
  assert.equal(savedWithNewKey.alreadySaved, true);
  assert.equal(repository.listMistakes().length, 1);
  assert.equal(
    repository.db
      .prepare("SELECT status FROM mistake_drafts WHERE id = ?")
      .get(draft.draftId).status,
    "saved"
  );
  repository.close();
});

test("提示记录和作答提交不会因重试重复写入", async () => {
  const { repository, tools } = createFixture();
  const mistake = repository.createMistake(baseMistake());

  const hintArgs = {
    mistakeId: mistake.id,
    hintLevel: 1,
    content: "先圈出单位“1”。",
    source: "rule"
  };
  const hint = await tools.invoke("record_hint", hintArgs, {
    caller: "agent",
    idempotencyKey: "hint-key-1"
  });
  const replayedHint = await tools.invoke("record_hint", hintArgs, {
    caller: "agent",
    idempotencyKey: "hint-key-1"
  });
  assert.equal(replayedHint.hintEventId, hint.hintEventId);
  assert.equal(
    repository.db.prepare("SELECT COUNT(*) AS count FROM hint_events").get()
      .count,
    1
  );

  const attemptArgs = {
    mistakeId: mistake.id,
    answer: "100元",
    independent: false,
    hintLevel: 1
  };
  const attempt = await tools.invoke("submit_attempt", attemptArgs, {
    caller: "agent",
    idempotencyKey: "attempt-key-1"
  });
  assert.equal(attempt.correct, false);
  const replayedAttempt = await tools.invoke("submit_attempt", attemptArgs, {
    caller: "agent",
    idempotencyKey: "attempt-key-1"
  });
  assert.equal(replayedAttempt.feedback, attempt.feedback);
  assert.equal(
    repository.db.prepare("SELECT COUNT(*) AS count FROM attempts").get().count,
    1
  );

  const storedAttempt = repository.db
    .prepare(
      "SELECT outcome, hint_level, independent, evaluation_source FROM attempts"
    )
    .get();
  assert.equal(storedAttempt.outcome, "incorrect");
  assert.equal(storedAttempt.hint_level, 1);
  assert.equal(storedAttempt.independent, 0);
  assert.equal(storedAttempt.evaluation_source, "rule");

  const audit = repository.db
    .prepare(
      "SELECT tool_name, status, latency_ms FROM tool_calls ORDER BY id"
    )
    .all();
  assert.deepEqual(
    audit.map((item) => [item.tool_name, item.status]),
    [
      ["record_hint", "succeeded"],
      ["submit_attempt", "succeeded"]
    ]
  );
  assert.ok(audit.every((item) => Number.isInteger(item.latency_ms)));

  const secondMistake = repository.createMistake(
    baseMistake({ question: "1+1 等于多少？", correctAnswer: "2" })
  );
  const minimalAttempt = await tools.invoke(
    "submit_attempt",
    { mistakeId: secondMistake.id, answer: "2" },
    { caller: "agent", idempotencyKey: "attempt-key-minimal" }
  );
  assert.equal(minimalAttempt.correct, true);

  const summary = await tools.invoke(
    "build_learning_summary",
    {},
    { caller: "agent" }
  );
  assert.equal(summary.totals.mistakes, 2);
  assert.equal(summary.totals.attempts, 2);
  assert.equal(summary.totals.hints, 1);
  assert.equal(summary.knowledgePoints[0].knowledgePoint, "百分数");
  repository.close();
});

test("写入工具缺少幂等键时拒绝执行且不修改数据", async () => {
  const { repository, tools } = createFixture();
  await expectToolError(
    tools.invoke(
      "create_mistake_draft",
      baseMistake(),
      { caller: "agent" }
    ),
    TOOL_ERROR_CODES.IDEMPOTENCY_REQUIRED
  );
  assert.equal(
    repository.db
      .prepare("SELECT COUNT(*) AS count FROM mistake_drafts")
      .get().count,
    0
  );
  repository.close();
});

test("错题修改保留历史作答并在关键字段变化时重置掌握进度", async () => {
  const { repository, tools } = createFixture();
  const mistake = repository.createMistake(baseMistake());
  repository.recordAttempt(mistake.id, "100元");

  const analysisUpdate = await tools.invoke(
    "update_mistake",
    {
      mistakeId: mistake.id,
      analysis: "先求 100 元的 20%，再与原价相加。"
    },
    { caller: "agent", idempotencyKey: "edit-analysis" }
  );
  assert.equal(analysisUpdate.revision, 2);
  assert.equal(analysisUpdate.learningReset, false);
  assert.deepEqual(analysisUpdate.changedFields, ["analysis"]);
  assert.deepEqual(Object.keys(analysisUpdate).sort(), [
    "changedFields",
    "learningReset",
    "mistakeId",
    "revision"
  ]);

  const replayed = await tools.invoke(
    "update_mistake",
    {
      mistakeId: mistake.id,
      analysis: "先求 100 元的 20%，再与原价相加。"
    },
    { caller: "agent", idempotencyKey: "edit-analysis" }
  );
  assert.equal(replayed.revision, 2);

  const answerUpdate = await tools.invoke(
    "update_mistake",
    {
      mistakeId: mistake.id,
      question: "一件商品原价 200 元，涨价 20% 后是多少元？",
      correctAnswer: "240元"
    },
    { caller: "ui", idempotencyKey: "edit-question" }
  );
  assert.equal(answerUpdate.revision, 3);
  assert.equal(answerUpdate.learningReset, true);
  assert.deepEqual(
    [...answerUpdate.changedFields].sort(),
    ["correctAnswer", "question"]
  );

  const updated = repository.getMistake(mistake.id, {
    includeSolution: true
  });
  assert.equal(updated.question, "一件商品原价 200 元，涨价 20% 后是多少元？");
  assert.equal(updated.correctAnswer, "240元");
  assert.equal(updated.status, "new");
  assert.equal(updated.consecutiveCorrect, 0);
  assert.equal(updated.attemptCount, 0);
  assert.equal(
    repository.db.prepare("SELECT COUNT(*) AS count FROM attempts").get().count,
    1
  );
  const latestEdit = repository.db
    .prepare("SELECT reset_learning FROM mistake_edits ORDER BY id DESC LIMIT 1")
    .get();
  assert.equal(latestEdit.reset_learning, 1);
  repository.close();
});

test("工具执行超时会记录失败审计", async () => {
  const { repository } = createFixture();
  const tools = createToolRegistry(repository, [
    {
      name: "slow_tool",
      description: "模拟超时工具",
      permission: "read",
      allowedCallers: ["agent"],
      timeoutMs: 5,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {}
      },
      outputSchema: {
        type: "object",
        additionalProperties: true
      },
      async handler() {
        await new Promise((resolve) => setTimeout(resolve, 25));
        repository.createMistakeDraft({
          question: "超时后不应写入",
          correctAnswer: "0"
        });
        return { ok: true };
      }
    }
  ]);

  await expectToolError(
    tools.invoke("slow_tool", {}, { caller: "agent" }),
    TOOL_ERROR_CODES.TOOL_TIMEOUT
  );
  const audit = repository.db
    .prepare("SELECT status, error_message FROM tool_calls")
    .get();
  assert.equal(audit.status, "failed");
  assert.match(audit.error_message, /TOOL_TIMEOUT/);
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(
    repository.db
      .prepare("SELECT COUNT(*) AS count FROM mistake_drafts")
      .get().count,
    0
  );
  repository.close();
});
