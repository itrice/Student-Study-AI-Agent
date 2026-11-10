import test from "node:test";
import assert from "node:assert/strict";
import { LearningRepository } from "../src/database.js";
import { createLearningTools } from "../src/tools/index.js";
import { createTutoringAgent } from "../src/llm/tutoring-agent.js";

function createMultiMistake(repository) {
  return repository.createMistake({
    question: "一项工程，甲队效率1/5，乙队效率1/6，求效率比和时间比。",
    knowledgePoint: "比和比例",
    parts: [
      {
        label: "工作效率比",
        answerType: "ratio",
        comparisonRule: "ratio",
        acceptedAnswers: ["2:3"]
      },
      {
        label: "时间比",
        answerType: "ratio",
        comparisonRule: "ratio",
        acceptedAnswers: ["3:2"]
      }
    ]
  });
}

function fakeGateway(content) {
  return {
    isConfigured: () => true,
    status: () => ({ configured: true }),
    provider: "test-provider",
    model: "test-model",
    async chat() {
      return {
        message: {
          role: "assistant",
          content: JSON.stringify(content)
        },
        usage: { inputTokens: 10, outputTokens: 10 },
        latencyMs: 15,
        provider: "test-provider",
        model: "test-model"
      };
    }
  };
}

function fakeGatewaySequence(contents) {
  let callIndex = 0;
  return {
    isConfigured: () => true,
    status: () => ({ configured: true }),
    provider: "test-provider",
    model: "test-model",
    async chat() {
      const content =
        contents[Math.min(callIndex, contents.length - 1)];
      callIndex += 1;
      return {
        message: {
          role: "assistant",
          content: JSON.stringify(content)
        },
        usage: { inputTokens: 10, outputTokens: 10 },
        latencyMs: 15,
        provider: "test-provider",
        model: "test-model"
      };
    }
  };
}

function createSinglePartMistake(
  repository,
  { acceptedAnswer, answerType = "auto", comparisonRule = "auto" }
) {
  return repository.createMistake({
    question: `用于提示泄露检测的题目：${acceptedAnswer}`,
    knowledgePoint: "综合应用",
    parts: [
      {
        label: "答案",
        answerType,
        comparisonRule,
        acceptedAnswers: [acceptedAnswer]
      }
    ]
  });
}

test("分级提示由 LLM 生成并记录提示证据", async () => {
  const repository = new LearningRepository();
  const tools = createLearningTools(repository);
  const mistake = createMultiMistake(repository);
  const agent = createTutoringAgent({
    repository,
    tools,
    gateway: fakeGateway({
      level: 1,
      title: "先看两个量的关系",
      content: "先写出甲、乙各自完成同一项工程需要的时间。",
      guidingQuestions: ["效率和时间之间是什么关系？"],
      sources: ["比和比例"]
    })
  });
  const hint = await agent.getHint({
    mistakeId: mistake.id,
    level: 1,
    idempotencyKey: "hint-level-1"
  });
  assert.equal(hint.source, "llm");
  assert.equal(hint.level, 1);
  assert.ok(hint.hintEventId);
  assert.equal(
    repository.db.prepare("SELECT COUNT(*) AS count FROM hint_events").get()
      .count,
    1
  );
  await assert.rejects(
    agent.getHint({
      mistakeId: mistake.id,
      level: 3,
      idempotencyKey: "hint-level-3-too-early"
    }),
    /较低等级/
  );
  repository.close();
});

test("提示中出现标准答案时被拦截并改用安全模板", async () => {
  const repository = new LearningRepository();
  const tools = createLearningTools(repository);
  const mistake = createMultiMistake(repository);
  const agent = createTutoringAgent({
    repository,
    tools,
    gateway: fakeGateway({
      level: 1,
      title: "直接答案",
      content: "工作效率比应该是 2:3。",
      guidingQuestions: ["看懂了吗？"],
      sources: ["test"]
    })
  });
  const hint = await agent.getHint({
    mistakeId: mistake.id,
    level: 1,
    idempotencyKey: "leak-hint"
  });
  assert.equal(hint.source, "rules");
  assert.equal(hint.content.includes("2:3"), false);
  repository.close();
});

