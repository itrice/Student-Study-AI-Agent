import { randomUUID } from "node:crypto";
import {
  ATTEMPT_EVALUATION_PROMPT_VERSION,
  FOLLOW_UP_PROMPT_VERSION,
  HINT_PROMPT_VERSION,
  attemptEvaluationSchema,
  followUpOutputSchema,
  hintOutputSchema
} from "./tutoring-schema.js";
import { validateAndNormalize } from "../tools/schema.js";
import {
  comparePartAnswer,
  evaluatePartResponses,
  validateSubmittedPartAnswers
} from "../domain/part-evaluation.js";

function parseModelJson(content) {
  const text = String(content || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  return JSON.parse(text);
}

function compact(value, length = 1000) {
  const text =
    typeof value === "string" ? value : JSON.stringify(value ?? "");
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

function normalizeSources(value, defaultSources = []) {
  if (!Array.isArray(value)) return [...defaultSources];
  return value
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (!item || typeof item !== "object") return String(item || "").trim();
      return String(
        item.name ||
          item.title ||
          item.knowledgePoint ||
          item.source ||
          compact(item, 200)
      ).trim();
    })
    .filter(Boolean)
    .slice(0, 8);
}

function normalized(value) {
  return String(value || "")
    .replace(/\s+/g, "")
    .replace(/[，。；;：:（）()]/g, "")
    .toLowerCase();
}

function outcomeLabel(outcome) {
  if (outcome === "correct") return "全部正确";
  if (outcome === "partial") return "部分正确";
  return "仍有错误";
}

function deterministicAnswerAssessment(deterministic) {
  const partSummaries = deterministic.results.map(
    (part) =>
      `小问 ${part.partNo}（${part.label}）：${
        part.outcome === "correct" ? "正确" : "需订正"
      }`
  );
  return `系统判定：${outcomeLabel(deterministic.outcome)}。${partSummaries.join(
    "；"
  )}。`;
}

function deterministicStepAssessment(part) {
  return part.outcome === "correct"
    ? "这一步由系统判定正确。"
    : "这一步由系统判定需要订正。";
}

function conflictsWithDeterministicResult(text, correct) {
  const value = String(text || "");
  const correctClaim =
    /(最终答案|整题|全部(?:小问|答案)?|答案|结果|这一步|这一小问|都|均|全对)[^，,。！？；;\n]{0,12}(?:正确|答对|无误)/;
  const incorrectClaim =
    /(最终答案|整题|全部(?:小问|答案)?|答案|结果|这一步|这一小问)[^，,。！？；;\n]{0,12}(?:错误|有误|不正确|不对|需订正|需要订正)|(?:答错|全错|完全错误)/;
  return correct
    ? incorrectClaim.test(value)
    : correctClaim.test(value);
}

function discardConflictingClauses(text, { correct, fallback }) {
  const clauses = String(text || "")
    .split(/[。！？；;\n]+/)
    .map((clause) => clause.trim())
    .filter(Boolean)
    .filter((clause) => !conflictsWithDeterministicResult(clause, correct));
  return clauses.length ? clauses.join("。") + "。" : fallback;
}

const ANSWER_CANDIDATE_PATTERN =
  /(?<![\p{L}\p{N}.])[-−]?\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?%?(?::[-−]?\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?%?)?(?:\s*(?:平方厘米|平方米|厘米|毫米|分米|千米|公里|cm²|m²|cm2|m2|cm|mm|dm|km|m))?(?![\p{L}\p{N}.])/gu;

function extractAnswerCandidates(text) {
  return [
    ...new Set(
      (String(text || "").match(ANSWER_CANDIDATE_PATTERN) || [])
        .map((candidate) => candidate.trim())
        .filter(Boolean)
    )
  ];
}

