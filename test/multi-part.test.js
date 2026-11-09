import test from "node:test";
import assert from "node:assert/strict";
import { LearningRepository } from "../src/database.js";
import {
  TOOL_ERROR_CODES,
  createLearningTools
} from "../src/tools/index.js";
import {
  comparePartAnswer,
  evaluatePartResponses
} from "../src/domain/part-evaluation.js";

function multiPartMistake() {
  return {
    question:
      "一项工程，甲队的工作效率是 1/5，乙队的工作效率是 1/6。工作效率比是（），时间比是（）。",
    analysis: "先分别写出效率比和时间比。",
    knowledgePoint: "比和比例",
    errorType: "前后项对应反了",
    parts: [
      {
        label: "工作效率比",
        prompt: "甲队和乙队的工作效率比",
        studentAnswer: "6:1",
        answerType: "ratio",
        comparisonRule: "ratio",
        knowledgePoint: "比和比例",
        acceptedAnswers: ["1:6"]
      },
      {
        label: "时间比",
        prompt: "甲队和乙队完成同一项工程所需时间比",
        studentAnswer: "1:6",
        answerType: "ratio",
        comparisonRule: "ratio",
        knowledgePoint: "比和比例",
        acceptedAnswers: ["6:1"]
      }
    ]
  };
}

test("多小问答案按所属小问独立比较", () => {
  assert.equal(
    comparePartAnswer({
      rawAnswer: "2:12",
      acceptedAnswers: ["1:6"],
      answerType: "ratio"
    }),
    true
  );
  assert.equal(
    comparePartAnswer({
      rawAnswer: "6:1",
      acceptedAnswers: ["1:6"],
      answerType: "ratio"
    }),
    false
  );
  assert.equal(
    comparePartAnswer({
      rawAnswer: "75%",
      acceptedAnswers: ["3/4", "0.75"],
      answerType: "percent"
    }),
    true
  );
});

test("多小问题目支持部分正确和分项作答记录", () => {
  const repository = new LearningRepository();
  const mistake = repository.createMistake(multiPartMistake());

  assert.equal(mistake.parts.length, 2);
  assert.deepEqual(mistake.parts[0].acceptedAnswers, ["1:6"]);
  assert.equal(mistake.parts[1].label, "时间比");

  const partial = repository.recordAttempt(mistake.id, "", {
    independent: true,
    answers: [
      { partId: mistake.parts[0].id, value: "1:6" },
      { partId: mistake.parts[1].id, value: "1:6" }
    ]
  });
  assert.equal(partial.correct, false);
  assert.equal(partial.outcome, "partial");
  assert.equal(partial.correctPartCount, 1);
  assert.equal(partial.totalPartCount, 2);
  assert.equal(partial.mistake.status, "practicing");
  assert.equal(
    repository.db
      .prepare("SELECT outcome FROM attempts ORDER BY id DESC LIMIT 1")
      .get().outcome,
    "partial"
  );
  assert.equal(
    repository.db
      .prepare("SELECT COUNT(*) AS count FROM attempt_part_results")
      .get().count,
    2
  );

  const allCorrect = repository.recordAttempt(mistake.id, "", {
    independent: true,
    answers: [
      { partId: mistake.parts[0].id, value: "2:12" },
      { partId: mistake.parts[1].id, value: "6:1" }
    ]
  });
  assert.equal(allCorrect.correct, true);
  assert.equal(allCorrect.outcome, "correct");
  assert.equal(allCorrect.mastered, false);

  const mastered = repository.recordAttempt(mistake.id, "", {
    independent: true,
    answers: [
      { partId: mistake.parts[0].id, value: "1:6" },
      { partId: mistake.parts[1].id, value: "6:1" }
    ]
  });
  assert.equal(mastered.mastered, true);
  repository.close();
});