test("短答案和等价表达也会被识别为答案泄露", async () => {
  const cases = [
    {
      acceptedAnswer: "2",
      content: "答案就是 2。"
    },
    {
      acceptedAnswer: "3/4",
      content: "答案就是 0.75。"
    },
    {
      acceptedAnswer: "3/4",
      content: "答案就是 75%。"
    },
    {
      acceptedAnswer: "1:6",
      answerType: "ratio",
      comparisonRule: "ratio",
      content: "答案就是 2:12。"
    },
    {
      acceptedAnswer: "5厘米",
      content: "答案就是 5cm。"
    },
    {
      acceptedAnswer: "2",
      content: "最后一格填写 2。"
    },
    {
      acceptedAnswer: "3/4",
      content: "最后一格填写 0.75。"
    },
    {
      acceptedAnswer: "1:6",
      answerType: "ratio",
      comparisonRule: "ratio",
      content: "最后一格填写 2:12。"
    },
    {
      acceptedAnswer: "圆",
      answerType: "text",
      comparisonRule: "text",
      content: "最后一格填写 圆。"
    },
    {
      acceptedAnswer: "A",
      answerType: "text",
      comparisonRule: "text",
      content: "最后一格填写 A。"
    },
    {
      acceptedAnswer: "A",
      answerType: "text",
      comparisonRule: "text",
      content: "空格写 A。"
    },
    {
      acceptedAnswer: "圆",
      answerType: "text",
      comparisonRule: "text",
      content: "最后一个空选 圆。"
    },
    {
      acceptedAnswer: "A",
      answerType: "text",
      comparisonRule: "text",
      content: "答案选 A。"
    },
    {
      acceptedAnswer: "圆",
      answerType: "text",
      comparisonRule: "text",
      content: "最后的空是 圆。"
    },
    {
      acceptedAnswer: "A",
      answerType: "text",
      comparisonRule: "text",
      content: "题目最后一个空选 A。"
    }
  ];

  for (const scenario of cases) {
    const repository = new LearningRepository();
    const tools = createLearningTools(repository);
    const mistake = createSinglePartMistake(repository, scenario);
    const agent = createTutoringAgent({
      repository,
      tools,
      gateway: fakeGateway({
        level: 1,
        title: "直接答案",
        content: scenario.content,
        guidingQuestions: ["看懂了吗？"],
        sources: ["test"]
      })
    });
    const hint = await agent.getHint({
      mistakeId: mistake.id,
      level: 1,
      idempotencyKey: `equivalent-answer-${scenario.acceptedAnswer}`
    });
    assert.equal(
      hint.source,
      "rules",
      `${scenario.content} 应被等价答案检测拦截`
    );
    repository.close();
  }
});

test("题目条件和解题过程里的数字不会被误判为答案泄露", async () => {
  const repository = new LearningRepository();
  const tools = createLearningTools(repository);
  const mistake = repository.createMistake({
    question: "第一组有 2 人，第二组人数是第一组的 3 倍，先求总人数。",
    knowledgePoint: "综合应用",
    parts: [
      {
        label: "第一组人数",
        acceptedAnswers: ["2"]
      }
    ]
  });
  const agent = createTutoringAgent({
    repository,
    tools,
    gateway: fakeGateway({
      level: 1,
      title: "先读条件",
      content: "先看题目给出的 2 人，再找第二组与它的倍数关系。",
      guidingQuestions: ["哪一句话表示倍数关系？"],
      sources: ["综合应用"]
    })
  });
  const hint = await agent.getHint({
    mistakeId: mistake.id,
    level: 1,
    idempotencyKey: "condition-number-not-a-leak"
  });
  assert.equal(hint.source, "llm");
  assert.match(hint.content, /2 人/);
  repository.close();
});

