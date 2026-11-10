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
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2fXkAAAAASUVORK5CYII=",
  "base64"
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

test(
  "HTTP 图片上传、纯图片错题、修改与删除在非安全上下文可用",
  { timeout: 30_000 },
  async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "math-coach-m9-http-"));
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
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    try {
      await waitForServer(child);
      const baseUrl = `http://127.0.0.1:${port}`;

      const rejected = await fetch(`${baseUrl}/api/attachments?kind=question`, {
        method: "POST",
        headers: { "Content-Type": "image/jpeg" },
        body: PNG
      });
      assert.equal(rejected.status, 400);
      assert.match((await jsonBody(rejected)).error, /格式与文件内容不一致/);

      const upload = await fetch(`${baseUrl}/api/attachments?kind=question`, {
        method: "POST",
        headers: {
          "Content-Type": "image/png",
          "X-Original-Name": encodeURIComponent("private-name.png")
        },
        body: PNG
      });
      assert.equal(upload.status, 201);
      const attachment = await jsonBody(upload);
      assert.equal(attachment.mimeType, "image/png");
      assert.equal(attachment.url, `/api/attachments/${attachment.id}`);
      assert.equal("storageKey" in attachment, false);
      assert.equal("originalName" in attachment, false);

      const image = await fetch(`${baseUrl}${attachment.url}`);
      assert.equal(image.status, 200);
      assert.equal(image.headers.get("cache-control"), "private, no-store");
      assert.equal(image.headers.get("x-content-type-options"), "nosniff");
      assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);

      const create = await fetch(`${baseUrl}/api/mistakes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: "",
          correctAnswer: "42",
          knowledgePoint: "百分数",
          errorType: "不会做",
          attachmentIds: [attachment.id]
        })
      });
      assert.equal(create.status, 201);
      const mistake = await jsonBody(create);
      assert.equal(mistake.question, "");
      assert.equal(mistake.attachments[0].id, attachment.id);

      const review = await jsonBody(
        await fetch(`${baseUrl}/api/review/${mistake.id}`)
      );
      assert.equal(review.attachments[0].id, attachment.id);
      const dashboard = await jsonBody(await fetch(`${baseUrl}/api/dashboard`));
      assert.equal(dashboard.nextReview.id, mistake.id);
      assert.equal(dashboard.nextReview.attachments[0].id, attachment.id);
      assert.equal(dashboard.recent[0].attachments[0].id, attachment.id);

      const replacementUpload = await fetch(
        `${baseUrl}/api/attachments?kind=question`,
        {
          method: "POST",
          headers: { "Content-Type": "image/png" },
          body: PNG
        }
      );
      const replacement = await jsonBody(replacementUpload);
      const update = await fetch(`${baseUrl}/api/mistakes/${mistake.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "m9-http-update-1"
        },
        body: JSON.stringify({
          question: "修改后的图片题",
          attachmentIds: [replacement.id]
        })
      });
      assert.equal(update.status, 200);
      const updated = await jsonBody(update);
      assert.equal(updated.mistake.question, "修改后的图片题");
      assert.deepEqual(
        updated.mistake.attachments.map((item) => item.id),
        [replacement.id]
      );

      const filesAfterReplace = fs.readdirSync(attachmentsDirectory);
      assert.equal(filesAfterReplace.length, 1);

      const unboundUpload = await fetch(
        `${baseUrl}/api/attachments?kind=question`,
        {
          method: "POST",
          headers: { "Content-Type": "image/png" },
          body: PNG
        }
      );
      const unbound = await jsonBody(unboundUpload);
      const deleteUnbound = await fetch(`${baseUrl}/api/attachments/${unbound.id}`, {
        method: "DELETE"
      });
      assert.equal(deleteUnbound.status, 200);
      assert.equal(fs.readdirSync(attachmentsDirectory).length, 1);

      const remove = await fetch(`${baseUrl}/api/mistakes/${mistake.id}`, {
        method: "DELETE"
      });
      assert.equal(remove.status, 200);
      assert.equal(fs.readdirSync(attachmentsDirectory).length, 0);

      const persistedLog = `${stdout}\n${stderr}`;
      assert.doesNotMatch(persistedLog, /private-name\.png/);
      assert.equal(fs.existsSync(path.join(attachmentsDirectory, filesAfterReplace[0])), false);
    } finally {
      await stopServer(child);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
);
