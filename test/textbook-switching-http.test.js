import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

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

async function jsonBody(response) {
  return response.json();
}

function localDateKey(date = new Date()) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function buildMappingChoices(preview) {
  const choices = {};
  for (const item of preview.items) {
    const needsChoice =
      item.mappingStatus === "split" ||
      item.conflict ||
      (item.requiresConfirmation && !item.unmapped);
    if (!needsChoice) continue;
    const targetId =
      item.candidateTargetPointIds[0] || preview.targetPoints[0]?.id;
    if (targetId) choices[item.resolutionKey] = targetId;
  }
  return choices;
}

test(
  "HTTP 教材切换预演、执行、幂等、审计与知识地图端到端",
  { timeout: 30_000 },
  async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "math-coach-textbook-http-"));
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
      const curriculum = await jsonBody(await fetch(`${baseUrl}/api/curriculum`));
      assert.equal(curriculum.currentTextbook.textbookKey, "renjiao-6-all");
      assert.equal(curriculum.textbooks.length, 5);
      const target = curriculum.textbooks.find(
        (textbook) => textbook.textbookKey === "beishida-6-upper"
      );

      const createResponse = await fetch(`${baseUrl}/api/mistakes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: "圆的半径是 2，面积是多少？",
          studentAnswer: "4",
          correctAnswer: "12.56",
          knowledgePoint: "圆",
          errorType: "不会做"
        })
      });
      assert.equal(createResponse.status, 201);
      const mistake = await jsonBody(createResponse);

      const preview = await jsonBody(
        await fetch(`${baseUrl}/api/curriculum/switch/preview`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetTextbookId: target.id })
        })
      );
      assert.equal(preview.fromTextbook.textbookKey, "renjiao-6-all");
      assert.equal(preview.targetTextbook.textbookKey, "beishida-6-upper");
      assert.equal(preview.items.length, 1);
      assert.equal(preview.items[0].targetKnowledgePoint, "圆");
      const afterPreview = await jsonBody(await fetch(`${baseUrl}/api/curriculum`));
      assert.equal(afterPreview.currentTextbook.textbookKey, "renjiao-6-all");

      const idempotencyKey = randomUUID();
      const executeBody = {
        targetTextbookId: target.id,
        previewToken: preview.previewToken,
        mappingChoices: buildMappingChoices(preview),
        confirmUnmapped: true
      };
      const executed = await jsonBody(
        await fetch(`${baseUrl}/api/curriculum/switch/execute`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey
          },
          body: JSON.stringify(executeBody)
        })
      );
      assert.equal(executed.status, "confirmed");
      assert.equal(executed.affectedCount, 1);
      assert.equal(executed.items[0].afterKnowledgePoint, "圆");

      const replay = await jsonBody(
        await fetch(`${baseUrl}/api/curriculum/switch/execute`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey
          },
          body: JSON.stringify(executeBody)
        })
      );
      assert.equal(replay.id, executed.id);
      assert.equal(replay.idempotentReplay, true);

      const knowledge = await jsonBody(
        await fetch(`${baseUrl}/api/knowledge-points`)
      );
      assert.ok(knowledge.some((point) => point.name === "数据处理"));
      assert.equal(
        knowledge.some((point) => String(point.unit).includes("人教版")),
        false
      );
      const search = await jsonBody(
        await fetch(
          `${baseUrl}/api/knowledge-base/search?q=${encodeURIComponent("扇形统计图")}`
        )
      );
      assert.equal(search.items[0].knowledgePoint, "数据处理");

      const trace = await jsonBody(
        await fetch(
          `${baseUrl}/api/curriculum/switches?mistakeId=${mistake.id}`
        )
      );
      assert.equal(trace.length, 1);
      assert.equal(trace[0].toTextbook.textbookKey, "beishida-6-upper");
      assert.equal(trace[0].items[0].beforeKnowledgePoint, "圆");
      assert.equal(trace[0].items[0].afterKnowledgePoint, "圆");

      const daily = await jsonBody(
        await fetch(`${baseUrl}/api/feedback/daily?date=${localDateKey()}`)
      );
      assert.equal(daily.textbookScope.note, "按当时教材");
      assert.equal(daily.textbookScope.label, "人教版六年级（上册/下册）");

      const unmapped = await jsonBody(
        await fetch(`${baseUrl}/api/curriculum/unmapped`)
      );
      assert.equal(unmapped.items.length, 0);
      assert.ok(unmapped.targetPoints.some((point) => point.name === "数据处理"));
    } finally {
      await stopServer(child);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
);
