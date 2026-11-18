import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync(
  new URL("../public/app.js", import.meta.url),
  "utf8"
);
const server = fs.readFileSync(
  new URL("../src/server.js", import.meta.url),
  "utf8"
);
const html = fs.readFileSync(
  new URL("../public/index.html", import.meta.url),
  "utf8"
);

test("修改错题同时提供 POST update 与 PATCH 兼容路由", () => {
  assert.ok(server.includes('postUpdate: "/api/mistakes/:id/update"'));
  assert.ok(server.includes('patch: "/api/mistakes/:id"'));
  assert.ok(server.includes('request.method === "PATCH"'));
});

test("修改错题仅在确认路由缺失时回退 PATCH，并保留真实错误", () => {
  assert.ok(app.includes("function isMissingUpdateRoute(error)"));
  assert.ok(app.includes('error?.code === "ROUTE_NOT_FOUND"'));
  assert.ok(app.includes('error?.message === "接口不存在"'));
  assert.ok(app.includes("MISTAKE_ID_INVALID"));
  assert.ok(app.includes('method: "PATCH"'));
  assert.ok(app.includes("MISTAKE_UPDATE_ROUTE_MISMATCH"));
  assert.ok(app.includes("服务端版本可能不一致"));
  assert.doesNotMatch(
    app,
    /const routeMissing = error\.status === 404 \|\| error\.status === 405;/
  );
});

test("页面资源版本由服务端构建指纹注入，避免部署后复用旧脚本", () => {
  assert.match(html, /\/styles\.css\?v=__STYLES_VERSION__/);
  assert.match(html, /\/app\.js\?v=__APP_VERSION__/);
  assert.ok(server.includes("stylesCss"));
  assert.ok(server.includes('replaceAll("__APP_VERSION__"'));
  assert.ok(server.includes('replaceAll("__STYLES_VERSION__"'));
});
