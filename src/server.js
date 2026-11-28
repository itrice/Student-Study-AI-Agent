import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
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
import {
  AttachmentStore,
  MAX_ATTACHMENT_BYTES
} from "./attachments.js";
import { scheduleAttachmentCleanup } from "./attachment-cleanup.js";
import { extractAttachmentText } from "./attachment-service.js";
import {
  clearAttachmentCrop,
  readAttachmentContent,
  saveAttachmentCrop
} from "./attachment-crop.js";
import {
  EinkPageService,
  etagMatches
} from "./eink/service.js";
import {
  parseDateKey,
  parseMonthKey,
  shanghaiDateKey,
  shanghaiMonthKey
} from "./feedback-calendar.js";
import { buildOpenApiDocument } from "./openapi.js";
import {
  createInternalOcrTextExtractorFromEnvironment,
  createQuestionScannerFromEnvironment,
  QuestionScanError
} from "./question-bank/scanner.js";
import {
  analyzeQuestionScan,
  confirmQuestionScanBoxes,
  createQuestionScan,
  importQuestionScan
} from "./question-bank/scan-service.js";
import { createVocabStore } from "./vocab/store.js";
import {
  parseDateKey as parseVocabDateKey,
  toDateKey
} from "./vocab/schedule.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, "..");
loadEnvFile(path.join(projectRoot, ".env"));
const publicDir = path.join(projectRoot, "public");
const port = Number(process.env.PORT || 3000);
const serverStartedAt = new Date().toISOString();
const host = process.env.HOST || "127.0.0.1";
const databasePath =
  process.env.DB_PATH || path.join(projectRoot, "data", "learning.sqlite");
const attachmentsDirectory = process.env.ATTACHMENTS_DIR
  ? path.resolve(process.env.ATTACHMENTS_DIR)
  : undefined;
const repository = createRepository(databasePath, {
  attachmentDirectory: attachmentsDirectory
});
const vocabStore = createVocabStore(repository.db);
const learningTools = createLearningTools(repository);
const llmGateway = createGatewayFromEnvironment(process.env);
const attachmentStore = new AttachmentStore({
  directory: repository.attachmentDirectory
});
const einkPageService = new EinkPageService({
  repository,
  attachmentStore
});
const internalOcrTextExtractor =
  createInternalOcrTextExtractorFromEnvironment(process.env);
const questionScanner = createQuestionScannerFromEnvironment(process.env, {
  gateway: llmGateway
});
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

const API_DOCS_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; " +
    "script-src 'self'; connect-src 'self'; base-uri 'none'; " +
    "form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cache-Control": "no-cache"
};

const API_DOC_REDIRECTS = new Map([
  ["/api", "/api/docs"],
  ["/api-docs", "/api/docs"],
  ["/api-docs/", "/api/docs"],
  ["/docs", "/api/docs"],
  ["/docs/", "/api/docs"],
  ["/openapi.json", "/api/openapi.json"],
  ["/openapi.json/", "/api/openapi.json"]
]);

class HttpError extends Error {
  constructor(status, message, { code = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(value));
}

function firstHeaderValue(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  return String(raw || "").split(",")[0].trim();
}

function requestBaseUrl(request) {
  const forwardedProto = firstHeaderValue(
    request.headers["x-forwarded-proto"]
  );
  const forwardedHost = firstHeaderValue(
    request.headers["x-forwarded-host"]
  );
  const host = forwardedHost || firstHeaderValue(request.headers.host);
  const protocol = forwardedProto === "https" ? "https" : "http";
  if (!host || !/^[A-Za-z0-9._:[\]-]+$/.test(host)) return "/";
  return `${protocol}://${host}`;
}

function canonicalApiPathname(pathname) {
  if (!pathname.startsWith("/api/")) return pathname;
  return pathname.replace(/\/+$/, "");
}

function sendRedirect(response, location) {
  response.writeHead(308, {
    Location: location,
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(`Redirecting to ${location}\n`);
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

async function readBinary(request, maxBytes = MAX_ATTACHMENT_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new HttpError(413, "图片不能超过 8 MB");
    }
    chunks.push(chunk);
  }
  if (!size) throw new HttpError(400, "请选择一张图片");
  return Buffer.concat(chunks);
}

function parseAttachmentIds(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new HttpError(400, "图片附件列表格式无效");
  }
  return value.map((id) => parseId(id));
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

function parseEinkId(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) {
    throw new HttpError(400, "题目编号必须是正整数");
  }
  const id = Number(text);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new HttpError(400, "题目编号必须是正整数");
  }
  return id;
}

function parseEinkLimit(value) {
  if (value === null) return 20;
  const text = String(value);
  if (!/^\d+$/.test(text)) {
    throw new HttpError(400, "limit 必须是 1～20 的整数");
  }
  const limit = Number(text);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new HttpError(400, "limit 必须是 1～20 的整数");
  }
  return limit;
}

function parseEinkMode(value) {
  if (value === null) return "question";
  if (value === "question" || value === "answer") return value;
  throw new HttpError(400, "mode 只能是 question 或 answer");
}

const VOCAB_SUBJECTS = new Set(["chinese", "english"]);
const VOCAB_ITEM_STATUSES = new Set(["active", "mastered"]);
const VOCAB_ENGLISH_MODES = new Set(["zh_to_en", "en_to_zh"]);
const VOCAB_LIST_TYPES = {
  chinese: new Set(["会认", "会写", "词语"]),
  english: new Set(["单词", "短语"])
};

function currentVocabStudentId() {
  const student = repository.getStudent();
  if (!student) throw new HttpError(400, "缺少默认学生，无法使用字词模块");
  return student.id;
}

function parseVocabSubject(value) {
  const subject = String(value ?? "").trim();
  if (!VOCAB_SUBJECTS.has(subject)) {
    throw new HttpError(400, "subject 只能是 chinese 或 english");
  }
  return subject;
}

function parseVocabStatus(value) {
  const status = String(value ?? "").trim();
  if (!VOCAB_ITEM_STATUSES.has(status)) {
    throw new HttpError(400, "status 只能是 active 或 mastered");
  }
  return status;
}

function parseVocabEnglishMode(value) {
  const mode = String(value ?? "").trim();
  if (!VOCAB_ENGLISH_MODES.has(mode)) {
    throw new HttpError(400, "english_mode 只能是 zh_to_en 或 en_to_zh");
  }
  return mode;
}

function parseVocabListType(subject, value) {
  const listType =
    String(value ?? "").trim() || (subject === "chinese" ? "会写" : "单词");
  if (!VOCAB_LIST_TYPES[subject].has(listType)) {
    throw new HttpError(
      400,
      subject === "chinese"
        ? "list_type 只能是 会认、会写 或 词语"
        : "list_type 只能是 单词 或 短语"
    );
  }
  return listType;
}

