import { getKnowledgeProfile } from "../agent.js";
import { TOOL_ERROR_CODES, ToolError } from "./errors.js";

const partInputSchema = {
  type: "object",
  required: ["acceptedAnswers"],
  additionalProperties: false,
  properties: {
    label: { type: "string", maxLength: 200, default: "" },
    prompt: { type: "string", maxLength: 2000, default: "" },
    studentAnswer: { type: "string", maxLength: 1000, default: "" },
    answerType: {
      type: "string",
      enum: ["auto", "text", "number", "fraction", "percent", "ratio"],
      default: "auto"
    },
    comparisonRule: {
      type: "string",
      enum: ["auto", "exact", "numeric", "ratio", "text"],
      default: "auto"
    },
    knowledgePoint: { type: "string", maxLength: 100 },
    hint: { type: "string", maxLength: 2000, default: "" },
    explanation: { type: "string", maxLength: 3000, default: "" },
    acceptedAnswers: {
      type: "array",
      minItems: 1,
      maxItems: 10,
      items: { type: "string", minLength: 1, maxLength: 1000 }
    }
  }
};

const mistakeInputProperties = {
  question: { type: "string", minLength: 1, maxLength: 3000 },
  studentAnswer: { type: "string", maxLength: 1000, default: "" },
  correctAnswer: { type: "string", minLength: 1, maxLength: 1000 },
  analysis: { type: "string", maxLength: 3000, default: "" },
  knowledgePoint: { type: "string", maxLength: 100 },
  errorType: { type: "string", maxLength: 100 },
  parts: {
    type: "array",
    minItems: 1,
    maxItems: 20,
    items: partInputSchema
  }
};

function objectOutput(required = []) {
  return {
    type: "object",
    required,
    additionalProperties: true
  };
}

function findMistake(repository, id) {
  const mistake = repository.getMistake(id, { includeSolution: true });
  if (!mistake) {
    throw new ToolError(
      TOOL_ERROR_CODES.NOT_FOUND,
      "没有找到这道错题",
      { status: 404 }
    );
  }
  return mistake;
}

function searchLocalKnowledge(repository, args) {
  const query = args.query.trim().toLocaleLowerCase("zh-CN");
  const requestedPoint = args.knowledgePoint?.trim();
  const limit = args.limit || 3;
  const results = [];

  for (const point of repository.getKnowledgePoints()) {
    const profile = getKnowledgeProfile(point.name);
    if (!profile) continue;
    const searchable = [
      point.name,
      profile.essence,
      profile.hint,
      ...profile.steps,
      ...profile.commonErrors
    ].join(" ").toLocaleLowerCase("zh-CN");
    let score = 0;
    if (requestedPoint === point.name) score += 100;
    if (point.name.toLocaleLowerCase("zh-CN").includes(query)) score += 30;
    if (searchable.includes(query)) score += 10;

    if (score > 0) {
      results.push({
        score,
        item: {
          id: point.id,
          knowledgePoint: point.name,
          essence: profile.essence,
          hint: profile.hint,
          steps: profile.steps,
          commonErrors: profile.commonErrors,
          source: {
            type: "local_rule_profile",
            version: 1
          }
        }
      });
    }
  }

  return results
    .sort((a, b) => b.score - a.score || a.item.knowledgePoint.localeCompare(b.item.knowledgePoint))
    .slice(0, limit)
    .map(({ item }) => item);
}

