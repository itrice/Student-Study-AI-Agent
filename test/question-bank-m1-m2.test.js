import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { LearningRepository } from "../src/database.js";
import { AttachmentStore } from "../src/attachments.js";
import { migrateDatabase, SCHEMA_MIGRATIONS } from "../src/migrations.js";
import { createQuestionScan } from "../src/question-bank/scan-service.js";
import { OpenAICompatibleQuestionScanner } from "../src/question-bank/scanner.js";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2fXkAAAAASUVORK5CYII=",
  "base64"
);
const NOW = "2026-01-10T08:00:00.000Z";

function withTemporaryDirectory(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "math-coach-qb-"));
  let result;
  try {
    result = callback(directory);
    if (result && typeof result.then === "function") {
      return result.finally(() => {
        try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* Windows may release sqlite handles after the test process exits. */ }
      });
    }
    return result;
  } finally {
    if (!result || typeof result.then !== "function") {
      try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* Windows may release sqlite handles after the test process exits. */ }
    }
  }
}

function createFixture(directory) {
  const databasePath = path.join(directory, "learning.sqlite");
  const repository = new LearningRepository(databasePath);
  const store = new AttachmentStore({ directory: repository.attachmentDirectory });
  return { databasePath, repository, store };
}

function saveAttachment(repository, store, name = "question.png") {
  const saved = store.save(PNG, {
    declaredMime: "image/png",
    originalName: name,
    kind: "question"
  });
  return {
    ...repository.insertAttachment(saved),
    sha256: saved.sha256,
    storageKey: saved.storageKey
  };
}

function tableCount(db, table) {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

function seedV13Database(databasePath) {
  const db = new DatabaseSync(databasePath);
  migrateDatabase(db, { migrations: SCHEMA_MIGRATIONS.slice(0, 13) });
  const student = db.prepare("SELECT id FROM students ORDER BY id LIMIT 1").get();
  const knowledgePoint = db
    .prepare("SELECT name FROM knowledge_points ORDER BY id LIMIT 1")
    .get().name;
  const insertMistake = db.prepare(
    `INSERT INTO mistakes (
      student_id, question, student_answer, correct_answer, analysis,
      knowledge_point, error_type, hint, method_steps, common_errors,
      diagnosis, status, consecutive_correct, attempt_count, due_at,
      last_reviewed_at, created_at, updated_at, revision, textbook_id,
      curriculum_point_id, curriculum_status
    ) VALUES (?, ?, '', '参考答案', '', ?, '概念混淆', '提示', '[]', '[]',
      '', 'new', 0, 0, NULL, NULL, ?, ?, 1, NULL, NULL, 'legacy')`
  );
  const insertAttachment = db.prepare(
    `INSERT INTO attachments (
      mistake_id, kind, storage_key, mime_type, byte_size, width, height,
      sha256, original_name, created_at
    ) VALUES (?, 'question', ?, 'image/png', 68, 1, 1, ?, ?, ?)`
  );
  const insertAttempt = db.prepare(
    `INSERT INTO attempts (
      mistake_id, answer, is_correct, feedback, created_at, outcome,
      hint_level, independent, evaluation_source, agent_run_id
    ) VALUES (?, '错误答案', 0, '需要再算一次', ?, 'incorrect', 0, 1, 'legacy_rule', NULL)`
  );
  const insertEvidence = db.prepare(
    `INSERT INTO mastery_evidence (
      mistake_id, attempt_id, evidence_type, rule_version, independent,
      previous_status, next_status, outcome, consecutive_independent_correct,
      review_schedule_id, reason, detail_json, created_at
    ) VALUES (?, ?, 'attempt', 'v1', 1, 'new', 'practicing', 'incorrect', 0,
      NULL, '初始证据', '{}', ?)`
  );
  const insertReview = db.prepare(
    `INSERT INTO review_schedule (
      mistake_id, next_review_at, interval_days, reason, rule_version,
      active, created_at, superseded_at
    ) VALUES (?, ?, 1, '首次复习', 'v1', 1, ?, NULL)`
  );

  db.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 1; index <= 15; index += 1) {
      const question = index <= 10 ? `第${index}题 计算 1/${index}` : "";
      const mistake = insertMistake.run(
        student.id,
        question,
        knowledgePoint,
        NOW,
        NOW
      );
      const mistakeId = Number(mistake.lastInsertRowid);
      insertAttachment.run(
        mistakeId,
        `questions/q${index}.png`,
        createHash(index),
        `q${index}.png`,
        NOW
      );
      const attempt = insertAttempt.run(mistakeId, NOW);
      insertEvidence.run(
        mistakeId,
        Number(attempt.lastInsertRowid),
        NOW
      );
      insertReview.run(mistakeId, NOW, NOW);
    }
    db.prepare(
      `INSERT INTO attachment_crops (
        attachment_id, storage_key, mime_type, byte_size, width, height,
        sha256, crop_x, crop_y, crop_width, crop_height, rotation,
        source_width, source_height, created_at, updated_at
      ) VALUES (11, 'crops/q11.png', 'image/png', 68, 1, 1, ?, 0, 0, 1, 1,
        0, 1, 1, ?, ?)`
    ).run(createHash(101), NOW, NOW);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const counts = {
    mistakes: tableCount(db, "mistakes"),
    attachments: tableCount(db, "attachments"),
    attempts: tableCount(db, "attempts"),
    mastery_evidence: tableCount(db, "mastery_evidence"),
    review_schedule: tableCount(db, "review_schedule"),
    attachment_crops: tableCount(db, "attachment_crops")
  };
  db.close();
  return counts;
}

