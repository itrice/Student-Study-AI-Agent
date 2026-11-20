import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const html = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
const server = fs.readFileSync(path.join(root, "src/server.js"), "utf8");
const css = fs.readFileSync(path.join(root, "public/styles.css"), "utf8");
const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8")
);

test("发布版本来自 package.json 且可被 APP_VERSION 覆盖", () => {
  assert.match(packageJson.version, /^\d+\.\d+\.\d+$/);
  assert.match(server, /path\.join\(projectRoot, "package\.json"\)/);
  assert.match(server, /process\.env\.APP_VERSION/);
  assert.match(server, /versionLabel/);
});

test("侧边栏与系统配置展示版本和构建指纹", () => {
  assert.match(html, /id="app-version"/);
  assert.match(html, /__RELEASE_VERSION__/);
  assert.match(html, /__BUILD_ID__/);
  assert.match(html, /id="settings-version"/);
  assert.match(html, /id="settings-build-id"/);
  assert.ok(server.includes('replaceAll("__RELEASE_VERSION__"'));
  assert.ok(server.includes('replaceAll("__BUILD_ID__"'));
});

test("版本信息保持 16px 可读字号并允许换行", () => {
  const block = css.match(/\.app-version\s*\{[^}]*\}/s)?.[0] || "";
  assert.match(block, /font-size:\s*var\(--text-meta\)/);
  assert.match(block, /flex-wrap:\s*wrap/);
  assert.match(css, /#settings-build-id\s*\{[^}]*overflow-wrap:\s*anywhere/s);
});
