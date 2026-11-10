import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LearningRepository } from "../src/database.js";
import {
  BASELINE_SCHEMA_SQL,
  SCHEMA_MIGRATIONS,
  getSchemaVersion,
  migrateDatabase
} from "../src/migrations.js";

function withTemporaryDirectory(callback) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "math-coach-migrations-")
  );
  try {
    return callback(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function createLegacyDatabase(filePath) {
  const db = new DatabaseSync(filePath);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(BASELINE_SCHEMA_SQL);
  db.prepare(
    "INSERT INTO students (name, grade, created_at) VALUES (?, ?, ?)"
  ).run("旧版学生", 6, "2026-01-01T00:00:00.000Z");
  db.prepare(
    "INSERT INTO knowledge_points (name, position) VALUES (?, ?)"
  ).run("百分数", 0);
  db.prepare(
    `INSERT INTO mistakes (
      student_id, question, student_answer, correct_answer, analysis,
      knowledge_point, error_type, hint, method_steps, common_errors,
      diagnosis, status, consecutive_correct, attempt_count, due_at,
      last_reviewed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    1,
    "一件商品原价 100 元，涨价 20% 后是多少元？",
    "100元",
    "120元",
    "",
    "百分数",
    "单位“1”找错",
    "先求涨价部分",
    '["步骤一","步骤二","步骤三"]',
    '["单位“1”找错"]',
    "旧版诊断",
    "practicing",
    1,
    2,
    null,
    null,
    "2026-01-01T00:00:00.000Z",
    "2026-01-02T00:00:00.000Z"
  );
  db.prepare(
    `INSERT INTO attempts
     (mistake_id, answer, is_correct, feedback, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    1,
    "100元",
    0,
    "需要先计算涨价部分",
    "2026-01-02T00:00:00.000Z"
  );
  db.close();
}

test("新数据库建立版本化迁移记录并初始化基线数据", () => {
  const repository = new LearningRepository();

  assert.equal(repository.getSchemaVersion(), 9);
  assert.equal(repository.lastBackupPath, null);
  assert.equal(repository.getStudent().name, "六年级同学");
  assert.equal(repository.getKnowledgePoints().length, 12);

  const migrations = repository.db
    .prepare(
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version"
    )
    .all();
  assert.deepEqual(
    migrations.map((migration) => migration.name),
    [
      "baseline_learning_schema",
      "agent_learning_records",
      "tooling_contract",
      "mistake_editing",
      "multi_part_questions",
      "attempt_evaluations",
      "knowledge_base",
      "mastery_evidence_and_spaced_review",
      "legacy_mastery_evidence_backfill"
    ]
  );
  assert.equal(migrations[0].checksum.length, 64);
  assert.equal(migrations[1].checksum.length, 64);
  assert.equal(migrations[2].checksum.length, 64);
  assert.equal(migrations[3].checksum.length, 64);
  assert.equal(migrations[4].checksum.length, 64);
  assert.equal(migrations[5].checksum.length, 64);
  assert.equal(migrations[6].checksum.length, 64);
  assert.equal(migrations[7].checksum.length, 64);
  assert.equal(migrations[8].checksum.length, 64);
  assert.equal(
    Number(repository.db.prepare("PRAGMA user_version").get().user_version),
    9
  );

  for (const table of [
    "agent_runs",
    "diagnoses",
    "hint_events",
    "review_schedule",
    "mastery_evidence",
    "tool_calls",
    "llm_calls",
    "mistake_drafts",
    "mistake_edits",
    "mistake_parts",
    "accepted_answers",
    "attempt_part_results",
    "attempt_evaluations",
    "knowledge_sources",
    "knowledge_chunks",
    "knowledge_reviews"
  ]) {
    assert.ok(
      repository.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
        )
        .get(table),
      `缺少 ${table} 表`
    );
  }

  const attemptColumns = new Set(
    repository.db
      .prepare('PRAGMA table_info("attempts")')
      .all()
      .map((column) => column.name)
  );
  for (const column of [
    "outcome",
    "hint_level",
    "independent",
    "evaluation_source",
    "agent_run_id"
  ]) {
    assert.ok(attemptColumns.has(column), `attempts 缺少 ${column}`);
  }
  repository.close();
});

test("旧数据库自动升级、创建校验备份并保留学习记录", () => {
  withTemporaryDirectory((directory) => {
    const databasePath = path.join(directory, "learning.sqlite");
    createLegacyDatabase(databasePath);

    const repository = new LearningRepository(databasePath);
    assert.equal(repository.getSchemaVersion(), 9);
    assert.ok(repository.lastBackupPath);
    assert.equal(fs.existsSync(repository.lastBackupPath), true);
    assert.equal(fs.existsSync(`${repository.lastBackupPath}-wal`), false);
    assert.equal(fs.existsSync(`${repository.lastBackupPath}-shm`), false);

    const mistakes = repository.listMistakes();
    assert.equal(mistakes.length, 1);
    assert.equal(mistakes[0].status, "practicing");
    assert.equal(mistakes[0].consecutiveCorrect, 1);
    const migratedMistake = repository.getMistake(mistakes[0].id, {
      includeSolution: true
    });
    assert.equal(migratedMistake.parts.length, 1);
    assert.deepEqual(migratedMistake.parts[0].acceptedAnswers, ["120元"]);
    assert.equal(
      repository.db
        .prepare("SELECT COUNT(*) AS count FROM attempt_part_results")
        .get().count,
      1
    );
    const migratedAttempt = repository.db
      .prepare(
        "SELECT outcome, hint_level, independent, evaluation_source FROM attempts"
      )
      .get();
    assert.equal(migratedAttempt.outcome, "incorrect");
    assert.equal(migratedAttempt.hint_level, null);
    assert.equal(migratedAttempt.independent, null);
    assert.equal(migratedAttempt.evaluation_source, "legacy_rule");

    const backup = new DatabaseSync(repository.lastBackupPath, {
      readOnly: true
    });
    try {
      assert.equal(
        backup.prepare("SELECT COUNT(*) AS count FROM mistakes").get().count,
        1
      );
      assert.equal(backup.prepare("PRAGMA quick_check").get().quick_check, "ok");
    } finally {
      backup.close();
    }

    repository.close();
    const reopened = new LearningRepository(databasePath);
    assert.equal(reopened.lastBackupPath, null);
    assert.equal(reopened.getSchemaVersion(), 9);
    assert.equal(reopened.listMistakes().length, 1);
    assert.equal(
      reopened.db
        .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
        .get().count,
      9
    );
    reopened.close();
  });
});

test("已有 v1 数据库可以增量升级到最新版本", () => {
  const db = new DatabaseSync(":memory:");
  migrateDatabase(db, { migrations: [SCHEMA_MIGRATIONS[0]] });
  assert.equal(getSchemaVersion(db), 1);

  const result = migrateDatabase(db);
  assert.equal(result.fromVersion, 1);
  assert.equal(result.toVersion, 9);
  assert.deepEqual(result.appliedVersions, [2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
      )
      .get("agent_runs").name,
    "agent_runs"
  );
  db.close();
});

test("已有 v2 数据库可以增量升级到最新数据模型", () => {
  const db = new DatabaseSync(":memory:");
  migrateDatabase(db, { migrations: SCHEMA_MIGRATIONS.slice(0, 2) });
  assert.equal(getSchemaVersion(db), 2);

  const result = migrateDatabase(db);
  assert.equal(result.fromVersion, 2);
  assert.equal(result.toVersion, 9);
  assert.deepEqual(result.appliedVersions, [3, 4, 5, 6, 7, 8, 9]);
  const toolColumns = new Set(
    db
      .prepare('PRAGMA table_info("tool_calls")')
      .all()
      .map((column) => column.name)
  );
  assert.ok(toolColumns.has("idempotency_key"));
  assert.ok(toolColumns.has("updated_at"));
  assert.equal(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
      )
      .get("mistake_drafts").name,
    "mistake_drafts"
  );
  db.close();
});

test("已有 v3 数据库可以增量升级到最新数据模型", () => {
  const db = new DatabaseSync(":memory:");
  migrateDatabase(db, { migrations: SCHEMA_MIGRATIONS.slice(0, 3) });
  assert.equal(getSchemaVersion(db), 3);

  const result = migrateDatabase(db);
  assert.equal(result.toVersion, 9);
  assert.deepEqual(result.appliedVersions, [4, 5, 6, 7, 8, 9]);
  const mistakeColumns = new Set(
    db
      .prepare('PRAGMA table_info("mistakes")')
      .all()
      .map((column) => column.name)
  );
  assert.ok(mistakeColumns.has("revision"));
  assert.equal(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
      )
      .get("mistake_edits").name,
    "mistake_edits"
  );
  db.close();
});

