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
import { saveAttachmentCrop } from "../src/attachment-crop.js";
import { migrateDatabase, SCHEMA_MIGRATIONS } from "../src/migrations.js";
import {
  createQuestionScan,
  importQuestionScan
} from "../src/question-bank/scan-service.js";
import {
  InternalOcrClient,
  OcrTextQuestionScanner,
  detectOcrBlockWarnings
} from "../src/question-bank/scanner.js";

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

function saveAttachment(repository, store, name = "question.png", buffer = PNG) {
  const saved = store.save(buffer, {
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
        suggestedAnswer: "42",
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

function startFakeScanPipeline({
  ocrBlocks,
  llmCandidates = [],
  repairCandidates = [],
  ocrStatus = 200,
  llmStatus = 200
}) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      requests.push({
        url: request.url,
        authorization: request.headers.authorization || "",
        contentType: request.headers["content-type"] || "",
        body
      });
      if (request.url === "/v1/ocr/raw") {
        response.writeHead(ocrStatus, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify(
            ocrStatus === 200
              ? {
                  engine: "rapidocr",
                  modelVersion: "PP-OCRv6-small",
                  width: 1000,
                  height: 800,
                  processingTimeMs: 25,
                  blocks: ocrBlocks
                }
              : { detail: { code: "OCR_PROCESSING_FAILED" } }
          )
        );
        return;
      }
      const requestPayload = body.length
        ? JSON.parse(body.toString("utf8"))
        : {};
      const isRepair = Array.isArray(requestPayload.messages)
        ? requestPayload.messages.some(
            (message) =>
              typeof message.content === "string" &&
              message.content.includes("结构化助手")
          )
        : false;
      response.writeHead(llmStatus, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify(
          llmStatus === 200
            ? {
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        candidates: isRepair
                          ? repairCandidates
                          : llmCandidates
                      })
                    }
                  }
                ],
                usage: { prompt_tokens: 10, completion_tokens: 10 }
              }
            : { error: { message: "fixture failure" } }
        )
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

test("v13 升级到 v15 保留 15 条现有数据并回填兼容层", () => {
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
    assert.equal(repository.getSchemaVersion(), 15);
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
    const taskColumns = new Set(
      repository.db
        .prepare("PRAGMA table_info(question_scan_tasks)")
        .all()
        .map((row) => row.name)
    );
    const candidateColumns = new Set(
      repository.db
        .prepare("PRAGMA table_info(question_scan_candidates)")
        .all()
        .map((row) => row.name)
    );
    for (const column of ["ocr_provider", "ocr_model", "ocr_blocks_json"]) {
      assert.ok(taskColumns.has(column));
    }
    for (const column of ["analysis_json", "imported_question_id"]) {
      assert.ok(candidateColumns.has(column));
    }
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

test("候选导入失败会回滚正式题并允许安全重试", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { repository, store } = createFixture(directory);
    const sourceImage = await sharp({
      create: {
        width: 20,
        height: 20,
        channels: 3,
        background: { r: 240, g: 240, b: 240 }
      }
    })
      .png()
      .toBuffer();
    const attachment = saveAttachment(
      repository,
      store,
      "scan-source.png",
      sourceImage
    );
    let task = createScanTask(repository, attachment.id);
    const candidateId = task.candidates[0].id;
    task = repository.updateQuestionScanSelection(task.id, {
      action: "select_candidate",
      candidateId
    });
    assert.equal(task.candidates[0].selected, true);

    repository.db.exec(`
      CREATE TRIGGER fail_scan_candidate_import
      BEFORE UPDATE OF imported_question_id ON question_scan_candidates
      WHEN NEW.imported_question_id IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'forced scan import failure');
      END;
    `);
    const failed = await importQuestionScan({
      repository,
      attachmentStore: store,
      scanId: task.id,
      candidateIds: [candidateId]
    });
    assert.equal(failed.successCount, 0);
    assert.equal(failed.failedCount, 1);
    assert.equal(repository.listQuestions().length, 0);
    assert.equal(tableCount(repository.db, "mistake_parts"), 0);
    assert.equal(tableCount(repository.db, "accepted_answers"), 0);
    assert.equal(tableCount(repository.db, "question_options"), 0);
    assert.equal(tableCount(repository.db, "attachments"), 1);
    assert.equal(
      repository.db
        .prepare(
          "SELECT imported_question_id FROM question_scan_candidates WHERE id = ?"
        )
        .get(candidateId).imported_question_id,
      null
    );

    repository.db.exec("DROP TRIGGER fail_scan_candidate_import");
    const imported = await importQuestionScan({
      repository,
      attachmentStore: store,
      scanId: task.id,
      candidateIds: [candidateId]
    });
    assert.equal(
      imported.successCount,
      1,
      JSON.stringify(imported.results)
    );
    assert.equal(imported.failedCount, 0);
    assert.equal(repository.listQuestions().length, 1);
    assert.equal(tableCount(repository.db, "mistake_parts"), 1);
    assert.equal(tableCount(repository.db, "accepted_answers"), 1);
    assert.ok(imported.scan.candidates[0].importedQuestionId);
    repository.close();
  });
});