function createHash(seed) {
  return `${String(seed).padStart(2, "0")}${"a".repeat(62)}`.slice(0, 64);
}

function createScanTask(repository, attachmentId) {
  return repository.createQuestionScanTask({
    attachmentIds: [attachmentId],
    scanner: {
      provider: "fixture",
      model: "fixture-model",
      promptVersion: "m2-scan-1"
    },
    candidates: [
      {
        text: "1. 完整但答案待确认",
        completenessStatus: "complete",
        suspectedWrong: false,
        answerPending: true,
        region: { x: 0, y: 0, width: 1, height: 0.2 }
      },
      {
        text: "2. 完整疑似错误",
        completenessStatus: "complete",
        suspectedWrong: true,
        region: { x: 0, y: 0.2, width: 1, height: 0.2 }
      },
      {
        text: "3. 完整疑似错误且答案待确认",
        completenessStatus: "complete",
        suspectedWrong: true,
        answerPending: true,
        region: { x: 0, y: 0.4, width: 1, height: 0.2 }
      },
      {
        text: "4. 残缺疑似错误",
        completenessStatus: "incomplete",
        suspectedWrong: true,
        region: { x: 0, y: 0.6, width: 1, height: 0.2 }
      },
      {
        text: "5. 完整度未知",
        completenessStatus: "unknown",
        suspectedWrong: true,
        region: { x: 0, y: 0.7, width: 1, height: 0.15 }
      },
      {
        text: "6. 识别失败",
        status: "failed",
        completenessStatus: "unknown",
        recognitionError: "边界无法确认",
        region: { x: 0, y: 0.85, width: 1, height: 0.15 }
      },
      {
        text: "7. 已排除",
        completenessStatus: "complete",
        suspectedWrong: true,
        region: { x: 0, y: 0.9, width: 1, height: 0.1 }
      }
    ]
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    let errors = "";
    const timer = setTimeout(() => {
      reject(new Error(`服务启动超时：${errors || output}`));
    }, 15_000);
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

function startFakeVisionServer(responsePayload, status = 200) {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      requests.push({
        url: request.url,
        authorization: request.headers.authorization,
        body
      });
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({ candidates: responsePayload })
              }
            }
          ]
        })
      );
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, requests, port: server.address().port });
    });
  });
}