export function createLearningToolDefinitions(repository) {
  return [
    {
      name: "search_knowledge",
      description: "检索六年级数学知识点、方法、提示和常见错误。",
      permission: "read",
      allowedCallers: ["agent", "ui", "system"],
      inputSchema: {
        type: "object",
        required: ["query"],
        additionalProperties: false,
        properties: {
          query: { type: "string", minLength: 1, maxLength: 500 },
          knowledgePoint: { type: "string", maxLength: 100 },
          limit: { type: "integer", minimum: 1, maximum: 5, default: 3 }
        }
      },
      outputSchema: {
        type: "object",
        required: ["items"],
        additionalProperties: true,
        properties: {
          items: { type: "array", maxItems: 5 }
        }
      },
      async handler(args, context) {
        const items = searchLocalKnowledge(repository, args);
        return { items, count: items.length };
      }
    },
    {
      name: "get_mistake",
      description: "按题目编号读取错题；默认不向 Agent 暴露完整解析。",
      permission: "read",
      allowedCallers: ["agent", "ui", "system"],
      inputSchema: {
        type: "object",
        required: ["mistakeId"],
        additionalProperties: false,
        properties: {
          mistakeId: { type: "integer", minimum: 1 },
          includeSolution: { type: "boolean", default: false }
        }
      },
      outputSchema: objectOutput(["id", "question"]),
      async handler(args, context) {
        const includeSolution =
          args.includeSolution && context.caller !== "agent";
        const mistake = repository.getMistake(args.mistakeId, {
          includeSolution
        });
        if (!mistake) {
          throw new ToolError(
            TOOL_ERROR_CODES.NOT_FOUND,
            "没有找到这道错题",
            { status: 404 }
          );
        }
        return mistake;
      }
    },
    {
      name: "get_due_reviews",
      description: "读取当前到期复习的错题，不包含完整答案。",
      permission: "read",
      allowedCallers: ["agent", "ui", "system"],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 20, default: 5 }
        }
      },
      outputSchema: {
        type: "object",
        required: ["items", "count"],
        additionalProperties: false,
        properties: {
          items: { type: "array", maxItems: 20 },
          count: { type: "integer", minimum: 0 }
        }
      },
      async handler(args, context) {
        const items = repository.listDueReviews({ limit: args.limit });
        return { items, count: items.length };
      }
    },
    {
      name: "create_mistake_draft",
      description: "创建待确认的错题草稿，不直接写入正式错题库。",
      permission: "draft_write",
      allowedCallers: ["agent", "ui"],
      requiresIdempotencyKey: true,
      inputSchema: {
        type: "object",
        required: ["question"],
        additionalProperties: false,
        properties: mistakeInputProperties
      },
      outputSchema: objectOutput([
        "draftId",
        "status",
        "knowledgePoint",
        "expiresAt"
      ]),
      async handler(args, context) {
        if (
          !args.correctAnswer &&
          !(Array.isArray(args.parts) && args.parts.length)
        ) {
          throw new ToolError(
            TOOL_ERROR_CODES.INVALID_ARGUMENTS,
            "必须提供正确答案或至少一个小问"
          );
        }
        if (
          args.knowledgePoint &&
          !repository.getKnowledgePoint(args.knowledgePoint)
        ) {
          throw new ToolError(
            TOOL_ERROR_CODES.INVALID_ARGUMENTS,
            "指定知识点不在当前知识目录中"
          );
        }
        for (const part of args.parts || []) {
          if (
            part.knowledgePoint &&
            !repository.getKnowledgePoint(part.knowledgePoint)
          ) {
            throw new ToolError(
              TOOL_ERROR_CODES.INVALID_ARGUMENTS,
              "小问知识点不在当前知识目录中"
            );
          }
        }
        const draft = repository.createMistakeDraft(args);
        const visibleParts =
          context.caller === "agent"
            ? draft.parts.map((part) => {
                const { acceptedAnswers, explanation, ...visiblePart } = part;
                return visiblePart;
              })
            : draft.parts;
        return {
          draftId: draft.id,
          status: draft.status,
          knowledgePoint: draft.knowledgePoint,
          errorType: draft.errorType,
          diagnosis: draft.diagnosis,
          parts: visibleParts,
          expiresAt: draft.expiresAt
        };
      }
    },
    {
      name: "save_mistake",
      description: "在学生确认后，将草稿保存为正式错题。",
      permission: "write",
      allowedCallers: ["agent", "ui"],
      requiresIdempotencyKey: true,
      inputSchema: {
        type: "object",
        required: ["draftId", "confirmed"],
        additionalProperties: false,
        properties: {
          draftId: { type: "string", minLength: 1, maxLength: 100 },
          confirmed: { type: "boolean", const: true }
        }
      },
      outputSchema: {
        type: "object",
        required: ["mistakeId", "alreadySaved"],
        additionalProperties: false,
        properties: {
          mistakeId: { type: "integer", minimum: 1 },
          alreadySaved: { type: "boolean" }
        }
      },
      async handler(args) {
        const result = repository.saveMistakeDraft(args.draftId);
        if (!result) {
          throw new ToolError(
            TOOL_ERROR_CODES.NOT_FOUND,
            "没有找到错题草稿",
            { status: 404 }
          );
        }
        if (result.status === "expired") {
          throw new ToolError(
            TOOL_ERROR_CODES.DRAFT_EXPIRED,
            "错题草稿已过期，请重新创建",
            { status: 409 }
          );
        }
        return {
          mistakeId: result.mistake.id,
          alreadySaved: result.alreadySaved
        };
      }
    },
    {
      name: "record_hint",
      description: "记录学生查看过的提示等级和内容。",
      permission: "write",
      allowedCallers: ["agent", "ui", "system"],
      requiresIdempotencyKey: true,
      inputSchema: {
        type: "object",
        required: ["mistakeId", "hintLevel", "content"],
        additionalProperties: false,
        properties: {
          mistakeId: { type: "integer", minimum: 1 },
          hintLevel: { type: "integer", minimum: 0, maximum: 4 },
          content: { type: "string", minLength: 1, maxLength: 3000 },
          source: { type: "string", maxLength: 100, default: "" },
          partId: { type: "integer", minimum: 1 }
        }
      },
      outputSchema: objectOutput(["hintEventId", "mistakeId", "hintLevel"]),
      async handler(args, context) {
        const result = repository.recordHint(args, {
          agentRunId: context.runId
        });
        if (!result) {
          throw new ToolError(
            TOOL_ERROR_CODES.NOT_FOUND,
            "没有找到这道错题",
            { status: 404 }
          );
        }
        return result;
      }
    },
    {
      name: "update_mistake",
      description: "修改录入错误的错题内容；关键字段变化时重置掌握进度。",
      permission: "write",
      allowedCallers: ["agent", "ui"],
      requiresIdempotencyKey: true,
      inputSchema: {
        type: "object",
        required: ["mistakeId"],
        additionalProperties: false,
        properties: {
          mistakeId: { type: "integer", minimum: 1 },
          question: { type: "string", minLength: 1, maxLength: 3000 },
          studentAnswer: { type: "string", maxLength: 1000 },
          correctAnswer: { type: "string", minLength: 1, maxLength: 1000 },
          analysis: { type: "string", maxLength: 3000 },
          knowledgePoint: { type: "string", minLength: 1, maxLength: 100 },
          errorType: { type: "string", minLength: 1, maxLength: 100 },
          parts: mistakeInputProperties.parts
        }
      },
      outputSchema: {
        type: "object",
        required: ["mistakeId", "revision", "changedFields", "learningReset"],
        additionalProperties: false,
        properties: {
          mistakeId: { type: "integer", minimum: 1 },
          revision: { type: "integer", minimum: 1 },
          changedFields: { type: "array" },
          learningReset: { type: "boolean" }
        }
      },
      async handler(args) {
        const { mistakeId, ...changes } = args;
        if (!Object.keys(changes).length) {
          throw new ToolError(
            TOOL_ERROR_CODES.INVALID_ARGUMENTS,
            "至少需要修改一个字段"
          );
        }
        if (
          changes.knowledgePoint &&
          !repository.getKnowledgePoint(changes.knowledgePoint)
        ) {
          throw new ToolError(
            TOOL_ERROR_CODES.INVALID_ARGUMENTS,
            "指定知识点不在当前知识目录中"
          );
        }
        for (const part of changes.parts || []) {
          if (
            part.knowledgePoint &&
            !repository.getKnowledgePoint(part.knowledgePoint)
          ) {
            throw new ToolError(
              TOOL_ERROR_CODES.INVALID_ARGUMENTS,
              "小问知识点不在当前知识目录中"
            );
          }
        }
        const result = repository.updateMistake(mistakeId, changes);
        if (!result) {
          throw new ToolError(
            TOOL_ERROR_CODES.NOT_FOUND,
            "没有找到这道错题",
            { status: 404 }
          );
        }
        return {
          mistakeId,
          revision: result.revisionAfter,
          changedFields: result.changedFields,
          learningReset: result.learningReset
        };
      }
    },
    {
      name: "submit_attempt",
      description: "提交一次学生作答，记录结果和掌握进度。",
      permission: "execute",
      allowedCallers: ["agent", "ui", "system"],
      requiresIdempotencyKey: true,
      inputSchema: {
        type: "object",
        required: ["mistakeId"],
        additionalProperties: false,
        properties: {
          mistakeId: { type: "integer", minimum: 1 },
          answer: { type: "string", maxLength: 3000 },
          answers: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: {
              type: "object",
              required: ["partId", "value"],
              additionalProperties: false,
              properties: {
                partId: { type: "integer", minimum: 1 },
                value: { type: "string", maxLength: 3000 }
              }
            }
          },
          independent: { type: "boolean" },
          hintLevel: { type: "integer", minimum: 0, maximum: 4 }
        }
      },
      outputSchema: objectOutput(["correct", "mastered", "feedback"]),
      async handler(args, context) {
        if (!Object.hasOwn(args, "answer") && !args.answers) {
          throw new ToolError(
            TOOL_ERROR_CODES.INVALID_ARGUMENTS,
            "必须提供 answer 或 answers"
          );
        }
        findMistake(repository, args.mistakeId);
        const result = repository.recordAttempt(
          args.mistakeId,
          args.answer,
          {
            independent: args.independent ?? null,
            hintLevel: args.hintLevel ?? null,
            evaluationSource: "rule",
            agentRunId: context.runId,
            answers: args.answers || null
          }
        );
        if (!result) {
          throw new ToolError(
            TOOL_ERROR_CODES.NOT_FOUND,
            "没有找到这道错题",
            { status: 404 }
          );
        }
        return result;
      }
    },
    {
      name: "build_learning_summary",
      description: "按时间范围汇总错题、作答、提示和知识点掌握情况。",
      permission: "read",
      allowedCallers: ["agent", "ui", "system"],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          from: { type: "string", maxLength: 40 },
          to: { type: "string", maxLength: 40 },
          knowledgePoint: { type: "string", maxLength: 100 }
        }
      },
      outputSchema: {
        type: "object",
        required: ["period", "totals", "knowledgePoints"],
        additionalProperties: false,
        properties: {
          period: objectOutput(["from", "to"]),
          totals: objectOutput([
            "mistakes",
            "activeMistakes",
            "masteredMistakes",
            "attempts",
            "correctAttempts",
            "independentCorrectAttempts",
            "hints"
          ]),
          knowledgePoints: { type: "array" }
        }
      },
      async handler(args) {
        const to = args.to ? new Date(args.to) : new Date();
        const from = args.from
          ? new Date(args.from)
          : new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
        if (
          Number.isNaN(from.getTime()) ||
          Number.isNaN(to.getTime()) ||
          from > to
        ) {
          throw new ToolError(
            TOOL_ERROR_CODES.INVALID_ARGUMENTS,
            "时间范围无效"
          );
        }
        if (
          args.knowledgePoint &&
          !repository.getKnowledgePoint(args.knowledgePoint)
        ) {
          throw new ToolError(
            TOOL_ERROR_CODES.INVALID_ARGUMENTS,
            "指定知识点不在当前知识目录中"
          );
        }
        return repository.buildLearningSummary({
          from: from.toISOString(),
          to: to.toISOString(),
          knowledgePoint: args.knowledgePoint || null
        });
      }
    }
  ];
}