function hasCompletionContext(text, candidate) {
  const normalizedText = normalized(text);
  const normalizedCandidate = normalized(candidate);
  if (!normalizedCandidate) return false;
  let index = normalizedText.indexOf(normalizedCandidate);
  while (index >= 0) {
    const before = normalizedText.slice(
      Math.max(0, index - 24),
      index
    );
    const after = normalizedText.slice(
      index + normalizedCandidate.length,
      index + normalizedCandidate.length + 8
    );
    const slotNearAnswer =
      /(空格|空位|空|最后一格|格|括号|横线|答案|结果|选项)[^。！？；;\n]{0,8}$/.test(
        before
      );
    const answerAction =
      /(填写|填入|应填|填|写|选|是|为|应为|就是|得到|得数)[^。！？；;\n]{0,4}$/.test(
        before
      );
    const slotDirectlyBeforeAnswer =
      /(空格|空位|空|最后一格|格|括号|横线|答案|结果|选项)$/.test(
        before
      );
    const answerPredicateAfter =
      /^(?:就是|是|为)?(?:正确答案|答案|结果|选项|正确)/.test(after);
    if (
      (slotNearAnswer && answerAction) ||
      slotDirectlyBeforeAnswer ||
      answerPredicateAfter
    ) {
      return true;
    }
    index = normalizedText.indexOf(
      normalizedCandidate,
      index + normalizedCandidate.length
    );
  }
  return false;
}

function hasUnsafeSingleTextMention(text, answer) {
  const normalizedAnswer = normalized(answer);
  if (normalizedAnswer.length !== 1) return false;
  const clauses = String(text || "").split(/[，,。！？；;\n]/);
  for (const clause of clauses) {
    const normalizedClause = normalized(clause);
    let index = normalizedClause.indexOf(normalizedAnswer);
    while (index >= 0) {
      const beforeCharacter = normalizedClause[index - 1] || "";
      const afterCharacter =
        normalizedClause[index + normalizedAnswer.length] || "";
      const standaloneAscii =
        !/^[a-z]$/i.test(normalizedAnswer) ||
        (!/[a-z0-9]/i.test(beforeCharacter) &&
          !/[a-z0-9]/i.test(afterCharacter));
      if (standaloneAscii) {
        const localContext =
          normalizedClause.slice(Math.max(0, index - 12), index) +
          normalizedAnswer +
          normalizedClause.slice(
            index + normalizedAnswer.length,
            index + normalizedAnswer.length + 12
          );
        const referencesQuestion =
          /题目|题干|已知|条件|图中|图示|图形|场地|背景|材料|队伍|队里|给出|说明/.test(
            localContext
          );
        const hasAnswerSlotSemantics =
          /空格|空位|空|最后一格|格|括号|横线|填写|填入|应填|填|写|选|应为|得数|答案|结果|选项/.test(
            localContext
          );
        if (!referencesQuestion || hasAnswerSlotSemantics) return true;
      }
      index = normalizedClause.indexOf(
        normalizedAnswer,
        index + normalizedAnswer.length
      );
    }
  }
  return false;
}

function candidateOccursAsQuestionCondition(
  candidate,
  acceptedAnswer,
  answerType,
  comparisonRule,
  conditionCandidates,
  normalizedConditionText
) {
  const appearsAsCondition = conditionCandidates.some((condition) =>
    comparePartAnswer({
      rawAnswer: condition,
      acceptedAnswers: [acceptedAnswer],
      answerType,
      comparisonRule
    })
  );
  const acceptedText = normalized(acceptedAnswer);
  return (
    appearsAsCondition ||
    (acceptedText.length >= 2 &&
      normalizedConditionText.includes(acceptedText))
  );
}

function leaksAnswer(text, mistake) {
  const haystack = normalized(text);
  const candidates = extractAnswerCandidates(text);
  const conditionText = [
    mistake.question,
    ...(mistake.parts || []).map((part) =>
      [part.label, part.prompt, part.studentAnswer].filter(Boolean).join(" ")
    )
  ]
    .filter(Boolean)
    .join(" ");
  const conditionCandidates = extractAnswerCandidates(conditionText);
  const normalizedConditionText = normalized(conditionText);

  return (mistake.parts || []).some((part) =>
    (part.acceptedAnswers || []).some((answer) => {
      const acceptedText = normalized(answer);
      const directTextLeak =
        acceptedText.length >= 2 &&
        haystack.includes(acceptedText) &&
        (!normalizedConditionText.includes(acceptedText) ||
          hasCompletionContext(text, answer));
      if (directTextLeak) return true;
      const singleTextAnswerLeak =
        acceptedText.length === 1 &&
        !/\d/.test(acceptedText) &&
        hasUnsafeSingleTextMention(text, answer);
      if (singleTextAnswerLeak) return true;
      return candidates.some((candidate) => {
        const matches = comparePartAnswer({
          rawAnswer: candidate,
          acceptedAnswers: [answer],
          answerType: part.answerType,
          comparisonRule: part.comparisonRule
        });
        if (!matches) return false;
        return !candidateOccursAsQuestionCondition(
          candidate,
          answer,
          part.answerType,
          part.comparisonRule,
          conditionCandidates,
          normalizedConditionText
        ) || hasCompletionContext(text, candidate);
      });
    })
  );
}