test("v13 升级到 v14 保留 15 条现有数据并回填兼容层", () => {
  withTemporaryDirectory((directory) => {
    const databasePath = path.join(directory, "learning.sqlite");
    const before = seedV13Database(databasePath);
    assert.deepEqual(before, {
      mistakes: 15,
      attachments: 15,
      attempts: 15,
      mastery_evidence: 15,
      review_schedule: 15,
      attachment_crops: 1
    });

    const repository = new LearningRepository(databasePath);
    assert.equal(repository.getSchemaVersion(), 14);
    assert.ok(repository.lastBackupPath);

    const after = {
      mistakes: tableCount(repository.db, "mistakes"),
      attachments: tableCount(repository.db, "attachments"),
      attempts: tableCount(repository.db, "attempts"),
      mastery_evidence: tableCount(repository.db, "mastery_evidence"),
      review_schedule: tableCount(repository.db, "review_schedule"),
      attachment_crops: tableCount(repository.db, "attachment_crops")
    };
    assert.deepEqual(after, before);

    assert.equal(tableCount(repository.db, "question_categories"), 15);
    assert.equal(tableCount(repository.db, "question_content_units"), 15);
    assert.equal(tableCount(repository.db, "question_image_derivations"), 16);
    for (const row of repository.db
      .prepare(
        `SELECT question_type, completeness_status, source_status,
                answer_review_status, eink_fit_status
         FROM mistakes ORDER BY id`
      )
      .all()) {
      assert.equal(row.question_type, "general");
      assert.equal(row.completeness_status, "confirmed");
      assert.equal(row.source_status, "legacy");
      assert.equal(row.answer_review_status, "confirmed");
      assert.equal(row.eink_fit_status, "unchecked");
    }
    const textUnits = repository.db
      .prepare(
        `SELECT COUNT(*) AS count FROM question_content_units
         WHERE unit_type = 'text'`
      )
      .get().count;
    const imageUnits = repository.db
      .prepare(
        `SELECT COUNT(*) AS count FROM question_content_units
         WHERE unit_type = 'image'`
      )
      .get().count;
    assert.equal(textUnits, 10);
    assert.equal(imageUnits, 5);
    repository.close();
  });
});

test("扫描候选默认不选，快捷选择不自动选残缺或失败候选", () => {
  withTemporaryDirectory((directory) => {
    const { repository, store } = createFixture(directory);
    const attachment = saveAttachment(repository, store);
    let task = createScanTask(repository, attachment.id);

    assert.equal(task.selectedCount, 0);
    assert.ok(task.candidates.every((candidate) => candidate.selected === false));

    task = repository.updateQuestionScanCandidate(task.id, task.candidates[6].id, {
      excluded: true
    });
    assert.equal(task.candidates[6].status, "excluded");

    const incompleteId = task.candidates[3].id;
    task = repository.updateQuestionScanSelection(task.id, {
      action: "select_candidate",
      candidateId: incompleteId
    });
    assert.equal(task.selectedCount, 1);
    assert.equal(task.candidates[3].selected, true);
    assert.equal(task.candidates[3].manuallySelected, true);

    task = repository.updateQuestionScanSelection(task.id, {
      action: "select_all"
    });
    assert.equal(task.selectedCount, 4);
    assert.equal(task.candidates[0].selected, true, "答案待确认但内容完整应被全选");
    assert.equal(task.candidates[1].selected, true);
    assert.equal(task.candidates[2].selected, true);
    assert.equal(task.candidates[3].selected, true, "手动选择应保留");
    assert.equal(task.candidates[4].selected, false, "完整度未知不能自动选中");
    assert.equal(task.candidates[5].selected, false, "识别失败不能自动选中");
    assert.equal(task.candidates[6].selected, false, "已排除不能自动选中");

    task = repository.updateQuestionScanSelection(task.id, {
      action: "select_wrong"
    });
    assert.equal(task.selectedCount, 3);
    assert.equal(task.candidates[0].selected, false);
    assert.equal(task.candidates[1].selected, true);
    assert.equal(task.candidates[2].selected, true);
    assert.equal(task.candidates[3].selected, true, "手动选择应保留");
    assert.equal(task.candidates[4].selected, false);
    assert.equal(task.candidates[3].manuallySelected, true);

    task = repository.updateQuestionScanSelection(task.id, { action: "clear_all" });
    assert.equal(task.selectedCount, 0);
    assert.ok(task.candidates.every((candidate) => candidate.selected === false));
    assert.ok(task.candidates.every((candidate) => candidate.manuallySelected === false));

    assert.throws(
      () =>
        repository.updateQuestionScanSelection(task.id, {
          action: "select_candidate",
          candidateId: task.candidates[5].id
        }),
      (error) => error.code === "SCAN_CANDIDATE_NOT_SELECTABLE"
    );
    assert.throws(
      () =>
        repository.updateQuestionScanSelection(task.id, {
          action: "select_candidate",
          candidateId: task.candidates[6].id
        }),
      (error) => error.code === "SCAN_CANDIDATE_NOT_SELECTABLE"
    );

    task = repository.updateQuestionScanCandidate(task.id, task.candidates[1].id, {
      text: "2. 人工补充后的题干",
      region: { x: 0.1, y: 0.2, width: 0.8, height: 0.3 }
    });
    assert.equal(task.candidates[1].text, "2. 人工补充后的题干");
    assert.deepEqual(task.candidates[1].region, {
      x: 0.1,
      y: 0.2,
      width: 0.8,
      height: 0.3
    });

    assert.equal(repository.listQuestions().length, 0);

    repository.db
      .prepare("UPDATE question_scan_tasks SET expires_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", task.id);
    const expired = repository.getQuestionScan(task.id);
    assert.equal(expired.status, "expired");
    assert.throws(
      () =>
        repository.updateQuestionScanSelection(task.id, {
          action: "select_all"
        }),
      (error) => error.code === "SCAN_EXPIRED"
    );
    repository.close();
  });
});

