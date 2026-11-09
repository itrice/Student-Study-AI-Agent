import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadEnvFile,
  parseEnvText
} from "../src/environment.js";

test("解析 .env 注释、引号和 export 前缀", () => {
  const values = parseEnvText(`
    # comment
    export LLM_MODEL=test-model
    LLM_API_KEY="secret\\nkey"
    LLM_TEMPERATURE=0.2
  `);
  assert.equal(values.LLM_MODEL, "test-model");
  assert.equal(values.LLM_API_KEY, "secret\nkey");
  assert.equal(values.LLM_TEMPERATURE, "0.2");
});

test("加载 .env 时不覆盖已有环境变量", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "math-agent-env-"));
  const filePath = path.join(directory, ".env");
  fs.writeFileSync(filePath, "LLM_MODEL=from-file\nLLM_STREAM=false\n");
  const environment = { LLM_MODEL: "from-process" };
  try {
    const result = loadEnvFile(filePath, { environment });
    assert.deepEqual(result.loaded, ["LLM_STREAM"]);
    assert.equal(environment.LLM_MODEL, "from-process");
    assert.equal(environment.LLM_STREAM, "false");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
