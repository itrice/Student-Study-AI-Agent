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

test("修改错题同时提供 POST update 与 PATCH 兼容路由", () => {
  assert.ok(server.includes('postUpdate: "/api/mistakes/:id/update"'));
  assert.ok(server.includes('patch: "/api/mistakes/:id"'));
  assert.ok(server.includes('request.method === "PATCH"'));
});

test("修改错题在路由缺失时回退 PATCH，并提示版本不一致", () => {
  assert.ok(
    app.includes(
      "const routeMissing = error.status === 404 || error.status === 405;"
    )
  );
  assert.ok(app.includes('method: "PATCH"'));
  assert.ok(app.includes("MISTAKE_UPDATE_ROUTE_MISMATCH"));
  assert.ok(app.includes("服务端版本可能不一致"));
});