test("拍照选题使用原图的裁剪区域进行 OCR", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { repository, store } = createFixture(directory);
    const original = await sharp({
      create: {
        width: 20,
        height: 20,
        channels: 3,
        background: { r: 245, g: 245, b: 245 }
      }
    })
      .png()
      .toBuffer();
    const attachment = saveAttachment(
      repository,
      store,
      "scan-original.png",
      original
    );
    const crop = await sharp({
      create: {
        width: 8,
        height: 6,
        channels: 3,
        background: { r: 230, g: 240, b: 235 }
      }
    })
      .png()
      .toBuffer();
    const cropped = saveAttachmentCrop({
      repository,
      attachmentStore: store,
      attachmentId: attachment.id,
      buffer: crop,
      declaredMime: "image/png",
      crop: {
        x: 2,
        y: 3,
        width: 8,
        height: 6,
        rotation: 0,
        sourceWidth: 20,
        sourceHeight: 20
      }
    });
    assert.equal(cropped.hasCrop, true);

    let seen = null;
    const task = await createQuestionScan({
      repository,
      attachmentStore: store,
      scanner: {
        isConfigured: () => true,
        provider: "fixture",
        model: "fixture-model",
        promptVersion: "m2-scan-crop",
        scan: async ({ images }) => {
          seen = images[0];
          return {
            provider: "fixture",
            model: "fixture-model",
            promptVersion: "m2-scan-crop",
            candidates: [
              {
                text: "1. 裁剪区域中的题目",
                completenessStatus: "complete",
                suspectedWrong: false,
                region: { x: 0, y: 0, width: 1, height: 1 }
              }
            ]
          };
        }
      },
      attachmentIds: [attachment.id]
    });

    assert.deepEqual(seen.buffer, crop);
    assert.equal(seen.mimeType, "image/png");
    assert.equal(task.images[0].width, 8);
    assert.equal(task.images[0].height, 6);
    assert.match(task.images[0].url, /variant=crop/);
    const context = repository.getQuestionScanImageContext(
      task.id,
      task.candidates[0].id
    );
    assert.deepEqual(store.read(context.storageKey), crop);
    assert.equal(context.width, 8);
    assert.equal(context.height, 6);
    assert.deepEqual(
      store.read(
        repository.getAttachment(attachment.id, {
          includeStorageKey: true
        }).storageKey
      ),
      original
    );
    repository.close();
  });
});