function fallbackHint(mistake, level, part = null) {
  const titleByLevel = [
    "先观察题目",
    "找出数量关系",
    "补上关键一步",
    "对照思路再试一次"
  ];
  const candidates = [
    part?.hint || mistake.hint,
    part?.explanation || mistake.methodSteps?.[0],
    mistake.methodSteps?.[1],
    mistake.methodSteps?.slice(1).join("；")
  ].filter(Boolean);
  let content =
    candidates[Math.min(level - 1, candidates.length - 1)] ||
    "先把已知条件、问题和需要使用的数量关系分别写出来。";
  if (leaksAnswer(content, mistake)) {
    content = "暂时只提示方法：先重新读题，把已知条件和问题分开，再尝试写出第一步数量关系。";
  }
  return {
    level,
    title: titleByLevel[level - 1],
    content,
    guidingQuestions: [
      "题目最终要求的是什么？",
      "哪两个数量之间存在关系？"
    ],
    sources: ["local_rule_hint"],
    source: "rules"
  };
}

function buildMistakeContext(mistake) {
  return {
    question: mistake.question,
    knowledgePoint: mistake.knowledgePoint,
    errorType: mistake.errorType,
    parts: (mistake.parts || []).map((part) => ({
      partNo: part.partNo,
      label: part.label,
      prompt: part.prompt,
      studentAnswer: part.studentAnswer,
      answerType: part.answerType,
      acceptedAnswers: part.acceptedAnswers
    }))
  };
}

function normalizeHintResponse(raw, requestedLevel, knowledge) {
  const content = String(raw.content || raw.hint || "").trim();
  return {
    level: requestedLevel,
    title: String(raw.title || `提示 ${requestedLevel}`),
    content,
    guidingQuestions: Array.isArray(raw.guidingQuestions)
      ? raw.guidingQuestions
          .map(String)
          .filter(Boolean)
          .slice(0, 3)
      : raw.question
        ? [String(raw.question)]
        : ["先说说你准备从哪一步开始？"],
    sources: normalizeSources(
      raw.sources,
      knowledge.items.map((item) => item.knowledgePoint)
    )
  };
}

export class TutoringAgent {
  constructor({ repository, tools, gateway }) {
    this.repository = repository;
    this.tools = tools;
    this.gateway = gateway;
  }

  async getHint({ mistakeId, level, partId = null, idempotencyKey }) {
    const mistake = this.repository.getMistake(mistakeId, {
      includeSolution: true
    });
    if (!mistake) {
      throw new Error("没有找到这道错题");
    }
    const part = partId
      ? (mistake.parts || []).find((item) => item.id === partId)
      : null;
    if (partId && !part) throw new Error("小问不属于当前错题");
    const maxLevel = this.repository.getMaxHintLevel(mistakeId, partId);
    if (level > maxLevel + 1) {
      throw new Error("请先查看较低等级的提示");
    }
    const runId = this.repository.createAgentRun({
      taskType: "generate_hint",
      goal: `生成第 ${level} 级提示`
    });
    const knowledge = await this.tools.invoke(
      "search_knowledge",
      {
        query: `${mistake.question} ${part?.label || ""}`.trim(),
        knowledgePoint: part?.knowledgePoint || mistake.knowledgePoint,
        limit: 3
      },
      { caller: "agent", runId }
    );

    let hint;
    let response = null;
    try {
      response = await this.gateway.chat({
        messages: [
          {
            role: "system",
            content:
              "你是六年级数学提示 Agent。题目与答案仅供你判断，不得在回复中输出任何标准答案。" +
              "只提供当前等级需要的信息，用启发式问题引导，不替代学生完成整题。" +
              "返回 JSON：level, title, content, guidingQuestions（字符串数组）, sources。"
          },
          {
            role: "user",
            content: JSON.stringify({
              requestedLevel: level,
              focusPart: part?.partNo || null,
              mistake: buildMistakeContext(mistake),
              retrievedKnowledge: knowledge.items,
              rule:
                "1级只提示观察；2级提示数量关系；3级提示下一步；4级只补最关键的步骤，仍不得写最终答案。"
            })
          }
        ],
        tools: [],
        temperature: 0.3
      });
      this.repository.recordLlmCall({
        runId,
        provider: response.provider,
        model: response.model,
        promptVersion: HINT_PROMPT_VERSION,
        inputSummary: compact(mistake.question),
        outputSummary: compact(response.message.content),
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        latencyMs: response.latencyMs,
        status: "succeeded"
      });
      const raw = normalizeHintResponse(
        parseModelJson(response.message.content),
        level,
        knowledge
      );
      hint = validateAndNormalize(raw, hintOutputSchema);
      hint.level = level;
      hint.source = "llm";
      if (leaksAnswer(JSON.stringify(hint), mistake)) {
        throw new Error("ANSWER_LEAK_BLOCKED");
      }
    } catch (error) {
      this.repository.recordLlmCall({
        runId,
        provider: this.gateway.provider,
        model: this.gateway.model,
        promptVersion: HINT_PROMPT_VERSION,
        inputSummary: compact(mistake.question),
        status: "failed",
        errorMessage: `${error.code || "HINT_ERROR"}: ${error.message}`
      });
      hint = fallbackHint(mistake, level, part);
    }

    const recorded = await this.tools.invoke(
      "record_hint",
      {
        mistakeId,
        partId: partId || undefined,
        hintLevel: level,
        content: `${hint.title}：${hint.content}`,
        source: hint.source
      },
      {
        caller: "agent",
        runId,
        idempotencyKey: idempotencyKey || randomUUID()
      }
    );
    this.repository.finishAgentRun(runId, { status: "completed" });
    return {
      ...hint,
      hintEventId: recorded.hintEventId,
      provider: hint.source === "llm" ? response.provider : "rules",
      model: hint.source === "llm" ? response.model : "",
      promptVersion: hint.source === "llm" ? HINT_PROMPT_VERSION : "",
      agentRunId: runId
    };
  }