test("已有 v4 数据库可以增量升级到最新模型", () => {
  const db = new DatabaseSync(":memory:");
  migrateDatabase(db, { migrations: SCHEMA_MIGRATIONS.slice(0, 4) });
  assert.equal(getSchemaVersion(db), 4);

  const result = migrateDatabase(db);
  assert.equal(result.toVersion, 9);
  assert.deepEqual(result.appliedVersions, [5, 6, 7, 8, 9]);
  assert.equal(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
      )
      .get("mistake_parts").name,
    "mistake_parts"
  );
  db.close();
});

test("已有 v5 数据库可以增量升级到最新模型", () => {
  const db = new DatabaseSync(":memory:");
  migrateDatabase(db, { migrations: SCHEMA_MIGRATIONS.slice(0, 5) });
  assert.equal(getSchemaVersion(db), 5);

  const result = migrateDatabase(db);
  assert.equal(result.toVersion, 9);
  assert.deepEqual(result.appliedVersions, [6, 7, 8, 9]);
  assert.equal(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
      )
      .get("attempt_evaluations").name,
    "attempt_evaluations"
  );
  assert.equal(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
      )
      .get("knowledge_chunks").name,
    "knowledge_chunks"
  );
  db.close();
});

test("已有 v6 数据库可以增量升级到 v9 掌握证据模型", () => {
  const db = new DatabaseSync(":memory:");
  migrateDatabase(db, { migrations: SCHEMA_MIGRATIONS.slice(0, 6) });
  assert.equal(getSchemaVersion(db), 6);

  const result = migrateDatabase(db);
  assert.equal(result.toVersion, 9);
  assert.deepEqual(result.appliedVersions, [7, 8, 9]);
  assert.equal(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
      )
      .get("knowledge_sources").name,
    "knowledge_sources"
  );
  db.close();
});