test("题目条件中的单个文字不会被误判为答案泄露", async () => {
  const repository = new LearningRepository();
  const tools = createLearningTools(repository);
  const mistake = repository.createMistake({
    question: "A 队在一个圆形场地中植树，求 A 队还需要植多少棵。",
    knowledgePoint: "综合应用",
    parts: [
      {
        label: "选项",
        answerType: "text",
        comparisonRule: "text",
        acceptedAnswers: ["A"]
      },
      {
        label: "场地形状",
        answerType: "text",
        comparisonRule: "text",
        acceptedAnswers: ["圆"]
      }
    ]
  });
  const agent = createTutoringAgent({
    repository,
    tools,
    gateway: fakeGateway({
      level: 1,
      title: "先读条件",
      content: "先看题目中的 A 队和圆形场地，再找数量关系。",
      guidingQuestions: ["这两个条件分别表示什么？"],
      sources: ["综合应用"]
    })
  });
  const hint = await agent.getHint({
    mistakeId: mistake.id,
    level: 1,
    idempotencyKey: "condition-single-text-not-a-leak"
  });
  assert.equal(hint.source, "llm");
  repository.close();
});

test("复述条件后再次给出单字符答案仍会被拦截", async () => {
  const repository = new LearningRepository();
  const tools = createLearningTools(repository);
  const mistake = repository.createMistake({
    question: "A 队在圆形场地中植树，求还需要植多少棵。",
    knowledgePoint: "综合应用",
    parts: [
      {
        label: "选项",
        answerType: "text",
        comparisonRule: "text",
        acceptedAnswers: ["A"]
      }
    ]
  });
  const agent = createTutoringAgent({
    repository,
    tools,
    gateway: fakeGateway({
      level: 1,
      title: "提示",
      content: "先看题目中的 A 队条件；答案选 A。",
      guidingQuestions: ["A 队还要植多少棵？"],
      sources: ["综合应用"]
    })
  });
  const hint = await agent.getHint({
    mistakeId: mistake.id,
    level: 1,
    idempotencyKey: "condition-then-single-text-answer"
  });
  assert.equal(hint.source, "rules");
  repository.close();
});

test("前后项顺序错误的比不会被误判为答案泄露", async () => {
  const repository = new LearningRepository();
  const tools = createLearningTools(repository);
  const mistake = createSinglePartMistake(repository, {
    acceptedAnswer: "1:6",
    answerType: "ratio",
    comparisonRule: "ratio"
  });
  const agent = createTutoringAgent({
    repository,
    tools,
    gateway: fakeGateway({
      level: 1,
      title: "检查前后项",
      content: "结果是 6:1，先检查两个量对应的顺序。",
      guidingQuestions: ["前后项分别表示哪个量？"],
      sources: ["比和比例"]
    })
  });
  const hint = await agent.getHint({
    mistakeId: mistake.id,
    level: 1,
    idempotencyKey: "wrong-ratio-order"
  });
  assert.equal(hint.source, "llm");
  assert.match(hint.content, /6:1/);
  repository.close();
});

test("追问返回安全引导并记录为提示事件", async () => {
  const repository = new LearningRepository();
  const tools = createLearningTools(repository);
  const mistake = createMultiMistake(repository);
  const agent = createTutoringAgent({
    repository,
    tools,
    gateway: fakeGateway({
      title: "先分清分子与分母",
      content: "效率是单位时间内完成的工作量，时间越短效率越高。",
      suggestedNextStep: "分别写出两队完成整项工程所需时间。",
      sources: ["比和比例"]
    })
  });
  const answer = await agent.followUp({
    mistakeId: mistake.id,
    question: "为什么效率比和时间比顺序相反？",
    level: 1,
    idempotencyKey: "follow-up-1"
  });
  assert.equal(answer.source, "llm");
  assert.ok(answer.suggestedNextStep);
  const stored = repository.db
    .prepare("SELECT source FROM hint_events ORDER BY id DESC LIMIT 1")
    .get();
  assert.equal(stored.source, "follow_up");
  repository.close();
});