  async followUp({
    mistakeId,
    question,
    partId = null,
    idempotencyKey
  }) {
    const mistake = this.repository.getMistake(mistakeId, {
      includeSolution: true
    });
    if (!mistake) throw new Error("没有找到这道错题");
    const part = partId
      ? (mistake.parts || []).find((item) => item.id === partId)
      : null;
    if (partId && !part) throw new Error("小问不属于当前错题");
    const currentLevel = this.repository.getMaxHintLevel(
      mistakeId,
      partId
    );
    const runId = this.repository.createAgentRun({
      taskType: "answer_follow_up",
      goal: "回答学生复习中的追问"
    });
    const knowledge = await this.tools.invoke(
      "search_knowledge",
      {
        query: `${question} ${mistake.knowledgePoint}`,
        knowledgePoint: part?.knowledgePoint || mistake.knowledgePoint,
        limit: 3
      },
      { caller: "agent", runId }
    );

    let answer;
    let response = null;
    try {
      response = await this.gateway.chat({
        messages: [
          {
            role: "system",
            content:
              "你是六年级数学辅导 Agent。回答学生的追问，但不得输出当前题目的标准答案或最终结果。" +
              "回答要短，最后给出一个学生可以立即执行的下一步。返回 JSON：title, content, suggestedNextStep, sources。"
          },
          {
            role: "user",
            content: JSON.stringify({
              studentQuestion: question,
              currentHintLevel: currentLevel,
              focusPart: part?.partNo || null,
              mistake: buildMistakeContext(mistake),
              retrievedKnowledge: knowledge.items
            })
          }
        ],
        tools: [],
        temperature: 0.3
      });
      this.repository.recordLlmCall({
        runId,
        provider: response.provider,
        model: response.model,
        promptVersion: FOLLOW_UP_PROMPT_VERSION,
        inputSummary: compact(question),
        outputSummary: compact(response.message.content),
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        latencyMs: response.latencyMs,
        status: "succeeded"
      });
      const raw = parseModelJson(response.message.content);
      answer = {
        title: String(raw.title || "继续想一想"),
        content: String(raw.content || ""),
        suggestedNextStep: String(raw.suggestedNextStep || "先写出第一步数量关系。"),
        sources: normalizeSources(
          raw.sources,
          knowledge.items.map((item) => item.knowledgePoint)
        )
      };
      answer = validateAndNormalize(answer, followUpOutputSchema);
      answer.source = "llm";
      if (leaksAnswer(JSON.stringify(answer), mistake)) {
        throw new Error("ANSWER_LEAK_BLOCKED");
      }
    } catch (error) {
      this.repository.recordLlmCall({
        runId,
        provider: this.gateway.provider,
        model: this.gateway.model,
        promptVersion: FOLLOW_UP_PROMPT_VERSION,
        inputSummary: compact(question),
        status: "failed",
        errorMessage: `${error.code || "FOLLOW_UP_ERROR"}: ${error.message}`
      });
      answer = {
        title: "先回到题目关系",
        content:
          "这一步先不急着算结果。把已知条件和要求分别写出来，再找它们之间的数量关系。",
        suggestedNextStep: "写下你认为最关键的一个数量关系。",
        sources: ["local_rule_hint"],
        source: "rules"
      };
    }
    await this.tools.invoke(
      "record_hint",
      {
        mistakeId,
        partId: partId || undefined,
        hintLevel: currentLevel,
        content: `${answer.title}：${answer.content}`,
        source: "follow_up"
      },
      {
        caller: "agent",
        runId,
        idempotencyKey: idempotencyKey || randomUUID()
      }
    );
    this.repository.finishAgentRun(runId, { status: "completed" });
    return {
      ...answer,
      provider: answer.source === "llm" ? response.provider : "rules",
      model: answer.source === "llm" ? response.model : "",
      promptVersion: answer.source === "llm" ? FOLLOW_UP_PROMPT_VERSION : "",
      agentRunId: runId
    };
  }