test("Agent 读取多小问题目时不暴露小问答案", async () => {
  const repository = new LearningRepository();
  const tools = createLearningTools(repository);
  const mistake = repository.createMistake(multiPartMistake());

  const forAgent = await tools.invoke(
    "get_mistake",
    { mistakeId: mistake.id },
    { caller: "agent" }
  );
  assert.equal(forAgent.parts.length, 2);
  assert.equal(Object.hasOwn(forAgent.parts[0], "acceptedAnswers"), false);
  assert.equal(forAgent.parts[0].explanation, "");
  assert.equal(forAgent.parts[0].label, "工作效率比");

  const forUi = await tools.invoke(
    "get_mistake",
    { mistakeId: mistake.id, includeSolution: true },
    { caller: "ui" }
  );
  assert.deepEqual(forUi.parts[0].acceptedAnswers, ["1:6"]);
  repository.close();
});

test("多小问草稿保存和提交工具支持 answers 数组", async () => {
  const repository = new LearningRepository();
  const tools = createLearningTools(repository);
  const draft = await tools.invoke(
    "create_mistake_draft",
    multiPartMistake(),
    { caller: "agent", idempotencyKey: "multi-draft" }
  );
  const saved = await tools.invoke(
    "save_mistake",
    { draftId: draft.draftId, confirmed: true },
    { caller: "agent", idempotencyKey: "multi-save" }
  );
  const mistake = repository.getMistake(saved.mistakeId, {
    includeSolution: true
  });
  assert.equal(mistake.parts.length, 2);

  const result = await tools.invoke(
    "submit_attempt",
    {
      mistakeId: mistake.id,
      answers: [
        { partId: mistake.parts[0].id, value: "6:1" },
        { partId: mistake.parts[1].id, value: "6:1" }
      ]
    },
    { caller: "agent", idempotencyKey: "multi-attempt" }
  );
  assert.equal(result.outcome, "partial");
  assert.deepEqual(
    result.partResults.map((part) => part.outcome),
    ["incorrect", "correct"]
  );
  repository.close();
});

test("修改多小问结构会归档旧小问并保留历史结果", () => {
  const repository = new LearningRepository();
  const mistake = repository.createMistake(multiPartMistake());
  repository.recordAttempt(mistake.id, "", {
    independent: true,
    answers: [
      { partId: mistake.parts[0].id, value: "1:6" },
      { partId: mistake.parts[1].id, value: "6:1" }
    ]
  });
  const result = repository.updateMistake(mistake.id, {
    parts: [
      {
        label: "效率比",
        studentAnswer: "1:6",
        answerType: "ratio",
        comparisonRule: "ratio",
        knowledgePoint: "比和比例",
        acceptedAnswers: ["1:6"]
      },
      {
        label: "时间比",
        studentAnswer: "6:1",
        answerType: "ratio",
        comparisonRule: "ratio",
        knowledgePoint: "比和比例",
        acceptedAnswers: ["6:1"]
      },
      {
        label: "效率和时间的关系",
        studentAnswer: "",
        answerType: "text",
        comparisonRule: "text",
        knowledgePoint: "比和比例",
        acceptedAnswers: ["互为倒数"]
      }
    ]
  });
  assert.equal(result.learningReset, true);
  assert.ok(result.changedFields.includes("parts"));
  assert.equal(result.mistake.parts.length, 3);
  assert.equal(
    repository.db
      .prepare(
        "SELECT COUNT(*) AS count FROM mistake_parts WHERE mistake_id = ? AND active = 0"
      )
      .get(mistake.id).count,
    2
  );
  assert.equal(
    repository.db
      .prepare("SELECT COUNT(*) AS count FROM attempt_part_results")
      .get().count,
    2
  );
  repository.close();
});

test("提示辅助的全对作答不累计独立掌握次数", () => {
  const repository = new LearningRepository();
  const mistake = repository.createMistake(multiPartMistake());
  const answers = [
    { partId: mistake.parts[0].id, value: "1:6" },
    { partId: mistake.parts[1].id, value: "6:1" }
  ];

  const first = repository.recordAttempt(mistake.id, "", {
    answers,
    independent: false,
    hintLevel: 1
  });
  const second = repository.recordAttempt(mistake.id, "", {
    answers,
    independent: false,
    hintLevel: 1
  });
  assert.equal(first.correct, true);
  assert.equal(second.correct, true);
  assert.equal(second.mastered, false);
  assert.equal(second.mistake.status, "practicing");
  assert.equal(second.mistake.consecutiveCorrect, 0);
  repository.close();
});

