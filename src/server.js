import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRepository } from "./database.js";
import { createLearningTools } from "./tools/index.js";
import {
  createDiagnosisAgent,
  createGatewayFromEnvironment,
  createTutoringAgent,
  diagnosisOutputSchema
} from "./llm/index.js";
import { validateAndNormalize } from "./tools/schema.js";
import { loadEnvFile } from "./environment.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, "..");
loadEnvFile(path.join(projectRoot, ".env"));
const publicDir = path.join(projectRoot, "public");
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
const databasePath =
  process.env.DB_PATH || path.join(projectRoot, "data", "learning.sqlite");
const repository = createRepository(databasePath);
const learningTools = createLearningTools(repository);
const llmGateway = createGatewayFromEnvironment(process.env);
const diagnosisAgent = createDiagnosisAgent({
  repository,
  tools: learningTools,
  gateway: llmGateway
});
const tutoringAgent = createTutoringAgent({
  repository,
  tools: learningTools,
  gateway: llmGateway
});

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};
const EDIT_SESSION_TTL_MS = 2 * 60 * 1000;
const REVIEW_SESSION_TTL_MS = 30 * 60 * 1000;
const editSessions = new Map();
const reviewSessions = new Map();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) {
      throw new HttpError(413, "请求内容过大");
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "请求内容不是有效的 JSON");
  }
}

function requireText(value, field, maxLength = 3000) {
  const text = String(value || "").trim();
  if (!text) {
    throw new HttpError(400, `请填写${field}`);
  }
  if (text.length > maxLength) {
    throw new HttpError(400, `${field}内容过长`);
  }
  return text;
}

function optionalText(value, maxLength = 3000) {
  const text = String(value || "").trim();
  if (text.length > maxLength) {
    throw new HttpError(400, "输入内容过长");
  }
  return text;
}

function parseCalendarDate(value, fallback = new Date()) {
  const text = String(value || "").trim();
  if (!text) {
    return new Date(
      fallback.getFullYear(),
      fallback.getMonth(),
      fallback.getDate()
    );
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) {
    throw new HttpError(400, "日期格式应为 YYYY-MM-DD");
  }
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3])
  );
  if (
    date.getFullYear() !== Number(match[1]) ||
    date.getMonth() !== Number(match[2]) - 1 ||
    date.getDate() !== Number(match[3])
  ) {
    throw new HttpError(400, "日期无效");
  }
  return date;
}

function dayBounds(date) {
  const start = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    0,
    0,
    0,
    0
  );
  const end = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    23,
    59,
    59,
    999
  );
  return { from: start.toISOString(), to: end.toISOString() };
}

function optionalKnowledgePoint(value) {
  const name = optionalText(value, 100);
  if (name && !repository.getKnowledgePoint(name)) {
    throw new HttpError(400, "指定知识点不在当前知识目录中");
  }
  return name || null;
}

function parseId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new HttpError(400, "题目编号无效");
  }
  return id;
}

function issueEditSession(mistakeId, context) {
  const token = randomUUID();
  editSessions.set(token, {
    mistakeId,
    context,
    expiresAt: Date.now() + EDIT_SESSION_TTL_MS
  });
  return {
    token,
    expiresAt: new Date(
      Date.now() + EDIT_SESSION_TTL_MS
    ).toISOString()
  };
}

function consumeEditSession(token, mistakeId) {
  const session = editSessions.get(token);
  editSessions.delete(token);
  if (
    !session ||
    session.expiresAt <= Date.now() ||
    session.mistakeId !== mistakeId
  ) {
    return null;
  }
  return session;
}

function issueReviewSession(mistakeId) {
  const id = randomUUID();
  reviewSessions.set(id, {
    mistakeId,
    answered: false,
    expiresAt: Date.now() + REVIEW_SESSION_TTL_MS
  });
  return id;
}