test("v7 零作答旧题升级后补齐掌握证据且不重复回填", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrateDatabase(db, { migrations: SCHEMA_MIGRATIONS.slice(0, 7) });
  assert.equal(getSchemaVersion(db), 7);

  let studentId = db.prepare("SELECT id FROM students LIMIT 1").get()?.id;
  if (!studentId) {
    studentId = Number(
      db
        .prepare(
          "INSERT INTO students (name, grade, created_at) VALUES (?, ?, ?)"
        )
        .run("迁移学生", 6, "2026-01-01T00:00:00.000Z").lastInsertRowid
    );
  }
  let knowledgePoint = db
    .prepare("SELECT name FROM knowledge_points LIMIT 1")
    .get()?.name;
  if (!knowledgePoint) {
    knowledgePoint = "百分数";
    db.prepare(
      "INSERT INTO knowledge_points (name, position) VALUES (?, ?)"
    ).run(knowledgePoint, 0);
  }

  const insertMistake = db.prepare(
    `INSERT INTO mistakes (
      student_id, question, student_answer, correct_answer, analysis,
      knowledge_point, error_type, hint, method_steps, common_errors,
      diagnosis, status, consecutive_correct, attempt_count, due_at,
      last_reviewed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const zeroAttemptId = Number(
    insertMistake.run(
      studentId,
      "从未作答的旧题",
      "",
      "120元",
      "",
      knowledgePoint,
      "单位“1”找错",
      "先找单位“1”",
      "[]",
      "[]",
      "旧诊断",
      "new",
      0,
      0,
      null,
      null,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z"
    ).lastInsertRowid
  );
  const attemptedId = Number(
    insertMistake.run(
      studentId,
      "有历史作答的旧题",
      "100元",
      "120元",
      "",
      knowledgePoint,
      "单位“1”找错",
      "先找单位“1”",
      "[]",
      "[]",
      "旧诊断",
      "practicing",
      1,
      1,
      null,
      null,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z"
    ).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO attempts
     (mistake_id, answer, is_correct, feedback, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    attemptedId,
    "100元",
    0,
    "需要先计算涨价部分",
    "2026-01-02T00:00:00.000Z"
  );

  const result = migrateDatabase(db);
  assert.equal(result.toVersion, 9);
  const zeroEvidence = db
    .prepare(
      `SELECT evidence_type, attempt_id, previous_status, next_status
       FROM mastery_evidence WHERE mistake_id = ? ORDER BY id`
    )
    .all(zeroAttemptId);
  assert.equal(zeroEvidence.length, 1);
  assert.equal(zeroEvidence[0].evidence_type, "legacy_seed");
  assert.equal(zeroEvidence[0].attempt_id, null);
  assert.equal(zeroEvidence[0].previous_status, "");
  assert.equal(zeroEvidence[0].next_status, "new");

  const attemptedEvidence = db
    .prepare(
      `SELECT evidence_type, attempt_id FROM mastery_evidence
       WHERE mistake_id = ? ORDER BY id`
    )
    .all(attemptedId);
  assert.equal(attemptedEvidence.length, 1);
  assert.equal(attemptedEvidence[0].evidence_type, "legacy_backfill");
  assert.ok(attemptedEvidence[0].attempt_id);
  assert.equal(
    db
      .prepare(
        `SELECT COUNT(DISTINCT mistake_id) AS count FROM mastery_evidence`
      )
      .get().count,
    2
  );

  const rerun = migrateDatabase(db);
  assert.deepEqual(rerun.appliedVersions, []);
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS count FROM mastery_evidence")
      .get().count,
    2
  );
  db.close();
});

test("迁移失败会回滚数据变更且不记录版本", () => {
  const db = new DatabaseSync(":memory:");
  const failingMigrations = [
    {
      version: 1,
      name: "failing_migration",
      checksumSource: "failing_migration_v1",
      up(database) {
        database.exec("CREATE TABLE partial_change (id INTEGER PRIMARY KEY);");
        throw new Error("模拟迁移失败");
      }
    }
  ];

  assert.throws(
    () => migrateDatabase(db, { migrations: failingMigrations }),
    /执行失败/
  );
  assert.equal(getSchemaVersion(db), 0);
  assert.equal(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
      )
      .get("partial_change"),
    undefined
  );
  db.close();
});

test("检测已执行迁移被修改和未知的未来版本", () => {
  const db = new DatabaseSync(":memory:");
  migrateDatabase(db);
  db.prepare(
    "UPDATE schema_migrations SET checksum = ? WHERE version = 1"
  ).run("tampered");
  assert.throws(() => migrateDatabase(db), /已执行内容被修改/);
  db.close();

  const futureDb = new DatabaseSync(":memory:");
  futureDb.exec("PRAGMA user_version = 99;");
  assert.throws(
    () => migrateDatabase(futureDb),
    /高于当前程序支持的版本/
  );
  futureDb.close();
});
