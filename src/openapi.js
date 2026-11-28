/**
 * OpenAPI 3.1 contract for the learning-data HTTP API.
 *
 * The document is generated per request so the advertised server origin
 * matches the deployment that served it, including reverse proxies.
 */

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });

const anyOfNullable = (schema) => ({ anyOf: [schema, { type: "null" }] });

const jsonContent = (schema, example) => ({
  content: {
    "application/json": {
      schema,
      ...(example === undefined ? {} : { example })
    }
  }
});

const jsonResponse = (description, schema, example) => ({
  description,
  ...jsonContent(schema, example)
});

const errorResponse = (description, example) =>
  jsonResponse(description, ref("Error"), example);

const binaryResponse = (description, mimeType) => ({
  description,
  content: {
    [mimeType]: {
      schema: { type: "string", format: "binary" }
    }
  }
});

const requestBody = (
  schema,
  {
    description = "请求体",
    required = true,
    example,
    contentType = "application/json"
  } = {}
) => ({
  required,
  description,
  content: {
    [contentType]: {
      schema,
      ...(example === undefined ? {} : { example })
    }
  }
});

const idParameter = (description = "资源编号") => ({
  name: "id",
  in: "path",
  required: true,
  description,
  schema: { type: "integer", minimum: 1 }
});

const mistakeIdPathParameter = {
  name: "mistakeId",
  in: "path",
  required: true,
  description: "错题编号",
  schema: { type: "integer", minimum: 1 }
};

const idempotencyKeyParameter = (
  description = "幂等键；同一键重复提交返回首次结果"
) => ({
  name: "Idempotency-Key",
  in: "header",
  required: true,
  description,
  schema: { type: "string", minLength: 1, maxLength: 200 }
});

const errorSchema = {
  type: "object",
  required: ["error"],
  properties: {
    error: { type: "string", description: "可直接展示给调用方的错误说明" },
    code: {
      type: ["string", "null"],
      description: "稳定错误码；路由不存在时为 ROUTE_NOT_FOUND"
    }
  },
  additionalProperties: true,
  example: { error: "没有找到这道错题", code: "MISTAKE_NOT_FOUND" }
};

const attachmentCropSchema = {
  type: "object",
  properties: {
    x: { type: "integer", minimum: 0 },
    y: { type: "integer", minimum: 0 },
    width: { type: "integer", minimum: 1 },
    height: { type: "integer", minimum: 1 },
    rotation: { type: "integer", enum: [0, 90, 180, 270] },
    sourceWidth: { type: "integer", minimum: 1 },
    sourceHeight: { type: "integer", minimum: 1 },
    updatedAt: { type: "string", format: "date-time" }
  },
  additionalProperties: true
};

const attachmentSchema = {
  type: "object",
  required: [
    "id",
    "kind",
    "mimeType",
    "byteSize",
    "width",
    "height",
    "url",
    "hasCrop",
    "createdAt"
  ],
  properties: {
    id: { type: "integer", minimum: 1 },
    kind: {
      type: "string",
      enum: ["question", "part", "draft", "answer"],
      description: "图片用途"
    },
    mimeType: {
      type: "string",
      enum: ["image/jpeg", "image/png", "image/webp"]
    },
    byteSize: { type: "integer", minimum: 1 },
    width: { type: "integer", minimum: 1 },
    height: { type: "integer", minimum: 1 },
    url: { type: "string", description: "兼容字段；默认读取展示图" },
    displayUrl: {
      type: "string",
      description: "带缓存版本号的展示地址；有裁剪时指向裁剪图"
    },
    originalUrl: { type: "string", description: "原图读取地址" },
    hasCrop: { type: "boolean" },
    crop: { anyOf: [attachmentCropSchema, { type: "null" }] },
    createdAt: { type: "string", format: "date-time" }
  },
  additionalProperties: false,
  example: {
    id: 12,
    kind: "question",
    mimeType: "image/jpeg",
    byteSize: 348210,
    width: 1600,
    height: 1200,
    url: "/api/attachments/12",
    displayUrl: "/api/attachments/12?variant=original&v=2026-11-17T08%3A00%3A00.000Z",
    originalUrl: "/api/attachments/12?variant=original",
    hasCrop: false,
    crop: null,
    createdAt: "2026-11-17T08:00:00.000Z"
  }
};

const mistakePartInputSchema = {
  type: "object",
  required: ["acceptedAnswers"],
  properties: {
    label: { type: "string", maxLength: 200, description: "小问标签，如“（1）”" },
    prompt: { type: "string", maxLength: 2000, description: "小问题干" },
    studentAnswer: { type: "string", maxLength: 1000 },
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
    hint: { type: "string", maxLength: 2000 },
    explanation: { type: "string", maxLength: 3000 },
    acceptedAnswers: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: { type: "string", minLength: 1, maxLength: 1000 },
      description: "可接受的正确答案变体；保存时至少一个"
    }
  },
  additionalProperties: false
};

const mistakePartSchema = {
  type: "object",
  properties: {
    id: { type: "integer" },
    partNo: { type: "integer", minimum: 1 },
    label: { type: "string" },
    prompt: { type: "string" },
    studentAnswer: { type: "string" },
    answerType: { type: "string" },
    comparisonRule: { type: "string" },
    knowledgePoint: { type: "string" },
    hint: { type: "string", description: "仅带解答权限的读取返回" },
    explanation: { type: "string", description: "仅带解答权限的读取返回" },
    acceptedAnswers: {
      type: "array",
      items: { type: "string" },
      description: "仅带解答权限的读取返回"
    }
  },
  additionalProperties: true
};

const mistakeSchema = {
  type: "object",
  required: ["id", "question", "status", "revision", "createdAt", "updatedAt"],
  properties: {
    id: { type: "integer", minimum: 1 },
    question: { type: "string", description: "题目文字；纯图片题可能为空" },
    studentAnswer: { type: "string", description: "原始作答" },
    knowledgePoint: { type: "string" },
    textbookId: { type: ["integer", "null"] },
    curriculumPointId: { type: ["integer", "null"] },
    curriculumStatus: {
      type: "string",
      enum: ["mapped", "unmapped", "legacy"],
      description: "当前教材映射状态"
    },
    errorType: { type: "string" },
    revision: {
      type: "integer",
      minimum: 1,
      description: "内容修订号，修改题目会增加"
    },
    status: {
      type: "string",
      enum: ["new", "practicing", "relearning", "mastered"]
    },
    consecutiveCorrect: { type: "integer", minimum: 0 },
    attemptCount: { type: "integer", minimum: 0 },
    dueAt: { type: ["string", "null"], format: "date-time" },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
    lastReviewedAt: { type: ["string", "null"], format: "date-time" },
    correctAnswer: {
      type: "string",
      description: "仅创建、修改或编辑会话读取返回"
    },
    analysis: {
      type: "string",
      description: "仅创建、修改或编辑会话读取返回"
    },
    hint: { type: "string", description: "仅创建、修改或编辑会话读取返回" },
    methodSteps: {
      type: "array",
      items: { type: "string" },
      description: "仅创建、修改或编辑会话读取返回"
    },
    commonErrors: {
      type: "array",
      items: { type: "string" },
      description: "仅创建、修改或编辑会话读取返回"
    },
    diagnosis: {
      type: "string",
      description: "仅创建、修改或编辑会话读取返回"
    },
    parts: { type: "array", items: ref("MistakePart") },
    partCount: { type: "integer", minimum: 0 },
    attachments: { type: "array", items: ref("Attachment") },
    reviewSessionId: {
      type: "string",
      description: "创建错题、复习下一题和复习详情接口返回的会话编号"
    }
  },
  additionalProperties: true,
  example: {
    id: 1,
    question: "一件商品原价 240 元，先涨价 20%，再降价 20%。现在的价格是多少元？",
    studentAnswer: "240元",
    knowledgePoint: "百分数",
    textbookId: 1,
    curriculumPointId: 7,
    curriculumStatus: "mapped",
    errorType: "单位“1”找错",
    revision: 1,
    status: "new",
    consecutiveCorrect: 0,
    attemptCount: 0,
    dueAt: "2026-11-17T07:19:04.22Z",
    createdAt: "2026-11-17T07:19:04.22Z",
    updatedAt: "2026-11-17T07:19:04.22Z",
    lastReviewedAt: null,
    parts: [
      {
        id: 1,
        partNo: 1,
        label: "",
        prompt: "",
        studentAnswer: "240元",
        answerType: "auto",
        comparisonRule: "auto",
        knowledgePoint: "百分数"
      }
    ],
    partCount: 1,
    attachments: []
  }
};

const diagnosisSchema = {
  type: "object",
  description:
    "诊断结果。source 为 rules 时表示本地可解释规则降级，不代表外部模型调用成功。",
  properties: {
    knowledgePoint: { type: "string" },
    errorType: { type: "string" },
    errorStep: { type: "string" },
    missingConcept: { type: "string" },
    initialHint: { type: "string" },
    hint: { type: "string" },
    confidence: { type: ["number", "null"], minimum: 0, maximum: 1 },
    evidence: { type: "array", items: { type: "string" } },
    knowledgeSources: { type: "array", items: { type: "string" } },
    partAnalyses: {
      type: "array",
      items: { type: "object", additionalProperties: true }
    },
    diagnosis: { type: "string" },
    methodSteps: { type: "array", items: { type: "string" } },
    commonErrors: { type: "array", items: { type: "string" } },
    source: { type: "string", enum: ["llm", "rules"] },
    fallbackReason: { type: ["string", "null"] },
    provider: { type: "string" },
    model: { type: "string" },
    promptVersion: { type: "string" },
    agentRunId: { type: ["integer", "null"] },
    contextHash: {
      type: "string",
      description:
        "POST /api/diagnose 返回；保存错题时通过 diagnosis.contextHash 绑定题目"
    }
  },
  additionalProperties: true,
  example: {
    knowledgePoint: "百分数",
    errorType: "计算或关系判断错误",
    initialHint: "先把“谁比谁多或少百分之几”改写成数量关系。",
    hint: "先把“谁比谁多或少百分之几”改写成数量关系。",
    confidence: 0.5,
    evidence: ["使用本地可解释规则进行降级诊断。"],
    knowledgeSources: [],
    diagnosis: "初步归因：计算或关系判断错误。",
    methodSteps: ["圈出单位“1”，标出对应量和比较量。"],
    commonErrors: ["单位“1”找错"],
    source: "rules",
    provider: "rules",
    model: "",
    promptVersion: "",
    agentRunId: 1,
    contextHash:
      "c451397681a0a0212026d4afc1e3b8630d6da198f57f7f075b8330279d1bc19f"
  }
};

const attemptResultSchema = {
  type: "object",
  required: ["attemptId", "correct", "outcome", "nextStatus"],
  properties: {
    attemptId: { type: "integer", minimum: 1 },
    independent: { type: ["boolean", "null"] },
    hintLevel: { type: "integer", minimum: 0, maximum: 4 },
    linkedHintCount: { type: "integer", minimum: 0 },
    correct: { type: "boolean" },
    mastered: { type: "boolean" },
    previousStatus: { type: "string" },
    nextStatus: { type: "string" },
    statusChanged: { type: "boolean" },
    evidenceType: { type: "string" },
    intervalDays: { type: "integer", minimum: 0 },
    reviewReason: { type: "string" },
    reviewScheduleId: { type: "integer" },
    feedback: { type: "string" },
    answer: { type: "string", description: "正确答案" },
    analysis: { type: "string" },
    hint: { type: "string" },
    methodSteps: { type: "array", items: { type: "string" } },
    commonErrors: { type: "array", items: { type: "string" } },
    diagnosis: { type: "string" },
    nextReviewAt: { type: "string", format: "date-time" },
    policyVersion: { type: "string" },
    independentEvidence: { type: "boolean" },
    usedHint: { type: "boolean" },
    partResults: {
      type: "array",
      items: {
        type: "object",
        properties: {
          partId: { type: "integer" },
          partNo: { type: "integer" },
          label: { type: "string" },
          prompt: { type: "string" },
          rawAnswer: { type: "string" },
          outcome: {
            type: "string",
            enum: ["correct", "partial", "incorrect"]
          },
          acceptedAnswers: { type: "array", items: { type: "string" } }
        },
        additionalProperties: true
      }
    },
    correctPartCount: { type: "integer", minimum: 0 },
    totalPartCount: { type: "integer", minimum: 0 },
    outcome: { type: "string", enum: ["correct", "partial", "incorrect"] },
    mistake: ref("Mistake"),
    finalAnswerAssessment: { type: "string" },
    stepAssessment: {
      type: "array",
      items: { type: "object", additionalProperties: true }
    },
    firstError: { type: "string" },
    masteryEvidence: { type: "array", items: { type: "string" } },
    evaluationSource: { type: "string" },
    provider: { type: "string" },
    model: { type: "string" },
    agentRunId: { type: ["integer", "null"] }
  },
  additionalProperties: true
};

const hintResultSchema = {
  type: "object",
  required: ["level", "title", "content"],
  properties: {
    level: { type: "integer", minimum: 1, maximum: 4 },
    title: { type: "string" },
    content: { type: "string" },
    guidingQuestions: { type: "array", items: { type: "string" } },
    sources: { type: "array", items: { type: "string" } },
    source: { type: "string" },
    hintEventId: { type: "integer" },
    provider: { type: "string" },
    model: { type: "string" },
    promptVersion: { type: "string" },
    agentRunId: { type: ["integer", "null"] }
  },
  additionalProperties: true,
  example: {
    level: 1,
    title: "先观察题目",
    content: "先把“谁比谁多或少百分之几”改写成数量关系。",
    guidingQuestions: ["题目最终要求的是什么？", "哪两个数量之间存在关系？"],
    sources: ["local_rule_hint"],
    source: "rules",
    hintEventId: 1,
    provider: "rules",
    model: "",
    promptVersion: "",
    agentRunId: 3
  }
};

const followUpResultSchema = {
  type: "object",
  required: ["title", "content"],
  properties: {
    title: { type: "string" },
    content: { type: "string" },
    suggestedNextStep: { type: "string" },
    sources: { type: "array", items: { type: "string" } },
    source: { type: "string" },
    provider: { type: "string" },
    model: { type: "string" },
    promptVersion: { type: "string" },
    agentRunId: { type: ["integer", "null"] }
  },
  additionalProperties: true
};

const textbookSchema = {
  type: "object",
  required: ["id", "textbookKey", "editionKey", "displayName", "selectable"],
  properties: {
    id: { type: "integer", minimum: 1 },
    textbookKey: { type: "string" },
    editionKey: { type: "string", examples: ["renjiao", "beishida-2024"] },
    publisher: { type: "string" },
    edition: { type: "string" },
    grade: { type: "integer" },
    semester: { type: "string", enum: ["upper", "lower", "full"] },
    displayName: { type: "string" },
    selectable: { type: "boolean" },
    reviewStatus: { type: "string" },
    sourceKey: { type: "string" },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" }
  },
  additionalProperties: true
};

const studentSchema = {
  type: "object",
  required: ["id", "name", "grade"],
  properties: {
    id: { type: "integer", minimum: 1 },
    name: { type: "string" },
    grade: { type: "integer" },
    textbookId: { type: ["integer", "null"] },
    textbookSelectedAt: { type: ["string", "null"], format: "date-time" },
    textbook: { anyOf: [ref("Textbook"), { type: "null" }] }
  },
  additionalProperties: true
};

const curriculumPointSchema = {
  type: "object",
  required: ["id", "textbookId", "unitId", "name", "slug"],
  properties: {
    id: { type: "integer", minimum: 1 },
    textbookId: { type: "integer", minimum: 1 },
    unitId: { type: "integer", minimum: 1 },
    unitNo: { type: "integer" },
    unitTitle: { type: "string" },
    teachingUnitNo: { type: ["integer", "null"] },
    name: { type: "string" },
    slug: { type: "string" },
    aliases: { type: "array", items: { type: "string" } },
    semanticKeys: { type: "array", items: { type: "string" } },
    sourceKnowledgeSlug: { type: "string" },
    position: { type: "integer" },
    reviewStatus: { type: "string" },
    sourceKey: { type: "string" },
    contentVersion: { type: "string" },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" }
  },
  additionalProperties: true
};

const curriculumSchema = {
  type: "object",
  properties: {
    student: ref("Student"),
    currentTextbook: anyOfNullable(ref("Textbook")),
    textbooks: { type: "array", items: ref("Textbook") },
    allTextbooks: { type: "array", items: ref("Textbook") },
    mappingVersion: { type: "string" },
    units: { type: "array", items: { type: "object", additionalProperties: true } },
    knowledgePoints: {
      type: "array",
      items: ref("CurriculumPoint")
    }
  },
  additionalProperties: true
};

const bootstrapSchema = {
  type: "object",
  properties: {
    student: ref("Student"),
    knowledgePoints: { type: "array", items: ref("CurriculumPoint") },
    currentTextbook: anyOfNullable(ref("Textbook")),
    textbooks: { type: "array", items: ref("Textbook") },
    mappingVersion: { type: "string" }
  },
  additionalProperties: true
};

