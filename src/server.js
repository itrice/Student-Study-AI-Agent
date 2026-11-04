import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { diagnoseMistake } from "./agent.js";
import { createRepository } from "./database.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, "..");
const publicDir = path.join(projectRoot, "public");
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
const databasePath =
  process.env.DB_PATH || path.join(projectRoot, "data", "learning.sqlite");
const repository = createRepository(databasePath);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

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

function parseId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new HttpError(400, "题目编号无效");
  }
  return id;
}

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/health") {
    return sendJson(response, 200, {
      ok: true,
      schemaVersion: repository.getSchemaVersion()
    });
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

  if (request.method === "GET" && url.pathname === "/api/knowledge-points") {
    return sendJson(response, 200, repository.getKnowledgeSummary());
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
    const input = {
      question: requireText(body.question, "题目"),
      studentAnswer: optionalText(body.studentAnswer),
      correctAnswer: requireText(body.correctAnswer, "正确答案"),
      analysis: optionalText(body.analysis),
      knowledgePoint: optionalText(body.knowledgePoint, 100),
      errorType: optionalText(body.errorType, 100)
    };
    return sendJson(response, 201, repository.createMistake(input));
  }

  if (request.method === "POST" && url.pathname === "/api/diagnose") {
    const body = await readJson(request);
    return sendJson(
      response,
      200,
      diagnoseMistake({
        question: optionalText(body.question),
        studentAnswer: optionalText(body.studentAnswer),
        correctAnswer: optionalText(body.correctAnswer),
        analysis: optionalText(body.analysis),
        knowledgePoint: optionalText(body.knowledgePoint, 100),
        errorType: optionalText(body.errorType, 100)
      })
    );
  }

  if (request.method === "GET" && url.pathname === "/api/review/next") {
    return sendJson(response, 200, repository.getNextReview());
  }

  if (request.method === "POST" && url.pathname === "/api/demo") {
    return sendJson(response, 200, repository.addDemoData());
  }

  const mistakeMatch = url.pathname.match(/^\/api\/mistakes\/(\d+)$/);
  if (mistakeMatch && request.method === "GET") {
    const mistake = repository.getMistake(parseId(mistakeMatch[1]), {
      includeSolution: true
    });
    if (!mistake) throw new HttpError(404, "没有找到这道错题");
    return sendJson(response, 200, mistake);
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
    const result = repository.recordAttempt(
      parseId(attemptMatch[1]),
      optionalText(body.answer)
    );
    if (!result) throw new HttpError(404, "没有找到这道错题");
    return sendJson(response, 200, result);
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
    const status = error instanceof HttpError ? error.status : 500;
    if (status === 500) {
      console.error(error);
    }
    if (!response.headersSent) {
      sendJson(response, status, {
        error: error instanceof HttpError ? error.message : "服务器暂时出错"
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
