import test from "node:test";
import assert from "node:assert/strict";
import { LearningRepository } from "../src/database.js";
import {
  TOOL_ERROR_CODES,
  createLearningTools
} from "../src/tools/index.js";
import { createToolRegistry } from "../src/tools/registry.js";

test("公开契约中的可选参数可以省略", async () => {
  const repository = new LearningRepository();
  const tools = createLearningTools(repository);

  const search = await tools.invoke(
    "search_knowledge",
    { query: "百分数" },
    { caller: "agent" }
  );
  assert.ok(search.items.length > 0);

  const draft = await tools.invoke(
    "create_mistake_draft",
    { question: "1+1=?", correctAnswer: "2" },
    { caller: "agent", idempotencyKey: "optional-draft" }
  );
  assert.ok(draft.draftId);

  const mistake = repository.createMistake({
    question: "1+1=?",
    studentAnswer: "2",
    correctAnswer: "2",
    knowledgePoint: "综合应用"
  });
  const attempt = await tools.invoke(
    "submit_attempt",
    { mistakeId: mistake.id, answer: "2" },
    { caller: "agent", idempotencyKey: "optional-attempt" }
  );
  assert.equal(attempt.correct, true);
  repository.close();
});

test("Agent 保存错题时只获得编号和保存状态", async () => {
  const repository = new LearningRepository();
  const tools = createLearningTools(repository);
  const draft = await tools.invoke(
    "create_mistake_draft",
    {
      question: "一件商品原价 100 元，涨价 20% 后是多少元？",
      studentAnswer: "100元",
      correctAnswer: "120元",
      analysis: "先求涨价部分。",
      knowledgePoint: "百分数"
    },
    { caller: "agent", idempotencyKey: "leak-draft" }
  );

  const saved = await tools.invoke(
    "save_mistake",
    { draftId: draft.draftId, confirmed: true },
    { caller: "agent", idempotencyKey: "leak-save" }
  );
  assert.deepEqual(Object.keys(saved).sort(), ["alreadySaved", "mistakeId"]);
  assert.equal(Object.hasOwn(saved, "correctAnswer"), false);
  assert.equal(Object.hasOwn(saved, "analysis"), false);
  assert.equal(Object.hasOwn(saved, "hint"), false);
  repository.close();
});

test("超时后恢复的异步处理不能继续写入数据库", async () => {
  const repository = new LearningRepository();
  const tools = createToolRegistry(repository, [
    {
      name: "late_writer",
      description: "超时后尝试写入",
      permission: "write",
      allowedCallers: ["agent"],
      requiresIdempotencyKey: true,
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
          question: "超时后写入",
          correctAnswer: "0"
        });
        return { written: true };
      }
    }
  ]);

  await assert.rejects(
    tools.invoke(
      "late_writer",
      {},
      { caller: "agent", idempotencyKey: "timeout-write" }
    ),
    (error) =>
      error instanceof Error &&
      error.code === TOOL_ERROR_CODES.TOOL_TIMEOUT
  );
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(
    repository.db
      .prepare("SELECT COUNT(*) AS count FROM mistake_drafts")
      .get().count,
    0
  );
  repository.close();
});