const curriculumSwitchPreviewSchema = {
  type: "object",
  description:
    "教材切换预演结果。confirm 前不写入数据；previewToken 用于执行阶段校验预演是否过期。",
  required: ["previewToken", "mappingVersion", "summary", "items"],
  properties: {
    previewToken: { type: "string" },
    alreadyCurrent: { type: "boolean" },
    mappingVersion: { type: "string" },
    student: { type: "object", additionalProperties: true },
    fromTextbook: ref("Textbook"),
    targetTextbook: ref("Textbook"),
    mappingTable: { type: "array", items: { type: "object", additionalProperties: true } },
    items: {
      type: "array",
      description: "逐题映射预演，包含自动/人工/未覆盖/冲突",
      items: { type: "object", additionalProperties: true }
    },
    summary: {
      type: "object",
      properties: {
        totalMistakes: { type: "integer" },
        affectedMistakes: { type: "integer" },
        autoMapped: { type: "integer" },
        needsConfirmation: { type: "integer" },
        unmapped: { type: "integer" },
        conflicts: { type: "integer" },
        attachments: { type: "integer" },
        attempts: { type: "integer" },
        hintEvents: { type: "integer" },
        masteryEvidence: { type: "integer" },
        activeReviews: { type: "integer" },
        historicalReportDays: { type: "integer" },
        statusCounts: { type: "object", additionalProperties: { type: "integer" } }
      },
      additionalProperties: true
    },
    affectedKnowledgePoints: {
      type: "array",
      items: { type: "object", additionalProperties: true }
    },
    impacts: { type: "object", additionalProperties: { type: "string" } }
  },
  additionalProperties: true,
  example: {
    previewToken: "d4ba3f0b09ebd1149f1939beee60cdc6670a19b6bed3f1b9283febf6edbb4113",
    alreadyCurrent: false,
    mappingVersion: "2026.11.15-v2",
    fromTextbook: { id: 1, displayName: "人教版六年级（上册/下册）" },
    targetTextbook: { id: 2, displayName: "人教版六年级上册" },
    summary: {
      totalMistakes: 5,
      affectedMistakes: 5,
      autoMapped: 4,
      needsConfirmation: 1,
      unmapped: 1,
      conflicts: 0,
      attachments: 0,
      attempts: 0,
      hintEvents: 0,
      masteryEvidence: 5,
      activeReviews: 5,
      historicalReportDays: 1
    },
    impacts: {
      mistakes: "仅更新当前教材关系；题目、答案和附件保留。",
      mastery: "掌握状态、连续答对次数和掌握证据保留，不清零。",
      reports: "历史日/周报按切换前教材快照保留，并标注“按当时教材”。"
    }
  }
};

const curriculumSwitchLogSchema = {
  type: "object",
  required: ["id", "studentId", "operation", "status", "items", "createdAt"],
  properties: {
    id: { type: "integer" },
    studentId: { type: "integer" },
    operation: { type: "string", enum: ["switch", "manual_resolve"] },
    fromTextbook: anyOfNullable(ref("Textbook")),
    toTextbook: anyOfNullable(ref("Textbook")),
    fromGrade: { type: ["integer", "null"] },
    fromSemester: { type: ["string", "null"] },
    toGrade: { type: ["integer", "null"] },
    toSemester: { type: ["string", "null"] },
    mappingVersion: { type: "string" },
    previewHash: { type: "string" },
    idempotencyKey: { type: "string" },
    actor: { type: "string" },
    confirmer: { type: "string" },
    status: { type: "string" },
    affectedCount: { type: "integer" },
    autoCount: { type: "integer" },
    manualCount: { type: "integer" },
    unmappedCount: { type: "integer" },
    conflictCount: { type: "integer" },
    result: { type: "object", additionalProperties: true },
    rollback: { type: "object", additionalProperties: true },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          mistakeId: { type: "integer" },
          beforeTextbookId: { type: ["integer", "null"] },
          afterTextbookId: { type: ["integer", "null"] },
          beforeCurriculumPointId: { type: ["integer", "null"] },
          afterCurriculumPointId: { type: ["integer", "null"] },
          beforeKnowledgePoint: { type: "string" },
          afterKnowledgePoint: { type: "string" },
          mappingStatus: { type: "string" },
          resolutionMode: { type: "string" },
          conflict: { type: "boolean" },
          unmapped: { type: "boolean" },
          detail: { type: "object", additionalProperties: true },
          createdAt: { type: "string", format: "date-time" }
        },
        additionalProperties: true
      }
    },
    createdAt: { type: "string", format: "date-time" }
  },
  additionalProperties: true
};

const unmappedCurriculumSchema = {
  type: "object",
  required: ["items", "targetPoints"],
  properties: {
    items: { type: "array", items: ref("Mistake") },
    targetPoints: { type: "array", items: ref("CurriculumPoint") }
  },
  additionalProperties: true
};

const extractionResultSchema = {
  type: "object",
  required: ["available", "requiresConfirmation"],
  properties: {
    available: { type: "boolean" },
    requiresConfirmation: { type: "boolean" },
    message: { type: "string" },
    text: { type: "string", description: "候选文字，必须由学生确认后才能保存" },
    confidence: { type: ["number", "null"] },
    provider: { type: "string" },
    model: { type: "string" },
    usedCrop: { type: "boolean", description: "是否只发送了裁剪区域" }
  },
  additionalProperties: true,
  example: {
    available: false,
    requiresConfirmation: true,
    message: "当前没有配置内部 OCR，可直接填写题目文字并使用图片保存。"
  }
};

const editSessionResultSchema = {
  type: "object",
  required: ["token", "expiresAt"],
  properties: {
    token: {
      type: "string",
      description: "放入 X-Edit-Session 请求头；单次使用，默认有效期 2 分钟"
    },
    expiresAt: { type: "string", format: "date-time" }
  },
  additionalProperties: false
};

const updateResultSchema = {
  type: "object",
  required: [
    "mistakeId",
    "revision",
    "changedFields",
    "learningReset",
    "mistake"
  ],
  properties: {
    mistakeId: { type: "integer" },
    revision: { type: "integer" },
    changedFields: { type: "array", items: { type: "string" } },
    learningReset: {
      type: "boolean",
      description: "题目、答案等关键字段变化时是否重置掌握进度"
    },
    revisionBefore: { type: "integer" },
    revisionAfter: { type: "integer" },
    mistake: ref("Mistake")
  },
  additionalProperties: true
};

const masteryEvidenceSchema = {
  type: "object",
  required: ["mistakeId", "currentStatus", "schedule", "evidence"],
  properties: {
    mistakeId: { type: "integer" },
    currentStatus: { type: "string" },
    schedule: { type: ["object", "null"], additionalProperties: true },
    evidence: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          mistakeId: { type: "integer" },
          attemptId: { type: ["integer", "null"] },
          evidenceType: { type: "string" },
          ruleVersion: { type: "string" },
          independent: { type: ["boolean", "null"] },
          previousStatus: { type: "string" },
          nextStatus: { type: "string" },
          outcome: { type: "string" },
          consecutiveIndependentCorrect: { type: "integer" },
          reviewScheduleId: { type: ["integer", "null"] },
          reason: { type: "string" },
          detail: { type: "object", additionalProperties: true },
          attempt: { type: ["object", "null"], additionalProperties: true },
          createdAt: { type: "string", format: "date-time" }
        },
        additionalProperties: true
      }
    }
  },
  additionalProperties: true
};

const knowledgePointSummarySchema = {
  type: "object",
  required: ["id", "name", "total", "mastery"],
  properties: {
    id: { type: "integer" },
    name: { type: "string" },
    unitNo: { type: ["integer", "null"] },
    teachingUnitNo: { type: ["integer", "null"] },
    unitTitle: { type: "string" },
    unit: { type: "string" },
    textbookId: { type: ["integer", "null"] },
    textbookLabel: { type: "string" },
    reviewStatus: { type: "string" },
    mapped: { type: "boolean" },
    total: { type: "integer", minimum: 0 },
    new: { type: "integer", minimum: 0 },
    practicing: { type: "integer", minimum: 0 },
    relearning: { type: "integer", minimum: 0 },
    mastered: { type: "integer", minimum: 0 },
    mastery: { type: ["integer", "null"], minimum: 0, maximum: 100 }
  },
  additionalProperties: true,
  example: {
    id: 1,
    name: "分数乘除法",
    unitNo: 1,
    teachingUnitNo: 1,
    unitTitle: "六年级全册",
    unit: "人教版六年级（上册/下册） 第1单元 六年级全册",
    textbookId: 1,
    textbookLabel: "人教版六年级（上册/下册）",
    reviewStatus: "self_reviewed",
    mapped: true,
    total: 1,
    new: 1,
    practicing: 0,
    relearning: 0,
    mastered: 0,
    mastery: 10
  }
};

const knowledgeCardSchema = {
  type: "object",
  description: "可追溯知识卡片；chunks 与 sources 提供引用和覆盖依据。",
  required: ["id", "name", "slug", "chunks"],
  properties: {
    id: { type: "integer" },
    name: { type: "string" },
    slug: { type: "string" },
    aliases: { type: "array", items: { type: "string" } },
    unit: { type: "string" },
    textbookVersion: { type: "string" },
    prerequisites: { type: "array", items: { type: "string" } },
    keywords: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
    hint: { type: "string" },
    steps: { type: "array", items: { type: "string" } },
    commonErrors: { type: "array", items: { type: "string" } },
    contentVersion: { type: "string" },
    reviewStatus: { type: "string" },
    updatedAt: { type: "string", format: "date-time" },
    chunks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          key: { type: "string" },
          kind: { type: "string" },
          title: { type: "string" },
          content: { type: "string" },
          citation: { type: "string" },
          sourceKey: { type: "string" }
        },
        additionalProperties: true
      }
    },
    sources: { type: "array", items: { type: "object", additionalProperties: true } },
    citations: { type: "array", items: { type: "string" } }
  },
  additionalProperties: true
};

const knowledgeBaseSchema = {
  type: "object",
  required: ["stats", "cards"],
  properties: {
    stats: {
      type: "object",
      properties: {
        knowledgePoints: { type: "integer" },
        units: { type: "integer" },
        chunks: { type: "integer" },
        sources: { type: "integer" },
        reviewCounts: { type: "object", additionalProperties: { type: "integer" } },
        textbookVersion: { type: "string" },
        textbookId: { type: "integer" },
        contentVersion: { type: "string" }
      },
      additionalProperties: true
    },
    cards: { type: "array", items: ref("KnowledgeCard") }
  },
  additionalProperties: true
};

const knowledgeSearchSchema = {
  type: "object",
  required: ["query", "items", "count", "coverage"],
  properties: {
    query: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "knowledgePoint", "chunks", "citations", "score"],
        properties: {
          id: { type: "integer" },
          knowledgePoint: { type: "string" },
          slug: { type: "string" },
          unit: { type: "string" },
          aliases: { type: "array", items: { type: "string" } },
          summary: { type: "string" },
          essence: { type: "string" },
          hint: { type: "string" },
          steps: { type: "array", items: { type: "string" } },
          commonErrors: { type: "array", items: { type: "string" } },
          chunks: { type: "array", items: { type: "object", additionalProperties: true } },
          citations: { type: "array", items: { type: "string" } },
          sources: { type: "array", items: { type: "object", additionalProperties: true } },
          score: { type: "number" },
          matchedBy: { type: "array", items: { type: "string" } }
        },
        additionalProperties: true
      }
    },
    count: { type: "integer", minimum: 0 },
    coverage: {
      type: "object",
      required: ["status", "note"],
      properties: {
        status: { type: "string", enum: ["covered", "not_covered"] },
        note: { type: "string" },
        bestScore: { type: "number" },
        matchedKnowledgePoints: { type: "array", items: { type: "string" } },
        sourceCount: { type: "integer" },
        citationCount: { type: "integer" }
      },
      additionalProperties: true
    }
  },
  additionalProperties: true
};

const dailyFeedbackSchema = {
  type: "object",
  description: "日总结。字段随反馈模块版本扩展，调用方应忽略未知字段。",
  properties: {
    kind: { type: "string", enum: ["daily"] },
    date: { type: "string", format: "date" },
    hasData: { type: "boolean" },
    insufficientData: { type: "boolean" },
    totals: { type: "object", additionalProperties: true },
    rates: { type: "object", additionalProperties: true },
    dependency: { type: "object", additionalProperties: true },
    masteryChanges: { type: "object", additionalProperties: true },
    knowledgePoints: { type: "array", items: { type: "object", additionalProperties: true } },
    parentReport: { type: "object", additionalProperties: true },
    textbookScope: { type: "object", additionalProperties: true }
  },
  additionalProperties: true
};

const weeklyFeedbackSchema = {
  type: "object",
  description: "周报。历史周报按当时教材快照保留，不追溯重算。",
  properties: {
    kind: { type: "string", enum: ["weekly"] },
    from: { type: "string", format: "date-time" },
    to: { type: "string", format: "date-time" },
    hasData: { type: "boolean" },
    insufficientData: { type: "boolean" },
    totals: { type: "object", additionalProperties: true },
    rates: { type: "object", additionalProperties: true },
    dependency: { type: "object", additionalProperties: true },
    masteryChanges: { type: "object", additionalProperties: true },
    knowledgePoints: { type: "array", items: { type: "object", additionalProperties: true } },
    parentReport: { type: "object", additionalProperties: true },
    dueCount: { type: "integer" },
    textbookScope: { type: "object", additionalProperties: true }
  },
  additionalProperties: true
};

const feedbackCalendarSchema = {
  type: "object",
  description: "按 Asia/Shanghai 自然月聚合的打卡日历；不含答案或提示正文。",
  required: ["month", "today", "days", "summary"],
  additionalProperties: false,
  properties: {
    month: { type: "string", pattern: "^\\d{4}-\\d{2}$" },
    today: { type: "string", format: "date" },
    days: {
      type: "array",
      items: {
        type: "object",
        required: [
          "date",
          "completedCount",
          "correctCount",
          "attemptCount",
          "hintCount",
          "hasActivity"
        ],
        additionalProperties: false,
        properties: {
          date: { type: "string", format: "date" },
          completedCount: { type: "integer", minimum: 0 },
          correctCount: { type: "integer", minimum: 0 },
          attemptCount: { type: "integer", minimum: 0 },
          hintCount: { type: "integer", minimum: 0 },
          hasActivity: { type: "boolean" }
        }
      }
    },
    summary: {
      type: "object",
      required: ["checkInDays", "completedCount", "correctCount"],
      additionalProperties: false,
      properties: {
        checkInDays: { type: "integer", minimum: 0 },
        completedCount: { type: "integer", minimum: 0 },
        correctCount: { type: "integer", minimum: 0 }
      }
    }
  }
};

const feedbackDaySchema = {
  type: "object",
  description:
    "按 Asia/Shanghai 自然日聚合的完成明细；同题多次作答合并为一行，不返回答案或提示正文。",
  required: ["date", "summary", "items"],
  additionalProperties: false,
  properties: {
    date: { type: "string", format: "date" },
    summary: {
      type: "object",
      required: [
        "completedCount",
        "attemptCount",
        "correctCount",
        "needsCorrectionCount"
      ],
      additionalProperties: false,
      properties: {
        completedCount: { type: "integer", minimum: 0 },
        attemptCount: { type: "integer", minimum: 0 },
        correctCount: { type: "integer", minimum: 0 },
        needsCorrectionCount: { type: "integer", minimum: 0 }
      }
    },
    items: {
      type: "array",
      items: {
        type: "object",
        required: [
          "mistakeId",
          "question",
          "knowledgePoint",
          "unitTitle",
          "teachingUnitNo",
          "unitMapped",
          "attemptCount",
          "hintCount",
          "lastOutcome",
          "lastAt"
        ],
        additionalProperties: false,
        properties: {
          mistakeId: { type: "integer", minimum: 1 },
          question: { type: "string" },
          knowledgePoint: { type: "string" },
          unitTitle: { type: "string" },
          teachingUnitNo: anyOfNullable({ type: "integer", minimum: 1 }),
          unitMapped: { type: "boolean" },
          attemptCount: { type: "integer", minimum: 1 },
          hintCount: { type: "integer", minimum: 0 },
          lastOutcome: {
            type: "string",
            enum: ["correct", "partial", "incorrect", "ungraded"]
          },
          lastAt: { type: "string", format: "date-time" }
        }
      }
    }
  }
};

const dashboardSchema = {
  type: "object",
  required: ["stats", "nextReview", "recent"],
  properties: {
    stats: {
      type: "object",
      properties: {
        total: { type: "integer" },
        new: { type: "integer" },
        practicing: { type: "integer" },
        mastered: { type: "integer" },
        relearning: { type: "integer" },
        due: { type: "integer" }
      },
      additionalProperties: false
    },
    nextReview: { anyOf: [ref("Mistake"), { type: "null" }] },
    recent: { type: "array", items: ref("Mistake") }
  },
  additionalProperties: true
};