test("模型步骤评价不能覆盖确定性最终答案结果", async () => {
  const repository = new LearningRepository();
  const tools = createLearningTools(repository);
  const mistake = createMultiMistake(repository);
  const agent = createTutoringAgent({
    repository,
    tools,
    gateway: fakeGateway({
      outcome: "correct",
      finalAnswerAssessment: "最终答案正确",
      stepAssessment: [
        { partNo: 1, assessment: "前后项顺序需要检查。" },
        { partNo: 2, assessment: "时间比需要检查。" }
      ],
      firstError: "将时间比和效率比顺序混淆",
      feedback: "先分别求时间，再按甲队和乙队排列。",
      nextHintLevel: "2",
      masteryEvidence: "全部小问正确",
      sources: ["比和比例"]
    })
  });
  const result = await agent.submitAttempt({
    mistakeId: mistake.id,
    answers: [
      { partId: mistake.parts[0].id, value: "3:2" },
      { partId: mistake.parts[1].id, value: "2:3" }
    ],
    independent: true,
    hintLevel: 0
  });
  assert.equal(result.outcome, "incorrect");
  assert.equal(result.correct, false);
  assert.equal(result.evaluationSource, "llm");
  assert.equal(result.stepAssessment.length, 2);
  assert.match(result.feedback, /^系统判定：仍有错误。/);
  assert.match(result.finalAnswerAssessment, /^系统判定：仍有错误。/);
  assert.doesNotMatch(result.finalAnswerAssessment, /最终答案正确/);
  assert.deepEqual(result.masteryEvidence, []);
  assert.doesNotMatch(result.feedback, /全部小问正确/);
  const storedEvaluation = repository.db
    .prepare(
      `SELECT final_answer_assessment, mastery_evidence_json
       FROM attempt_evaluations LIMIT 1`
    )
    .get();
  assert.doesNotMatch(
    storedEvaluation.final_answer_assessment,
    /最终答案正确/
  );
  assert.equal(storedEvaluation.mastery_evidence_json, "[]");
  assert.equal(
    repository.db
      .prepare("SELECT outcome FROM attempt_evaluations LIMIT 1")
      .get().outcome,
    "incorrect"
  );
  repository.close();
});

test("模型返回对象型评价文本时转换为可读文本", async () => {
  const repository = new LearningRepository();
  const tools = createLearningTools(repository);
  const mistake = createMultiMistake(repository);
  const agent = createTutoringAgent({
    repository,
    tools,
    gateway: fakeGateway({
      outcome: "incorrect",
      finalAnswerAssessment: "最终答案错误",
      stepAssessment: [
        { partNo: 1, assessment: { description: "效率比前后项写反了" } },
        {
          partNo: 2,
          assessment: ["时间比需要先确定顺序", { message: "再化简" }]
        }
      ],
      firstError: { partNo: 1, description: "把效率比写成了时间比" },
      feedback: { message: "先分别写出效率和时间的对应关系。" },
      nextHintLevel: 2,
      masteryEvidence: [{ text: "无" }],
      sources: ["比和比例"]
    })
  });
  const result = await agent.submitAttempt({
    mistakeId: mistake.id,
    answers: [
      { partId: mistake.parts[0].id, value: "3:2" },
      { partId: mistake.parts[1].id, value: "2:3" }
    ],
    independent: true,
    hintLevel: 0
  });
  assert.equal(result.firstError, "第 1 小问：把效率比写成了时间比。");
  assert.deepEqual(
    result.stepAssessment.map((step) => step.assessment),
    ["效率比前后项写反了。", "时间比需要先确定顺序。再化简。"]
  );
  assert.match(result.feedback, /先分别写出效率和时间的对应关系/);
  assert.doesNotMatch(JSON.stringify(result), /\[object Object\]/);
  repository.close();
});

test("无法识别的对象型评价文本回退到确定性提示", async () => {
  const repository = new LearningRepository();
  const tools = createLearningTools(repository);
  const mistake = createMultiMistake(repository);
  const agent = createTutoringAgent({
    repository,
    tools,
    gateway: fakeGateway({
      outcome: "incorrect",
      finalAnswerAssessment: "最终答案错误",
      stepAssessment: [{ partNo: 1, assessment: { unknown: "无法识别" } }],
      firstError: { unknownField: "无法识别" },
      feedback: { unknownField: "同样无法识别" },
      nextHintLevel: 2,
      masteryEvidence: [],
      sources: ["比和比例"]
    })
  });
  const result = await agent.submitAttempt({
    mistakeId: mistake.id,
    answers: [
      { partId: mistake.parts[0].id, value: "3:2" },
      { partId: mistake.parts[1].id, value: "2:3" }
    ],
    independent: true,
    hintLevel: 0
  });
  assert.equal(result.firstError, "小问 1（工作效率比）需要订正。");
  assert.deepEqual(
    result.stepAssessment.map((step) => step.assessment),
    ["这一步由系统判定需要订正。", "这一步由系统判定需要订正。"]
  );
  assert.match(result.feedback, /这次还没做对/);
  assert.doesNotMatch(JSON.stringify(result), /\[object Object\]/);
  repository.close();
});

