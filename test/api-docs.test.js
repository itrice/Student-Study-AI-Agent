import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { projectRoot, startServer, stopServer } from "./helpers/http-fixture.js";

const DOCUMENTED_PATHS = [
  "/api/health",
  "/api/tools",
  "/api/ai/status",
  "/api/ai/test",
  "/api/bootstrap",
  "/api/openapi.json",
  "/api/docs",
  "/api/curriculum",
  "/api/curriculum/unmapped",
  "/api/curriculum/switch/preview",
  "/api/curriculum/switch/execute",
  "/api/curriculum/switches",
  "/api/curriculum/mistakes/{mistakeId}/resolve",
  "/api/attachments",
  "/api/attachments/{id}",
  "/api/attachments/{id}/extract",
  "/api/attachments/{id}/ocr-boxes",
  "/api/attachments/{id}/ocr-boxes/confirm",
  "/api/attachments/{id}/crop",
  "/api/dashboard",
  "/api/eink/queue",
  "/api/eink/dashboard",
  "/api/eink/page",
  "/api/eink/preview",
  "/api/operations/metrics",
  "/api/learning-data",
  "/api/feedback/daily",
  "/api/feedback/weekly",
  "/api/feedback/calendar",
  "/api/feedback/day",
  "/api/knowledge-points",
  "/api/knowledge-base",
  "/api/knowledge-base/search",
  "/api/knowledge-base/{cardId}",
  "/api/mistakes",
  "/api/diagnose",
  "/api/review/next",
  "/api/review/queue",
  "/api/demo",
  "/api/mistakes/{id}",
  "/api/mistakes/{id}/evidence",
  "/api/mistakes/{id}/edit-session",
  "/api/mistakes/{id}/edit",
  "/api/mistakes/{id}/update",
  "/api/mistakes/{id}/attempts",
  "/api/review/{id}",
  "/api/review/{id}/hints",
  "/api/review/{id}/follow-up",
  "/api/questions",
  "/api/questions/{id}",
  "/api/questions/scans",
  "/api/questions/scans/{id}",
  "/api/questions/scans/{id}/selection",
  "/api/questions/scans/{id}/analyze",
  "/api/questions/scans/{id}/import",
  "/api/questions/scans/{id}/candidates/{candidateId}",
  "/api/questions/scans/{id}/candidates/{candidateId}/image"
];


function collectOperations(document) {
  const operations = [];
  for (const [path, item] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      operations.push({ path, method, operation });
    }
  }
  return operations;
}

function collectRefs(value, refs = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, refs);
    return refs;
  }
  if (!value || typeof value !== "object") return refs;
  if (typeof value.$ref === "string") refs.push(value.$ref);
  for (const child of Object.values(value)) collectRefs(child, refs);
  return refs;
}

function pathParameters(template) {
  return [...template.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
}

function normalizeRoutePath(pathname) {
  return pathname.replace(/\/+$/, "").replace(/\{[^}]+\}/g, "{param}");
}

function collectServerRoutePaths(source) {
  const routes = new Set();
  for (const match of source.matchAll(/url\.pathname\s*===\s*"(\/api\/[^"]+)"/g)) {
    routes.add(normalizeRoutePath(match[1]));
  }
  for (const match of source.matchAll(
    /url\.pathname\.match\(\s*\/\^([^\n]+?)\$\/?\s*\)/g
  )) {
    const converted = match[1]
      .replace(/\\\//g, "/")
      .replace(/\((?:\?:)?[^)]*\)/g, "{param}");
    routes.add(normalizeRoutePath(converted));
  }
  return routes;
}