const operationsMetricsSchema = {
  type: "object",
  required: ["generatedAt", "period", "llm", "tools", "agentRuns", "diagnoses", "cost"],
  properties: {
    generatedAt: { type: "string", format: "date-time" },
    period: {
      type: "object",
      properties: {
        from: { type: "string", format: "date-time" },
        to: { type: "string", format: "date-time" }
      },
      additionalProperties: false
    },
    llm: {
      type: "object",
      additionalProperties: true,
      properties: {
        calls: { type: "integer" },
        succeeded: { type: "integer" },
        failed: { type: "integer" },
        inputTokens: { type: "integer" },
        outputTokens: { type: "integer" },
        averageLatencyMs: { type: ["number", "null"] },
        p50LatencyMs: { type: ["number", "null"] },
        p95LatencyMs: { type: ["number", "null"] }
      }
    },
    tools: { type: "object", additionalProperties: true },
    agentRuns: { type: "object", additionalProperties: true },
    diagnoses: { type: "object", additionalProperties: true },
    cost: { type: "object", additionalProperties: true }
  },
  additionalProperties: true
};

const toolSchema = {
  type: "object",
  required: ["name", "description", "permission", "requiresIdempotencyKey"],
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    permission: { type: "string", enum: ["read", "draft_write", "write", "execute"] },
    requiresIdempotencyKey: { type: "boolean" },
    timeoutMs: { type: "integer" },
    inputSchema: { type: "object", additionalProperties: true },
    outputSchema: { type: "object", additionalProperties: true }
  },
  additionalProperties: true
};

const aiStatusSchema = {
  type: "object",
  required: ["configured", "fallback"],
  properties: {
    configured: { type: "boolean" },
    provider: { type: "string" },
    model: { type: "string" },
    timeoutMs: { type: "integer" },
    maxRetries: { type: "integer" },
    maxInputChars: { type: "integer" },
    rateLimitPerMinute: { type: "integer" },
    maxOutputTokens: { type: "integer" },
    temperature: { type: "number" },
    stream: { type: "boolean" },
    configurationErrors: { type: "array", items: { type: "string" } },
    fallback: { type: "string", enum: ["local_rules"] },
    promptVersion: { type: "string" }
  },
  additionalProperties: true
};

const healthSchema = {
  type: "object",
  required: ["ok", "schemaVersion", "toolCount"],
  properties: {
    ok: { type: "boolean" },
    schemaVersion: { type: "integer" },
    toolCount: { type: "integer" }
  },
  additionalProperties: false
};

const deleteAllResultSchema = {
  type: "object",
  required: ["deleted", "total"],
  properties: {
    deleted: {
      type: "object",
      additionalProperties: { type: "integer" }
    },
    total: { type: "integer", minimum: 0 }
  },
  additionalProperties: true
};

const diagnosisPartInputSchema = {
  type: "object",
  properties: {
    label: { type: "string", maxLength: 200 },
    prompt: { type: "string", maxLength: 2000 },
    studentAnswer: { type: "string", maxLength: 1000 },
    answerType: {
      type: "string",
      enum: ["auto", "text", "number", "fraction", "percent", "ratio"]
    },
    comparisonRule: {
      type: "string",
      enum: ["auto", "exact", "numeric", "ratio", "text"]
    },
    knowledgePoint: { type: "string", maxLength: 100 },
    acceptedAnswers: { type: "array", items: { type: "string" } }
  },
  additionalProperties: false
};

const createMistakeInputSchema = {
  type: "object",
  description:
    "题目文字与 attachmentIds 至少提供一项；correctAnswer 与 parts 至少提供一项。",
  properties: {
    question: { type: "string", maxLength: 3000 },
    studentAnswer: { type: "string", maxLength: 1000 },
    correctAnswer: { type: "string", maxLength: 1000 },
    analysis: { type: "string", maxLength: 3000 },
    knowledgePoint: { type: "string", maxLength: 100 },
    errorType: { type: "string", maxLength: 100 },
    attachmentIds: {
      type: "array",
      maxItems: 6,
      items: { type: "integer", minimum: 1 },
      description: "先通过 POST /api/attachments 上传得到的图片编号"
    },
    parts: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: ref("MistakePartInput")
    },
    diagnosis: {
      allOf: [ref("Diagnosis")],
      description:
        "可选。将 /api/diagnose 的返回原样回传，且必须带 contextHash；题目或答案变化会导致 409。"
    }
  },
  additionalProperties: false,
  example: {
    question: "一件商品原价 240 元，先涨价 20%，再降价 20%。现在的价格是多少元？",
    studentAnswer: "240元",
    correctAnswer: "230.4元",
    analysis: "涨价和降价对应的单位“1”不同。",
    knowledgePoint: "百分数",
    errorType: "单位“1”找错",
    attachmentIds: []
  }
};

const updateMistakeInputSchema = {
  type: "object",
  description: "只传需要修改的字段；所有字段均可选，但至少应传一个字段。",
  properties: {
    question: { type: "string", maxLength: 3000 },
    studentAnswer: { type: "string", maxLength: 1000 },
    correctAnswer: { type: "string", maxLength: 1000 },
    analysis: { type: "string", maxLength: 3000 },
    knowledgePoint: { type: "string", maxLength: 100 },
    errorType: { type: "string", maxLength: 100 },
    attachmentIds: {
      type: "array",
      maxItems: 6,
      items: { type: "integer", minimum: 1 }
    },
    parts: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: ref("MistakePartInput")
    }
  },
  additionalProperties: false,
  example: {
    studentAnswer: "230.4元",
    analysis: "先算涨价后的价格，再算降价后的价格。"
  }
};

const diagnoseInputSchema = {
  type: "object",
  required: ["question"],
  properties: {
    question: { type: "string", maxLength: 3000 },
    studentAnswer: { type: "string" },
    correctAnswer: { type: "string" },
    analysis: { type: "string" },
    knowledgePoint: { type: "string", maxLength: 100 },
    errorType: { type: "string", maxLength: 100 },
    parts: {
      type: "array",
      maxItems: 20,
      items: ref("DiagnosisPartInput")
    }
  },
  additionalProperties: false,
  example: {
    question: "一件商品原价 240 元，先涨价 20%，再降价 20%。现在的价格是多少元？",
    studentAnswer: "240元",
    correctAnswer: "230.4元"
  }
};

const attemptInputSchema = {
  type: "object",
  properties: {
    answer: {
      type: "string",
      maxLength: 3000,
      description: "单小问作答；多小问请使用 answers"
    },
    answers: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: {
        type: "object",
        required: ["partId", "value"],
        properties: {
          partId: { type: "integer", minimum: 1 },
          value: { type: "string", maxLength: 3000 }
        },
        additionalProperties: false
      }
    },
    independent: {
      type: ["boolean", "null"],
      description: "是否独立完成；影响掌握度与提示依赖统计"
    },
    hintLevel: { type: "integer", minimum: 0, maximum: 4, default: 0 }
  },
  additionalProperties: false,
  example: {
    answer: "230.4元",
    independent: true,
    hintLevel: 0
  }
};

const hintInputSchema = {
  type: "object",
  required: ["level"],
  properties: {
    level: { type: "integer", minimum: 1, maximum: 4 },
    partId: { type: "integer", minimum: 1 }
  },
  additionalProperties: false,
  example: { level: 1 }
};

const followUpInputSchema = {
  type: "object",
  required: ["question"],
  properties: {
    question: { type: "string", maxLength: 2000 },
    hintLevel: { type: "integer", minimum: 0, maximum: 4, default: 1 },
    partId: { type: "integer", minimum: 1 }
  },
  additionalProperties: false,
  example: {
    question: "为什么要先算涨价后的价格？",
    hintLevel: 1
  }
};

const curriculumPreviewInputSchema = {
  type: "object",
  required: ["targetTextbookId"],
  properties: {
    targetTextbookId: { type: "integer", minimum: 1 }
  },
  additionalProperties: false,
  example: { targetTextbookId: 4 }
};

const curriculumExecuteInputSchema = {
  type: "object",
  required: ["targetTextbookId", "previewToken"],
  properties: {
    targetTextbookId: { type: "integer", minimum: 1 },
    previewToken: { type: "string", maxLength: 128 },
    mappingChoices: {
      type: "object",
      additionalProperties: {
        type: "integer",
        description: "源知识点编号到目标知识点编号的人工选择"
      }
    },
    confirmUnmapped: {
      type: "boolean",
      description: "确认接受“当前教材未覆盖/待归类”的结果"
    },
    actor: { type: "string", maxLength: 100 },
    confirmer: { type: "string", maxLength: 100 }
  },
  additionalProperties: false,
  example: {
    targetTextbookId: 4,
    previewToken: "替换为预演返回的 previewToken",
    mappingChoices: {},
    confirmUnmapped: false,
    actor: "家长",
    confirmer: "家长"
  }
};

const resolveCurriculumInputSchema = {
  type: "object",
  required: ["targetCurriculumPointId"],
  properties: {
    targetCurriculumPointId: { type: "integer", minimum: 1 },
    actor: { type: "string", maxLength: 100 },
    confirmer: { type: "string", maxLength: 100 }
  },
  additionalProperties: false,
  example: { targetCurriculumPointId: 21, actor: "家长", confirmer: "家长" }
};

const editSessionInputSchema = {
  type: "object",
  required: ["confirmed"],
  properties: {
    confirmed: { type: "boolean", enum: [true] },
    context: {
      type: "string",
      enum: ["mistake-library", "review"],
      default: "mistake-library"
    },
    reviewSessionId: {
      type: "string",
      description: "context=review 时用于确认本次作答已完成"
    }
  },
  additionalProperties: false,
  example: { confirmed: true, context: "mistake-library" }
};

const extractAttachmentInputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
  example: {}
};

const questionScanRegionSchema = {
  type: "object",
  required: ["x", "y", "width", "height"],
  properties: {
    x: { type: "number", minimum: 0, maximum: 1 },
    y: { type: "number", minimum: 0, maximum: 1 },
    width: { type: "number", exclusiveMinimum: 0, maximum: 1 },
    height: { type: "number", exclusiveMinimum: 0, maximum: 1 }
  },
  additionalProperties: false,
  description: "候选在整张图片中的相对区域，坐标范围为 0～1。"
};

const questionSchema = {
  type: "object",
  required: [
    "id",
    "question",
    "knowledgePoint",
    "status",
    "questionType",
    "completenessStatus",
    "sourceStatus",
    "answerReviewStatus",
    "einkFitStatus",
    "categories"
  ],
  properties: {
    id: { type: "integer", minimum: 1 },
    question: { type: "string" },
    studentAnswer: { type: "string" },
    knowledgePoint: { type: "string" },
    textbookId: anyOfNullable({ type: "integer", minimum: 1 }),
    curriculumPointId: anyOfNullable({ type: "integer", minimum: 1 }),
    curriculumStatus: { type: "string" },
    errorType: { type: "string" },
    revision: { type: "integer", minimum: 1 },
    questionType: { type: "string" },
    completenessStatus: {
      type: "string",
      enum: ["confirmed", "incomplete", "unknown"]
    },
    sourceStatus: { type: "string" },
    answerReviewStatus: { type: "string" },
    einkFitStatus: { type: "string" },
    status: { type: "string" },
    consecutiveCorrect: { type: "integer", minimum: 0 },
    attemptCount: { type: "integer", minimum: 0 },
    dueAt: anyOfNullable({ type: "string", format: "date-time" }),
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
    lastReviewedAt: anyOfNullable({ type: "string", format: "date-time" }),
    categories: { type: "array", items: { type: "string" } },
    tags: { type: "array", items: { type: "string" } },
    contentUnits: { type: "array", items: { type: "object", additionalProperties: true } },
    options: { type: "array", items: { type: "object", additionalProperties: true } },
    sources: { type: "array", items: { type: "object", additionalProperties: true } },
    imageDerivations: { type: "array", items: { type: "object", additionalProperties: true } }
  },
  additionalProperties: true,
  description: "题库兼容视图。题目文字、附件、作答历史等旧字段保持原语义。"
};

const questionScanPartSchema = {
  type: "object",
  required: [
    "partNo",
    "label",
    "prompt",
    "studentAnswer",
    "suggestedAnswer",
    "answerType",
    "confidence",
    "pendingReasons",
    "answerSource"
  ],
  properties: {
    partNo: { type: "integer", minimum: 1, maximum: 20 },
    label: { type: "string", maxLength: 50 },
    prompt: { type: "string", maxLength: 2000 },
    studentAnswer: { type: "string", maxLength: 2000 },
    suggestedAnswer: {
      type: "string",
      maxLength: 2000,
      description: "标准答案建议；等价答案用中文分号分隔"
    },
    answerType: {
      type: "string",
      enum: ["auto", "text", "number", "fraction", "percent", "ratio"]
    },
    confidence: anyOfNullable({ type: "number", minimum: 0, maximum: 1 }),
    pendingReasons: { type: "array", items: { type: "string" } },
    answerSource: {
      type: "string",
      enum: ["system_suggested", "user_confirmed"],
      description: "OCR 模型生成时标记为 system_suggested；用户修改后标记为 user_confirmed"
    }
  },
  additionalProperties: false
};

const questionScanPartInputSchema = {
  type: "object",
  required: ["prompt", "studentAnswer", "suggestedAnswer", "answerType"],
  properties: {
    partNo: { type: "integer", minimum: 1, maximum: 20 },
    label: { type: "string", maxLength: 50 },
    prompt: { type: "string", maxLength: 2000 },
    studentAnswer: { type: "string", maxLength: 2000 },
    suggestedAnswer: { type: "string", maxLength: 2000 },
    answerType: {
      type: "string",
      enum: ["auto", "text", "number", "fraction", "percent", "ratio"]
    },
    confidence: anyOfNullable({ type: "number", minimum: 0, maximum: 1 }),
    pendingReasons: { type: "array", maxItems: 20, items: { type: "string" } },
    answerSource: {
      type: "string",
      enum: ["system_suggested", "user_confirmed"]
    }
  },
  additionalProperties: false
};

const questionScanCandidateSchema = {
  type: "object",
  required: [
    "id",
    "candidateNo",
    "status",
    "completenessStatus",
    "suspectedWrong",
    "answerPending",
    "selected",
    "manuallySelected",
    "text",
    "questionNo",
    "analysisStage",
    "questionType",
    "options",
    "studentAnswer",
    "suggestedAnswer",
    "parts",
    "pendingReasons",
    "sourceBlocks",
    "confidence",
    "region",
    "imageUrl",
    "importedQuestionId"
  ],
  properties: {
    id: { type: "integer", minimum: 1 },
    candidateNo: { type: "integer", minimum: 1 },
    status: { type: "string", enum: ["ready", "failed", "excluded"] },
    completenessStatus: {
      type: "string",
      enum: ["complete", "incomplete", "unknown"]
    },
    suspectedWrong: { type: "boolean" },
    answerPending: { type: "boolean" },
    selected: {
      type: "boolean",
      description: "候选是否被选中；默认不选，残缺候选不会自动选中。"
    },
    manuallySelected: {
      type: "boolean",
      description: "是否由学生手动选择；快捷选择会保留手动项。"
    },
    text: { type: "string" },
    questionNo: {
      type: "integer",
      minimum: 1,
      description: "页面上可见的题号；看不清时使用阅读顺序编号。"
    },
    analysisStage: {
      type: "string",
      enum: ["discovered", "analyzed"],
      description:
        "多题扫描先返回 discovered 边界；用户勾选并逐题分析后变为 analyzed。"
    },
    questionType: {
      type: "string",
      enum: [
        "general",
        "single_choice",
        "multiple_choice",
        "true_false",
        "fill_blank",
        "short_answer",
        "proof",
        "drawing",
        "composite"
      ]
    },
    options: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        properties: {
          position: { type: "integer", minimum: 1 },
          label: { type: "string" },
          text: { type: "string" },
          sourceBlockIds: {
            type: "array",
            items: { type: "string" }
          },
          pendingReasons: {
            type: "array",
            items: { type: "string" }
          }
        },
        additionalProperties: false
      }
    },
    studentAnswer: {
      type: "string",
      description: "各小问学生答案的兼容汇总"
    },
    suggestedAnswer: {
      type: "string",
      description: "各小问标准答案建议的兼容汇总"
    },
    parts: {
      type: "array",
      minItems: 0,
      maxItems: 20,
      items: ref("QuestionScanPart"),
      description:
        "discovered 阶段为空，不提前分析小问；analyzed 阶段至少 1 个。"
    },
    pendingReasons: { type: "array", items: { type: "string" } },
    sourceBlocks: {
      type: "array",
      items: { type: "object", additionalProperties: true },
      description: "OCR 字块文字、原图坐标和置信度。"
    },
    confidence: anyOfNullable({ type: "number", minimum: 0, maximum: 1 }),
    region: ref("QuestionScanRegion"),
    recognitionError: { type: "string" },
    imageUrl: {
      type: "string",
      description: "候选区域裁剪图地址，返回 PNG 二进制。"
    },
    importedQuestionId: anyOfNullable({ type: "integer", minimum: 1 }),
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" }
  },
  additionalProperties: false
};