function parseVocabItemId(value, field = "条目编号") {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new HttpError(400, `${field}无效`);
  }
  return id;
}

function parseVocabOptionalId(value) {
  if (value === undefined || value === null || value === "") return null;
  return parseVocabItemId(value, "编号");
}

function parseVocabDueAt(value) {
  const dueAt = parseVocabDateKey(value);
  if (!dueAt) throw new HttpError(400, "到期日期格式应为 YYYY-MM-DD");
  return dueAt;
}

function parseVocabDailyLimit(value) {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 5 || limit > 100) {
    throw new HttpError(400, "每日复习上限必须是 5～100 的整数");
  }
  return limit;
}

function parseVocabPastedText(subject, text) {
  const entries = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const tokens = line.split(/\s+/);
    if (subject === "chinese") {
      entries.push({
        term: tokens[0],
        pinyin: tokens[1] || "",
        meaning: tokens.slice(2).join(" ")
      });
    } else {
      entries.push({
        term: tokens[0],
        meaning: tokens.slice(1).join(" ")
      });
    }
  }
  if (!entries.length) throw new HttpError(400, "没有可导入的词条");
  return entries;
}

function parseVocabEntry(subject, raw) {
  if (!raw || typeof raw !== "object") {
    throw new HttpError(400, "词条格式无效");
  }
  const term = requireText(raw.term ?? raw.word, "词条", 50);
  const kind =
    subject === "chinese"
      ? raw.kind === "char" || raw.kind === "word"
        ? raw.kind
        : [...term].length === 1
          ? "char"
          : "word"
      : null;
  return {
    term,
    kind,
    pinyin: optionalText(raw.pinyin, 100),
    meaning: optionalText(raw.meaning, 200),
    phonetic: optionalText(raw.phonetic, 100),
    pos: optionalText(raw.pos, 20),
    pinyinInBook: optionalText(raw.pinyinInBook, 100),
    unitId: parseVocabOptionalId(raw.unitId),
    lessonId: parseVocabOptionalId(raw.lessonId),
    listType:
      raw.listType === undefined || raw.listType === null
        ? null
        : parseVocabListType(subject, raw.listType),
    position: Number.isInteger(raw.position) ? raw.position : null,
    dueAt:
      raw.dueAt === undefined || raw.dueAt === null
        ? null
        : parseVocabDueAt(raw.dueAt)
  };
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
const QUESTION_TYPES = new Set([
  "general",
  "single_choice",
  "multiple_choice",
  "true_false",
  "fill_blank",
  "short_answer",
  "proof",
  "drawing",
  "composite"
]);
const SCAN_ANSWER_TYPES = new Set([
  "auto",
  "text",
  "number",
  "fraction",
  "percent",
  "ratio"
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

async function handleMistakeUpdate(request, response, mistakeId) {
  const body = await readJson(request);
  const input = {};
  if (Object.hasOwn(body, "question")) {
    input.question = optionalText(body.question, 3000);
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
  if (Object.hasOwn(body, "attachmentIds")) {
    input.attachmentIds = parseAttachmentIds(body.attachmentIds);
  }

  const result = await learningTools.invoke(
    "update_mistake",
    {
      mistakeId,
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

let buildInfoPromise;
function normalizeVersionLabel(value) {
  const text = String(value || "").trim();
  if (!text) return "dev";
  return /^v/i.test(text) ? text : `v${text}`;
}

async function getBuildInfo() {
  if (!buildInfoPromise) {
    buildInfoPromise = Promise.all([
      fs.readFile(path.join(currentDir, "server.js")),
      fs.readFile(path.join(publicDir, "app.js")),
      fs.readFile(path.join(publicDir, "index.html")),
      fs.readFile(path.join(publicDir, "styles.css")),
      fs.readFile(path.join(projectRoot, "package.json"))
    ])
      .then(
        ([
          serverSource,
          appSource,
          indexSource,
          stylesSource,
          packageSource
        ]) => {
          let packageVersion = "";
          try {
            packageVersion = JSON.parse(packageSource.toString("utf8")).version;
          } catch {
            packageVersion = "";
          }
          const version = String(
            process.env.APP_VERSION || packageVersion || "dev"
          ).trim();
          return {
            server: createHash("sha256")
              .update(serverSource)
              .digest("hex")
              .slice(0, 12),
            appJs: createHash("sha256")
              .update(appSource)
              .digest("hex")
              .slice(0, 12),
            indexHtml: createHash("sha256")
              .update(indexSource)
              .digest("hex")
              .slice(0, 12),
            stylesCss: createHash("sha256")
              .update(stylesSource)
              .digest("hex")
              .slice(0, 12),
            version: version || "dev",
            versionLabel: normalizeVersionLabel(version)
          };
        }
      )
      .catch(() => null);
  }
  return buildInfoPromise;
}

async function handleApi(request, response, url) {
  const canonicalPathname = canonicalApiPathname(url.pathname);
  if (canonicalPathname !== url.pathname) url.pathname = canonicalPathname;

  if (
    (request.method === "GET" || request.method === "HEAD") &&
    API_DOC_REDIRECTS.has(url.pathname)
  ) {
    return sendRedirect(response, API_DOC_REDIRECTS.get(url.pathname));
  }

  if (request.method === "GET" && url.pathname === "/api/openapi.json") {
    return sendJson(
      response,
      200,
      buildOpenApiDocument({ baseUrl: requestBaseUrl(request) })
    );
  }

  if (
    request.method === "GET" &&
    (url.pathname === "/api/docs" || url.pathname === "/api/docs/")
  ) {
    return serveStatic(response, "/api-docs.html", API_DOCS_HEADERS);
  }

  if (request.method === "GET" && url.pathname === "/api/health") {
    const build = await getBuildInfo();
    return sendJson(response, 200, {
      ok: true,
      appVersion: build?.version || process.env.APP_VERSION || null,
      startedAt: serverStartedAt,
      schemaVersion: repository.getSchemaVersion(),
      toolCount: learningTools.listTools("ui").length,
      build,
      capabilities: {
        mistakeUpdate: {
          postUpdate: "/api/mistakes/:id/update",
          patch: "/api/mistakes/:id"
        },
        feedbackCalendar: true
      }
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
    const curriculum = repository.getCurriculumBaseData();
    return sendJson(response, 200, {
      student: curriculum.student,
      knowledgePoints: curriculum.knowledgePoints,
      currentTextbook: curriculum.currentTextbook,
      textbooks: curriculum.textbooks,
      mappingVersion: curriculum.mappingVersion
    });
  }

  if (request.method === "GET" && url.pathname === "/api/questions") {
    const questions = repository.listQuestions({
      category: optionalText(url.searchParams.get("category"), 40) || null
    });
    return sendJson(response, 200, {
      total: questions.length,
      questions
    });
  }

  if (request.method === "POST" && url.pathname === "/api/questions/scans") {
    const body = await readJson(request);
    const scanMode = String(body.scanMode || "single");
    if (!["single", "multi"].includes(scanMode)) {
      throw new HttpError(400, "扫描模式无效");
    }
    return sendJson(
      response,
      201,
      await createQuestionScan({
        repository,
        attachmentStore,
        scanner: questionScanner,
        attachmentIds: parseAttachmentIds(body.attachmentIds),
        scanMode
      })
    );
  }

  const scanImageMatch = url.pathname.match(
    /^\/api\/questions\/scans\/(\d+)\/candidates\/(\d+)\/image$/
  );
  if (scanImageMatch && request.method === "GET") {
    const context = repository.getQuestionScanImageContext(
      parseId(scanImageMatch[1]),
      parseId(scanImageMatch[2])
    );
    if (!context) throw new HttpError(404, "没有找到候选图片");
    const buffer = attachmentStore.read(context.storageKey);
    const width = Number(context.width);
    const height = Number(context.height);
    const left = Math.max(
      0,
      Math.min(width - 1, Math.round(context.region.x * width))
    );
    const top = Math.max(
      0,
      Math.min(height - 1, Math.round(context.region.y * height))
    );
    const cropWidth = Math.max(
      1,
      Math.min(width - left, Math.round(context.region.width * width))
    );
    const cropHeight = Math.max(
      1,
      Math.min(height - top, Math.round(context.region.height * height))
    );
    const image = await sharp(buffer)
      .rotate()
      .extract({
        left,
        top,
        width: cropWidth,
        height: cropHeight
      })
      .png()
      .toBuffer();
    response.writeHead(200, {
      "Content-Type": "image/png",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    });
    response.end(image);
    return;
  }

  const scanSelectionMatch = url.pathname.match(
    /^\/api\/questions\/scans\/(\d+)\/selection$/
  );
  if (scanSelectionMatch && request.method === "POST") {
    const body = await readJson(request);
    return sendJson(
      response,
      200,
      repository.updateQuestionScanSelection(parseId(scanSelectionMatch[1]), {
        action: optionalText(body.action, 40),
        candidateId:
          body.candidateId === undefined || body.candidateId === null
          ? null
          : parseId(body.candidateId)
      })
    );
  }

  const scanImportMatch = url.pathname.match(
    /^\/api\/questions\/scans\/(\d+)\/import$/
  );
  if (scanImportMatch && request.method === "POST") {
    const body = await readJson(request);
    if (!Array.isArray(body.candidateIds) || !body.candidateIds.length) {
      throw new HttpError(400, "请先选择要导入的题目");
    }
    if (body.candidateIds.length > 20) {
      throw new HttpError(400, "单次最多导入 20 道题");
    }
    return sendJson(
      response,
      200,
      await importQuestionScan({
        repository,
        attachmentStore,
        scanId: parseId(scanImportMatch[1]),
        candidateIds: body.candidateIds.map(parseId),
        confirmIncomplete: body.confirmIncomplete === true
      })
    );
  }

  const scanAnalyzeMatch = url.pathname.match(
    /^\/api\/questions\/scans\/(\d+)\/analyze$/
  );
  if (scanAnalyzeMatch && request.method === "POST") {
    const body = await readJson(request);
    if (!Array.isArray(body.candidateIds) || !body.candidateIds.length) {
      throw new HttpError(400, "请先勾选要分析的题目");
    }
    if (body.candidateIds.length > 20) {
      throw new HttpError(400, "单次最多分析 20 道题");
    }
    return sendJson(
      response,
      200,
      await analyzeQuestionScan({
        repository,
        attachmentStore,
        scanner: questionScanner,
        scanId: parseId(scanAnalyzeMatch[1]),
        candidateIds: body.candidateIds.map(parseId)
      })
    );
  }

  const scanCandidateMatch = url.pathname.match(
    /^\/api\/questions\/scans\/(\d+)\/candidates\/(\d+)$/
  );
  if (scanCandidateMatch && request.method === "PATCH") {
    const body = await readJson(request);
    const input = {};
    if (Object.hasOwn(body, "text")) {
      input.text = optionalText(body.text, 5000);
    }
    if (Object.hasOwn(body, "questionType")) {
      const questionType = String(body.questionType || "general");
      if (!QUESTION_TYPES.has(questionType)) {
        throw new HttpError(400, "题型无效");
      }
      input.questionType = questionType;
    }
    if (Object.hasOwn(body, "studentAnswer")) {
      input.studentAnswer = optionalText(body.studentAnswer, 2000);
    }
    if (Object.hasOwn(body, "suggestedAnswer")) {
      input.suggestedAnswer = optionalText(body.suggestedAnswer, 2000);
    }
    if (Object.hasOwn(body, "parts")) {
      if (
        !Array.isArray(body.parts) ||
        body.parts.length === 0 ||
        body.parts.length > 20
      ) {
        throw new HttpError(400, "小问数量必须为 1～20 个");
      }
      input.parts = body.parts.map((part, index) => {
        if (!part || typeof part !== "object" || Array.isArray(part)) {
          throw new HttpError(400, `小问 ${index + 1} 格式无效`);
        }
        const answerType = String(part.answerType || "auto");
        if (!SCAN_ANSWER_TYPES.has(answerType)) {
          throw new HttpError(400, `小问 ${index + 1} 答案类型无效`);
        }
        const confidence =
          part.confidence === null || part.confidence === undefined
            ? null
            : Number(part.confidence);
        if (
          confidence !== null &&
          (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)
        ) {
          throw new HttpError(400, `小问 ${index + 1} 置信度无效`);
        }
        if (
          part.pendingReasons !== undefined &&
          !Array.isArray(part.pendingReasons)
        ) {
          throw new HttpError(400, `小问 ${index + 1} 待确认项无效`);
        }
        return {
          partNo: index + 1,
          label: optionalText(part.label, 50),
          prompt: optionalText(part.prompt, 2000),
          studentAnswer: optionalText(part.studentAnswer, 2000),
          suggestedAnswer: optionalText(part.suggestedAnswer, 2000),
          answerType,
          confidence,
          pendingReasons: (part.pendingReasons || [])
            .slice(0, 20)
            .map((reason) => optionalText(reason, 100))
            .filter(Boolean),
          answerSource:
            part.answerSource === "user_confirmed"
              ? "user_confirmed"
              : "system_suggested"
        };
      });
    }
    if (Object.hasOwn(body, "answerPending")) {
      input.answerPending = body.answerPending === true;
    }
    if (Object.hasOwn(body, "pendingReasons")) {
      if (!Array.isArray(body.pendingReasons)) {
        throw new HttpError(400, "待确认项格式无效");
      }
      input.pendingReasons = body.pendingReasons
        .slice(0, 20)
        .map((reason) => optionalText(reason, 100))
        .filter(Boolean);
    }
    if (Object.hasOwn(body, "region")) {
      input.region = body.region;
    }
    if (Object.hasOwn(body, "excluded")) {
      input.excluded = body.excluded === true;
    }
    return sendJson(
      response,
      200,
      repository.updateQuestionScanCandidate(
        parseId(scanCandidateMatch[1]),
        parseId(scanCandidateMatch[2]),
        input
      )
    );
  }

  const scanMatch = url.pathname.match(/^\/api\/questions\/scans\/(\d+)$/);
  if (scanMatch && request.method === "GET") {
    const scan = repository.getQuestionScan(parseId(scanMatch[1]));
    if (!scan) throw new HttpError(404, "没有找到这次扫描任务");
    return sendJson(response, 200, scan);
  }

  const questionMatch = url.pathname.match(/^\/api\/questions\/(\d+)$/);
  if (questionMatch && request.method === "GET") {
    const question = repository.getQuestion(parseId(questionMatch[1]));
    if (!question) throw new HttpError(404, "没有找到这道题目");
    return sendJson(response, 200, question);
  }

  if (request.method === "GET" && url.pathname === "/api/curriculum") {
    return sendJson(response, 200, repository.getCurriculumBaseData());
  }

  if (
    request.method === "GET" &&
    url.pathname === "/api/curriculum/unmapped"
  ) {
    const student = repository.getStudent();
    const items = repository.getUnmappedCurriculumMistakes();
    return sendJson(response, 200, {
      items,
      targetPoints: student?.textbook
        ? repository.getCurriculumPoints(student.textbook.id)
        : []
    });
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/curriculum/switch/preview"
  ) {
    const body = await readJson(request);
    const targetTextbookId = parseId(body.targetTextbookId);
    return sendJson(
      response,
      200,
      repository.buildCurriculumSwitchPreview({ targetTextbookId })
    );
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/curriculum/switch/execute"
  ) {
    const body = await readJson(request);
    const idempotencyKey = request.headers["idempotency-key"];
    if (!idempotencyKey) {
      throw new HttpError(400, "切换教材请求缺少幂等键");
    }
    const mappingChoices =
      body.mappingChoices && typeof body.mappingChoices === "object"
        ? body.mappingChoices
        : {};
    return sendJson(
      response,
      200,
      repository.executeCurriculumSwitch({
        targetTextbookId: parseId(body.targetTextbookId),
        previewToken: requireText(body.previewToken, "预演凭证", 128),
        mappingChoices,
        confirmUnmapped: body.confirmUnmapped === true,
        idempotencyKey,
        actor: optionalText(body.actor, 100),
        confirmer: optionalText(body.confirmer, 100)
      })
    );
  }

  if (request.method === "GET" && url.pathname === "/api/curriculum/switches") {
    const mistakeId = url.searchParams.get("mistakeId");
    return sendJson(
      response,
      200,
      repository.getCurriculumSwitchLogs({
        mistakeId: mistakeId ? parseId(mistakeId) : null,
        limit: Number(url.searchParams.get("limit") || 20)
      })
    );
  }

  const curriculumResolveMatch = url.pathname.match(
    /^\/api\/curriculum\/mistakes\/(\d+)\/resolve$/
  );
  if (curriculumResolveMatch && request.method === "POST") {
    const body = await readJson(request);
    const idempotencyKey = request.headers["idempotency-key"];
    if (!idempotencyKey) {
      throw new HttpError(400, "未映射处理请求缺少幂等键");
    }
    return sendJson(
      response,
      200,
      repository.assignMistakeCurriculum({
        mistakeId: parseId(curriculumResolveMatch[1]),
        targetCurriculumPointId: parseId(body.targetCurriculumPointId),
        idempotencyKey,
        actor: optionalText(body.actor, 100),
        confirmer: optionalText(body.confirmer, 100)
      })
    );
  }

  if (request.method === "POST" && url.pathname === "/api/attachments") {
    const kind = url.searchParams.get("kind") || "question";
    if (!["question", "part", "draft", "answer"].includes(kind)) {
      throw new HttpError(400, "图片用途无效");
    }
    const buffer = await readBinary(request);
    const encodedName = request.headers["x-original-name"];
    let originalName = "";
    if (typeof encodedName === "string") {
      try {
        originalName = decodeURIComponent(encodedName);
      } catch {
        originalName = "";
      }
    }
    const saved = attachmentStore.save(buffer, {
      declaredMime: request.headers["content-type"],
      originalName,
      kind
    });
    try {
      return sendJson(response, 201, repository.insertAttachment(saved));
    } catch (error) {
      attachmentStore.delete(saved.storageKey);
      throw error;
    }
  }

  const attachmentOcrBoxesMatch = url.pathname.match(
    /^\/api\/attachments\/(\d+)\/ocr-boxes$/
  );
  if (attachmentOcrBoxesMatch && request.method === "POST") {
    const attachment = repository.getAttachment(
      parseId(attachmentOcrBoxesMatch[1]),
      { includeStorageKey: true }
    );
    if (!attachment) {
      throw new HttpError(404, "没有找到这张验证图片");
    }
    if (!questionScanner.ocrClient?.isConfigured()) {
      throw new HttpError(503, "内部 OCR 未配置");
    }
    const content = readAttachmentContent(attachment, attachmentStore, {
      variant: "original"
    });
    const result = await questionScanner.ocrClient.recognize({
      buffer: content.buffer,
      mimeType: content.mimeType
    });
    const grouped = await questionScanner.scan({
      mode: "multi",
      ocrResults: [result]
    });
    return sendJson(response, 200, {
      provider: result.provider,
      engine: result.engine,
      model: result.model,
      version: result.version,
      width: result.width,
      height: result.height,
      processingTimeMs: result.processingTimeMs,
      groupingProvider: grouped.provider,
      groupingModel: grouped.model,
      groupingPromptVersion: grouped.promptVersion,
      blocks: result.blocks.map((block) => ({
        id: block.id,
        order: block.order,
        text: block.text,
        bbox: block.bbox,
        confidence: block.confidence,
        region: block.region
      })),
      questions: grouped.candidates.map((candidate, index) => ({
        id: `q${index + 1}`,
        questionNo: candidate.questionNo || index + 1,
        text: candidate.text,
        confidence: candidate.confidence,
        region: candidate.region,
        pendingReasons: candidate.pendingReasons || [],
        sourceBlockIds: (candidate.sourceBlocks || []).map((block) => block.id)
      }))
    });
  }

  const attachmentOcrBoxesConfirmMatch = url.pathname.match(
    /^\/api\/attachments\/(\d+)\/ocr-boxes\/confirm$/
  );
  if (attachmentOcrBoxesConfirmMatch && request.method === "POST") {
    const body = await readJson(request);
    return sendJson(
      response,
      200,
      await confirmQuestionScanBoxes({
        repository,
        attachmentStore,
        scanner: questionScanner,
        attachmentId: parseId(attachmentOcrBoxesConfirmMatch[1]),
        scanMode: body.scanMode,
        selections: body.selections,
        ocr: body.ocr
      })
    );
  }

  const attachmentExtractMatch = url.pathname.match(
    /^\/api\/attachments\/(\d+)\/extract$/
  );
  if (attachmentExtractMatch && request.method === "POST") {
    await readJson(request);
    return sendJson(
      response,
      200,
      await extractAttachmentText({
        repository,
        attachmentStore,
        extractor: internalOcrTextExtractor,
        attachmentId: parseId(attachmentExtractMatch[1])
      })
    );
  }

  const attachmentCropMatch = url.pathname.match(
    /^\/api\/attachments\/(\d+)\/crop$/
  );
  if (attachmentCropMatch && request.method === "POST") {
    const buffer = await readBinary(request);
    const attachment = saveAttachmentCrop({
      repository,
      attachmentStore,
      attachmentId: parseId(attachmentCropMatch[1]),
      buffer,
      declaredMime: request.headers["content-type"],
      crop: {
        x: request.headers["x-crop-x"],
        y: request.headers["x-crop-y"],
        width: request.headers["x-crop-width"],
        height: request.headers["x-crop-height"],
        rotation: request.headers["x-crop-rotation"],
        sourceWidth: request.headers["x-crop-source-width"],
        sourceHeight: request.headers["x-crop-source-height"]
      }
    });
    return sendJson(response, 200, attachment);
  }

  if (attachmentCropMatch && request.method === "DELETE") {
    return sendJson(
      response,
      200,
      clearAttachmentCrop({
        repository,
        attachmentStore,
        attachmentId: parseId(attachmentCropMatch[1])
      })
    );
  }

  const attachmentMatch = url.pathname.match(/^\/api\/attachments\/(\d+)$/);
  if (attachmentMatch && request.method === "GET") {
    const attachment = repository.getAttachment(parseId(attachmentMatch[1]), {
      includeStorageKey: true
    });
    if (!attachment) throw new HttpError(404, "没有找到这张题目图片");
    let content;
    try {
      content = readAttachmentContent(attachment, attachmentStore, {
        variant: url.searchParams.get("variant") || "crop"
      });
    } catch {
      throw new HttpError(404, "题目图片文件不存在");
    }
    response.writeHead(200, {
      "Content-Type": content.mimeType,
      "Content-Length": content.buffer.length,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff"
    });
    return response.end(content.buffer);
  }

  if (attachmentMatch && request.method === "DELETE") {
    const result = repository.deleteUnboundAttachment(
      parseId(attachmentMatch[1])
    );
    if (result.missing) throw new HttpError(404, "没有找到这张题目图片");
    if (result.bound) {
      throw new HttpError(409, "图片已关联到错题，请通过修改错题移除");
    }
    for (const storageKey of result.storageKeys || [result.storageKey]) {
      attachmentStore.delete(storageKey);
    }
    return sendJson(response, 200, { deleted: true });
  }

  if (request.method === "GET" && url.pathname === "/api/dashboard") {
    return sendJson(response, 200, repository.getDashboard());
  }

  if (request.method === "GET" && url.pathname === "/api/operations/metrics") {
    const to = url.searchParams.get("to")
      ? new Date(url.searchParams.get("to"))
      : new Date();
    const from = url.searchParams.get("from")
      ? new Date(url.searchParams.get("from"))
      : new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
    if (Number.isNaN(to.getTime()) || Number.isNaN(from.getTime())) {
      throw new HttpError(400, "时间范围格式无效");
    }
    return sendJson(
      response,
      200,
      repository.buildOperationalMetrics({
        from: from.toISOString(),
        to: to.toISOString(),
        costPer1kInput: Number(url.searchParams.get("costPer1kInput") || 0),
        costPer1kOutput: Number(url.searchParams.get("costPer1kOutput") || 0)
      })
    );
  }

  if (request.method === "GET" && url.pathname === "/api/eink/queue") {
    response.setHeader("X-Content-Type-Options", "nosniff");
    return sendJson(
      response,
      200,
      einkPageService.getQueue(
        parseEinkLimit(url.searchParams.get("limit"))
      )
    );
  }

  if (request.method === "GET" && url.pathname === "/api/eink/dashboard") {
    response.setHeader("X-Content-Type-Options", "nosniff");
    const startedAt = Date.now();
    let dashboard;
    try {
      dashboard = await einkPageService.getDashboard();
    } catch (error) {
      console.info(
        `[eink-dashboard] status=${error.status || 500} ` +
          `cache=miss duration=${Date.now() - startedAt}ms`
      );
      throw error;
    }
    const notModified = etagMatches(
      request.headers["if-none-match"],
      dashboard.etag
    );
    if (notModified) {
      response.writeHead(304, {
        ETag: dashboard.etag,
        "X-Etag": dashboard.etag,
        "Cache-Control": "no-transform",
        "X-Content-Type-Options": "nosniff"
      });
      response.end();
    } else {
      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": dashboard.frame.length,
        ETag: dashboard.etag,
        "X-Etag": dashboard.etag,
        "Cache-Control": "no-transform",
        "X-Content-Type-Options": "nosniff"
      });
      response.end(dashboard.frame);
    }
    console.info(
      `[eink-dashboard] status=${notModified ? 304 : 200} ` +
        `cache=${dashboard.cacheHit ? "hit" : "miss"} ` +
        `duration=${Date.now() - startedAt}ms`
    );
    return;
  }

  if (
    request.method === "GET" &&
    (url.pathname === "/api/eink/page" ||
      url.pathname === "/api/eink/preview")
  ) {
    response.setHeader("X-Content-Type-Options", "nosniff");
    const startedAt = Date.now();
    const id = parseEinkId(url.searchParams.get("id"));
    const mode = parseEinkMode(url.searchParams.get("mode"));
    let page;
    try {
      page = await einkPageService.getPage({ id, mode });
    } catch (error) {
      console.info(
        `[eink] id=${id} mode=${mode} status=${error.status || 500} ` +
          `cache=miss duration=${Date.now() - startedAt}ms`
      );
      throw error;
    }
    if (page.warning) {
      console.warn(
        `[eink] id=${id} mode=${mode} warning=${page.warning}`
      );
    }

    if (page.unfit) {
      const reasons = page.reasons || [];
      if (url.pathname === "/api/eink/page") {
        console.info(
          `[eink] id=${id} mode=${mode} status=409 ` +
            `unfit=${reasons.join(",") || "EINK_UNFIT"} ` +
            `cache=${page.cacheHit ? "hit" : "miss"} ` +
            `duration=${Date.now() - startedAt}ms`
        );
        return sendJson(response, 409, {
          error: "不适配墨水屏单页",
          code: "EINK_UNFIT",
          reasons
        });
      }
      response.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": page.png.length,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Eink-Unfit": "1"
      });
      response.end(page.png);
      console.info(
        `[eink] id=${id} mode=${mode} status=200 preview=unfit ` +
          `cache=${page.cacheHit ? "hit" : "miss"} ` +
          `duration=${Date.now() - startedAt}ms`
      );
      return;
    }

    if (url.pathname === "/api/eink/page") {
      if (etagMatches(request.headers["if-none-match"], page.etag)) {
        response.writeHead(304, {
          ETag: page.etag,
          "X-Etag": page.etag,
          "Cache-Control": "no-transform",
          "X-Content-Type-Options": "nosniff"
        });
        response.end();
      } else {
        response.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": page.frame.length,
          ETag: page.etag,
          "X-Etag": page.etag,
          "Cache-Control": "no-transform",
          "X-Content-Type-Options": "nosniff"
        });
        response.end(page.frame);
      }
      console.info(
        `[eink] id=${id} mode=${mode} status=${
          etagMatches(request.headers["if-none-match"], page.etag)
            ? 304
            : 200
        } cache=${page.cacheHit ? "hit" : "miss"} ` +
          `duration=${Date.now() - startedAt}ms`
      );
      return;
    }

    response.writeHead(200, {
      "Content-Type": "image/png",
      "Content-Length": page.png.length,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    });
    response.end(page.png);
    console.info(
      `[eink] id=${id} mode=${mode} status=200 ` +
        `cache=${page.cacheHit ? "hit" : "miss"} ` +
        `duration=${Date.now() - startedAt}ms`
    );
    return;
  }

  if (request.method === "DELETE" && url.pathname === "/api/learning-data") {
    if (
      request.headers["x-confirm-delete"] !== "DELETE_ALL_LEARNING_DATA"
    ) {
      throw new HttpError(400, "删除学习数据需要明确确认");
    }
    return sendJson(response, 200, repository.deleteAllLearningData());
  }

  if (request.method === "GET" && url.pathname === "/api/feedback/daily") {
    const date = parseCalendarDate(url.searchParams.get("date"));
    const bounds = dayBounds(date);
    const student = repository.getStudent();
    return sendJson(
      response,
      200,
      repository.buildDailySummary({
        ...bounds,
        knowledgePoint: optionalKnowledgePoint(
          url.searchParams.get("knowledgePoint")
        ),
        at: new Date().toISOString(),
        studentId: student?.id || null
      })
    );
  }

  if (request.method === "GET" && url.pathname === "/api/feedback/weekly") {
    const endDate = parseCalendarDate(url.searchParams.get("end"));
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - 6);
    const startBounds = dayBounds(startDate);
    const endBounds = dayBounds(endDate);
    const student = repository.getStudent();
    return sendJson(
      response,
      200,
      repository.buildWeeklyReport({
        from: startBounds.from,
        to: endBounds.to,
        knowledgePoint: optionalKnowledgePoint(
          url.searchParams.get("knowledgePoint")
        ),
        at: new Date().toISOString(),
        studentId: student?.id || null
      })
    );
  }

  if (request.method === "GET" && url.pathname === "/api/feedback/calendar") {
    const rawMonth = String(url.searchParams.get("month") || "").trim();
    if (rawMonth && !parseMonthKey(rawMonth)) {
      throw new HttpError(400, "月份格式应为 YYYY-MM");
    }
    const month = rawMonth || shanghaiMonthKey();
    const student = repository.getStudent();
    return sendJson(
      response,
      200,
      repository.buildFeedbackCalendar({
        month,
        studentId: student?.id || null
      })
    );
  }

  if (request.method === "GET" && url.pathname === "/api/feedback/day") {
    const rawDate = String(url.searchParams.get("date") || "").trim();
    if (rawDate && !parseDateKey(rawDate)) {
      throw new HttpError(400, "日期格式应为 YYYY-MM-DD");
    }
    const date = rawDate || shanghaiDateKey();
    const student = repository.getStudent();
    return sendJson(
      response,
      200,
      repository.buildFeedbackDay({
        date,
        studentId: student?.id || null
      })
    );
  }

  if (request.method === "GET" && url.pathname === "/api/knowledge-points") {
    const student = repository.getStudent();
    return sendJson(
      response,
      200,
      student?.textbook
        ? repository.getCurriculumKnowledgeSummary(
            student.textbook.id,
            student.id
          )
        : repository.getKnowledgeSummary()
    );
  }

  if (request.method === "GET" && url.pathname === "/api/knowledge-base") {
    const student = repository.getStudent();
    if (student?.textbook) {
      return sendJson(
        response,
        200,
        repository.getCurriculumKnowledgeBaseData(student.textbook.id)
      );
    }
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
    const student = repository.getStudent();
    return sendJson(
      response,
      200,
      repository.searchKnowledge({
        query,
        limit,
        textbookId: student?.textbook?.id || null
      })
    );
  }

  const knowledgeCardMatch = url.pathname.match(
    /^\/api\/knowledge-base\/([A-Za-z0-9-]+|\d+)$/
  );
  if (knowledgeCardMatch && request.method === "GET") {
    const student = repository.getStudent();
    const card = student?.textbook
      ? repository
          .getCurriculumKnowledgeCards(student.textbook.id)
          .find(
            (item) =>
              String(item.id) === knowledgeCardMatch[1] ||
              item.slug === knowledgeCardMatch[1] ||
              item.name === knowledgeCardMatch[1]
          ) || null
      : repository.getKnowledgeCard(knowledgeCardMatch[1]);
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
    const attachmentIds = parseAttachmentIds(body.attachmentIds);
    const question = optionalText(body.question, 3000);
    if (!question && !attachmentIds.length) {
      throw new HttpError(400, "请填写题目或添加题目图片");
    }
    const correctAnswer = Object.hasOwn(body, "correctAnswer")
      ? requireText(body.correctAnswer, "正确答案", 1000)
      : parts?.[0]?.acceptedAnswers?.[0];
    if (!correctAnswer) {
      throw new HttpError(400, "请填写正确答案或小问答案");
    }
    const input = {
      question,
      studentAnswer: optionalText(body.studentAnswer),
      correctAnswer,
      analysis: optionalText(body.analysis),
      knowledgePoint: optionalText(body.knowledgePoint, 100),
      errorType: optionalText(body.errorType, 100),
      attachmentIds,
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

  if (request.method === "GET" && url.pathname === "/api/vocab/items") {
    const studentId = currentVocabStudentId();
    const subjectParam = url.searchParams.get("subject");
    const statusParam = url.searchParams.get("status");
    const items = vocabStore.listItems({
      studentId,
      subject: subjectParam ? parseVocabSubject(subjectParam) : null,
      status:
        statusParam && statusParam !== "all"
          ? parseVocabStatus(statusParam)
          : null
    });
    return sendJson(response, 200, { items, count: items.length });
  }

  if (request.method === "POST" && url.pathname === "/api/vocab/items") {
    const body = await readJson(request);
    const studentId = currentVocabStudentId();
    const subject = parseVocabSubject(body.subject);
    const hasTermRef = body.termId !== undefined && body.termId !== null;
    if (hasTermRef) {
      if (
        Array.isArray(body.entries) ||
        (typeof body.text === "string" && body.text.trim()) ||
        body.term !== undefined ||
        body.word !== undefined
      ) {
        throw new HttpError(400, "termId 录入不能与词条内容同时提供");
      }
      const termId = parseVocabItemId(body.termId, "词条编号");
      vocabStore.requireTerm(subject, termId);
      const occurrenceId = parseVocabOptionalId(body.sourceOccurrenceId);
      if (occurrenceId) {
        vocabStore.requireSourceOccurrence(subject, occurrenceId, termId);
      }
      const dueAt =
        body.dueAt === undefined || body.dueAt === null
          ? null
          : parseVocabDueAt(body.dueAt);
      const result = vocabStore.createItem({
        studentId,
        subject,
        termId,
        sourceOccurrenceId: occurrenceId,
        dueAt
      });
      return sendJson(response, 201, {
        created: result.created ? 1 : 0,
        existing: result.created ? 0 : 1,
        items: [result.item]
      });
    }
    let rawEntries = [];
    if (Array.isArray(body.entries)) {
      rawEntries = body.entries;
    } else if (typeof body.text === "string" && body.text.trim()) {
      rawEntries = parseVocabPastedText(subject, body.text);
    } else if (body.term !== undefined || body.word !== undefined) {
      rawEntries = [body];
    }
    if (!rawEntries.length) {
      throw new HttpError(400, "请提供要录入的词条");
    }

    const defaultListType = parseVocabListType(subject, body.listType);
    const defaultUnitId = parseVocabOptionalId(body.unitId);
    const defaultLessonId = parseVocabOptionalId(body.lessonId);
    const defaultDueAt =
      body.dueAt === undefined || body.dueAt === null
        ? null
        : parseVocabDueAt(body.dueAt);
    const unitCache = new Map();
    const lessonCache = new Map();
    const items = [];
    let created = 0;
    let existing = 0;

    const importEntry = (raw, index) => {
      const entry = parseVocabEntry(subject, raw);
      let unitId =
        entry.unitId === null ? defaultUnitId : entry.unitId;
      let lessonId =
        entry.lessonId === null ? defaultLessonId : entry.lessonId;
      let textbookId = null;

      if (lessonId) {
        let lesson = lessonCache.get(lessonId);
        if (!lesson) {
          lesson = vocabStore.requireLesson(subject, lessonId, unitId);
          lessonCache.set(lessonId, lesson);
        }
        unitId = lesson.unit_id;
        textbookId = lesson.textbook_id;
      } else if (unitId) {
        let unit = unitCache.get(unitId);
        if (!unit) {
          unit = vocabStore.requireUnit(subject, unitId);
          unitCache.set(unitId, unit);
        }
        textbookId = unit.textbook_id;
      }

      const listType = entry.listType || defaultListType;
      const position = entry.position ?? index + 1;
      let termId;
      let occurrenceId = null;
      if (subject === "chinese") {
        termId = vocabStore.findOrCreateZhTerm({
          word: entry.term,
          kind: entry.kind,
          pinyin: entry.pinyin,
          meaning: entry.meaning
        });
        if (unitId) {
          occurrenceId = vocabStore.upsertZhOccurrence({
            termId,
            textbookId,
            unitId,
            lessonId,
            listType,
            pinyinInBook: entry.pinyinInBook || entry.pinyin,
            position
          });
        }
      } else {
        termId = vocabStore.findOrCreateEnTerm({
          term: entry.term,
          phonetic: entry.phonetic,
          pos: entry.pos,
          meaning: entry.meaning
        });
        if (unitId) {
          occurrenceId = vocabStore.upsertEnOccurrence({
            termId,
            textbookId,
            unitId,
            lessonId,
            listType,
            position
          });
        }
      }

      const result = vocabStore.createItem({
        studentId,
        subject,
        termId,
        sourceOccurrenceId: occurrenceId,
        dueAt: entry.dueAt || defaultDueAt
      });
      if (result.created) created += 1;
      else existing += 1;
      items.push(result.item);
    };

    repository.db.exec("BEGIN IMMEDIATE");
    try {
      rawEntries.forEach(importEntry);
      repository.db.exec("COMMIT");
    } catch (error) {
      repository.db.exec("ROLLBACK");
      throw error;
    }

    return sendJson(response, 201, { created, existing, items });
  }

  const vocabItemMatch = url.pathname.match(/^\/api\/vocab\/items\/(\d+)$/);
  if (vocabItemMatch && request.method === "PATCH") {
    const body = await readJson(request);
    const studentId = currentVocabStudentId();
    const hasStatus = Object.hasOwn(body, "status");
    const hasDueAt = Object.hasOwn(body, "dueAt");
    if (!hasStatus && !hasDueAt) {
      throw new HttpError(400, "请提供 status 或 dueAt");
    }
    const patch = {
      studentId,
      itemId: parseVocabItemId(vocabItemMatch[1])
    };
    if (hasStatus) patch.status = parseVocabStatus(body.status);
    if (hasDueAt) {
      patch.dueAt = body.dueAt === null ? null : parseVocabDueAt(body.dueAt);
    }
    return sendJson(response, 200, vocabStore.updateItem(patch));
  }

  if (vocabItemMatch && request.method === "DELETE") {
    const studentId = currentVocabStudentId();
    vocabStore.deleteItem(studentId, parseVocabItemId(vocabItemMatch[1]));
    return sendJson(response, 200, { deleted: true });
  }

  if (request.method === "GET" && url.pathname === "/api/vocab/catalog") {
    const subject = parseVocabSubject(url.searchParams.get("subject"));
    return sendJson(response, 200, vocabStore.catalog(subject));
  }

  if (request.method === "GET" && url.pathname === "/api/vocab/occurrences") {
    const studentId = currentVocabStudentId();
    const subject = parseVocabSubject(url.searchParams.get("subject"));
    const unitId = parseVocabOptionalId(url.searchParams.get("unitId"));
    const lessonId = parseVocabOptionalId(url.searchParams.get("lessonId"));
    if (!unitId && !lessonId) {
      throw new HttpError(400, "请提供 unitId 或 lessonId");
    }
    if (lessonId) {
      vocabStore.requireLesson(subject, lessonId, unitId);
    } else {
      vocabStore.requireUnit(subject, unitId);
    }
    return sendJson(
      response,
      200,
      vocabStore.listOccurrences({ studentId, subject, unitId, lessonId })
    );
  }

  if (request.method === "GET" && url.pathname === "/api/vocab/review/today") {
    const studentId = currentVocabStudentId();
    const dateParam = url.searchParams.get("date");
    const subjectParam = url.searchParams.get("subject");
    const subject = subjectParam ? parseVocabSubject(subjectParam) : null;
    const todayKey = dateParam
      ? parseVocabDueAt(dateParam)
      : toDateKey(new Date());
    return sendJson(
      response,
      200,
      vocabStore.reviewToday({ studentId, todayKey, subject })
    );
  }

  if (request.method === "POST" && url.pathname === "/api/vocab/reviews") {
    const body = await readJson(request);
    const studentId = currentVocabStudentId();
    if (!Array.isArray(body.reviews) || !body.reviews.length) {
      throw new HttpError(400, "请提供要提交的复习结果");
    }
    if (body.reviews.length > 200) {
      throw new HttpError(400, "单次提交不能超过 200 条");
    }
    const reviews = body.reviews.map((raw) => {
      if (!raw || typeof raw !== "object") {
        throw new HttpError(400, "复习结果格式无效");
      }
      const result = String(raw.result ?? "");
      if (result !== "correct" && result !== "incorrect") {
        throw new HttpError(400, "result 只能是 correct 或 incorrect");
      }
      const surface = String(raw.surface ?? "web");
      if (surface !== "web" && surface !== "eink") {
        throw new HttpError(400, "surface 只能是 web 或 eink");
      }
      return {
        itemId: parseVocabItemId(raw.itemId),
        result,
        surface
      };
    });
    return sendJson(
      response,
      200,
      vocabStore.submitReviews({ studentId, reviews, now: new Date() })
    );
  }

  if (request.method === "GET" && url.pathname === "/api/vocab/settings") {
    return sendJson(
      response,
      200,
      vocabStore.getSettings(currentVocabStudentId())
    );
  }

  if (request.method === "PUT" && url.pathname === "/api/vocab/settings") {
    const body = await readJson(request);
    const studentId = currentVocabStudentId();
    const hasLimit = Object.hasOwn(body, "dailyLimit");
    const hasMode = Object.hasOwn(body, "englishMode");
    if (!hasLimit && !hasMode) {
      throw new HttpError(400, "请提供 dailyLimit 或 englishMode");
    }
    const patch = {};
    if (hasLimit) patch.dailyLimit = parseVocabDailyLimit(body.dailyLimit);
    if (hasMode) patch.englishMode = parseVocabEnglishMode(body.englishMode);
    return sendJson(response, 200, vocabStore.updateSettings(studentId, patch));
  }

  if (request.method === "GET" && url.pathname === "/api/vocab/dictation") {
    const studentId = currentVocabStudentId();
    const subject = parseVocabSubject(url.searchParams.get("subject"));
    const unitId = parseVocabOptionalId(url.searchParams.get("unitId"));
    const lessonId = parseVocabOptionalId(url.searchParams.get("lessonId"));
    const modeParam = url.searchParams.get("mode");
    const mode = modeParam ? parseVocabEnglishMode(modeParam) : null;
    if (lessonId) {
      vocabStore.requireLesson(subject, lessonId, unitId);
    } else if (unitId) {
      vocabStore.requireUnit(subject, unitId);
    }
    return sendJson(
      response,
      200,
      vocabStore.dictation({
        studentId,
        subject,
        mode,
        unitId,
        lessonId,
        todayKey: toDateKey(new Date())
      })
    );
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

  const updateMistakeMatch = url.pathname.match(
    /^\/api\/mistakes\/(\d+)\/update$/
  );
  if (updateMistakeMatch && request.method === "POST") {
    return handleMistakeUpdate(
      request,
      response,
      parseId(updateMistakeMatch[1])
    );
  }

  if (mistakeMatch && request.method === "PATCH") {
    return handleMistakeUpdate(request, response, parseId(mistakeMatch[1]));
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

  throw new HttpError(404, "接口不存在", { code: "ROUTE_NOT_FOUND" });
}

async function serveStatic(response, pathname, extraHeaders = {}) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const resolved = path.resolve(publicDir, `.${requested}`);
  if (!resolved.startsWith(`${publicDir}${path.sep}`)) {
    throw new HttpError(403, "禁止访问");
  }

  try {
    let content = await fs.readFile(resolved);
    if (requested === "/index.html") {
      const build = await getBuildInfo();
      content = Buffer.from(
        content
          .toString("utf8")
          .replaceAll("__APP_VERSION__", build?.appJs || "dev")
          .replaceAll("__STYLES_VERSION__", build?.stylesCss || "dev")
          .replaceAll("__RELEASE_VERSION__", build?.versionLabel || "dev")
          .replaceAll("__BUILD_ID__", build?.appJs || "dev"),
        "utf8"
      );
    }
    response.writeHead(200, {
      "Content-Type":
        MIME_TYPES[path.extname(resolved).toLowerCase()] ||
        "application/octet-stream",
      "Cache-Control": "no-cache",
      ...extraHeaders
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
    if (
      url.pathname.startsWith("/api/") ||
      API_DOC_REDIRECTS.has(url.pathname)
    ) {
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
      console.error(error.stack || error.message || String(error));
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

scheduleAttachmentCleanup(
  { repository, attachmentStore },
  {
    onError: () => {
      console.warn("未引用题目图片清理失败，将在下次执行时重试。");
    }
  }
);

server.listen(port, host, () => {
  console.log(`数学错题教练已启动：http://${host}:${port}`);
  console.log(`数据文件：${databasePath}`);
  console.log(
    questionScanner.isConfigured()
      ? `OCR 扫描：${questionScanner.model}`
      : "OCR 扫描：未配置"
  );
});

function shutdown() {
  server.close(() => {
    repository.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