  async submitAttempt({
    mistakeId,
    answers,
    answer = "",
    independent = null,
    hintLevel = 0
  }) {
    const mistake = this.repository.getMistake(mistakeId, {
      includeSolution: true
    });
    if (!mistake) throw new Error("没有找到这道错题");
    const submitted = answers?.length
      ? answers
      : [{ partNo: 1, value: answer }];
    validateSubmittedPartAnswers(mistake.parts || [], answers);
    const deterministic = evaluatePartResponses(
      mistake.parts || [],
      submitted
    );
    const runId = this.repository.createAgentRun({
      taskType: "evaluate_attempt",
      goal: "评价学生作答并给出步骤反馈"
    });
    const result = this.repository.recordAttempt(mistakeId, answer, {
      answers,
      independent,
      hintLevel,
      evaluationSource: "hybrid",
      agentRunId: runId
    });

    let evaluation;
    let response = null;
    try {
      const knowledge = await this.tools.invoke(
        "search_knowledge",
        {
          query: mistake.question,
          knowledgePoint: mistake.knowledgePoint,
          limit: 2
        },
        { caller: "agent", runId }
      );
      response = await this.gateway.chat({
        messages: [
          {
            role: "system",
            content:
              "你是六年级数学作答评价 Agent。最终答案正误已经由确定性系统判定，你只能分析步骤，不得推翻。" +
              "返回 JSON：outcome, finalAnswerAssessment, stepAssessment（{partNo,assessment}数组）, firstError, feedback, nextHintLevel, masteryEvidence, sources。"
          },
          {
            role: "user",
            content: JSON.stringify({
              mistake: buildMistakeContext(mistake),
              submittedAnswers: submitted,
              deterministicOutcome: deterministic.outcome,
              deterministicPartResults: deterministic.results,
              retrievedKnowledge: knowledge.items
            })
          }
        ],
        tools: [],
        temperature: 0.1
      });
      this.repository.recordLlmCall({
        runId,
        provider: response.provider,
        model: response.model,
        promptVersion: ATTEMPT_EVALUATION_PROMPT_VERSION,
        inputSummary: compact(submitted),
        outputSummary: compact(response.message.content),
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        latencyMs: response.latencyMs,
        status: "succeeded"
      });
      const raw = parseModelJson(response.message.content);
      const parsedHintLevel = Number.parseInt(
        String(raw.nextHintLevel ?? hintLevel ?? 0),
        10
      );
      const rawMasteryEvidence = Array.isArray(raw.masteryEvidence)
        ? raw.masteryEvidence.map(String).filter(Boolean).slice(0, 10)
        : raw.masteryEvidence
          ? [String(raw.masteryEvidence)]
          : [];
      const masteryEvidence = deterministic.allCorrect
        ? rawMasteryEvidence.filter(
            (evidence) =>
              !conflictsWithDeterministicResult(evidence, true)
          )
        : [];
      if (deterministic.allCorrect && !masteryEvidence.length) {
        masteryEvidence.push("全部小问由确定性系统判定正确。");
      }
      const sources = normalizeSources(
        Array.isArray(raw.sources) ? raw.sources : [raw.sources].filter(Boolean),
        knowledge.items.map((item) => item.knowledgePoint)
      );
      const modelStepByPartNo = new Map(
        (Array.isArray(raw.stepAssessment) ? raw.stepAssessment : [])
          .map((step) => [Number(step?.partNo), String(step?.assessment || "")])
      );
      const stepAssessment = deterministic.results.map((part) => ({
        partNo: part.partNo,
        assessment: discardConflictingClauses(
          modelStepByPartNo.get(part.partNo),
          {
            correct: part.outcome === "correct",
            fallback: deterministicStepAssessment(part)
          }
        )
      }));
      const firstIncorrect = deterministic.results.find(
        (part) => part.outcome !== "correct"
      );
      const fallbackFirstError = firstIncorrect
        ? `小问 ${firstIncorrect.partNo}（${firstIncorrect.label}）需要订正。`
        : "";
      const firstError = deterministic.allCorrect
        ? ""
        : discardConflictingClauses(raw.firstError, {
            correct: false,
            fallback: fallbackFirstError
          });
      const safeModelFeedback = discardConflictingClauses(raw.feedback, {
        correct: deterministic.allCorrect,
        fallback: result.feedback
      });
      evaluation = validateAndNormalize(
        {
          outcome: deterministic.outcome,
          finalAnswerAssessment:
            deterministicAnswerAssessment(deterministic),
          stepAssessment,
          firstError,
          feedback:
            `系统判定：${outcomeLabel(deterministic.outcome)}。` +
            safeModelFeedback,
          nextHintLevel: deterministic.allCorrect
            ? 0
            : Number.isInteger(parsedHintLevel)
              ? Math.max(1, Math.min(4, parsedHintLevel))
              : 1,
          masteryEvidence,
          sources
        },
        attemptEvaluationSchema
      );
      evaluation.source = "llm";
    } catch (error) {
      this.repository.recordLlmCall({
        runId,
        provider: this.gateway.provider,
        model: this.gateway.model,
        promptVersion: ATTEMPT_EVALUATION_PROMPT_VERSION,
        inputSummary: compact(submitted),
        status: "failed",
        errorMessage: `${error.code || "EVALUATION_ERROR"}: ${error.message}`
      });
      evaluation = validateAndNormalize(
        {
          outcome: deterministic.outcome,
          finalAnswerAssessment:
            deterministicAnswerAssessment(deterministic),
          stepAssessment: deterministic.results.map((part) => ({
            partNo: part.partNo,
            assessment: deterministicStepAssessment(part)
          })),
          firstError: deterministic.allCorrect
            ? ""
            : `小问 ${
                deterministic.results.find(
                  (part) => part.outcome !== "correct"
                )?.partNo || 1
              } 需要订正。`,
          feedback: result.feedback,
          nextHintLevel: deterministic.allCorrect ? 0 : 1,
          masteryEvidence: deterministic.allCorrect
            ? ["全部小问由确定性系统判定正确。"]
            : [],
          sources: ["deterministic_evaluator"]
        },
        attemptEvaluationSchema
      );
      evaluation.source = "rules";
    }

    this.repository.saveAttemptEvaluation({
      attemptId: result.attemptId,
      outcome: deterministic.outcome,
      finalAnswerAssessment: evaluation.finalAnswerAssessment,
      stepAssessment: evaluation.stepAssessment,
      firstError: evaluation.firstError,
      feedback: evaluation.feedback,
      nextHintLevel: evaluation.nextHintLevel,
      masteryEvidence: evaluation.masteryEvidence,
      sources: evaluation.sources,
      provider:
        evaluation.source === "llm" ? response.provider : "rules",
      model: evaluation.source === "llm" ? response.model : "",
      promptVersion:
        evaluation.source === "llm"
          ? ATTEMPT_EVALUATION_PROMPT_VERSION
          : ""
    });
    this.repository.finishAgentRun(runId, { status: "completed" });
    return {
      ...result,
      outcome: deterministic.outcome,
      feedback: evaluation.feedback,
      finalAnswerAssessment: evaluation.finalAnswerAssessment,
      stepAssessment: evaluation.stepAssessment,
      firstError: evaluation.firstError,
      masteryEvidence: evaluation.masteryEvidence,
      evaluationSource: evaluation.source,
      provider:
        evaluation.source === "llm" ? response.provider : "rules",
      model: evaluation.source === "llm" ? response.model : "",
      agentRunId: runId
    };
  }
}

export function createTutoringAgent({ repository, tools, gateway }) {
  return new TutoringAgent({ repository, tools, gateway });
}