const questionScanSchema = {
  type: "object",
  required: [
    "id",
    "status",
    "scanMode",
    "analysisStage",
    "candidateCount",
    "selectedCount",
    "analyzedCount",
    "selectedDiscoveredCount",
    "incompleteSelectedCount",
    "images",
    "candidates",
    "canAnalyze",
    "canImport",
    "importStage",
    "createdAt",
    "updatedAt",
    "expiresAt"
  ],
  properties: {
    id: { type: "integer", minimum: 1 },
    status: {
      type: "string",
      enum: ["ready", "failed", "expired"],
      description: "任务有效 24 小时；过期后只读。"
    },
    storedStatus: { type: "string" },
    expired: { type: "boolean" },
    scanMode: {
      type: "string",
      enum: ["single", "multi"]
    },
    analysisStage: {
      type: "string",
      enum: ["empty", "discovered", "partially_analyzed", "analyzed"]
    },
    errorMessage: { type: "string" },
    candidateCount: { type: "integer", minimum: 0 },
    selectedCount: { type: "integer", minimum: 0 },
    analyzedCount: { type: "integer", minimum: 0 },
    selectedDiscoveredCount: { type: "integer", minimum: 0 },
    incompleteSelectedCount: { type: "integer", minimum: 0 },
    scanner: {
      type: "object",
      properties: {
        provider: { type: "string" },
        model: { type: "string" },
        promptVersion: { type: "string" }
      },
      additionalProperties: false
    },
    ocr: {
      type: "object",
      properties: {
        provider: { type: "string" },
        model: { type: "string" },
        version: { type: "string" },
        blocks: {
          type: "array",
          items: { type: "object", additionalProperties: true }
        }
      },
      additionalProperties: false
    },
    images: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          attachmentId: { type: "integer" },
          role: { type: "string" },
          position: { type: "integer" },
          mimeType: { type: "string" },
          byteSize: { type: "integer" },
          width: { type: "integer" },
          height: { type: "integer" },
          url: { type: "string" }
        },
        additionalProperties: false
      }
    },
    candidates: {
      type: "array",
      maxItems: 20,
      items: ref("QuestionScanCandidate")
    },
    canAnalyze: {
      type: "boolean",
      description: "是否至少有一道已勾选且尚未分析的边界候选。"
    },
    canImport: {
      type: "boolean",
      description:
        "是否至少有一道已选择、已完成分析且尚未导入的候选；多题扫描不能跳过分析直接导入。"
    },
    importStage: { type: "string", enum: ["ready"] },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
    expiresAt: { type: "string", format: "date-time" }
  },
  additionalProperties: false
};

const questionListSchema = {
  type: "object",
  required: ["total", "questions"],
  properties: {
    total: { type: "integer", minimum: 0 },
    questions: { type: "array", items: ref("Question") }
  },
  additionalProperties: false
};

const createQuestionScanInputSchema = {
  type: "object",
  required: ["attachmentIds"],
  properties: {
    attachmentIds: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: { type: "integer", minimum: 1 },
      description: "已通过 POST /api/attachments 上传的图片编号。"
    },
    scanMode: {
      type: "string",
      enum: ["single", "multi"],
      default: "single",
      description:
        "single 直接使用现有单题 OCR+LLM；multi 先只识别题目边界，勾选后再逐题分析。"
    }
  },
  additionalProperties: false
};

const questionScanSelectionInputSchema = {
  type: "object",
  required: ["action"],
  properties: {
    action: {
      type: "string",
      enum: [
        "select_all",
        "select_wrong",
        "clear_all",
        "select_candidate",
        "unselect_candidate"
      ],
      description:
        "全选只选内容完整候选并保留手动项；全部错题只叠加完整且疑似错误项；取消全选会清空手动选择。"
    },
    candidateId: {
      type: "integer",
      minimum: 1,
      description: "单题选择/取消时必填。"
    }
  },
  additionalProperties: false
};

const updateQuestionScanCandidateInputSchema = {
  type: "object",
  minProperties: 1,
  properties: {
    text: { type: "string", maxLength: 5000 },
    questionType: {
      type: "string",
      enum: [
        "general",
        "single_choice",
        "multiple_choice",
        "true_false",
        "fill_blank",
        "short_answer",
        "proof",
        "drawing",
        "composite"
      ]
    },
    studentAnswer: { type: "string", maxLength: 2000 },
    suggestedAnswer: { type: "string", maxLength: 2000 },
    parts: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: ref("QuestionScanPartInput")
    },
    answerPending: { type: "boolean" },
    pendingReasons: {
      type: "array",
      maxItems: 20,
      items: { type: "string", maxLength: 100 }
    },
    region: ref("QuestionScanRegion"),
    excluded: { type: "boolean" }
  },
  additionalProperties: false
};

const importQuestionScanInputSchema = {
  type: "object",
  required: ["candidateIds"],
  properties: {
    candidateIds: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: { type: "integer", minimum: 1 }
    },
    confirmIncomplete: { type: "boolean", default: false }
  },
  additionalProperties: false
};

const analyzeQuestionScanInputSchema = {
  type: "object",
  required: ["candidateIds"],
  properties: {
    candidateIds: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: { type: "integer", minimum: 1 },
      description: "必须是当前扫描中已勾选的边界候选。"
    }
  },
  additionalProperties: false
};

const questionScanOcrBlockSchema = {
  type: "object",
  required: ["id", "text", "bbox", "confidence", "region"],
  properties: {
    id: { type: "string" },
    order: { type: "integer", minimum: 1 },
    text: { type: "string" },
    bbox: {
      type: "array",
      minItems: 4,
      maxItems: 4,
      items: { type: "number" }
    },
    confidence: anyOfNullable({
      type: "number",
      minimum: 0,
      maximum: 1
    }),
    region: ref("QuestionScanRegion")
  },
  additionalProperties: false
};

const questionScanOcrQuestionSchema = {
  type: "object",
  required: [
    "id",
    "questionNo",
    "text",
    "confidence",
    "region",
    "pendingReasons",
    "sourceBlockIds"
  ],
  properties: {
    id: { type: "string" },
    questionNo: { type: "integer", minimum: 1 },
    text: { type: "string" },
    confidence: anyOfNullable({
      type: "number",
      minimum: 0,
      maximum: 1
    }),
    region: ref("QuestionScanRegion"),
    pendingReasons: { type: "array", items: { type: "string" } },
    sourceBlockIds: {
      type: "array",
      minItems: 1,
      items: { type: "string" }
    }
  },
  additionalProperties: false
};

const questionScanOcrSchema = {
  type: "object",
  required: ["provider", "engine", "model", "version", "width", "height", "blocks"],
  properties: {
    provider: { type: "string" },
    engine: { type: "string" },
    model: { type: "string" },
    version: { type: "string" },
    width: { type: "integer", minimum: 1 },
    height: { type: "integer", minimum: 1 },
    processingTimeMs: anyOfNullable({ type: "integer", minimum: 0 }),
    blocks: {
      type: "array",
      maxItems: 120,
      items: ref("QuestionScanOcrBlock")
    },
    questions: {
      type: "array",
      maxItems: 20,
      items: ref("QuestionScanOcrQuestion"),
      description: "按题目边界分组后的整题区域，前端只展示这些题框。"
    }
  },
  additionalProperties: false
};

const confirmQuestionScanBoxesInputSchema = {
  type: "object",
  required: ["scanMode", "selections", "ocr"],
  properties: {
    scanMode: { type: "string", enum: ["single", "multi"] },
    selections: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: {
        type: "object",
        required: ["groupId", "sourceBlockIds", "region"],
        properties: {
          groupId: { type: "string" },
          questionNo: { type: "integer", minimum: 1 },
          sourceBlockIds: {
            type: "array",
            minItems: 1,
            maxItems: 80,
            items: { type: "string" }
          },
          region: ref("QuestionScanRegion")
        },
        additionalProperties: false
      }
    },
    ocr: ref("QuestionScanOcr")
  },
  additionalProperties: false
};

const confirmQuestionScanBoxesResultSchema = {
  type: "object",
  required: [
    "scan",
    "analyzedCount",
    "failedCount",
    "cachedCount",
    "reOcrCount",
    "results"
  ],
  properties: {
    scan: ref("QuestionScan"),
    analyzedCount: { type: "integer", minimum: 0 },
    failedCount: { type: "integer", minimum: 0 },
    cachedCount: { type: "integer", minimum: 0 },
    reOcrCount: { type: "integer", minimum: 0 },
    results: {
      type: "array",
      items: {
        type: "object",
        required: ["groupId", "status", "source"],
        properties: {
          groupId: { type: "string" },
          status: { type: "string", enum: ["analyzed", "failed"] },
          source: { type: "string", enum: ["cache", "re_ocr", "cache_or_retry"] },
          error: { type: "string" }
        },
        additionalProperties: false
      }
    }
  },
  additionalProperties: false
};

const vocabItemSchema = {
  type: "object",
  required: [
    "id",
    "subject",
    "termId",
    "term",
    "meaning",
    "intervalIndex",
    "dueAt",
    "status",
    "consecutiveCorrect",
    "lapses",
    "createdAt",
    "updatedAt"
  ],
  properties: {
    id: { type: "integer", minimum: 1 },
    studentId: { type: "integer", minimum: 1 },
    subject: { type: "string", enum: ["chinese", "english"] },
    termId: { type: "integer", minimum: 1 },
    term: { type: "string" },
    kind: anyOfNullable({ type: "string", enum: ["char", "word"] }),
    pinyin: anyOfNullable({ type: "string" }),
    phonetic: anyOfNullable({ type: "string" }),
    pos: anyOfNullable({ type: "string" }),
    meaning: { type: "string" },
    intervalIndex: { type: "integer", minimum: 0, maximum: 4 },
    dueAt: anyOfNullable({ type: "string", format: "date" }),
    status: { type: "string", enum: ["active", "mastered"] },
    consecutiveCorrect: { type: "integer", minimum: 0 },
    lapses: { type: "integer", minimum: 0 },
    sourceOccurrenceId: anyOfNullable({ type: "integer", minimum: 1 }),
    occurrencePinyin: anyOfNullable({ type: "string" }),
    lastReviewedAt: anyOfNullable({ type: "string", format: "date-time" }),
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" }
  },
  additionalProperties: false
};

const vocabItemsResponseSchema = {
  type: "object",
  required: ["items", "count"],
  properties: {
    items: { type: "array", items: ref("VocabItem") },
    count: { type: "integer", minimum: 0 }
  },
  additionalProperties: false
};

const vocabEntryInputSchema = {
  type: "object",
  required: ["term"],
  properties: {
    term: { type: "string", minLength: 1, maxLength: 50 },
    pinyin: { type: "string", maxLength: 100 },
    pinyinInBook: { type: "string", maxLength: 100 },
    meaning: { type: "string", maxLength: 200 },
    phonetic: { type: "string", maxLength: 100 },
    pos: { type: "string", maxLength: 20 },
    kind: { type: "string", enum: ["char", "word"] },
    unitId: { type: "integer", minimum: 1 },
    lessonId: { type: "integer", minimum: 1 },
    listType: { type: "string", enum: ["会认", "会写", "词语", "单词", "短语"] },
    position: { type: "integer", minimum: 0 },
    dueAt: { type: "string", format: "date" }
  },
  additionalProperties: false
};

const vocabItemsInputSchema = {
  type: "object",
  required: ["subject"],
  properties: {
    subject: { type: "string", enum: ["chinese", "english"] },
    termId: {
      type: "integer",
      minimum: 1,
      description:
        "直接引用已入库词条建条目（如在听写批改中补录生词），不能与 term/word/entries/text 同时提供，且必须与 subject 同学科。"
    },
    sourceOccurrenceId: {
      type: "integer",
      minimum: 1,
      description:
        "配合 termId 使用，指定该词条在教材中的出现位置；必须与 termId 同科且同词。"
    },
    term: { type: "string", maxLength: 50 },
    pinyin: { type: "string", maxLength: 100 },
    meaning: { type: "string", maxLength: 200 },
    phonetic: { type: "string", maxLength: 100 },
    pos: { type: "string", maxLength: 20 },
    kind: { type: "string", enum: ["char", "word"] },
    entries: {
      type: "array",
      maxItems: 200,
      items: ref("VocabEntryInput")
    },
    text: {
      type: "string",
      maxLength: 20000,
      description:
        "批量粘贴文本，每行一条；语文格式「词 拼音 释义（可选）」，英语格式「word 中文释义」。空行和 # 开头的行忽略。"
    },
    unitId: { type: "integer", minimum: 1 },
    lessonId: { type: "integer", minimum: 1 },
    listType: { type: "string", enum: ["会认", "会写", "词语", "单词", "短语"] },
    dueAt: {
      type: "string",
      format: "date",
      description: "可选到期日期；默认按排期引擎设为次日。"
    }
  },
  additionalProperties: false
};

const vocabItemsCreatedSchema = {
  type: "object",
  required: ["created", "existing", "items"],
  properties: {
    created: { type: "integer", minimum: 0 },
    existing: { type: "integer", minimum: 0 },
    items: { type: "array", items: ref("VocabItem") }
  },
  additionalProperties: false
};

const vocabItemPatchSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["active", "mastered"] },
    dueAt: anyOfNullable({ type: "string", format: "date" })
  },
  additionalProperties: false
};

const vocabReviewTodayItemSchema = {
  type: "object",
  required: ["itemId", "subject", "prompt", "intervalIndex", "dueAt"],
  properties: {
    itemId: { type: "integer", minimum: 1 },
    subject: { type: "string", enum: ["chinese", "english"] },
    prompt: {
      type: "string",
      description:
        "听写提示：语文为课本拼音，英语按模式返回中文释义或英文单词；不下发答案。"
    },
    intervalIndex: { type: "integer", minimum: 0, maximum: 4 },
    dueAt: anyOfNullable({ type: "string", format: "date" })
  },
  additionalProperties: false
};

const vocabReviewTodaySchema = {
  type: "object",
  required: [
    "date",
    "dailyLimit",
    "dueCount",
    "deferredCount",
    "reviewedToday",
    "items"
  ],
  properties: {
    date: { type: "string", format: "date" },
    dailyLimit: { type: "integer", minimum: 5, maximum: 100 },
    dueCount: { type: "integer", minimum: 0 },
    deferredCount: { type: "integer", minimum: 0 },
    reviewedToday: { type: "integer", minimum: 0 },
    items: { type: "array", items: ref("VocabReviewTodayItem") }
  },
  additionalProperties: false
};

const vocabReviewEntrySchema = {
  type: "object",
  required: ["itemId", "result"],
  properties: {
    itemId: { type: "integer", minimum: 1 },
    result: { type: "string", enum: ["correct", "incorrect"] },
    surface: { type: "string", enum: ["web", "eink"] }
  },
  additionalProperties: false
};

const vocabReviewsInputSchema = {
  type: "object",
  required: ["reviews"],
  properties: {
    reviews: {
      type: "array",
      minItems: 1,
      maxItems: 200,
      items: ref("VocabReviewEntry")
    }
  },
  additionalProperties: false
};

const vocabReviewsResultSchema = {
  type: "object",
  required: ["updated"],
  properties: {
    updated: {
      type: "array",
      items: {
        type: "object",
        required: ["itemId", "status", "intervalIndex", "dueAt"],
        properties: {
          itemId: { type: "integer", minimum: 1 },
          status: { type: "string", enum: ["active", "mastered"] },
          intervalIndex: { type: "integer", minimum: 0, maximum: 4 },
          dueAt: anyOfNullable({ type: "string", format: "date" })
        },
        additionalProperties: false
      }
    }
  },
  additionalProperties: false
};

const vocabSettingsSchema = {
  type: "object",
  required: ["dailyLimit", "englishMode"],
  properties: {
    dailyLimit: { type: "integer", minimum: 5, maximum: 100 },
    englishMode: { type: "string", enum: ["zh_to_en", "en_to_zh"] },
    updatedAt: { type: "string", format: "date-time" }
  },
  additionalProperties: false
};

const vocabSettingsInputSchema = {
  type: "object",
  properties: {
    dailyLimit: { type: "integer", minimum: 5, maximum: 100 },
    englishMode: { type: "string", enum: ["zh_to_en", "en_to_zh"] }
  },
  minProperties: 1,
  additionalProperties: false
};

const vocabDictationItemSchema = {
  type: "object",
  required: ["prompt"],
  properties: {
    itemId: anyOfNullable({ type: "integer", minimum: 1 }),
    occurrenceId: anyOfNullable({ type: "integer", minimum: 1 }),
    termId: { type: "integer", minimum: 1 },
    unitId: anyOfNullable({ type: "integer", minimum: 1 }),
    lessonId: anyOfNullable({ type: "integer", minimum: 1 }),
    listType: anyOfNullable({ type: "string" }),
    position: anyOfNullable({ type: "integer", minimum: 0 }),
    intervalIndex: anyOfNullable({ type: "integer", minimum: 0, maximum: 4 }),
    dueAt: anyOfNullable({ type: "string", format: "date" }),
    prompt: {
      type: "string",
      description: "听写提示；答案字段始终不下发。"
    }
  },
  additionalProperties: false
};