test("扫描失败、未配置模型和图片读取失败都保留图片且不写正式题库", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { repository, store } = createFixture(directory);
    const attachment = saveAttachment(repository, store);
    const before = repository.listQuestions().length;

    await assert.rejects(
      () =>
        createQuestionScan({
          repository,
          attachmentStore: store,
          scanner: { isConfigured: () => false },
          attachmentIds: [attachment.id],
          consent: false
        }),
      (error) => error.code === "VISION_CONSENT_REQUIRED"
    );
    assert.equal(
      repository.db.prepare("SELECT COUNT(*) AS count FROM question_scan_tasks").get().count,
      0
    );

    const unconfigured = await createQuestionScan({
      repository,
      attachmentStore: store,
      scanner: { isConfigured: () => false },
      attachmentIds: [attachment.id],
      consent: true
    });
    assert.equal(unconfigured.status, "failed");
    assert.equal(unconfigured.candidateCount, 0);
    assert.equal(unconfigured.images.length, 1);
    assert.equal(unconfigured.canImport, false);
    assert.match(unconfigured.errorMessage, /没有配置视觉识别/);

    fs.rmSync(path.join(store.directory, attachment.storageKey));
    const readFailure = await createQuestionScan({
      repository,
      attachmentStore: store,
      scanner: {
        isConfigured: () => true,
        scan: async () => {
          throw new Error("should not be called");
        }
      },
      attachmentIds: [attachment.id],
      consent: true
    });
    assert.equal(readFailure.status, "failed");
    assert.equal(readFailure.images.length, 1);
    assert.match(readFailure.errorMessage, /图片读取失败/);

    const second = saveAttachment(repository, store, "second.png");
    const ready = await createQuestionScan({
      repository,
      attachmentStore: store,
      scanner: {
        isConfigured: () => true,
        provider: "fixture",
        model: "fixture-model",
        promptVersion: "m2-scan-1",
        scan: async () => ({
          provider: "fixture",
          model: "fixture-model",
          promptVersion: "m2-scan-1",
          candidates: [
            {
              text: "1. 可选候选",
              completenessStatus: "complete",
              suspectedWrong: false,
              region: { x: 0, y: 0, width: 1, height: 1 }
            }
          ]
        })
      },
      attachmentIds: [second.id],
      consent: true
    });
    assert.equal(ready.status, "ready");
    assert.equal(ready.candidateCount, 1);
    assert.equal(ready.images.length, 1);
    assert.equal(ready.canImport, false);

    assert.equal(repository.listQuestions().length, before);
    assert.equal(repository.listQuestions().length, 0);
    repository.close();
  });
});