function getReviewSession(id, mistakeId) {
  const session = reviewSessions.get(id);
  if (
    !session ||
    session.expiresAt <= Date.now() ||
    session.mistakeId !== mistakeId
  ) {
    if (session) reviewSessions.delete(id);
    return null;
  }
  return session;
}

function markReviewSessionAnswered(id, mistakeId) {
  const session = getReviewSession(id, mistakeId);
  if (!session) return false;
  session.answered = true;
  return true;
}

const ANSWER_TYPES = new Set([
  "auto",
  "text",
  "number",
  "fraction",
  "percent",
  "ratio"
]);
const COMPARISON_RULES = new Set([
  "auto",
  "exact",
  "numeric",
  "ratio",
  "text"
]);

function parseMistakeParts(
  value,
  { required = false, requireAnswers = true } = {}
) {
  if (value === undefined) {
    if (required) {
      throw new HttpError(400, "请至少添加一个小问");
    }
    return undefined;
  }
  if (Array.isArray(value) && value.length === 0 && !required) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.length || value.length > 20) {
    throw new HttpError(400, "小问数量必须在 1～20 之间");
  }
  return value.map((part, index) => {
    if (!part || typeof part !== "object") {
      throw new HttpError(400, `第 ${index + 1} 个小问格式无效`);
    }
    const acceptedAnswers = Array.isArray(part.acceptedAnswers)
      ? part.acceptedAnswers
          .map((answer) => optionalText(answer, 1000))
          .filter(Boolean)
      : [];
    if (requireAnswers && !acceptedAnswers.length) {
      throw new HttpError(400, `第 ${index + 1} 个小问缺少答案`);
    }
    const answerType = String(part.answerType || "auto");
    const comparisonRule = String(part.comparisonRule || "auto");
    if (!ANSWER_TYPES.has(answerType)) {
      throw new HttpError(400, `第 ${index + 1} 个小问答案类型无效`);
    }
    if (!COMPARISON_RULES.has(comparisonRule)) {
      throw new HttpError(400, `第 ${index + 1} 个小问比较规则无效`);
    }
    return {
      label: optionalText(part.label, 200),
      prompt: optionalText(part.prompt, 2000),
      studentAnswer: optionalText(part.studentAnswer, 1000),
      answerType,
      comparisonRule,
      knowledgePoint: optionalText(part.knowledgePoint, 100),
      hint: optionalText(part.hint, 2000),
      explanation: optionalText(part.explanation, 3000),
      acceptedAnswers
    };
  });
}

function parseAttemptAnswers(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.length || value.length > 20) {
    throw new HttpError(400, "作答小问数量必须在 1～20 之间");
  }
  return value.map((item) => {
    const partId = parseId(item?.partId);
    return {
      partId,
      value: optionalText(item?.value, 3000)
    };
  });
}

function parseConfirmedDiagnosis(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "诊断信息格式无效");
  }
  const normalized = validateAndNormalize(
    {
      knowledgePoint: value.knowledgePoint,
      errorType: value.errorType,
      errorStep: value.errorStep,
      missingConcept: value.missingConcept,
      initialHint: value.initialHint || value.hint,
      confidence: value.confidence,
      evidence: value.evidence,
      knowledgeSources: value.knowledgeSources,
      ...(value.partAnalyses
        ? { partAnalyses: value.partAnalyses }
        : {})
    },
    diagnosisOutputSchema
  );
  return {
    ...normalized,
    source: String(value.source || "llm"),
    provider: optionalText(value.provider, 100),
    model: optionalText(value.model, 200),
    promptVersion: optionalText(value.promptVersion, 100),
    agentRunId:
      Number.isInteger(value.agentRunId) && value.agentRunId > 0
        ? value.agentRunId
        : null,
    contextHash: optionalText(value.contextHash, 128),
    rawOutput: value.rawOutput || normalized
  };
}