const vocabDictationSchema = {
  type: "object",
  required: ["subject", "mode", "items"],
  properties: {
    subject: { type: "string", enum: ["chinese", "english"] },
    mode: {
      type: "string",
      enum: ["pinyin_to_hanzi", "zh_to_en", "en_to_zh"]
    },
    items: { type: "array", items: ref("VocabDictationItem") }
  },
  additionalProperties: false
};

const vocabCatalogLessonSchema = {
  type: "object",
  required: ["id", "name", "lessonNo"],
  properties: {
    id: { type: "integer", minimum: 1 },
    name: { type: "string" },
    lessonNo: { type: "integer" }
  },
  additionalProperties: false
};

const vocabCatalogUnitSchema = {
  type: "object",
  required: ["id", "name", "order", "lessons"],
  properties: {
    id: { type: "integer", minimum: 1 },
    name: { type: "string" },
    order: { type: "integer" },
    lessons: { type: "array", items: ref("VocabCatalogLesson") }
  },
  additionalProperties: false
};

const vocabCatalogTextbookSchema = {
  type: "object",
  required: ["id", "name", "grade", "semester", "units"],
  properties: {
    id: { type: "integer", minimum: 1 },
    name: { type: "string" },
    grade: { type: "integer" },
    semester: { type: "string", enum: ["full", "upper", "lower"] },
    units: { type: "array", items: ref("VocabCatalogUnit") }
  },
  additionalProperties: false
};

const vocabCatalogSchema = {
  type: "object",
  required: ["textbooks"],
  properties: {
    textbooks: {
      type: "array",
      items: ref("VocabCatalogTextbook")
    }
  },
  additionalProperties: false
};

const vocabOccurrenceSchema = {
  type: "object",
  required: [
    "occurrenceId",
    "termId",
    "word",
    "pinyin",
    "meaning",
    "listType",
    "position",
    "itemId"
  ],
  properties: {
    occurrenceId: { type: "integer", minimum: 1 },
    termId: { type: "integer", minimum: 1 },
    word: { type: "string" },
    pinyin: {
      type: "string",
      description: "语文为课本拼音（缺省回退主拼音）；英语为空串。"
    },
    meaning: {
      type: "string",
      description: "语文为释义；英语为中文释义。"
    },
    listType: { type: "string", enum: ["会认", "会写", "词语", "单词", "短语"] },
    position: { type: "integer", minimum: 0 },
    itemId: anyOfNullable({ type: "integer", minimum: 1 })
  },
  additionalProperties: false
};

const vocabOccurrencesSchema = {
  type: "object",
  required: ["items"],
  properties: {
    items: { type: "array", items: ref("VocabOccurrence") }
  },
  additionalProperties: false
};

const TAGS = [
  { name: "系统", description: "健康检查、运行状态与启动引导数据。" },
  { name: "教材", description: "教材目录、切换预演/执行和不可篡改的切换审计日志。" },
  { name: "附件", description: "图片上传、读取、裁剪与可选文字识别。" },
  { name: "错题", description: "错题录入、修改、诊断、作答和掌握证据。" },
  { name: "题库", description: "兼容题库读取、扫描候选和用户确认后的批量导入。" },
  { name: "复习", description: "复习队列、分级提示与追问。" },
  { name: "知识库", description: "知识点统计、可追溯知识卡片与全文检索。" },
  { name: "反馈", description: "日总结、周报和家长可读报告。" },
  { name: "墨水屏", description: "匿名只读的到期队列、1bpp 整页帧和 PNG 预览。" },
  { name: "运维", description: "仪表盘、运营指标、演示数据与学习数据删除。" },
  {
    name: "字词",
    description: "语文生字词与英语单词的录入、到期复习清单、批量勾选和听写出题。"
  }
];

const components = {
  schemas: {
    Error: errorSchema,
    Attachment: attachmentSchema,
    AttachmentCrop: attachmentCropSchema,
    Question: questionSchema,
    QuestionScanRegion: questionScanRegionSchema,
    QuestionScanPart: questionScanPartSchema,
    QuestionScanPartInput: questionScanPartInputSchema,
    QuestionScanCandidate: questionScanCandidateSchema,
    QuestionScan: questionScanSchema,
    QuestionScanOcrBlock: questionScanOcrBlockSchema,
    QuestionScanOcrQuestion: questionScanOcrQuestionSchema,
    QuestionScanOcr: questionScanOcrSchema,
    QuestionList: questionListSchema,
    Mistake: mistakeSchema,
    MistakePart: mistakePartSchema,
    MistakePartInput: mistakePartInputSchema,
    DiagnosisPartInput: diagnosisPartInputSchema,
    Diagnosis: diagnosisSchema,
    AttemptResult: attemptResultSchema,
    HintResult: hintResultSchema,
    FollowUpResult: followUpResultSchema,
    Textbook: textbookSchema,
    Student: studentSchema,
    CurriculumPoint: curriculumPointSchema,
    Curriculum: curriculumSchema,
    Bootstrap: bootstrapSchema,
    CurriculumSwitchPreview: curriculumSwitchPreviewSchema,
    CurriculumSwitchLog: curriculumSwitchLogSchema,
    UnmappedCurriculum: unmappedCurriculumSchema,
    ExtractionResult: extractionResultSchema,
    EditSessionResult: editSessionResultSchema,
    UpdateResult: updateResultSchema,
    ImportQuestionScanInput: importQuestionScanInputSchema,
    AnalyzeQuestionScanInput: analyzeQuestionScanInputSchema,
    ConfirmQuestionScanBoxesInput: confirmQuestionScanBoxesInputSchema,
    ConfirmQuestionScanBoxesResult: confirmQuestionScanBoxesResultSchema,
    MasteryEvidence: masteryEvidenceSchema,
    KnowledgePointSummary: knowledgePointSummarySchema,
    KnowledgeCard: knowledgeCardSchema,
    KnowledgeBase: knowledgeBaseSchema,
    KnowledgeSearchResult: knowledgeSearchSchema,
    DailyFeedback: dailyFeedbackSchema,
    WeeklyFeedback: weeklyFeedbackSchema,
    FeedbackCalendar: feedbackCalendarSchema,
    FeedbackDay: feedbackDaySchema,
    Dashboard: dashboardSchema,
    OperationsMetrics: operationsMetricsSchema,
    Tool: toolSchema,
    AiStatus: aiStatusSchema,
    Health: healthSchema,
    DeleteAllResult: deleteAllResultSchema,
    CreateMistakeInput: createMistakeInputSchema,
    UpdateMistakeInput: updateMistakeInputSchema,
    DiagnoseInput: diagnoseInputSchema,
    AttemptInput: attemptInputSchema,
    HintInput: hintInputSchema,
    FollowUpInput: followUpInputSchema,
    CurriculumPreviewInput: curriculumPreviewInputSchema,
    CurriculumExecuteInput: curriculumExecuteInputSchema,
    ResolveCurriculumInput: resolveCurriculumInputSchema,
    EditSessionInput: editSessionInputSchema,
    ExtractAttachmentInput: extractAttachmentInputSchema,
    CreateQuestionScanInput: createQuestionScanInputSchema,
    QuestionScanSelectionInput: questionScanSelectionInputSchema,
    UpdateQuestionScanCandidateInput: updateQuestionScanCandidateInputSchema,
    VocabItem: vocabItemSchema,
    VocabItemsResponse: vocabItemsResponseSchema,
    VocabEntryInput: vocabEntryInputSchema,
    VocabItemsInput: vocabItemsInputSchema,
    VocabItemsCreated: vocabItemsCreatedSchema,
    VocabItemPatch: vocabItemPatchSchema,
    VocabReviewTodayItem: vocabReviewTodayItemSchema,
    VocabReviewToday: vocabReviewTodaySchema,
    VocabReviewEntry: vocabReviewEntrySchema,
    VocabReviewsInput: vocabReviewsInputSchema,
    VocabReviewsResult: vocabReviewsResultSchema,
    VocabSettings: vocabSettingsSchema,
    VocabSettingsInput: vocabSettingsInputSchema,
    VocabDictationItem: vocabDictationItemSchema,
    VocabDictation: vocabDictationSchema,
    VocabCatalogLesson: vocabCatalogLessonSchema,
    VocabCatalogUnit: vocabCatalogUnitSchema,
    VocabCatalogTextbook: vocabCatalogTextbookSchema,
    VocabCatalog: vocabCatalogSchema,
    VocabOccurrence: vocabOccurrenceSchema,
    VocabOccurrences: vocabOccurrencesSchema
  }
};

const paths = {
  "/api/health": {
    get: {
      tags: ["系统"],
      summary: "健康检查",
      description: "返回服务可用性、数据库 schema 版本和可调用工具数量。可用于容器健康检查。",
      operationId: "getHealth",
      responses: {
        200: jsonResponse(
          "服务正常",
          ref("Health"),
          { ok: true, schemaVersion: 17, toolCount: 9 }
        )
      }
    }
  },
  "/api/tools": {
    get: {
      tags: ["系统"],
      summary: "列出受控学习工具",
      description:
        "返回 Agent/UI 可用的工具定义，包括权限、是否需要幂等键、超时和输入/输出 Schema。",
      operationId: "listTools",
      responses: {
        200: jsonResponse(
          "工具定义列表",
          {
            type: "object",
            required: ["tools"],
            properties: {
              tools: { type: "array", items: ref("Tool") }
            },
            additionalProperties: false
          }
        )
      }
    }
  },
  "/api/ai/status": {
    get: {
      tags: ["系统"],
      summary: "读取模型配置状态",
      description:
        "只返回模型网关的配置摘要和降级策略，不返回 API Key。未配置时系统使用本地规则。",
      operationId: "getAiStatus",
      responses: {
        200: jsonResponse(
          "模型网关配置状态",
          ref("AiStatus"),
          {
            configured: true,
            provider: "deepseek",
            model: "deepseek-chat",
            timeoutMs: 30000,
            maxRetries: 2,
            maxInputChars: 24000,
            rateLimitPerMinute: 0,
            maxOutputTokens: 1200,
            temperature: 0.2,
            stream: false,
            configurationErrors: [],
            fallback: "local_rules",
            promptVersion: "diagnosis-v1"
          }
        )
      }
    }
  },
  "/api/ai/test": {
    post: {
      tags: ["系统"],
      summary: "测试模型连通性",
      description:
        "主动调用一次已配置的模型网关进行连通性测试。未配置或网络失败时返回失败摘要，不写入学习数据。",
      operationId: "testAiConnection",
      responses: {
        200: jsonResponse(
          "测试结果",
          {
            type: "object",
            required: ["ok"],
            properties: {
              ok: { type: "boolean" },
              provider: { type: "string" },
              model: { type: "string" },
              latencyMs: { type: ["number", "null"] },
              message: { type: "string" }
            },
            additionalProperties: true
          }
        )
      }
    }
  },
  "/api/bootstrap": {
    get: {
      tags: ["系统"],
      summary: "读取界面启动数据",
      description:
        "一次返回当前学生、当前教材、可选教材、当前教材知识点和映射版本，供前端首屏加载。",
      operationId: "getBootstrap",
      responses: {
        200: jsonResponse("启动数据", ref("Bootstrap"))
      }
    }
  },
  "/api/openapi.json": {
    get: {
      tags: ["系统"],
      summary: "获取 OpenAPI 3.1 契约",
      description:
        "机器可读契约，可直接导入 Swagger Editor、Postman、Insomnia 或代码生成器。servers[0].url 会按当前请求的 Host / 反向代理头动态生成。",
      operationId: "getOpenApiDocument",
      responses: {
        200: jsonResponse(
          "OpenAPI 文档",
          { type: "object", additionalProperties: true }
        )
      }
    }
  },
  "/api/docs": {
    get: {
      tags: ["系统"],
      summary: "交互式 API 文档页",
      description:
        "零外部依赖的 Swagger 风格阅读器，支持搜索、请求示例、Try it out 和 cURL 复制。",
      operationId: "getApiDocsPage",
      responses: {
        200: {
          description: "API 文档 HTML",
          content: {
            "text/html": { schema: { type: "string" } }
          }
        }
      }
    }
  },

  "/api/curriculum": {
    get: {
      tags: ["教材"],
      summary: "读取教材目录与编排",
      description:
        "返回当前学生、当前教材、可选教材、教材单元和知识点编排。人教版与北师大版同时存在，互不删除。",
      operationId: "getCurriculum",
      responses: {
        200: jsonResponse("教材目录与编排", ref("Curriculum"))
      }
    }
  },
  "/api/curriculum/unmapped": {
    get: {
      tags: ["教材"],
      summary: "读取未映射错题",
      description:
        "返回当前教材下状态为“当前教材未覆盖/待归类”的错题，以及可用于人工处理的目标知识点。",
      operationId: "getUnmappedCurriculumMistakes",
      responses: {
        200: jsonResponse("未映射错题与目标知识点", ref("UnmappedCurriculum"))
      }
    }
  },
  "/api/curriculum/switch/preview": {
    post: {
      tags: ["教材"],
      summary: "预演教材切换",
      description:
        "只读预演：计算逐题映射、需人工确认项、未覆盖项，以及掌握度、复习队列和历史报告的影响。取消预演不会修改任何数据。",
      operationId: "previewCurriculumSwitch",
      requestBody: requestBody(
        ref("CurriculumPreviewInput"),
        { example: { targetTextbookId: 4 } }
      ),
      responses: {
        200: jsonResponse(
          "预演结果",
          ref("CurriculumSwitchPreview")
        ),
        400: errorResponse("目标教材无效", { error: "目标教材无效" }),
        404: errorResponse("没有找到当前学生或目标教材")
      }
    }
  },
  "/api/curriculum/switch/execute": {
    post: {
      tags: ["教材"],
      summary: "执行教材切换",
      description:
        "确认预演后在一个事务中切换当前学生教材并重映射错题；失败完整回滚。previewToken、映射选择和未覆盖确认必须与预演一致。重复请求需使用同一个 Idempotency-Key。",
      operationId: "executeCurriculumSwitch",
      parameters: [idempotencyKeyParameter()],
      requestBody: requestBody(ref("CurriculumExecuteInput")),
      responses: {
        200: jsonResponse(
          "切换结果",
          {
            allOf: [ref("CurriculumSwitchLog")],
            description:
              "返回审计日志；幂等重放时附带 idempotentReplay=true，已切换时附带 alreadyCurrent=true。"
          }
        ),
        400: errorResponse("缺少幂等键或参数无效"),
        409: errorResponse("预演已过期、映射冲突或存在未确认项"),
        500: errorResponse("事务失败，已完整回滚")
      }
    }
  },
  "/api/curriculum/switches": {
    get: {
      tags: ["教材"],
      summary: "查询教材切换审计日志",
      description:
        "按学生读取不可篡改的切换记录。可按错题编号追溯该题每次切换前后的教材、知识点和映射结果，支持 A→B→A。",
      operationId: "listCurriculumSwitches",
      parameters: [
        {
          name: "mistakeId",
          in: "query",
          required: false,
          description: "只返回涉及该错题的切换记录",
          schema: { type: "integer", minimum: 1 }
        },
        {
          name: "limit",
          in: "query",
          required: false,
          description: "返回条数，默认 20，最大 100",
          schema: { type: "integer", minimum: 1, maximum: 100, default: 20 }
        }
      ],
      responses: {
        200: {
          description: "审计日志列表",
          content: {
            "application/json": {
              schema: {
                type: "array",
                items: ref("CurriculumSwitchLog")
              }
            }
          }
        }
      }
    }
  },
  "/api/curriculum/mistakes/{mistakeId}/resolve": {
    post: {
      tags: ["教材"],
      summary: "人工处理未映射错题",
      description:
        "为一道“当前教材未覆盖/待归类”的错题指定当前教材中的知识点。会写入审计日志，不删除错题。重复请求需使用同一个 Idempotency-Key。",
      operationId: "resolveUnmappedMistake",
      parameters: [mistakeIdPathParameter, idempotencyKeyParameter()],
      requestBody: requestBody(ref("ResolveCurriculumInput")),
      responses: {
        200: jsonResponse(
          "处理结果",
          {
            type: "object",
            description:
              "返回审计日志；已处理时可能返回 alreadyResolved=true 和当前错题。",
            additionalProperties: true
          }
        ),
        400: errorResponse("目标知识点不属于当前教材"),
        404: errorResponse("没有找到这道错题"),
        409: errorResponse("幂等键冲突")
      }
    }
  },

  "/api/attachments": {
    post: {
      tags: ["附件"],
      summary: "上传题目图片",
      description:
        "直接以图片二进制作为请求体。支持 JPG/PNG/WebP，单张不超过 8 MB；每道错题最多 6 张、合计 30 MB。原图只保存在本机，SQLite 仅存元数据。",
      operationId: "uploadAttachment",
      parameters: [
        {
          name: "kind",
          in: "query",
          required: false,
          description: "图片用途",
          schema: {
            type: "string",
            enum: ["question", "part", "draft", "answer"],
            default: "question"
          }
        },
        {
          name: "Content-Type",
          in: "header",
          required: true,
          description: "实际图片 MIME，必须与文件内容一致",
          schema: {
            type: "string",
            enum: ["image/jpeg", "image/png", "image/webp"]
          }
        },
        {
          name: "X-Original-Name",
          in: "header",
          required: false,
          description: "URL 编码后的原始文件名，仅用于展示，不落盘为路径",
          schema: { type: "string", maxLength: 500 }
        }
      ],
      requestBody: requestBody(
        { type: "string", format: "binary" },
        {
          description: "图片二进制。",
          contentType: "application/octet-stream",
          example: "<binary image>"
        }
      ),
      responses: {
        201: jsonResponse("上传成功", ref("Attachment")),
        400: errorResponse(
          "图片格式、尺寸或用途无效",
          { error: "仅支持 JPG、PNG 或 WebP 图片", code: "INVALID_IMAGE" }
        ),
        413: errorResponse("图片超过 8 MB")
      }
    }
  },
  "/api/attachments/{id}": {
    get: {
      tags: ["附件"],
      summary: "读取题目图片",
      description:
        "返回图片二进制。默认 variant=crop 读取裁剪图；没有裁剪时回退原图。响应禁止缓存，避免携带旧图。",
      operationId: "getAttachmentContent",
      parameters: [
        idParameter("附件编号"),
        {
          name: "variant",
          in: "query",
          required: false,
          description: "crop 为展示图（有裁剪优先），original 为原图",
          schema: { type: "string", enum: ["crop", "original"], default: "crop" }
        }
      ],
      responses: {
        200: {
          description: "图片内容",
          content: {
            "image/jpeg": { schema: { type: "string", format: "binary" } },
            "image/png": { schema: { type: "string", format: "binary" } },
            "image/webp": { schema: { type: "string", format: "binary" } }
          }
        },
        404: errorResponse("附件或文件不存在")
      }
    },
    delete: {
      tags: ["附件"],
      summary: "删除未关联附件",
      description:
        "只允许删除尚未绑定错题的附件。已绑定附件返回 409，需要先通过修改错题移除。删除会同时清理原图和裁剪派生文件。",
      operationId: "deleteUnboundAttachment",
      parameters: [idParameter("附件编号")],
      responses: {
        200: jsonResponse(
          "删除成功",
          {
            type: "object",
            required: ["deleted"],
            properties: { deleted: { type: "boolean", enum: [true] } },
            additionalProperties: false
          }
        ),
        404: errorResponse("没有找到这张题目图片"),
        409: errorResponse("图片已关联到错题")
      }
    }
  },
  "/api/attachments/{id}/extract": {
    post: {
      tags: ["附件"],
      summary: "可选图片文字识别",
      description:
        "由用户点击“识别文字”后调用。图片（有裁剪时仅发送裁剪区域）只发送到同一部署环境内的内部 OCR 服务。识别结果只是候选文字，必须由学生确认；失败或未配置时返回 available=false，仍可用图片 + 文字保存。",
      operationId: "extractAttachmentText",
      parameters: [idParameter("附件编号")],
      requestBody: requestBody(ref("ExtractAttachmentInput")),
      responses: {
        200: jsonResponse("识别或降级结果", ref("ExtractionResult")),
        404: errorResponse("没有找到这张题目图片")
      }
    }
  },
  "/api/attachments/{id}/ocr-boxes": {
    post: {
      tags: ["附件"],
      summary: "识别并分组题目框",
      description:
        "内部 OCR 返回原始文字字块后，纯文本模型复用现有题目边界逻辑生成整题区域。响应同时保留原始字块供缓存分析，但前端只展示 questions 中的整题框。接口不创建正式候选题。",
      operationId: "getAttachmentOcrBoxes",
      parameters: [idParameter("附件编号")],
      responses: {
        200: jsonResponse("OCR 字块结果", ref("QuestionScanOcr")),
        404: errorResponse("没有找到这张验证图片"),
        503: errorResponse("内部 OCR 未配置")
      }
    }
  },
  "/api/attachments/{id}/ocr-boxes/confirm": {
    post: {
      tags: ["附件"],
      summary: "确认题框并开始题目分析",
      description:
        "单题只提交一个题框，多题提交全部已勾选题框。区域未变化时复用首次 OCR；区域移动、缩放、缓存缺失或置信度过低时按新区域重新 OCR。分析结果进入现有扫描候选页，仍须用户确认后导入题库。",
      operationId: "confirmQuestionScanBoxes",
      parameters: [idParameter("附件编号")],
      requestBody: requestBody(ref("ConfirmQuestionScanBoxesInput")),
      responses: {
        200: jsonResponse(
          "题框分析完成",
          ref("ConfirmQuestionScanBoxesResult")
        ),
        400: errorResponse("题框选择或区域无效"),
        404: errorResponse("没有找到这张验证图片"),
        422: errorResponse("缓存 OCR 或题框区域无效"),
        502: errorResponse("题框识别或题目分析失败")
      }
    }
  },
  "/api/attachments/{id}/crop": {
    post: {
      tags: ["附件"],
      summary: "保存人工裁剪图",
      description:
        "请求体必须是浏览器已经按元数据裁剪、旋转后的图片二进制。服务端校验原图尺寸、裁剪范围和旋转角度后保存派生文件，不覆盖原图。失败不会删除原图或旧裁剪。",
      operationId: "saveAttachmentCrop",
      parameters: [
        idParameter("附件编号"),
        {
          name: "Content-Type",
          in: "header",
          required: true,
          schema: {
            type: "string",
            enum: ["image/jpeg", "image/png", "image/webp"]
          }
        },
        {
          name: "X-Crop-X",
          in: "header",
          required: true,
          description: "旋转后图片坐标系中的起点 X",
          schema: { type: "integer", minimum: 0 }
        },
        {
          name: "X-Crop-Y",
          in: "header",
          required: true,
          schema: { type: "integer", minimum: 0 }
        },
        {
          name: "X-Crop-Width",
          in: "header",
          required: true,
          schema: { type: "integer", minimum: 1 }
        },
        {
          name: "X-Crop-Height",
          in: "header",
          required: true,
          schema: { type: "integer", minimum: 1 }
        },
        {
          name: "X-Crop-Rotation",
          in: "header",
          required: true,
          schema: { type: "integer", enum: [0, 90, 180, 270] }
        },
        {
          name: "X-Crop-Source-Width",
          in: "header",
          required: true,
          description: "原图宽度，用于检测原图是否已变化",
          schema: { type: "integer", minimum: 1 }
        },
        {
          name: "X-Crop-Source-Height",
          in: "header",
          required: true,
          schema: { type: "integer", minimum: 1 }
        }
      ],
      requestBody: requestBody(
        { type: "string", format: "binary" },
        {
          description: "裁剪后的图片二进制。",
          contentType: "application/octet-stream"
        }
      ),
      responses: {
        200: jsonResponse("裁剪已保存", ref("Attachment")),
        400: errorResponse("裁剪参数无效或原图尺寸已变化"),
        404: errorResponse("没有找到这张题目图片")
      }
    },
    delete: {
      tags: ["附件"],
      summary: "恢复原图",
      description: "删除裁剪派生文件和元数据，保留原图，返回已恢复的附件信息。",
      operationId: "clearAttachmentCrop",
      parameters: [idParameter("附件编号")],
      responses: {
        200: jsonResponse("已恢复原图", ref("Attachment")),
        404: errorResponse("没有找到这张题目图片")
      }
    }
  }
};