test("HTTP 上传页面生成候选且读取裁剪图，未导入不增加正式题", async () => {
  await withTemporaryDirectory(async (directory) => {
    const fake = await startFakeVisionServer([
      {
        text: "1. 完整题",
        completeness: "complete",
        suspectedWrong: false,
        answerPending: false,
        confidence: 0.9,
        region: { x: 0, y: 0, width: 1, height: 0.5 }
      },
      {
        text: "2. 残缺题",
        completeness: "incomplete",
        suspectedWrong: true,
        answerPending: false,
        confidence: 0.8,
        region: { x: 0, y: 0.5, width: 1, height: 0.5 }
      }
    ]);
    const port = await freePort();
    const child = spawn(process.execPath, ["src/server.js"], {
      cwd: projectRoot,
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(port),
        DB_PATH: path.join(directory, "learning.sqlite"),
        ATTACHMENTS_DIR: path.join(directory, "attachments"),
        SCAN_BASE_URL: `http://127.0.0.1:${fake.port}`,
        SCAN_API_KEY: "fixture-key",
        SCAN_MODEL: "fixture-model",
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
      const initial = await fetch(`${baseUrl}/api/questions`).then((response) =>
        response.json()
      );
      assert.equal(initial.total, 0);

      const image = await sharp({
        create: {
          width: 8,
          height: 8,
          channels: 3,
          background: { r: 240, g: 240, b: 240 }
        }
      })
        .png()
        .toBuffer();
      const upload = await fetch(`${baseUrl}/api/attachments?kind=question`, {
        method: "POST",
        headers: {
          "Content-Type": "image/png",
          "X-Original-Name": encodeURIComponent("page.png")
        },
        body: image
      });
      assert.equal(upload.status, 201);
      const attachment = await upload.json();
      assert.equal(attachment.mimeType, "image/png");

      const scanResponse = await fetch(`${baseUrl}/api/questions/scans`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attachmentIds: [attachment.id], consent: true })
      });
      assert.equal(scanResponse.status, 201);
      const task = await scanResponse.json();
      assert.equal(task.status, "ready");
      assert.equal(task.candidateCount, 2);
      assert.equal(task.selectedCount, 0);
      assert.equal(task.canImport, false);
      assert.equal(task.importStage, "M3");
      assert.equal(task.images.length, 1);
      assert.equal(fake.requests.length, 1);
      assert.match(fake.requests[0].body, /data:image\/png;base64/);

      const crop = await fetch(`${baseUrl}${task.candidates[0].imageUrl}`);
      assert.equal(crop.status, 200);
      assert.match(crop.headers.get("content-type") || "", /image\/png/);
      assert.ok((await crop.arrayBuffer()).byteLength > 0);

      const selectAll = await fetch(
        `${baseUrl}/api/questions/scans/${task.id}/selection`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "select_all" })
        }
      );
      assert.equal(selectAll.status, 200);
      const selected = await selectAll.json();
      assert.equal(selected.selectedCount, 1, "只选择完整候选");
      assert.equal(selected.candidates[0].selected, true);
      assert.equal(selected.candidates[1].selected, false);

      const exclude = await fetch(
        `${baseUrl}/api/questions/scans/${task.id}/candidates/${task.candidates[0].id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ excluded: true })
        }
      );
      assert.equal(exclude.status, 200);
      const excludedTask = await exclude.json();
      assert.equal(excludedTask.candidates[0].status, "excluded");
      assert.equal(excludedTask.candidates[0].selected, false);

      const final = await fetch(`${baseUrl}/api/questions`).then((response) =>
        response.json()
      );
      assert.equal(final.total, 0, "M2 只能保存候选");
    } finally {
      await stopServer(child);
      await new Promise((resolve) => fake.server.close(resolve));
    }
  });
});

test("扫描模型返回非 2xx 时保留上游状态与错误体", async () => {
  const scanner = new OpenAICompatibleQuestionScanner({
    baseUrl: "https://example.invalid",
    apiKey: "fixture-key",
    model: "fixture-model",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          error: { code: "InvalidParameter", message: "image unsupported" }
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
  });
  await assert.rejects(
    () =>
      scanner.scan({
        images: [{ mimeType: "image/png", buffer: Buffer.from("fixture") }]
      }),
    (error) =>
      error.code === "SCAN_MODEL_FAILED" &&
      error.details?.upstreamStatus === 400 &&
      /image unsupported/.test(error.details?.upstreamBody || "")
  );
});
