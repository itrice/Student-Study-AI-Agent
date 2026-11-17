import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

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
  "/api/attachments/{id}/crop",
  "/api/dashboard",
  "/api/operations/metrics",
  "/api/learning-data",
  "/api/feedback/daily",
  "/api/feedback/weekly",
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
  "/api/review/{id}/follow-up"
];

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    let errors = "";
    const timer = setTimeout(() => {
      reject(new Error(`服务启动超时：${errors || output}`));
    }, 10_000);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.includes("已启动")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on("data", (chunk) => {
      errors += chunk.toString();
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`服务提前退出（${code}）：${errors || output}`));
    });
  });
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve();
    }, 3_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

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

test(
  "OpenAPI 契约和交互式 API 文档可离线使用",
  { timeout: 30_000 },
  async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "math-coach-api-docs-")
    );
    const databasePath = path.join(directory, "learning.sqlite");
    const attachmentsDirectory = path.join(directory, "attachments");
    const port = await freePort();
    const child = spawn(process.execPath, ["src/server.js"], {
      cwd: projectRoot,
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(port),
        DB_PATH: databasePath,
        ATTACHMENTS_DIR: attachmentsDirectory,
        VISION_BASE_URL: "",
        VISION_API_KEY: "",
        VISION_MODEL: ""
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    try {
      await waitForServer(child);
      const baseUrl = `http://127.0.0.1:${port}`;

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
      assert.equal(operations.length, 45);
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
  assert.equal(document.servers[0].url, "https://example.test");
  assert.deepEqual(
    TAGS.map((tag) => tag.name),
    ["系统", "教材", "附件", "错题", "复习", "知识库", "反馈", "运维"]
  );
  assert.equal(
    Object.keys(document.paths).length,
    DOCUMENTED_PATHS.length
  );
  assert.equal(
    collectOperations(document).length,
    45
  );
});