Object.assign(paths, {
  "/api/mistakes": {
    get: {
      tags: ["错题"],
      summary: "列出错题",
      description:
        "兼容接口，等价于 GET /api/questions?category=mistake 后按 status 转换响应外壳。只读取统一题库，不维护第二份题目数据。包含附件安全元数据和小问摘要，不返回正确答案、解析或提示；非法 status 会按 all 处理。",
      operationId: "listMistakes",
      parameters: [
        {
          name: "status",
          in: "query",
          required: false,
          schema: {
            type: "string",
            enum: ["all", "new", "practicing", "relearning", "mastered"],
            default: "all"
          }
        }
      ],
      responses: {
        200: {
          description: "错题列表",
          content: {
            "application/json": {
              schema: { type: "array", items: ref("Mistake") }
            }
          }
        }
      }
    },
    post: {
      tags: ["错题"],
      summary: "录入错题",
      description:
        "题目文字与图片至少提供一项；正确答案与小问至少提供一项。可附带 /api/diagnose 的确认结果。成功后返回错题和一次性复习会话编号。",
      operationId: "createMistake",
      requestBody: requestBody(ref("CreateMistakeInput")),
      responses: {
        201: jsonResponse("错题已创建", ref("Mistake")),
        400: errorResponse("题目、答案、小问或附件参数无效"),
        409: errorResponse(
          "诊断上下文已变化，请重新诊断",
          { error: "题目或答案已变化，请重新诊断后再保存" }
        )
      }
    }
  },
  "/api/diagnose": {
    post: {
      tags: ["错题"],
      summary: "诊断错题（可选 AI 辅助）",
      description:
        "调用已配置模型；未配置或调用失败时降级为本地规则。返回 contextHash，保存错题时原样回传 diagnosis 才能绑定本次诊断。",
      operationId: "diagnoseMistake",
      requestBody: requestBody(ref("DiagnoseInput")),
      responses: {
        200: jsonResponse("诊断结果", ref("Diagnosis")),
        400: errorResponse("缺少题目或输入过长")
      }
    }
  },
  "/api/mistakes/{id}": {
    get: {
      tags: ["错题"],
      summary: "读取错题详情",
      description:
        "学生视角详情，不返回正确答案、解析、提示和可接受答案。需要带解答权限时使用编辑会话接口。",
      operationId: "getMistake",
      parameters: [idParameter("错题编号")],
      responses: {
        200: jsonResponse("错题详情（已脱敏）", ref("Mistake")),
        404: errorResponse("没有找到这道错题")
      }
    },
    patch: {
      tags: ["错题"],
      summary: "修改错题",
      description:
        "与 POST /api/mistakes/{id}/update 等价。只更新传入字段；关键字段变化会增加 revision 并按规则重置掌握进度。必须提供幂等键。",
      operationId: "patchMistake",
      parameters: [idParameter("错题编号"), idempotencyKeyParameter()],
      requestBody: requestBody(ref("UpdateMistakeInput")),
      responses: {
        200: jsonResponse("修改结果", ref("UpdateResult")),
        400: errorResponse("缺少幂等键或字段无效"),
        404: errorResponse("没有找到这道错题")
      }
    },
    delete: {
      tags: ["错题"],
      summary: "删除错题",
      description:
        "删除错题及其小问、附件元数据和附件文件，并清理派生裁剪文件；不会留下孤儿文件。",
      operationId: "deleteMistake",
      parameters: [idParameter("错题编号")],
      responses: {
        200: jsonResponse(
          "删除成功",
          {
            type: "object",
            required: ["deleted"],
            properties: { deleted: { type: "boolean", enum: [true] } },
            additionalProperties: false
          }
        ),
        404: errorResponse("没有找到这道错题")
      }
    }
  },
  "/api/mistakes/{id}/evidence": {
    get: {
      tags: ["错题"],
      summary: "读取掌握证据",
      description:
        "返回当前状态、活动复习计划和不可篡改的掌握证据链（含关联作答摘要），用于家长或验收追溯。",
      operationId: "getMistakeEvidence",
      parameters: [idParameter("错题编号")],
      responses: {
        200: jsonResponse("掌握证据", ref("MasteryEvidence")),
        404: errorResponse("没有找到这道错题")
      }
    }
  },
  "/api/mistakes/{id}/edit-session": {
    post: {
      tags: ["错题"],
      summary: "申请题目修正会话",
      description:
        "必须显式确认进入修正流程。返回一次性 token，放入后续 GET /api/mistakes/{id}/edit 的 X-Edit-Session 头；默认 2 分钟有效，读取一次后失效。",
      operationId: "createMistakeEditSession",
      parameters: [idParameter("错题编号")],
      requestBody: requestBody(ref("EditSessionInput")),
      responses: {
        200: jsonResponse("修正会话", ref("EditSessionResult")),
        400: errorResponse("未确认进入修正流程"),
        404: errorResponse("没有找到这道错题"),
        409: errorResponse("复习场景尚未完成本次作答")
      }
    }
  },
  "/api/mistakes/{id}/edit": {
    get: {
      tags: ["错题"],
      summary: "读取可编辑错题（含解答）",
      description:
        "使用 edit-session 返回的一次性 token。返回正确答案、解析、提示和可接受答案；token 读取后立即失效。",
      operationId: "getMistakeForEdit",
      parameters: [
        idParameter("错题编号"),
        {
          name: "X-Edit-Session",
          in: "header",
          required: true,
          description: "POST /edit-session 返回的 token",
          schema: { type: "string" }
        }
      ],
      responses: {
        200: jsonResponse("含解答的错题", ref("Mistake")),
        403: errorResponse("修正会话无效或已过期"),
        404: errorResponse("没有找到这道错题")
      }
    }
  },
  "/api/mistakes/{id}/update": {
    post: {
      tags: ["错题"],
      summary: "修改错题（推荐入口）",
      description:
        "与 PATCH /api/mistakes/{id} 等价，兼容旧调用方。必须提供幂等键；返回修订前后编号、变更字段和是否重置掌握进度。",
      operationId: "updateMistake",
      parameters: [idParameter("错题编号"), idempotencyKeyParameter()],
      requestBody: requestBody(ref("UpdateMistakeInput")),
      responses: {
        200: jsonResponse("修改结果", ref("UpdateResult")),
        400: errorResponse("缺少幂等键或字段无效"),
        404: errorResponse("没有找到这道错题")
      }
    }
  },
  "/api/mistakes/{id}/attempts": {
    post: {
      tags: ["错题"],
      summary: "提交作答",
      description:
        "确定性判题后记录作答、掌握证据和下一次复习时间。可选 X-Review-Session 用于标记本次复习会话已完成。作答本身不要求 Idempotency-Key。",
      operationId: "submitAttempt",
      parameters: [
        idParameter("错题编号"),
        {
          name: "X-Review-Session",
          in: "header",
          required: false,
          description: "复习会话编号；来自 /api/review/next 或 /api/review/{id}",
          schema: { type: "string" }
        }
      ],
      requestBody: requestBody(ref("AttemptInput")),
      responses: {
        200: jsonResponse("作答与掌握度结果", ref("AttemptResult")),
        400: errorResponse("作答参数无效或小问不匹配"),
        404: errorResponse("没有找到这道错题")
      }
    }
  }
});