test("扫描未配置和图片读取失败都保留图片且不写正式题库", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { repository, store } = createFixture(directory);
    const attachment = saveAttachment(repository, store);
    const before = repository.listQuestions().length;

    const unconfigured = await createQuestionScan({
      repository,
      attachmentStore: store,
      scanner: { isConfigured: () => false },
      attachmentIds: [attachment.id]
    });
    assert.equal(unconfigured.status, "failed");
    assert.equal(unconfigured.candidateCount, 0);
    assert.equal(unconfigured.images.length, 1);
    assert.equal(unconfigured.canImport, false);
    assert.match(unconfigured.errorMessage, /没有配置内部 OCR/);

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
      attachmentIds: [attachment.id]
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
      attachmentIds: [second.id]
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

test("HTTP OCR 与纯文本模型生成候选，确认后导入现有题库", async () => {
  await withTemporaryDirectory(async (directory) => {
    const fake = await startFakeScanPipeline({
      ocrBlocks: [
        {
          order: 1,
          text: "1. 完整题",
          bbox: [0, 0, 500, 400],
          confidence: 0.77
        },
        {
          order: 2,
          text: "2. 残缺题",
          bbox: [0, 400, 500, 800],
          confidence: 0.9
        }
      ],
      llmCandidates: [
        {
          text: "1. 完整题",
          options: [
            { label: "A", text: "41", sourceBlockIds: ["i1b1"] },
            { label: "B", text: "42", sourceBlockIds: ["i1b1"] }
          ],
          questionType: "fill_blank",
          studentAnswer: "41",
          suggestedAnswer: "42",
          parts: [
            {
              partNo: 1,
              label: "（1）",
              prompt: "圆的半径是多少？",
              studentAnswer: "3",
              suggestedAnswer: "3厘米",
              answerType: "number",
              confidence: 0.9,
              sourceBlockIds: ["i1b1"],
              pendingReasons: []
            },
            {
              partNo: 2,
              label: "（2）",
              prompt: "圆的面积是多少？",
              studentAnswer: "28.26",
              suggestedAnswer: "28.26平方厘米；9π平方厘米",
              answerType: "number",
              confidence: 0.88,
              sourceBlockIds: ["i1b2"],
              pendingReasons: []
            }
          ],
          completeness: "complete",
          suspectedWrong: true,
          answerPending: false,
          confidence: 0.9,
          sourceBlockIds: ["i1b1"],
          region: { x: 0, y: 0, width: 0.5, height: 0.5 }
        },
        {
          text: "2. 残缺题",
          questionType: "general",
          studentAnswer: "",
          suggestedAnswer: "",
          completeness: "incomplete",
          suspectedWrong: true,
          answerPending: true,
          confidence: 0.8,
          sourceBlockIds: ["i1b2"],
          region: { x: 0, y: 0.5, width: 0.5, height: 0.5 }
        }
      ],
      repairCandidates: [
        {
          candidateNo: 2,
          parts: [
            {
              partNo: 1,
              label: "小问 1",
              prompt: "2. 残缺题",
              studentAnswer: "",
              suggestedAnswer: "",
              answerType: "auto",
              confidence: 0.8,
              sourceBlockIds: ["i1b2"],
              pendingReasons: ["ANSWER_PENDING"]
            }
          ]
        }
      ]
    });
    const port = await freePort();
    const child = spawn(process.execPath, ["src/server.js"], {
      cwd: projectRoot,
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(port),
        DB_PATH: path.join(directory, "learning.sqlite"),
        ATTACHMENTS_DIR: path.join(directory, "attachments"),
        OCR_BASE_URL: `http://127.0.0.1:${fake.port}`,
        OCR_TIMEOUT_MS: "5000",
        OCR_LOW_CONFIDENCE: "0.8",
        LLM_BASE_URL: `http://127.0.0.1:${fake.port}`,
        LLM_API_KEY: "fixture-key",
        LLM_MODEL: "fixture-model",
        LLM_MAX_RETRIES: "0"
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

      const extractResponse = await fetch(
        `${baseUrl}/api/attachments/${attachment.id}/extract`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}"
        }
      );
      assert.equal(extractResponse.status, 200);
      const extracted = await extractResponse.json();
      assert.equal(extracted.available, true);
      assert.equal(extracted.text, "1. 完整题\n2. 残缺题");
      assert.equal(extracted.provider, "rapidocr");
      assert.equal(extracted.model, "PP-OCRv6-small");
      assert.equal(fake.requests.length, 1);
      assert.equal(fake.requests[0].url, "/v1/ocr/raw");
      assert.deepEqual(fake.requests[0].body, image);

      const scanResponse = await fetch(`${baseUrl}/api/questions/scans`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attachmentIds: [attachment.id] })
      });
      assert.equal(scanResponse.status, 201);
      const task = await scanResponse.json();
      assert.equal(task.status, "ready");
      assert.equal(task.candidateCount, 2);
      assert.equal(task.selectedCount, 0);
      assert.equal(task.canImport, false);
      assert.equal(task.importStage, "ready");
      assert.equal(task.images.length, 1);
      assert.equal(task.ocr.model, "PP-OCRv6-small");
      assert.equal(task.ocr.blocks.length, 2);
      assert.equal(task.candidates[0].studentAnswer, "3；28.26");
      assert.equal(
        task.candidates[0].suggestedAnswer,
        "3厘米；28.26平方厘米；9π平方厘米"
      );
      assert.equal(task.candidates[0].parts.length, 2);
      assert.equal(task.candidates[0].parts[0].label, "（1）");
      assert.equal(
        task.candidates[0].parts[1].suggestedAnswer,
        "28.26平方厘米；9π平方厘米"
      );
      assert.equal(
        task.candidates[0].parts[0].answerSource,
        "system_suggested"
      );
      assert.equal(task.candidates[1].parts.length, 1, "无小问时生成默认小问");
      assert.equal(task.candidates[0].questionType, "fill_blank");
      assert.equal(task.candidates[0].options.length, 2);
      assert.equal(task.candidates[0].answerPending, true);
      assert.ok(task.candidates[0].pendingReasons.includes("LOW_CONFIDENCE"));
      assert.equal(fake.requests.length, 4);
      assert.equal(fake.requests[1].contentType, "image/png");
      assert.equal(fake.requests[1].url, "/v1/ocr/raw");
      assert.deepEqual(fake.requests[1].body, image);
      assert.equal(fake.requests[2].url, "/chat/completions");
      assert.equal(fake.requests[3].url, "/chat/completions");
      assert.doesNotMatch(
        fake.requests[2].body.toString("utf8"),
        /data:image\/png;base64/
      );
      assert.match(
        fake.requests[3].body.toString("utf8"),
        /结构化助手/
      );

      const unselectedImport = await fetch(
        `${baseUrl}/api/questions/scans/${task.id}/import`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ candidateIds: [task.candidates[0].id] })
        }
      );
      assert.equal(unselectedImport.status, 400);
      assert.match((await unselectedImport.json()).error, /已选择/);

      const selectWrong = await fetch(
        `${baseUrl}/api/questions/scans/${task.id}/selection`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "select_wrong",
            candidateId: null
          })
        }
      );
      assert.equal(selectWrong.status, 200);
      const selectWrongTask = await selectWrong.json();
      assert.equal(selectWrongTask.candidates[0].selected, true);

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
      assert.equal(selected.canImport, true);

      const editedPartsResponse = await fetch(
        `${baseUrl}/api/questions/scans/${task.id}/candidates/${task.candidates[0].id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            parts: [
              {
                ...task.candidates[0].parts[1],
                answerSource: "user_confirmed",
                pendingReasons: []
              },
              {
                ...task.candidates[0].parts[0],
                answerSource: "user_confirmed",
                pendingReasons: []
              }
            ]
          })
        }
      );
      assert.equal(editedPartsResponse.status, 200);
      const editedTask = await editedPartsResponse.json();
      assert.equal(editedTask.candidates[0].parts[0].prompt, "圆的面积是多少？");
      assert.equal(editedTask.candidates[0].parts[0].partNo, 1);
      assert.equal(
        editedTask.candidates[0].parts[0].answerSource,
        "user_confirmed"
      );
      assert.equal(
        editedTask.candidates[0].studentAnswer,
        "28.26；3"
      );

      const imported = await fetch(
        `${baseUrl}/api/questions/scans/${task.id}/import`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            candidateIds: [task.candidates[0].id],
            confirmIncomplete: false
          })
        }
      );
      assert.equal(imported.status, 200);
      const importResult = await imported.json();
      assert.equal(importResult.successCount, 1);
      assert.equal(importResult.failedCount, 0);
      assert.ok(importResult.scan.candidates[0].importedQuestionId);
      assert.equal(importResult.scan.candidates[0].selected, false);

      const final = await fetch(`${baseUrl}/api/questions`).then((response) =>
        response.json()
      );
      assert.equal(final.total, 1);
      assert.equal(final.questions[0].question, "1. 完整题");
      assert.equal(final.questions[0].studentAnswer, "28.26；3");
      assert.equal(final.questions[0].parts.length, 2);
      assert.equal(final.questions[0].parts[0].prompt, "圆的面积是多少？");
      assert.equal(final.questions[0].questionType, "fill_blank");
      assert.equal(final.questions[0].answerReviewStatus, "pending");
      assert.equal(final.questions[0].attachments.length, 1);
      const importedQuestion = await fetch(
        `${baseUrl}/api/questions/${importResult.results[0].questionId}`
      ).then((response) => response.json());
      assert.equal(importedQuestion.options.length, 2);
      assert.equal(importedQuestion.options[1].text, "42");
      const importedQuestionId = importResult.results[0].questionId;
      const verificationDb = new DatabaseSync(
        path.join(directory, "learning.sqlite"),
        { readOnly: true }
      );
      assert.equal(
        verificationDb
          .prepare("SELECT correct_answer FROM mistakes WHERE id = ?")
          .get(importedQuestionId).correct_answer,
        "28.26平方厘米；3厘米"
      );
      assert.equal(
        verificationDb
          .prepare(
            `SELECT COUNT(*) AS count FROM mistake_parts
             WHERE mistake_id = ? AND active = 1`
          )
          .get(importedQuestionId).count,
        2
      );
      assert.deepEqual(
        verificationDb
          .prepare(
            `SELECT aa.answer
             FROM accepted_answers aa
             JOIN mistake_parts mp ON mp.id = aa.part_id
             WHERE mp.mistake_id = ?
             ORDER BY mp.part_no, aa.position`
          )
          .all(importedQuestionId)
          .map((row) => row.answer),
        ["28.26平方厘米", "9π平方厘米", "3厘米"]
      );
      verificationDb.close();
    } finally {
      await stopServer(child);
      await new Promise((resolve) => fake.server.close(resolve));
    }
  });
});

test("OCR 非 2xx 时保留上游状态与错误体", async () => {
  const scanner = new OcrTextQuestionScanner({
    ocrClient: new InternalOcrClient({
      baseUrl: "https://example.invalid",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            detail: { code: "OCR_PROCESSING_FAILED", message: "decode failed" }
          }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        )
    })
  });
  await assert.rejects(
    () =>
      scanner.scan({
        images: [{ mimeType: "image/png", buffer: Buffer.from("fixture") }]
      }),
    (error) =>
      error.code === "OCR_PROCESSING_FAILED" &&
      error.details?.upstreamStatus === 500 &&
      /decode failed/.test(error.details?.upstreamBody || "")
  );
});

test("OCR 文本模型不可用时降级为待确认候选并保留字块", async () => {
  const scanner = new OcrTextQuestionScanner({
    ocrClient: new InternalOcrClient({
      baseUrl: "https://example.invalid",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            engine: "rapidocr",
            modelVersion: "PP-OCRv6-small",
            width: 1000,
            height: 800,
            blocks: [
              {
                order: 1,
                text: "1. 计算 1/2 + 1/4",
                bbox: [20, 20, 600, 100],
                confidence: 0.96
              },
              {
                order: 2,
                text: "2. 一个圆的半径是 3 厘米",
                bbox: [20, 140, 700, 220],
                confidence: 0.72
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    })
  });
  const result = await scanner.scan({
    images: [{ mimeType: "image/png", buffer: Buffer.from("fixture") }]
  });
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0].answerPending, true);
  assert.ok(result.candidates[0].pendingReasons.includes("LLM_NOT_CONFIGURED"));
  assert.ok(result.candidates[1].pendingReasons.includes("LOW_CONFIDENCE"));
  assert.equal(result.candidates[0].parts.length, 1);
  assert.equal(
    result.candidates[0].parts[0].answerSource,
    "system_suggested"
  );
  assert.ok(
    result.candidates[0].parts[0].pendingReasons.includes(
      "LLM_NOT_CONFIGURED"
    )
  );
  assert.equal(result.ocr.blocks.length, 2);
  assert.ok(result.candidates[0].sourceBlocks[0].bbox.length === 4);
});

test("答案引用未声明的低置信字块时仍标记待确认", async () => {
  const scanner = new OcrTextQuestionScanner({
    ocrClient: new InternalOcrClient({
      baseUrl: "https://example.invalid",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            engine: "rapidocr",
            modelVersion: "PP-OCRv6-small",
            width: 1000,
            height: 800,
            blocks: [
              {
                order: 1,
                text: "1. 计算圆的面积",
                bbox: [20, 20, 700, 100],
                confidence: 0.96
              },
              {
                order: 2,
                text: "28.26",
                bbox: [40, 120, 180, 180],
                confidence: 0.62
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    }),
    llmGateway: {
      model: "fixture-model",
      isConfigured: () => true,
      chat: async () => ({
        provider: "fixture",
        model: "fixture-model",
        message: {
          content: JSON.stringify({
            candidates: [
              {
                text: "1. 计算圆的面积",
                questionType: "fill_blank",
                studentAnswer: "28.26",
                suggestedAnswer: "28.26",
                completeness: "complete",
                answerPending: false,
                sourceBlockIds: ["i1b1"]
              }
            ]
          })
        }
      })
    }
  });
  const result = await scanner.scan({
    images: [{ mimeType: "image/png", buffer: Buffer.from("fixture") }]
  });
  assert.equal(result.candidates[0].answerPending, true);
  assert.ok(result.candidates[0].pendingReasons.includes("LOW_CONFIDENCE"));
});

test("模型漏报 sourceBlockIds 时按 OCR 文本补齐两行候选区域", async () => {
  const scanner = new OcrTextQuestionScanner({
    ocrClient: new InternalOcrClient({
      baseUrl: "https://example.invalid",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            engine: "rapidocr",
            modelVersion: "PP-OCRv6-small",
            width: 1000,
            height: 200,
            blocks: [
              {
                order: 1,
                text: "因为它们的半径与直径都相",
                bbox: [100, 0, 600, 20],
                confidence: 0.9
              },
              {
                order: 2,
                text: "7. 人民公园有一个半径为200 dm的圆形人工湖，现要在人工湖的周围加一圈护栏。至少",
                bbox: [20, 30, 950, 70],
                confidence: 0.98
              },
              {
                order: 3,
                text: "需要多",
                bbox: [40, 80, 100, 110],
                confidence: 1
              },
              {
                order: 4,
                text: "少米护栏？这个人工湖的占地面积是多少平方本？",
                bbox: [90, 80, 720, 110],
                confidence: 0.98
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    }),
    llmGateway: {
      model: "fixture-model",
      isConfigured: () => true,
      chat: async () => ({
        provider: "fixture",
        model: "fixture-model",
        message: {
          content: JSON.stringify({
            candidates: [
              {
                text: "7. 人民公园有一个半径为200 dm的圆形人工湖，现要在人工湖的周围加一圈护栏。至少需要多少米护栏？这个人工湖的占地面积是多少平方米？",
                questionType: "short_answer",
                completeness: "complete",
                answerPending: false,
                confidence: 0.98,
                region: { x: 0.02, y: 0.15, width: 0.93, height: 0.2 }
              }
            ]
          })
        }
      })
    }
  });
  const result = await scanner.scan({
    images: [{ mimeType: "image/png", buffer: Buffer.from("fixture") }]
  });
  const candidate = result.candidates[0];
  assert.deepEqual(
    candidate.sourceBlocks.map((block) => block.id),
    ["i1b2", "i1b3", "i1b4"]
  );
  assert.ok(candidate.region.height > 0.35);
  assert.equal(
    candidate.pendingReasons.includes("MISSING_SOURCE_BLOCKS"),
    false
  );
});

test("结构修复失败时按问句拆分两个小问", async () => {
  let calls = 0;
  const scanner = new OcrTextQuestionScanner({
    ocrClient: new InternalOcrClient({
      baseUrl: "https://example.invalid",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            engine: "rapidocr",
            modelVersion: "PP-OCRv6-small",
            width: 1000,
            height: 200,
            blocks: [
              {
                order: 1,
                text: "人民公园有一个半径为200 dm的圆形人工湖。至少需要多少米护栏？这个人工湖的占地面积是多少平方米？",
                bbox: [20, 30, 950, 150],
                confidence: 0.98
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    }),
    llmGateway: {
      model: "fixture-model",
      isConfigured: () => true,
      chat: async () => {
        calls += 1;
        if (calls > 1) throw new Error("repair unavailable");
        return {
          provider: "fixture",
          model: "fixture-model",
          message: {
            content: JSON.stringify({
              candidates: [
                {
                  text: "人民公园有一个半径为200 dm的圆形人工湖。至少需要多少米护栏？这个人工湖的占地面积是多少平方米？",
                  questionType: "short_answer",
                  completeness: "complete",
                  answerPending: false,
                  confidence: 0.98,
                  region: { x: 0.02, y: 0.15, width: 0.93, height: 0.6 }
                }
              ]
            })
          }
        };
      }
    }
  });
  const result = await scanner.scan({
    images: [{ mimeType: "image/png", buffer: Buffer.from("fixture") }]
  });
  const parts = result.candidates[0].parts;
  assert.equal(parts.length, 2);
  assert.match(parts[0].prompt, /多少米护栏/);
  assert.match(parts[1].prompt, /占地面积/);
  assert.ok(parts[0].pendingReasons.includes("PART_SPLIT_INFERRED"));
  assert.ok(parts[1].pendingReasons.includes("ANSWER_PENDING"));
});

test("多小问保留系统答案建议并对公式不足标记待确认", async () => {
  const scanner = new OcrTextQuestionScanner({
    ocrClient: new InternalOcrClient({
      baseUrl: "https://example.invalid",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            engine: "rapidocr",
            modelVersion: "PP-OCRv6-small",
            width: 1000,
            height: 800,
            blocks: [
              {
                order: 1,
                text: "求圆的面积和周长",
                bbox: [20, 20, 700, 100],
                confidence: 0.98
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    }),
    llmGateway: {
      model: "fixture-model",
      isConfigured: () => true,
      chat: async () => ({
        provider: "fixture",
        model: "fixture-model",
        message: {
          content: JSON.stringify({
            candidates: [
              {
                text: "求圆的面积和周长",
                questionType: "composite",
                parts: [
                  {
                    partNo: 1,
                    label: "（1）",
                    prompt: "求面积",
                    studentAnswer: "28.26",
                    suggestedAnswer: "28.26平方厘米；9π平方厘米",
                    answerType: "number",
                    confidence: 0.92,
                    sourceBlockIds: ["i1b1"],
                    pendingReasons: []
                  },
                  {
                    partNo: 2,
                    label: "（2）",
                    prompt: "根据图中公式求周长",
                    studentAnswer: "",
                    suggestedAnswer: "",
                    answerType: "number",
                    confidence: 0.9,
                    sourceBlockIds: ["i1b1"],
                    pendingReasons: ["FORMULA_UNCERTAIN"]
                  }
                ],
                completeness: "complete",
                answerPending: false,
                sourceBlockIds: ["i1b1"],
                region: { x: 0, y: 0, width: 1, height: 1 }
              }
            ]
          })
        }
      })
    }
  });
  const result = await scanner.scan({
    images: [{ mimeType: "image/png", buffer: Buffer.from("fixture") }]
  });
  const candidate = result.candidates[0];
  assert.equal(candidate.parts.length, 2);
  assert.equal(candidate.parts[0].answerSource, "system_suggested");
  assert.equal(
    candidate.parts[0].suggestedAnswer,
    "28.26平方厘米；9π平方厘米"
  );
  assert.ok(candidate.parts[1].pendingReasons.includes("FORMULA_UNCERTAIN"));
  assert.ok(candidate.parts[1].pendingReasons.includes("ANSWER_PENDING"));
  assert.equal(candidate.answerPending, true);
});

test("相邻数字旁的额外汇总符号标记待确认", () => {
  const warnings = detectOcrBlockWarnings(
    [
      {
        id: "a",
        text: "28.26",
        bbox: [250, 400, 420, 466]
      },
      {
        id: "b",
        text: "二",
        bbox: [210, 420, 245, 455]
      }
    ],
    0.8
  );
  assert.ok(warnings.get("a").includes("EXTRA_SYMBOL"));
  assert.ok(warnings.get("b").includes("EXTRA_SYMBOL"));
});

test("扫描 UI 展示题型与答案候选并只在选中后允许导入", () => {
  const app = fs.readFileSync(
    new URL("../public/app.js", import.meta.url),
    "utf8"
  );
  const html = fs.readFileSync(
    new URL("../public/index.html", import.meta.url),
    "utf8"
  );
  assert.match(app, /data-scan-question-type/);
  assert.match(app, /scan-parts-editor/);
  assert.match(app, /data-scan-part-field/);
  assert.match(app, /scanPartSourceLabel/);
  assert.match(app, /data-scan-add-part/);
  assert.match(app, /data-scan-remove-part/);
  assert.match(app, /data-scan-move-part/);
  assert.match(app, /标准答案（用户已修改）/);
  assert.match(app, /candidate\.options/);
  assert.match(app, /scanCandidateInput/);
  assert.match(app, /importSelectedScanCandidates/);
  assert.match(app, /candidate\.importedQuestionId/);
  assert.match(app, /pendingReasons\.map\(scanPendingLabel\)/);
  assert.match(app, /crop\.dataset\.cropContext = "scan"/);
  assert.match(
    app,
    /openCropEditor\(\s*Number\(crop\.dataset\.cropAttachment\),\s*crop\.dataset\.cropContext/
  );
  assert.match(html, /导入所选题目/);
  assert.doesNotMatch(html, /M3 开放/);
});