function diagnosisContextHash(input) {
  const canonical = input.parts?.length
    ? {
        question: input.question,
        analysis: input.analysis || "",
        parts: input.parts.map((part) => ({
          label: part.label,
          prompt: part.prompt,
          studentAnswer: part.studentAnswer,
          answerType: part.answerType,
          comparisonRule: part.comparisonRule,
          knowledgePoint: part.knowledgePoint,
          acceptedAnswers: part.acceptedAnswers
        }))
      }
    : {
        question: input.question,
        studentAnswer: input.studentAnswer || "",
        correctAnswer: input.correctAnswer || "",
        analysis: input.analysis || ""
      };
  return createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex");
}

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/health") {
    return sendJson(response, 200, {
      ok: true,
      schemaVersion: repository.getSchemaVersion(),
      toolCount: learningTools.listTools("ui").length
    });
  }

  if (request.method === "GET" && url.pathname === "/api/tools") {
    return sendJson(response, 200, {
      tools: learningTools.listTools("ui")
    });
  }

  if (request.method === "GET" && url.pathname === "/api/ai/status") {
    return sendJson(response, 200, diagnosisAgent.status());
  }

  if (request.method === "POST" && url.pathname === "/api/ai/test") {
    return sendJson(response, 200, await diagnosisAgent.testConnection());
  }

  if (request.method === "GET" && url.pathname === "/api/bootstrap") {
    return sendJson(response, 200, {
      student: repository.getStudent(),
      knowledgePoints: repository.getKnowledgePoints()
    });
  }

  if (request.method === "GET" && url.pathname === "/api/dashboard") {
    return sendJson(response, 200, repository.getDashboard());
  }

  if (request.method === "GET" && url.pathname === "/api/feedback/daily") {
    const date = parseCalendarDate(url.searchParams.get("date"));
    const bounds = dayBounds(date);
    return sendJson(
      response,
      200,
      repository.buildDailySummary({
        ...bounds,
        knowledgePoint: optionalKnowledgePoint(
          url.searchParams.get("knowledgePoint")
        ),
        at: new Date().toISOString()
      })
    );
  }

  if (request.method === "GET" && url.pathname === "/api/feedback/weekly") {
    const endDate = parseCalendarDate(url.searchParams.get("end"));
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - 6);
    const startBounds = dayBounds(startDate);
    const endBounds = dayBounds(endDate);
    return sendJson(
      response,
      200,
      repository.buildWeeklyReport({
        from: startBounds.from,
        to: endBounds.to,
        knowledgePoint: optionalKnowledgePoint(
          url.searchParams.get("knowledgePoint")
        ),
        at: new Date().toISOString()
      })
    );
  }

  if (request.method === "GET" && url.pathname === "/api/knowledge-points") {
    return sendJson(response, 200, repository.getKnowledgeSummary());
  }

  if (request.method === "GET" && url.pathname === "/api/knowledge-base") {
    return sendJson(response, 200, {
      stats: repository.getKnowledgeBaseStats(),
      cards: repository.getKnowledgeCards()
    });
  }

  if (
    request.method === "GET" &&
    url.pathname === "/api/knowledge-base/search"
  ) {
    const query = optionalText(url.searchParams.get("q"), 500);
    if (!query) {
      throw new HttpError(400, "请输入要检索的内容");
    }
    const limit = Math.max(
      1,
      Math.min(5, Number(url.searchParams.get("limit") || 3))
    );
    return sendJson(
      response,
      200,
      repository.searchKnowledge({ query, limit })
    );
  }

  const knowledgeCardMatch = url.pathname.match(
    /^\/api\/knowledge-base\/([A-Za-z0-9-]+|\d+)$/
  );
  if (knowledgeCardMatch && request.method === "GET") {
    const card = repository.getKnowledgeCard(knowledgeCardMatch[1]);
    if (!card) throw new HttpError(404, "没有找到这张知识卡片");
    return sendJson(response, 200, card);
  }

  if (request.method === "GET" && url.pathname === "/api/mistakes") {
    return sendJson(
      response,
      200,
      repository.listMistakes({
        status: url.searchParams.get("status") || "all"
      })
    );
  }

  if (request.method === "POST" && url.pathname === "/api/mistakes") {
    const body = await readJson(request);
    const parts = parseMistakeParts(body.parts);
    const correctAnswer = Object.hasOwn(body, "correctAnswer")
      ? requireText(body.correctAnswer, "正确答案", 1000)
      : parts?.[0]?.acceptedAnswers?.[0];
    if (!correctAnswer) {
      throw new HttpError(400, "请填写正确答案或小问答案");
    }
    const input = {
      question: requireText(body.question, "题目"),
      studentAnswer: optionalText(body.studentAnswer),
      correctAnswer,
      analysis: optionalText(body.analysis),
      knowledgePoint: optionalText(body.knowledgePoint, 100),
      errorType: optionalText(body.errorType, 100),
      ...(parts ? { parts } : {})
    };
    input.confirmedDiagnosis = parseConfirmedDiagnosis(body.diagnosis);
    if (input.confirmedDiagnosis) {
      if (!input.confirmedDiagnosis.contextHash) {
        throw new HttpError(409, "诊断缺少题目绑定信息，请重新诊断");
      }
      if (
        input.confirmedDiagnosis.contextHash !==
        diagnosisContextHash(input)
      ) {
        throw new HttpError(409, "题目或答案已变化，请重新诊断后再保存");
      }
    }
    const created = repository.createMistake(input);
    return sendJson(response, 201, {
      ...created,
      reviewSessionId: issueReviewSession(created.id)
    });
  }

  if (request.method === "POST" && url.pathname === "/api/diagnose") {
    const body = await readJson(request);
    const question = optionalText(body.question);
    if (!question) {
      throw new HttpError(400, "请填写题目");
    }
    const diagnosisParts = (
      parseMistakeParts(body.parts, { requireAnswers: false }) || []
    ).map((part, index) => ({
      ...part,
      partNo: index + 1
    }));
    const diagnosisInput = {
      question,
      studentAnswer: optionalText(body.studentAnswer),
      correctAnswer: optionalText(body.correctAnswer),
      analysis: optionalText(body.analysis),
      knowledgePoint: optionalText(body.knowledgePoint, 100),
      errorType: optionalText(body.errorType, 100),
      parts: diagnosisParts
    };
    const diagnosis = await diagnosisAgent.diagnose(diagnosisInput);
    return sendJson(response, 200, {
      ...diagnosis,
      contextHash: diagnosisContextHash(diagnosisInput)
    });
  }

  if (request.method === "GET" && url.pathname === "/api/review/next") {
    const next = repository.getNextReview();
    if (!next) return sendJson(response, 200, null);
    const review = repository.getMistake(next.id, {
      includeSolution: false
    });
    return sendJson(response, 200, {
      ...review,
      reviewSessionId: issueReviewSession(next.id)
    });
  }

  if (request.method === "GET" && url.pathname === "/api/review/queue") {
    const limit = Math.max(
      1,
      Math.min(20, Number(url.searchParams.get("limit") || 5))
    );
    const items = repository.listDueReviews({ limit });
    return sendJson(response, 200, { items, count: items.length });
  }

  if (request.method === "POST" && url.pathname === "/api/demo") {
    return sendJson(response, 200, repository.addDemoData());
  }

  const mistakeMatch = url.pathname.match(/^\/api\/mistakes\/(\d+)$/);
  if (mistakeMatch && request.method === "GET") {
    const mistake = repository.getMistake(parseId(mistakeMatch[1]), {
      includeSolution: false
    });
    if (!mistake) throw new HttpError(404, "没有找到这道错题");
    return sendJson(response, 200, mistake);
  }

  const evidenceMatch = url.pathname.match(
    /^\/api\/mistakes\/(\d+)\/evidence$/
  );
  if (evidenceMatch && request.method === "GET") {
    const mistakeId = parseId(evidenceMatch[1]);
    const mistake = repository.getMistake(mistakeId, {
      includeSolution: false
    });
    if (!mistake) throw new HttpError(404, "没有找到这道错题");
    return sendJson(response, 200, {
      mistakeId,
      currentStatus: mistake.status,
      schedule: repository.getActiveReviewSchedule(mistakeId),
      evidence: repository.getMasteryEvidence(mistakeId)
    });
  }

  const editSessionMatch = url.pathname.match(
    /^\/api\/mistakes\/(\d+)\/edit-session$/
  );
  if (editSessionMatch && request.method === "POST") {
    const body = await readJson(request);
    if (body.confirmed !== true) {
      throw new HttpError(400, "请先确认进入题目修正流程");
    }
    const mistakeId = parseId(editSessionMatch[1]);
    const mistake = repository.getMistake(mistakeId, {
      includeSolution: false
    });
    if (!mistake) throw new HttpError(404, "没有找到这道错题");
    const context =
      body.context === "review" ? "review" : "mistake-library";
    if (context === "review" && mistake.attemptCount < 1) {
      throw new HttpError(409, "请先完成本次作答，再查看答案并修正题目");
    }
    if (context === "review") {
      const reviewSession = getReviewSession(
        body.reviewSessionId,
        mistakeId
      );
      if (!reviewSession?.answered) {
        throw new HttpError(409, "请先完成本次作答，再查看答案并修正题目");
      }
    }
    return sendJson(
      response,
      200,
      issueEditSession(mistakeId, context)
    );
  }

  const editMatch = url.pathname.match(/^\/api\/mistakes\/(\d+)\/edit$/);
  if (editMatch && request.method === "GET") {
    const mistakeId = parseId(editMatch[1]);
    const token = request.headers["x-edit-session"];
    if (!token || !consumeEditSession(token, mistakeId)) {
      throw new HttpError(
        403,
        "题目修正会话无效或已过期，请重新进入修正流程"
      );
    }
    const mistake = repository.getMistake(mistakeId, {
      includeSolution: true
    });
    if (!mistake) throw new HttpError(404, "没有找到这道错题");
    return sendJson(response, 200, mistake);
  }

  if (mistakeMatch && request.method === "PATCH") {
    const body = await readJson(request);
    const input = {};
    if (Object.hasOwn(body, "question")) {
      input.question = requireText(body.question, "题目");
    }
    if (Object.hasOwn(body, "studentAnswer")) {
      input.studentAnswer = optionalText(body.studentAnswer, 1000);
    }
    const parts = parseMistakeParts(body.parts);
    if (parts) input.parts = parts;
    if (Object.hasOwn(body, "correctAnswer") && !parts) {
      input.correctAnswer = requireText(body.correctAnswer, "正确答案", 1000);
    }
    if (Object.hasOwn(body, "analysis")) {
      input.analysis = optionalText(body.analysis);
    }
    if (Object.hasOwn(body, "knowledgePoint")) {
      input.knowledgePoint = requireText(body.knowledgePoint, "知识点", 100);
    }
    if (Object.hasOwn(body, "errorType")) {
      input.errorType = requireText(body.errorType, "错因", 100);
    }

    const result = await learningTools.invoke(
      "update_mistake",
      {
        mistakeId: parseId(mistakeMatch[1]),
        ...input
      },
      {
        caller: "ui",
        idempotencyKey: request.headers["idempotency-key"]
      }
    );
    const mistake = repository.getMistake(result.mistakeId, {
      includeSolution: true
    });
    return sendJson(response, 200, {
      ...result,
      mistake
    });
  }

  if (mistakeMatch && request.method === "DELETE") {
    const deleted = repository.deleteMistake(parseId(mistakeMatch[1]));
    if (!deleted) throw new HttpError(404, "没有找到这道错题");
    return sendJson(response, 200, { deleted: true });
  }

  const attemptMatch = url.pathname.match(
    /^\/api\/mistakes\/(\d+)\/attempts$/
  );
  if (attemptMatch && request.method === "POST") {
    const body = await readJson(request);
    const answers = parseAttemptAnswers(body.answers);
    const result = await tutoringAgent.submitAttempt({
      mistakeId: parseId(attemptMatch[1]),
      answer: optionalText(body.answer),
      answers,
      independent:
        typeof body.independent === "boolean" ? body.independent : null,
      hintLevel: Number.isInteger(body.hintLevel) ? body.hintLevel : 0
    });
    const reviewSessionId = request.headers["x-review-session"];
    if (reviewSessionId) {
      markReviewSessionAnswered(
        reviewSessionId,
        parseId(attemptMatch[1])
      );
    }
    return sendJson(response, 200, result);
  }

  const reviewMatch = url.pathname.match(/^\/api\/review\/(\d+)$/);
  if (reviewMatch && request.method === "GET") {
    const mistake = repository.getMistake(parseId(reviewMatch[1]), {
      includeSolution: false
    });
    if (!mistake) throw new HttpError(404, "没有找到这道错题");
    return sendJson(response, 200, {
      ...mistake,
      reviewSessionId: issueReviewSession(mistake.id)
    });
  }

  const hintMatch = url.pathname.match(/^\/api\/review\/(\d+)\/hints$/);
  if (hintMatch && request.method === "POST") {
    const body = await readJson(request);
    const level = Number(body.level);
    if (!Number.isInteger(level) || level < 1 || level > 4) {
      throw new HttpError(400, "提示等级必须为 1～4");
    }
    const idempotencyKey = request.headers["idempotency-key"];
    if (!idempotencyKey) {
      throw new HttpError(400, "提示请求缺少幂等键");
    }
    return sendJson(
      response,
      200,
      await tutoringAgent.getHint({
        mistakeId: parseId(hintMatch[1]),
        level,
        partId:
          body.partId === undefined ? null : parseId(body.partId),
        idempotencyKey
      })
    );
  }

  const followUpMatch = url.pathname.match(
    /^\/api\/review\/(\d+)\/follow-up$/
  );
  if (followUpMatch && request.method === "POST") {
    const body = await readJson(request);
    const question = requireText(body.question, "追问", 2000);
    const idempotencyKey = request.headers["idempotency-key"];
    if (!idempotencyKey) {
      throw new HttpError(400, "追问请求缺少幂等键");
    }
    return sendJson(
      response,
      200,
      await tutoringAgent.followUp({
        mistakeId: parseId(followUpMatch[1]),
        question,
        level: Number.isInteger(body.hintLevel) ? body.hintLevel : 1,
        partId:
          body.partId === undefined ? null : parseId(body.partId),
        idempotencyKey
      })
    );
  }

  throw new HttpError(404, "接口不存在");
}