Object.assign(paths, {
  "/api/review/next": {
    get: {
      tags: ["复习"],
      summary: "读取下一道到期错题",
      description:
        "按到期时间、学习状态优先级返回下一题，不返回正确答案或解析，并签发一次性复习会话编号。没有到期题时返回 JSON null。",
      operationId: "getNextReview",
      responses: {
        200: {
          description: "下一道错题或 null",
          content: {
            "application/json": {
              schema: anyOfNullable(ref("Mistake"))
            }
          }
        }
      }
    }
  },
  "/api/review/queue": {
    get: {
      tags: ["复习"],
      summary: "读取复习队列",
      description:
        "返回当前到期错题，按状态与到期时间排序。count 为本次返回条数，不是全部到期总数。",
      operationId: "listReviewQueue",
      parameters: [
        {
          name: "limit",
          in: "query",
          required: false,
          description: "返回条数，1～20，默认 5",
          schema: { type: "integer", minimum: 1, maximum: 20, default: 5 }
        }
      ],
      responses: {
        200: jsonResponse(
          "复习队列",
          {
            type: "object",
            required: ["items", "count"],
            properties: {
              items: { type: "array", items: ref("Mistake") },
              count: { type: "integer", minimum: 0 }
            },
            additionalProperties: false
          }
        )
      }
    }
  },
  "/api/review/{id}": {
    get: {
      tags: ["复习"],
      summary: "读取指定错题用于复习",
      description:
        "返回脱敏错题并签发复习会话编号。复习会话 30 分钟有效，用于修正题目前的“是否已完成本次作答”校验。",
      operationId: "getReviewMistake",
      parameters: [idParameter("错题编号")],
      responses: {
        200: jsonResponse("复习用错题（已脱敏）", ref("Mistake")),
        404: errorResponse("没有找到这道错题")
      }
    }
  },
  "/api/review/{id}/hints": {
    post: {
      tags: ["复习"],
      summary: "获取分级提示",
      description:
        "等级 1～4，逐级增加引导；模型不可用时降级为本地规则提示，并记录提示事件用于提示依赖统计。必须提供幂等键。",
      operationId: "getReviewHint",
      parameters: [idParameter("错题编号"), idempotencyKeyParameter()],
      requestBody: requestBody(ref("HintInput")),
      responses: {
        200: jsonResponse("提示内容", ref("HintResult")),
        400: errorResponse("提示等级无效或缺少幂等键"),
        404: errorResponse("没有找到这道错题")
      }
    }
  },
  "/api/review/{id}/follow-up": {
    post: {
      tags: ["复习"],
      summary: "提交追问",
      description:
        "围绕当前错题追问，返回引导性回答和下一步建议；不直接泄露最终答案。必须提供幂等键。",
      operationId: "followUpReview",
      parameters: [idParameter("错题编号"), idempotencyKeyParameter()],
      requestBody: requestBody(ref("FollowUpInput")),
      responses: {
        200: jsonResponse("追问结果", ref("FollowUpResult")),
        400: errorResponse("追问为空、过长或缺少幂等键"),
        404: errorResponse("没有找到这道错题")
      }
    }
  },

  "/api/knowledge-points": {
    get: {
      tags: ["知识库"],
      summary: "按知识点聚合学习状态",
      description:
        "返回当前教材知识点及错题数量、四状态分布和掌握度。没有当前教材时返回兼容的旧版知识点汇总。",
      operationId: "listKnowledgePointSummary",
      responses: {
        200: {
          description: "知识点汇总",
          content: {
            "application/json": {
              schema: {
                type: "array",
                items: ref("KnowledgePointSummary")
              }
            }
          }
        }
      }
    }
  },
  "/api/knowledge-base": {
    get: {
      tags: ["知识库"],
      summary: "读取知识库目录",
      description:
        "返回当前教材的知识点卡片、知识片段、来源统计和审核状态。内容按教材版本隔离，不混用其他版本签字。",
      operationId: "getKnowledgeBase",
      responses: {
        200: jsonResponse("知识库目录", ref("KnowledgeBase"))
      }
    }
  },
  "/api/knowledge-base/search": {
    get: {
      tags: ["知识库"],
      summary: "全文检索可追溯知识",
      description:
        "支持知识点名称、别名、关键词和全文检索，返回片段、来源引用与覆盖状态。覆盖不足时 status=not_covered，不伪造来源。",
      operationId: "searchKnowledge",
      parameters: [
        {
          name: "q",
          in: "query",
          required: true,
          description: "检索词",
          schema: { type: "string", minLength: 1, maxLength: 500 }
        },
        {
          name: "limit",
          in: "query",
          required: false,
          description: "返回条数，1～5，默认 3",
          schema: { type: "integer", minimum: 1, maximum: 5, default: 3 }
        }
      ],
      responses: {
        200: jsonResponse("检索结果", ref("KnowledgeSearchResult")),
        400: errorResponse("检索词为空")
      }
    }
  },
  "/api/knowledge-base/{cardId}": {
    get: {
      tags: ["知识库"],
      summary: "读取知识卡片",
      description:
        "cardId 可以是数字编号、slug 或知识点名称。只在当前教材范围内查找；找不到时返回 404，不回退到其他教材。",
      operationId: "getKnowledgeCard",
      parameters: [
        {
          name: "cardId",
          in: "path",
          required: true,
          description: "知识卡片编号、slug 或知识点名称",
          schema: { type: "string", minLength: 1 }
        }
      ],
      responses: {
        200: jsonResponse("知识卡片", ref("KnowledgeCard")),
        404: errorResponse("没有找到这张知识卡片")
      }
    }
  },

  "/api/feedback/daily": {
    get: {
      tags: ["反馈"],
      summary: "读取日总结",
      description:
        "按自然日汇总作答、正确率、提示依赖、掌握变化和到期题数。历史数据按当时教材快照展示。",
      operationId: "getDailyFeedback",
      parameters: [
        {
          name: "date",
          in: "query",
          required: false,
          description: "YYYY-MM-DD；默认今天",
          schema: { type: "string", format: "date" }
        },
        {
          name: "knowledgePoint",
          in: "query",
          required: false,
          schema: { type: "string", maxLength: 100 }
        }
      ],
      responses: {
        200: jsonResponse("日总结", ref("DailyFeedback")),
        400: errorResponse("日期格式无效")
      }
    }
  },
  "/api/feedback/weekly": {
    get: {
      tags: ["反馈"],
      summary: "读取周报",
      description:
        "以 end 为最后一天向前取 7 天，返回家长可读周报。历史周报保留当时教材快照并标注“按当时教材”，不追溯重算。",
      operationId: "getWeeklyFeedback",
      parameters: [
        {
          name: "end",
          in: "query",
          required: false,
          description: "YYYY-MM-DD；默认今天",
          schema: { type: "string", format: "date" }
        },
        {
          name: "knowledgePoint",
          in: "query",
          required: false,
          schema: { type: "string", maxLength: 100 }
        }
      ],
      responses: {
        200: jsonResponse("周报", ref("WeeklyFeedback")),
        400: errorResponse("日期格式无效")
      }
    }
  },
  "/api/feedback/calendar": {
    get: {
      tags: ["反馈"],
      summary: "读取打卡月历",
      description:
        "按 Asia/Shanghai 自然月返回每天完成题数、正确题数、作答次数和提示次数，并返回本月打卡汇总。未来日期由客户端置灰，不返回答案或提示正文。",
      operationId: "getFeedbackCalendar",
      parameters: [
        {
          name: "month",
          in: "query",
          required: false,
          description: "YYYY-MM；默认当前月份",
          schema: { type: "string", pattern: "^\\d{4}-\\d{2}$" }
        }
      ],
      responses: {
        200: jsonResponse("打卡月历", ref("FeedbackCalendar")),
        400: errorResponse("月份格式无效")
      }
    }
  },
  "/api/feedback/day": {
    get: {
      tags: ["反馈"],
      summary: "读取当日完成情况",
      description:
        "按 Asia/Shanghai 自然日返回题目级完成明细。同题多次作答聚合为一行，最近一次结果决定是否正确；不返回正确答案、原始作答或提示正文。",
      operationId: "getFeedbackDay",
      parameters: [
        {
          name: "date",
          in: "query",
          required: false,
          description: "YYYY-MM-DD；默认今天",
          schema: { type: "string", format: "date" }
        }
      ],
      responses: {
        200: jsonResponse("当日完成情况", ref("FeedbackDay")),
        400: errorResponse("日期格式无效")
      }
    }
  },

  "/api/dashboard": {
    get: {
      tags: ["运维"],
      summary: "读取学习仪表盘",
      description: "返回错题状态统计、下一道到期题和最近 5 道错题摘要。",
      operationId: "getDashboard",
      responses: {
        200: jsonResponse("仪表盘数据", ref("Dashboard"))
      }
    }
  },
  "/api/eink/queue": {
    get: {
      tags: ["墨水屏"],
      summary: "读取墨水屏到期队列",
      description:
        "返回全部到期错题数和最多 20 条最小摘要，不返回题干、答案、提示、附件内容或附件 URL。不适配墨水屏单页（eink_fit_status=unfit）的错题会被排除，count 与 index 均按过滤后的队列计算。响应不得压缩。",
      operationId: "getEinkQueue",
      parameters: [
        {
          name: "limit",
          in: "query",
          required: false,
          description: "返回条数，缺省 20",
          schema: {
            type: "integer",
            minimum: 1,
            maximum: 20,
            default: 20
          }
        }
      ],
      responses: {
        200: jsonResponse(
          "到期队列",
          {
            type: "object",
            required: ["count", "updatedAt", "items"],
            properties: {
              count: {
                type: "integer",
                minimum: 0,
                description: "排除不适配错题后的到期错题数，不是 items.length"
              },
              updatedAt: { type: "string", format: "date-time" },
              items: {
                type: "array",
                maxItems: 20,
                items: {
                  type: "object",
                  required: ["id", "index", "hasPhoto", "partCount"],
                  properties: {
                    id: { type: "integer", minimum: 1 },
                    index: { type: "integer", minimum: 1 },
                    kp: { type: "string" },
                    hasPhoto: { type: "boolean" },
                    partCount: { type: "integer", minimum: 1 }
                  },
                  additionalProperties: false
                }
              }
            },
            additionalProperties: false
          },
          {
            count: 16,
            updatedAt: "2026-11-17T10:00:00.000Z",
            items: [
              {
                id: 9,
                index: 1,
                kp: "圆",
                hasPhoto: false,
                partCount: 1
              }
            ]
          }
        ),
        400: errorResponse("limit 不是 1～20 的整数")
      }
    }
  },
  "/api/eink/dashboard": {
    get: {
      tags: ["墨水屏"],
      summary: "读取电子墨水屏学习看板",
      description:
        "返回看板设备帧：固定 800×480、48000 字节，包含 Asia/Shanghai 当前日期、当前月学习日历、全部到期题数量和按日期稳定选择的本地励志语。支持强 ETag 与 If-None-Match 304。",
      operationId: "getEinkDashboard",
      parameters: [
        {
          name: "If-None-Match",
          in: "header",
          required: false,
          description: "上一次看板响应的强 ETag",
          schema: { type: "string" }
        }
      ],
      responses: {
        200: {
          description: "48000 字节无压缩看板帧",
          headers: {
            "Content-Length": {
              description: "固定为 48000",
              schema: { type: "integer", enum: [48000] }
            },
            ETag: {
              description: "基于最终看板帧内容计算的强校验值",
              schema: { type: "string" }
            },
            "X-Etag": {
              description: "与 ETag 相同的兼容头",
              schema: { type: "string" }
            },
            "Cache-Control": {
              schema: { type: "string", enum: ["no-transform"] }
            }
          },
          content: {
            "application/octet-stream": {
              schema: { type: "string", format: "binary" }
            }
          }
        },
        304: { description: "看板内容未变化，无响应体" }
      }
    }
  },
  "/api/eink/page": {
    get: {
      tags: ["墨水屏"],
      summary: "读取 800×480 1bpp 设备帧",
      description:
        "固定返回 48000 字节裸帧：每行 100 字节、MSB 在左、0=黑、1=白，不压缩。带 If-None-Match 命中时返回 304。不适配墨水屏单页的错题返回 409 JSON，不返回设备帧。",
      operationId: "getEinkPage",
      parameters: [
        {
          name: "id",
          in: "query",
          required: true,
          description: "错题编号",
          schema: { type: "integer", minimum: 1 }
        },
        {
          name: "mode",
          in: "query",
          required: false,
          description: "页面模式，缺省 question",
          schema: {
            type: "string",
            enum: ["question", "answer"],
            default: "question"
          }
        },
        {
          name: "If-None-Match",
          in: "header",
          required: false,
          description: "上一次响应的强 ETag",
          schema: { type: "string" }
        }
      ],
      responses: {
        200: {
          description: "48000 字节无压缩设备帧",
          headers: {
            "Content-Length": {
              description: "固定为 48000",
              schema: { type: "integer", enum: [48000] }
            },
            ETag: {
              description: "基于最终帧内容计算的强校验值",
              schema: { type: "string" }
            },
            "X-Etag": {
              description: "与 ETag 相同的兼容头",
              schema: { type: "string" }
            },
            "Cache-Control": {
              schema: { type: "string", enum: ["no-transform"] }
            }
          },
          content: {
            "application/octet-stream": {
              schema: { type: "string", format: "binary" }
            }
          }
        },
        304: { description: "内容未变化，无响应体" },
        400: errorResponse("id 或 mode 非法"),
        404: errorResponse("错题不存在", {
          error: "没有找到这道错题",
          code: "MISTAKE_NOT_FOUND"
        }),
        409: errorResponse("错题不适配墨水屏单页（PD-12）", {
          error: "不适配墨水屏单页",
          code: "EINK_UNFIT",
          reasons: ["EINK_UNFIT_TEXT"]
        })
      }
    }
  },
  "/api/eink/preview": {
    get: {
      tags: ["墨水屏"],
      summary: "读取设备帧对应的 PNG 预览",
      description:
        "返回 800×480 PNG，与同参数 page 帧逐像素一致；仅供人工查看和验收。不适配单页的错题返回标注“不适配墨水屏单页”的提示图，并带 X-Eink-Unfit: 1。",
      operationId: "getEinkPreview",
      parameters: [
        {
          name: "id",
          in: "query",
          required: true,
          description: "错题编号",
          schema: { type: "integer", minimum: 1 }
        },
        {
          name: "mode",
          in: "query",
          required: false,
          description: "页面模式，缺省 question",
          schema: {
            type: "string",
            enum: ["question", "answer"],
            default: "question"
          }
        }
      ],
      responses: {
        200: {
          ...binaryResponse(
            "与设备帧逐像素一致的 PNG 预览；不适配错题为“不适配墨水屏单页”提示图",
            "image/png"
          ),
          headers: {
            "X-Eink-Unfit": {
              description:
                "不适配提示图时为 1；正常预览不返回该响应头",
              schema: { type: "string", enum: ["1"] }
            }
          }
        },
        400: errorResponse("id 或 mode 非法"),
        404: errorResponse("错题不存在", {
          error: "没有找到这道错题",
          code: "MISTAKE_NOT_FOUND"
        })
      }
    }
  },
  "/api/operations/metrics": {
    get: {
      tags: ["运维"],
      summary: "读取运营指标",
      description:
        "返回模型调用、工具调用、Agent 运行、诊断降级率和成本估算。from/to 使用 ISO 8601；默认最近 7 天。",
      operationId: "getOperationsMetrics",
      parameters: [
        {
          name: "from",
          in: "query",
          required: false,
          description: "ISO 8601 起始时间",
          schema: { type: "string", format: "date-time" }
        },
        {
          name: "to",
          in: "query",
          required: false,
          description: "ISO 8601 结束时间",
          schema: { type: "string", format: "date-time" }
        },
        {
          name: "costPer1kInput",
          in: "query",
          required: false,
          schema: { type: "number", minimum: 0, default: 0 }
        },
        {
          name: "costPer1kOutput",
          in: "query",
          required: false,
          schema: { type: "number", minimum: 0, default: 0 }
        }
      ],
      responses: {
        200: jsonResponse("运营指标", ref("OperationsMetrics")),
        400: errorResponse("时间范围格式无效")
      }
    }
  },
  "/api/demo": {
    post: {
      tags: ["运维"],
      summary: "写入演示数据",
      description:
        "首次调用写入 5 道演示错题；已有错题时不会重复写入。仅用于开发/演示环境，不要在正式数据上调用。",
      operationId: "addDemoData",
      responses: {
        200: jsonResponse(
          "写入结果",
          {
            type: "object",
            required: ["added"],
            properties: { added: { type: "integer", minimum: 0 } },
            additionalProperties: true
          },
          { added: 5 }
        )
      }
    }
  },
  "/api/learning-data": {
    delete: {
      tags: ["运维"],
      summary: "删除全部学习数据（危险）",
      description:
        "删除全部错题、作答、提示、掌握证据、附件和审计数据。必须显式携带确认头；不可撤销，请先备份。",
      operationId: "deleteAllLearningData",
      "x-dangerous": true,
      parameters: [
        {
          name: "X-Confirm-Delete",
          in: "header",
          required: true,
          description: "固定值 DELETE_ALL_LEARNING_DATA",
          schema: {
            type: "string",
            enum: ["DELETE_ALL_LEARNING_DATA"]
          }
        }
      ],
      responses: {
        200: jsonResponse("删除统计", ref("DeleteAllResult")),
        400: errorResponse("缺少明确确认")
      }
    }
  }
});