test("Agent 创建多小问草稿时不返回标准答案和解析", async () => {
  const repository = new LearningRepository();
  const tools = createLearningTools(repository);
  const draft = await tools.invoke(
    "create_mistake_draft",
    multiPartMistake(),
    { caller: "agent", idempotencyKey: "safe-draft" }
  );
  assert.equal(draft.parts.length, 2);
  for (const part of draft.parts) {
    assert.equal(Object.hasOwn(part, "acceptedAnswers"), false);
    assert.equal(Object.hasOwn(part, "explanation"), false);
  }

  const forUi = await tools.invoke(
    "create_mistake_draft",
    {
      ...multiPartMistake(),
      question: "另一个多小问题目"
    },
    { caller: "ui", idempotencyKey: "safe-draft-ui" }
  );
  assert.deepEqual(forUi.parts[0].acceptedAnswers, ["1:6"]);
  repository.close();
});

test("提交作答拒绝跨错题和重复 partId 且不写入业务数据", async () => {
  const repository = new LearningRepository();
  const tools = createLearningTools(repository);
  const first = repository.createMistake(multiPartMistake());
  const second = repository.createMistake({
    ...multiPartMistake(),
    question: "第二道多小问题目"
  });

  await assert.rejects(
    tools.invoke(
      "submit_attempt",
      {
        mistakeId: first.id,
        answers: [
          { partId: second.parts[0].id, value: "1:6" },
          { partId: first.parts[1].id, value: "6:1" }
        ]
      },
      { caller: "agent", idempotencyKey: "cross-mistake-parts" }
    ),
    (error) =>
      error.code === TOOL_ERROR_CODES.INVALID_ARGUMENTS &&
      /不属于当前错题/.test(error.message)
  );
  await assert.rejects(
    tools.invoke(
      "submit_attempt",
      {
        mistakeId: first.id,
        answers: [
          { partId: first.parts[0].id, value: "1:6" },
          { partId: first.parts[0].id, value: "6:1" }
        ]
      },
      { caller: "agent", idempotencyKey: "duplicate-part" }
    ),
    (error) =>
      error.code === TOOL_ERROR_CODES.INVALID_ARGUMENTS &&
      /不能重复/.test(error.message)
  );
  assert.equal(
    repository.db.prepare("SELECT COUNT(*) AS count FROM attempts").get().count,
    0
  );
  repository.close();
});

test("提示记录拒绝把其他错题的小问关联到当前错题", async () => {
  const repository = new LearningRepository();
  const tools = createLearningTools(repository);
  const first = repository.createMistake(multiPartMistake());
  const second = repository.createMistake({
    ...multiPartMistake(),
    question: "另一道题"
  });

  await assert.rejects(
    tools.invoke(
      "record_hint",
      {
        mistakeId: first.id,
        partId: second.parts[0].id,
        hintLevel: 1,
        content: "跨错题提示"
      },
      { caller: "agent", idempotencyKey: "cross-mistake-hint" }
    ),
    (error) =>
      error.code === TOOL_ERROR_CODES.INVALID_ARGUMENTS &&
      /不属于当前错题/.test(error.message)
  );
  assert.equal(
    repository.db.prepare("SELECT COUNT(*) AS count FROM hint_events").get()
      .count,
    0
  );

  const valid = await tools.invoke(
    "record_hint",
    {
      mistakeId: first.id,
      partId: first.parts[0].id,
      hintLevel: 1,
      content: "先确认比的前后项"
    },
    { caller: "agent", idempotencyKey: "valid-part-hint" }
  );
  assert.equal(valid.partId, first.parts[0].id);
  repository.close();
});