test(
  "OpenAPI 契约和交互式 API 文档可离线使用",
  { timeout: 30_000 },
  async () => {
    const { child, directory, baseUrl } = await startServer({
      prefix: "math-coach-api-docs-"
    });

    try {
      const response = await fetch(`${baseUrl}/api/openapi.json`);
      assert.equal(response.status, 200);
      assert.match(
        response.headers.get("content-type") || "",
        /application\/json/
      );
      assert.equal(response.headers.get("content-encoding"), null);
      assert.equal(response.headers.get("cache-control"), "no-store");

      const document = await response.json();
      assert.equal(document.openapi, "3.1.0");
      assert.equal(document.servers[0].url, baseUrl);
      assert.equal(document["x-authentication"], "none");
      assert.equal(document["x-idempotency-header"], "Idempotency-Key");

      const tags = new Set(document.tags.map((tag) => tag.name));
      for (const expected of DOCUMENTED_PATHS) {
        assert.ok(document.paths[expected], `缺少接口：${expected}`);
      }
      assert.equal(Object.keys(document.paths).length, DOCUMENTED_PATHS.length);

      const operations = collectOperations(document);
      assert.equal(operations.length, 62);
      const operationIds = operations.map(
        ({ operation }) => operation.operationId
      );
      assert.equal(new Set(operationIds).size, operationIds.length);

      for (const { path: route, method, operation } of operations) {
        assert.ok(operation.summary, `${method} ${route} 缺少 summary`);
        assert.ok(operation.operationId, `${method} ${route} 缺少 operationId`);
        assert.ok(
          operation.tags?.length && tags.has(operation.tags[0]),
          `${method} ${route} 使用了未声明的 tag`
        );
        assert.ok(
          Object.keys(operation.responses || {}).length,
          `${method} ${route} 缺少 responses`
        );

        const declaredPathParameters = new Set(
          (operation.parameters || [])
            .filter((parameter) => parameter.in === "path")
            .map((parameter) => parameter.name)
        );
        for (const parameter of pathParameters(route)) {
          assert.ok(
            declaredPathParameters.has(parameter),
            `${method} ${route} 未声明路径参数 ${parameter}`
          );
        }
      }

      const refs = collectRefs(document);
      for (const ref of refs) {
        assert.match(ref, /^#\/components\/schemas\/[\w-]+$/);
        const name = ref.split("/").pop();
        assert.ok(
          document.components.schemas[name],
          `引用不存在：${ref}`
        );
      }

      assert.equal(
        document.paths["/api/learning-data"].delete["x-dangerous"],
        true
      );
      assert.equal(
        document.paths["/api/review/queue"].get.parameters[0].schema.maximum,
        20
      );
      assert.equal(
        document.paths["/api/attachments"].post.requestBody.required,
        true
      );
      assert.equal(
        document.paths["/api/feedback/calendar"].get.parameters[0].schema
          .pattern,
        "^\\d{4}-\\d{2}$"
      );
      assert.equal(
        document.paths["/api/feedback/day"].get.parameters[0].schema.format,
        "date"
      );

      const calendarResponse = await fetch(
        `${baseUrl}/api/feedback/calendar?month=2026-11`
      );
      assert.equal(calendarResponse.status, 200);
      const calendar = await calendarResponse.json();
      assert.equal(calendar.month, "2026-11");
      assert.match(calendar.today, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(Array.isArray(calendar.days) && calendar.days.length > 0);
      assert.deepEqual(Object.keys(calendar.summary).sort(), [
        "checkInDays",
        "completedCount",
        "correctCount"
      ]);

      const dayResponse = await fetch(
        `${baseUrl}/api/feedback/day?date=2026-11-15`
      );
      assert.equal(dayResponse.status, 200);
      const day = await dayResponse.json();
      assert.equal(day.date, "2026-11-15");
      assert.ok(Array.isArray(day.items));
      assert.deepEqual(Object.keys(day.summary).sort(), [
        "attemptCount",
        "completedCount",
        "correctCount",
        "needsCorrectionCount"
      ]);

      for (const invalidPath of [
        "/api/feedback/calendar?month=2026-13",
        "/api/feedback/day?date=2026-02-30"
      ]) {
        const invalid = await fetch(`${baseUrl}${invalidPath}`);
        assert.equal(invalid.status, 400, `${invalidPath} 应返回 400`);
      }

      for (const trailingPath of [
        "/api/health/",
        "/api/mistakes/",
        "/api/feedback/daily/",
        "/api/feedback/weekly/",
        "/api/feedback/calendar/?month=2026-11",
        "/api/feedback/day/?date=2026-11-15",
        "/api/review/queue/?limit=1"
      ]) {
        const normalized = await fetch(`${baseUrl}${trailingPath}`);
        assert.equal(normalized.status, 200, `${trailingPath} 应正常工作`);
      }

      const normalizedPost = await fetch(`${baseUrl}/api/diagnose/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      });
      assert.equal(normalizedPost.status, 400);
      assert.notEqual(normalizedPost.status, 404);

      for (const [aliasPath, canonicalPath] of [
        ["/api", "/api/docs"],
        ["/api/", "/api/docs"],
        ["/api-docs", "/api/docs"],
        ["/api-docs/", "/api/docs"],
        ["/docs", "/api/docs"],
        ["/docs/", "/api/docs"],
        ["/openapi.json", "/api/openapi.json"],
        ["/openapi.json/", "/api/openapi.json"]
      ]) {
        const redirected = await fetch(`${baseUrl}${aliasPath}`, {
          redirect: "manual"
        });
        assert.equal(redirected.status, 308, `${aliasPath} 应重定向`);
        assert.equal(redirected.headers.get("location"), canonicalPath);
      }

      const forwarded = await fetch(`${baseUrl}/api/openapi.json`, {
        headers: {
          "x-forwarded-proto": "https",
          "x-forwarded-host": "api.example.com"
        }
      });
      const forwardedDocument = await forwarded.json();
      assert.equal(
        forwardedDocument.servers[0].url,
        "https://api.example.com"
      );

      for (const docsPath of ["/api/docs", "/api/docs/"]) {
        const docs = await fetch(`${baseUrl}${docsPath}`);
        assert.equal(docs.status, 200);
        assert.match(docs.headers.get("content-type") || "", /text\/html/);
        assert.match(
          docs.headers.get("content-security-policy") || "",
          /default-src 'self'/
        );
        assert.equal(docs.headers.get("x-content-type-options"), "nosniff");
        const html = await docs.text();
        assert.match(html, /\/api-docs\.js/);
        assert.match(html, /\/api\/openapi\.json/);
        assert.doesNotMatch(html, /<script(?![^>]*src=)[^>]*>/i);
        assert.doesNotMatch(html, /<style[\s>]/i);
        assert.match(html, /rel="icon" href="\/assets\/brand\/ziyu-mark\.svg"/);
      }

      const css = await fetch(`${baseUrl}/api-docs.css`);
      assert.equal(css.status, 200);
      assert.match(css.headers.get("content-type") || "", /text\/css/);
      const cssText = await css.text();
      assert.match(cssText, /\.method-get/);
      assert.match(cssText, /@media \(max-width: 720px\)/);
      assert.match(cssText, /\.copy-buffer/);
      assert.match(cssText, /\.pill-danger/);

      const script = await fetch(`${baseUrl}/api-docs.js`);
      assert.equal(script.status, 200);
      assert.match(
        script.headers.get("content-type") || "",
        /text\/javascript/
      );
      const scriptText = await script.text();
      assert.match(scriptText, /fetch\("\/api\/openapi\.json"/);
      assert.match(scriptText, /crypto\.getRandomValues/);
      assert.doesNotMatch(scriptText, /crypto\.randomUUID/);
      assert.match(scriptText, /copyText/);
      assert.doesNotMatch(scriptText, /\.style\s*=|style\s*=/);
    } finally {
      await stopServer(child);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
);

test("OpenAPI 生成器可独立构建且包含第三方接入说明", async () => {
  const { buildOpenApiDocument, TAGS } = await import("../src/openapi.js");
  const document = buildOpenApiDocument({ baseUrl: "https://example.test" });

  assert.equal(document.info.title, "子鱼学习AI 学习数据 API");
  assert.match(document.info.description, /第三方/);
  assert.match(document.info.description, /Idempotency-Key/);
  assert.match(document.info.description, /未内置账号体系|无内置鉴权|鉴权/);
  assert.match(document.info.description, /尾斜杠/);
  assert.equal(document.info.version, "0.21.0");
  assert.deepEqual(
    document.components.schemas.QuestionScanCandidate.properties.parts.items.$ref,
    "#/components/schemas/QuestionScanPart"
  );
  assert.equal(
    Object.hasOwn(
      document.components.schemas.ExtractAttachmentInput.properties,
      "consent"
    ),
    false
  );
  assert.deepEqual(
    document.components.schemas.CreateQuestionScanInput.required,
    ["attachmentIds"]
  );
  assert.equal(document.servers[0].url, "https://example.test");
  assert.deepEqual(
    TAGS.map((tag) => tag.name),
    [
      "系统",
      "教材",
      "附件",
      "错题",
      "题库",
      "复习",
      "知识库",
      "反馈",
      "墨水屏",
      "运维"
    ]
  );
  assert.equal(
    Object.keys(document.paths).length,
    DOCUMENTED_PATHS.length
  );
  assert.equal(
    collectOperations(document).length,
    62
  );
});

test("OpenAPI paths 与服务端已注册 API 路由双向覆盖", async () => {
  const { buildOpenApiDocument } = await import("../src/openapi.js");
  const serverSource = fs.readFileSync(
    path.join(projectRoot, "src/server.js"),
    "utf8"
  );
  const registered = collectServerRoutePaths(serverSource);
  const documented = new Set(
    Object.keys(buildOpenApiDocument().paths).map(normalizeRoutePath)
  );

  assert.deepEqual(
    [...registered].filter((route) => !documented.has(route)).sort(),
    [],
    "存在已注册但未写入 OpenAPI paths 的路由"
  );
  assert.deepEqual(
    [...documented].filter((route) => !registered.has(route)).sort(),
    [],
    "OpenAPI paths 中存在服务端未注册的路由"
  );
});