Object.assign(paths, {
  "/api/questions": {
    get: {
      tags: ["题库"],
      summary: "列出统一题库题目",
      description:
        "默认返回全部题目；可用 category 按分类筛选。category=mistake 返回错题，包括没有分类记录的遗留题目。字段保持旧错题接口语义，只读取同一份正式题目数据。",
      operationId: "listQuestions",
      parameters: [
        {
          name: "category",
          in: "query",
          required: false,
          description: "题目分类，例如 mistake 或 normal；省略时返回全部题目。",
          schema: {
            type: "string",
            maxLength: 40,
            default: "all"
          }
        }
      ],
      responses: {
        200: jsonResponse("题库列表", ref("QuestionList"))
      }
    }
  },
  "/api/questions/{id}": {
    get: {
      tags: ["题库"],
      summary: "读取题目兼容详情",
      description:
        "返回题目兼容字段以及分类、标签、内容单元、选项、来源和图片派生关系。默认不返回正确答案和解析。",
      operationId: "getQuestion",
      parameters: [idParameter("题目编号")],
      responses: {
        200: jsonResponse("题目详情", ref("Question")),
        404: errorResponse("没有找到这道题目")
      }
    }
  },
  "/api/questions/scans": {
    post: {
      tags: ["题库"],
      summary: "创建扫描候选任务",
      description:
        "接收 1～3 张已上传图片。默认 single 模式直接使用现有单题 OCR+LLM；multi 模式只识别题目边界与题号，不提前分析小问和答案。候选默认不选；任务有效 24 小时。OCR/LLM 失败时保留图片并降级或不创建正式题目。",
      operationId: "createQuestionScan",
      requestBody: requestBody(ref("CreateQuestionScanInput")),
      responses: {
        201: jsonResponse("扫描任务", ref("QuestionScan")),
        400: errorResponse("图片数量或图片状态无效")
      }
    }
  },
  "/api/questions/scans/{id}": {
    get: {
      tags: ["题库"],
      summary: "读取扫描任务",
      description:
        "返回扫描任务、OCR 字块、候选、选择统计和有效期。过期任务只读。",
      operationId: "getQuestionScan",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          description: "扫描任务编号",
          schema: { type: "integer", minimum: 1 }
        }
      ],
      responses: {
        200: jsonResponse("扫描任务", ref("QuestionScan")),
        404: errorResponse("没有找到这次扫描任务")
      }
    }
  },
  "/api/questions/scans/{id}/selection": {
    post: {
      tags: ["题库"],
      summary: "批量调整候选选择",
      description:
        "全选只选内容完整候选并保留手动选择；全部错题只叠加完整且疑似错误项并保留手动选择；取消全选会清空包括手动项在内的全部选择。残缺候选不会被快捷选择自动选中。",
      operationId: "updateQuestionScanSelection",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          description: "扫描任务编号",
          schema: { type: "integer", minimum: 1 }
        }
      ],
      requestBody: requestBody(ref("QuestionScanSelectionInput")),
      responses: {
        200: jsonResponse("更新后的扫描任务", ref("QuestionScan")),
        400: errorResponse("选择操作无效或缺少候选编号"),
        409: errorResponse("扫描任务已失效")
      }
    }
  },
  "/api/questions/scans/{id}/candidates/{candidateId}": {
    patch: {
      tags: ["题库"],
      summary: "修改候选文字、区域或排除状态",
      description:
        "可修改候选题干、题型、学生答案、标准答案候选、相对框选区域，或排除/恢复候选。不能通过此接口创建正式题目。",
      operationId: "updateQuestionScanCandidate",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          description: "扫描任务编号",
          schema: { type: "integer", minimum: 1 }
        },
        {
          name: "candidateId",
          in: "path",
          required: true,
          description: "候选编号",
          schema: { type: "integer", minimum: 1 }
        }
      ],
      requestBody: requestBody(ref("UpdateQuestionScanCandidateInput")),
      responses: {
        200: jsonResponse("更新后的扫描任务", ref("QuestionScan")),
        400: errorResponse("文字、区域或排除参数无效"),
        404: errorResponse("没有找到这道候选题"),
        409: errorResponse("扫描任务已失效")
      }
    }
  },
  "/api/questions/scans/{id}/import": {
    post: {
      tags: ["题库"],
      summary: "导入用户确认的扫描候选",
      description:
        "只导入当前已选择候选；每道候选生成题目区域图片并写入现有统一题库。允许逐题部分成功，已导入候选不会重复创建。内容可能不完整时必须显式确认。",
      operationId: "importQuestionScan",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          description: "扫描任务编号",
          schema: { type: "integer", minimum: 1 }
        }
      ],
      requestBody: requestBody(ref("ImportQuestionScanInput")),
      responses: {
        200: jsonResponse(
          "逐题导入结果",
          {
            type: "object",
            required: [
              "scan",
              "successCount",
              "failedCount",
              "results"
            ],
            properties: {
              scan: ref("QuestionScan"),
              successCount: { type: "integer", minimum: 0 },
              failedCount: { type: "integer", minimum: 0 },
              results: {
                type: "array",
                items: { type: "object", additionalProperties: true }
              }
            },
            additionalProperties: false
          }
        ),
        400: errorResponse("未选择、候选未选中或残缺题未确认"),
        404: errorResponse("没有找到扫描任务"),
        409: errorResponse("扫描任务已失效或不可导入")
      }
    }
  },
  "/api/questions/scans/{id}/analyze": {
    post: {
      tags: ["题库"],
      summary: "逐题分析已勾选的多题边界",
      description:
        "仅用于 multi 扫描。对每个已勾选候选，按题目区域裁图并复用 single 模式的 OCR+LLM 流程分析小问、学生答案和标准答案。未勾选题不处理；逐题失败不影响其他题。",
      operationId: "analyzeQuestionScan",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          description: "扫描任务编号",
          schema: { type: "integer", minimum: 1 }
        }
      ],
      requestBody: requestBody(ref("AnalyzeQuestionScanInput")),
      responses: {
        200: jsonResponse(
          "逐题分析结果",
          {
            type: "object",
            required: ["scan", "analyzedCount", "failedCount", "results"],
            properties: {
              scan: ref("QuestionScan"),
              analyzedCount: { type: "integer", minimum: 0 },
              failedCount: { type: "integer", minimum: 0 },
              results: {
                type: "array",
                items: { type: "object", additionalProperties: true }
              }
            },
            additionalProperties: false
          }
        ),
        400: errorResponse("未勾选或候选编号无效"),
        404: errorResponse("没有找到扫描任务"),
        409: errorResponse("扫描任务已失效或不是多题扫描")
      }
    }
  },
  "/api/questions/scans/{id}/candidates/{candidateId}/image": {
    get: {
      tags: ["题库"],
      summary: "读取候选裁剪图",
      description:
        "按候选相对区域裁剪原图并返回 PNG；禁止缓存，不返回本地路径。",
      operationId: "getQuestionScanCandidateImage",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          description: "扫描任务编号",
          schema: { type: "integer", minimum: 1 }
        },
        {
          name: "candidateId",
          in: "path",
          required: true,
          description: "候选编号",
          schema: { type: "integer", minimum: 1 }
        }
      ],
      responses: {
        200: binaryResponse("候选裁剪图", "image/png"),
        404: errorResponse("没有找到候选图片")
      }
    }
  },
  "/api/vocab/items": {
    get: {
      tags: ["字词"],
      summary: "查询字词条目",
      description:
        "按学科和状态查询当前学生的生字词/单词条目，含排期档位、到期日与来源课文。",
      operationId: "listVocabItems",
      parameters: [
        {
          name: "subject",
          in: "query",
          required: false,
          description: "学科；缺省返回全部",
          schema: { type: "string", enum: ["chinese", "english"] }
        },
        {
          name: "status",
          in: "query",
          required: false,
          description: "状态；缺省或 all 返回全部",
          schema: { type: "string", enum: ["active", "mastered", "all"] }
        }
      ],
      responses: {
        200: jsonResponse("字词条目列表", ref("VocabItemsResponse"), {
          items: [],
          count: 0
        }),
        400: errorResponse("筛选参数无效")
      }
    },
    post: {
      tags: ["字词"],
      summary: "录入字词（单条或批量粘贴）",
      description:
        "录入生字词/英语单词并加入艾宾浩斯排期。支持单条 term、结构化 entries 数组或 text 批量粘贴；同学生同学科同词条按现有条目返回，不重复建卡。",
      operationId: "createVocabItems",
      requestBody: requestBody(ref("VocabItemsInput"), {
        example: {
          subject: "chinese",
          text: "山 shān\n水 shuǐ",
          listType: "会写"
        }
      }),
      responses: {
        201: jsonResponse(
          "录入结果",
          ref("VocabItemsCreated"),
          { created: 2, existing: 0, items: [] }
        ),
        400: errorResponse("词条或参数无效"),
        404: errorResponse("没有找到对应学科的教材单元或课文")
      }
    }
  },
  "/api/vocab/items/{id}": {
    patch: {
      tags: ["字词"],
      summary: "调整字词条目状态或到期日",
      description: "可手动标记 mastered 停排、恢复 active（按第 1 档重新开始）或指定到期日。",
      operationId: "updateVocabItem",
      parameters: [idParameter("字词条目编号")],
      requestBody: requestBody(ref("VocabItemPatch"), {
        example: { status: "mastered" }
      }),
      responses: {
        200: jsonResponse("更新后的条目", ref("VocabItem")),
        400: errorResponse("参数无效"),
        404: errorResponse("没有找到这个字词条目")
      }
    },
    delete: {
      tags: ["字词"],
      summary: "删除字词条目",
      description: "删除条目及其复习事件；词条主数据与教材挂载保留。",
      operationId: "deleteVocabItem",
      parameters: [idParameter("字词条目编号")],
      responses: {
        200: jsonResponse("删除成功", {
          type: "object",
          required: ["deleted"],
          properties: { deleted: { type: "boolean", const: true } },
          additionalProperties: false
        }),
        404: errorResponse("没有找到这个字词条目")
      }
    }
  },
  "/api/vocab/catalog": {
    get: {
      tags: ["字词"],
      summary: "读取学科教材目录",
      description:
        "按学科返回已有字词数据的教材、单元与课文三级目录，仅用于浏览选词；无数据的层级不返回。",
      operationId: "getVocabCatalog",
      parameters: [
        {
          name: "subject",
          in: "query",
          required: true,
          description: "学科",
          schema: { type: "string", enum: ["chinese", "english"] }
        }
      ],
      responses: {
        200: jsonResponse("教材目录", ref("VocabCatalog"), {
          textbooks: []
        }),
        400: errorResponse("subject 不是 chinese 或 english")
      }
    }
  },
  "/api/vocab/occurrences": {
    get: {
      tags: ["字词"],
      summary: "读取单元或课文的词条列表",
      description:
        "按单元或课文返回该学科的词条出现位置，含当前学生是否已入册（itemId 为 null 表示未入册）。语文返回字/词、课本拼音与释义；英语返回单词与中文释义。",
      operationId: "listVocabOccurrences",
      parameters: [
        {
          name: "subject",
          in: "query",
          required: true,
          description: "学科",
          schema: { type: "string", enum: ["chinese", "english"] }
        },
        {
          name: "unitId",
          in: "query",
          required: false,
          description: "教材单元编号；与 lessonId 至少提供一个",
          schema: { type: "integer", minimum: 1 }
        },
        {
          name: "lessonId",
          in: "query",
          required: false,
          description: "课文编号；提供时优先按课文过滤",
          schema: { type: "integer", minimum: 1 }
        }
      ],
      responses: {
        200: jsonResponse("词条列表", ref("VocabOccurrences"), {
          items: []
        }),
        400: errorResponse("参数无效或缺少 unitId/lessonId"),
        404: errorResponse("没有找到对应学科的教材单元或课文")
      }
    }
  },
  "/api/vocab/review/today": {
    get: {
      tags: ["字词"],
      summary: "今日到期复习清单",
      description:
        "到期优先、逾期最久在前；超出每日上限（默认 25，可配置 5～100）的条目顺延，不掺入未到期新词。只返回提示，不下发答案。可按学科过滤，计数仅统计该学科。",
      operationId: "getVocabReviewToday",
      parameters: [
        {
          name: "date",
          in: "query",
          required: false,
          description: "按指定日期模拟到期清单（YYYY-MM-DD），默认今天",
          schema: { type: "string", format: "date" }
        },
        {
          name: "subject",
          in: "query",
          required: false,
          description: "学科；缺省返回全部学科",
          schema: { type: "string", enum: ["chinese", "english"] }
        }
      ],
      responses: {
        200: jsonResponse("今日复习清单", ref("VocabReviewToday"), {
          date: "2026-11-28",
          dailyLimit: 25,
          dueCount: 0,
          deferredCount: 0,
          reviewedToday: 0,
          items: []
        }),
        400: errorResponse("日期格式无效")
      }
    }
  },
  "/api/vocab/reviews": {
    post: {
      tags: ["字词"],
      summary: "批量提交听写勾选结果",
      description:
        "人工勾选会/不会后批量提交。同日同条目重复提交按最后一次覆盖排期，历史事件全部保留。",
      operationId: "submitVocabReviews",
      requestBody: requestBody(ref("VocabReviewsInput"), {
        example: {
          reviews: [
            { itemId: 1, result: "correct", surface: "web" },
            { itemId: 2, result: "incorrect" }
          ]
        }
      }),
      responses: {
        200: jsonResponse("提交后的排期状态", ref("VocabReviewsResult"), {
          updated: []
        }),
        400: errorResponse("复习结果无效"),
        404: errorResponse("没有找到字词条目")
      }
    }
  },
  "/api/vocab/settings": {
    get: {
      tags: ["字词"],
      summary: "读取字词复习设置",
      operationId: "getVocabSettings",
      responses: {
        200: jsonResponse("字词设置", ref("VocabSettings"), {
          dailyLimit: 25,
          englishMode: "zh_to_en"
        })
      }
    },
    put: {
      tags: ["字词"],
      summary: "更新字词复习设置",
      description: "每日复习上限 5～100；英语听写模式 zh_to_en（默认）或 en_to_zh。",
      operationId: "updateVocabSettings",
      requestBody: requestBody(ref("VocabSettingsInput"), {
        example: { dailyLimit: 30, englishMode: "en_to_zh" }
      }),
      responses: {
        200: jsonResponse("更新后的字词设置", ref("VocabSettings")),
        400: errorResponse("设置值无效")
      }
    }
  },
  "/api/vocab/dictation": {
    get: {
      tags: ["字词"],
      summary: "获取听写出题提示",
      description:
        "语文显示课本拼音（多音字用 occurrence.pinyin_in_book），英语按模式显示中文或英文；答案始终不下发。缺省取今日到期清单，指定 unitId/lessonId 时按教材挂载出题。",
      operationId: "getVocabDictation",
      parameters: [
        {
          name: "subject",
          in: "query",
          required: true,
          description: "学科",
          schema: { type: "string", enum: ["chinese", "english"] }
        },
        {
          name: "mode",
          in: "query",
          required: false,
          description: "英语听写模式；缺省读系统设置",
          schema: { type: "string", enum: ["zh_to_en", "en_to_zh"] }
        },
        {
          name: "unitId",
          in: "query",
          required: false,
          description: "教材单元编号",
          schema: { type: "integer", minimum: 1 }
        },
        {
          name: "lessonId",
          in: "query",
          required: false,
          description: "课文编号",
          schema: { type: "integer", minimum: 1 }
        }
      ],
      responses: {
        200: jsonResponse("听写提示列表", ref("VocabDictation"), {
          subject: "chinese",
          mode: "pinyin_to_hanzi",
          items: []
        }),
        400: errorResponse("参数无效"),
        404: errorResponse("没有找到对应学科的教材单元或课文")
      }
    }
  }
});
const INFO_DESCRIPTION = [
  "子鱼学习AI 的本地学习数据 HTTP API，覆盖教材、字词、附件、错题、题库、复习、知识库、反馈和运维。",
  "",
  "### 接入前须知",
  "",
  "- 当前服务未内置账号体系或 API Key。默认只监听 `127.0.0.1`；对第三方开放时请放在反向代理/API 网关之后，并补上 TLS、鉴权和访问日志。",
  "- 浏览器跨域调用默认不被允许；第三方前端应使用同源代理或服务端调用。",
  "- 正式路径不带尾斜杠。服务兼容 `/api/.../` 写法；`/api`、`/api-docs`、`/docs` 会 308 重定向到 `/api/docs`，`/openapi.json` 会重定向到 `/api/openapi.json`。",
  "- 所有 JSON 错误统一为 `{ error, code? }`；路由不存在时为 404 + `ROUTE_NOT_FOUND`。",
  "- 写接口使用 `Idempotency-Key` 时，同键重放返回首次结果；不同请求复用同键会冲突。",
  "- 图片上传、裁剪使用图片二进制请求体；读取图片返回二进制，不返回本地路径。",
  "- 单图 OCR 和批量扫描只调用同一部署环境内的 OCR Service，不发送给外部多模态模型，也不需要额外同意参数。",
  "- `DELETE /api/learning-data` 会不可逆删除全部学习数据，调用前必须先备份。",
  "",
  "### 推荐接入流程",
  "",
  "1. `GET /api/health` 检查服务；`GET /api/bootstrap` 读取当前学生和教材。",
  "2. 文字题直接 `POST /api/mistakes`；图片题先 `POST /api/attachments`，再带 `attachmentIds` 保存。",
  "3. 作业页可先 `POST /api/questions/scans` 生成候选；`single` 直接分析，`multi` 勾选后调用 `/analyze`，再通过 `/import` 写入统一题库。",
  "4. 通过 `GET /api/review/queue` 取题，`POST /api/mistakes/{id}/attempts` 提交作答。",
  "5. 使用 `GET /api/feedback/daily`、`/weekly`、`/calendar` 和 `/day` 展示学习反馈。"
].join("\n");

export function buildOpenApiDocument({
  baseUrl = "/",
  version = "0.22.0"
} = {}) {
  return {
    openapi: "3.1.0",
    info: {
      title: "子鱼学习AI 学习数据 API",
      version,
      summary: "面向第三方集成的学习数据只读/写入接口",
      description: INFO_DESCRIPTION,
      contact: { name: "子鱼学习AI" }
    },
    servers: [
      {
        url: baseUrl,
        description: "当前部署（由请求 Host 动态生成）"
      }
    ],
    tags: TAGS,
    paths,
    components,
    "x-api-audience": "third-party",
    "x-authentication": "none",
    "x-idempotency-header": "Idempotency-Key"
  };
}

export { TAGS };