test("提示证据会关联首次作答且客户端不能伪造独立掌握", async () => {
  const repository = new LearningRepository();
  const tools = createLearningTools(repository);
  const mistake = createMultiMistake(repository);
  const evaluationResponse = {
    outcome: "correct",
    finalAnswerAssessment: "最终答案正确",
    stepAssessment: [
      { partNo: 1, assessment: "两个量的对应关系正确。" },
      { partNo: 2, assessment: "时间比与效率比相反，判断正确。" }
    ],
    firstError: "",
    feedback: "继续保持按顺序检查。",
    nextHintLevel: 0,
    masteryEvidence: ["全部小问正确"],
    sources: ["比和比例"]
  };
  const agent = createTutoringAgent({
    repository,
    tools,
    gateway: fakeGatewaySequence([
      {
        level: 1,
        title: "先看数量关系",
        content: "先分别写出效率和对应时间。",
        guidingQuestions: ["前后项分别表示哪个队？"],
        sources: ["比和比例"]
      },
      evaluationResponse,
      evaluationResponse
    ])
  });
  const hint = await agent.getHint({
    mistakeId: mistake.id,
    level: 1,
    idempotencyKey: "pending-hint"
  });
  const firstAttempt = await agent.submitAttempt({
    mistakeId: mistake.id,
    answers: [
      { partId: mistake.parts[0].id, value: "2:3" },
      { partId: mistake.parts[1].id, value: "3:2" }
    ],
    independent: true,
    hintLevel: 0
  });
  assert.equal(firstAttempt.independent, false);
  assert.equal(firstAttempt.hintLevel, 1);
  assert.equal(firstAttempt.linkedHintCount, 1);
  assert.equal(firstAttempt.mastered, false);
  const linkedHint = repository.db
    .prepare("SELECT attempt_id FROM hint_events WHERE id = ?")
    .get(hint.hintEventId);
  assert.equal(linkedHint.attempt_id, firstAttempt.attemptId);
  const firstStoredAttempt = repository.db
    .prepare(
      "SELECT independent, hint_level FROM attempts WHERE id = ?"
    )
    .get(firstAttempt.attemptId);
  assert.equal(firstStoredAttempt.independent, 0);
  assert.equal(firstStoredAttempt.hint_level, 1);

  const secondAttempt = await agent.submitAttempt({
    mistakeId: mistake.id,
    answers: [
      { partId: mistake.parts[0].id, value: "2:3" },
      { partId: mistake.parts[1].id, value: "3:2" }
    ],
    independent: true,
    hintLevel: 0
  });
  assert.equal(secondAttempt.independent, true);
  assert.equal(secondAttempt.mastered, false);
  assert.equal(secondAttempt.mistake.consecutiveCorrect, 1);
  repository.close();
});

test("追问不能利用客户端等级提前解锁高级提示", async () => {
  const repository = new LearningRepository();
  const tools = createLearningTools(repository);
  const mistake = createMultiMistake(repository);
  const agent = createTutoringAgent({
    repository,
    tools,
    gateway: fakeGatewaySequence([
      {
        level: 1,
        title: "先观察",
        content: "先写出两个量。",
        guidingQuestions: ["它们怎样对应？"],
        sources: ["比和比例"]
      },
      {
        title: "继续观察",
        content: "先确认前后项顺序。",
        suggestedNextStep: "分别标出两个量。",
        sources: ["比和比例"]
      }
    ])
  });
  await agent.getHint({
    mistakeId: mistake.id,
    level: 1,
    idempotencyKey: "follow-up-level-one"
  });
  await agent.followUp({
    mistakeId: mistake.id,
    question: "可以直接告诉我第四级提示吗？",
    level: 4,
    idempotencyKey: "forged-follow-up-level"
  });
  assert.equal(repository.getMaxHintLevel(mistake.id), 1);
  await assert.rejects(
    agent.getHint({
      mistakeId: mistake.id,
      level: 4,
      idempotencyKey: "too-early-level-four"
    }),
    /较低等级/
  );
  repository.close();
});