async function serveStatic(response, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const resolved = path.resolve(publicDir, `.${requested}`);
  if (!resolved.startsWith(`${publicDir}${path.sep}`)) {
    throw new HttpError(403, "禁止访问");
  }

  try {
    const content = await fs.readFile(resolved);
    response.writeHead(200, {
      "Content-Type":
        MIME_TYPES[path.extname(resolved).toLowerCase()] ||
        "application/octet-stream",
      "Cache-Control": "no-cache"
    });
    response.end(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new HttpError(404, "页面不存在");
    }
    throw error;
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
    } else if (request.method === "GET") {
      await serveStatic(response, decodeURIComponent(url.pathname));
    } else {
      throw new HttpError(405, "不支持该请求");
    }
  } catch (error) {
    const status =
      error instanceof HttpError
        ? error.status
        : Number.isInteger(error.status)
          ? error.status
          : 500;
    if (status === 500) {
      console.error(error);
    }
    if (!response.headersSent) {
      sendJson(response, status, {
        error:
          error instanceof HttpError || error.code
            ? error.message
            : "服务器暂时出错",
        ...(error.code ? { code: error.code } : {})
      });
    }
  }
});

server.listen(port, host, () => {
  console.log(`数学错题教练已启动：http://${host}:${port}`);
  console.log(`数据文件：${databasePath}`);
});

function shutdown() {
  server.close(() => {
    repository.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
