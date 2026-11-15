import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { LearningRepository } from "../src/database.js";
import { AttachmentStore } from "../src/attachments.js";
import { migrateDatabase, SCHEMA_MIGRATIONS } from "../src/migrations.js";
import {
  createLearningBackup,
  restoreLearningBackup
} from "../scripts/learning-backup.mjs";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2fXkAAAAASUVORK5CYII=",
  "base64"
);

const RENJIAO_POINTS = [
  "分数乘除法",
  "分数四则混合运算",
  "比和比例",
  "比例与图形",
  "圆",
  "圆柱与圆锥",
  "百分数",
  "统计与扇形统计图",
  "数与形",
  "负数",
  "位置与方向",
  "综合应用"
];

function withTemporaryDirectory(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "math-coach-textbook-"));
  try {
    const result = callback(directory);
    if (result && typeof result.then === "function") {
      return result.finally(() => {
        fs.rmSync(directory, { recursive: true, force: true });
      });
    }
    fs.rmSync(directory, { recursive: true, force: true });
    return result;
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function createFixture(directory) {
  const databasePath = path.join(directory, "learning.sqlite");
  const repository = new LearningRepository(databasePath);
  const store = new AttachmentStore({
    directory: repository.attachmentDirectory
  });
  return { databasePath, repository, store };
}

function createMistake(repository, knowledgePoint, overrides = {}) {
  return repository.createMistake({
    question: `${knowledgePoint}：求结果。`,
    studentAnswer: "1",
    correctAnswer: "2",
    analysis: "按步骤计算。",
    knowledgePoint,
    errorType: "不会做",
    ...overrides
  });
}

function saveAttachment(repository, store) {
  const saved = store.save(PNG, {
    declaredMime: "image/png",
    originalName: "question.png",
    kind: "question"
  });
  return repository.insertAttachment(saved);
}

function snapshotLearningData(repository) {
  return {
    mistakes: repository.db
      .prepare(
        `SELECT id, question, student_answer, correct_answer, analysis,
                error_type, hint, method_steps, common_errors, diagnosis,
                status, consecutive_correct, attempt_count, due_at,
                created_at, last_reviewed_at
         FROM mistakes ORDER BY id`
      )
      .all(),
    attempts: repository.db
      .prepare("SELECT * FROM attempts ORDER BY id")
      .all(),
    hintEvents: repository.db
      .prepare("SELECT * FROM hint_events ORDER BY id")
      .all(),
    masteryEvidence: repository.db
      .prepare("SELECT * FROM mastery_evidence ORDER BY id")
      .all(),
    reviewSchedule: repository.db
      .prepare("SELECT * FROM review_schedule ORDER BY id")
      .all(),
    attachments: repository.db
      .prepare(
        `SELECT id, mistake_id, kind, storage_key, mime_type, byte_size,
                width, height, sha256, original_name, created_at
         FROM attachments ORDER BY id`
      )
      .all()
  };
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

function switchTextbook(
  repository,
  targetKey,
  { key = randomUUID(), actor = "测试操作人", confirmer = "测试确认人" } = {}
) {
  const target = repository.getTextbook(targetKey);
  const preview = repository.buildCurriculumSwitchPreview({
    targetTextbookId: target.id
  });
  const result = repository.executeCurriculumSwitch({
    targetTextbookId: target.id,
    previewToken: preview.previewToken,
    mappingChoices: buildMappingChoices(preview),
    confirmUnmapped: true,
    idempotencyKey: key,
    actor,
    confirmer
  });
  return { preview, result, key };
}

function dayBounds(date) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const end = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    23,
    59,
    59,
    999
  );
  return { from: start.toISOString(), to: end.toISOString() };
}

function localDateKeyForTest(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

test("教材目录同时保留两套教材，12 个知识点映射与北师大新增内容可追溯", () => {
  const repository = new LearningRepository();
  try {
    const textbooks = repository.getTextbooks({ selectable: true });
    assert.deepEqual(
      textbooks.map((textbook) => textbook.textbookKey).sort(),
      [
        "beishida-6-lower",
        "beishida-6-upper",
        "renjiao-6-all",
        "renjiao-6-lower",
        "renjiao-6-upper"
      ]
    );
    const from = repository.getTextbook("renjiao-6-all");
    const target = repository.getTextbook("beishida-6-upper");
    assert.equal(repository.getStudent().textbookId, from.id);
    const table = repository.getCurriculumMappingTable(from.id, target.id);
    assert.equal(table.length, 12);
    const byName = new Map(table.map((group) => [group.sourcePointName, group]));
    assert.equal(byName.get("圆").status, "exact");
    assert.equal(byName.get("分数乘除法").status, "merged");
    assert.equal(byName.get("分数四则混合运算").status, "merged");
    assert.equal(byName.get("统计与扇形统计图").status, "renamed");
    assert.equal(byName.get("数与形").status, "renamed");
    assert.equal(byName.get("比和比例").status, "split");
    assert.equal(byName.get("百分数").status, "split");
    assert.equal(byName.get("负数").status, "uncovered");
    assert.equal(byName.get("位置与方向").status, "uncovered");
    assert.equal(byName.get("圆柱与圆锥").status, "uncovered");

    for (const point of repository.getCurriculumPoints(target.id)) {
      assert.equal(point.name.includes("北师大"), false);
    }
    const upperCards = repository.getCurriculumKnowledgeCards(target.id);
    const lowerCards = repository.getCurriculumKnowledgeCards(
      repository.getTextbook("beishida-6-lower").id
    );
    for (const [name, cards] of [
      ["观察物体", upperCards],
      ["图形的运动", lowerCards]
    ]) {
      const card = cards.find((entry) => entry.name === name);
      assert.ok(card, `${name} 卡片应存在`);
      assert.equal(card.sourceCardId, null);
      assert.equal(card.chunks.length, 0);
      assert.equal(card.reviewStatus, "unreviewed");
      assert.match(card.summary, /尚未.*审核|待.*审核/);
    }
    const aliasHit = repository.searchKnowledge({
      query: "扇形统计图",
      textbookId: target.id,
      limit: 3
    });
    assert.equal(aliasHit.items[0].knowledgePoint, "数据处理");
    const uncovered = repository.searchKnowledge({
      query: "负数",
      textbookId: target.id,
      limit: 3
    });
    assert.equal(uncovered.items.length, 0);
    assert.equal(uncovered.coverage.status, "not_covered");
  } finally {
    repository.close();
  }
});

test("切换预演展示影响但不写入任何数据", () => {
  const repository = new LearningRepository();
  try {
    createMistake(repository, "百分数");
    createMistake(repository, "圆");
    createMistake(repository, "负数");
    const before = snapshotLearningData(repository);
    const studentBefore = repository.getStudent();
    const target = repository.getTextbook("beishida-6-upper");
    const preview = repository.buildCurriculumSwitchPreview({
      targetTextbookId: target.id
    });
    assert.equal(preview.fromTextbook.textbookKey, "renjiao-6-all");
    assert.equal(preview.targetTextbook.textbookKey, "beishida-6-upper");
    assert.equal(preview.summary.totalMistakes, 3);
    assert.equal(preview.summary.unmapped, 1);
    assert.ok(preview.summary.needsConfirmation >= 2);
    assert.ok(preview.summary.attachments >= 0);
    assert.deepEqual(snapshotLearningData(repository), before);
    assert.equal(repository.getStudent().textbookId, studentBefore.textbookId);
    assert.equal(
      repository.db.prepare("SELECT COUNT(*) AS count FROM curriculum_switch_logs").get().count,
      0
    );
    assert.equal(
      repository.db.prepare("SELECT COUNT(*) AS count FROM report_snapshots").get().count,
      0
    );
  } finally {
    repository.close();
  }
});

test("执行切换保留 15 条现有数据、附件和全部学习证据，并支持幂等重放", () => {
  withTemporaryDirectory((directory) => {
    const { repository, store } = createFixture(directory);
    try {
      const attachment = saveAttachment(repository, store);
      const mistakes = RENJIAO_POINTS.map((point, index) =>
        createMistake(repository, point, {
          question: `${point} 第 ${index + 1} 题`,
          attachmentIds: index === 0 ? [attachment.id] : []
        })
      );
      createMistake(repository, "百分数", { question: "百分数补充题 1" });
      createMistake(repository, "圆", { question: "圆补充题 2" });
      createMistake(repository, "比和比例", { question: "比和比例补充题 3" });

      repository.recordAttempt(mistakes[0].id, "2", { independent: true });
      repository.recordAttempt(mistakes[1].id, "1");
      repository.recordHint({
        mistakeId: mistakes[2].id,
        hintLevel: 1,
        content: "先找单位一",
        source: "test"
      });
      const before = snapshotLearningData(repository);
      const beforeMistakes = repository.listMistakes();
      assert.equal(beforeMistakes.length, 15);

      const target = repository.getTextbook("beishida-6-upper");
      const preview = repository.buildCurriculumSwitchPreview({
        targetTextbookId: target.id
      });
      assert.equal(preview.items.length, 15);
      const { result, key } = switchTextbook(repository, "beishida-6-upper");

      assert.equal(result.status, "confirmed");
      assert.equal(result.affectedCount, 15);
      assert.equal(result.items.length, 15);
      assert.equal(result.fromTextbook.textbookKey, "renjiao-6-all");
      assert.equal(result.toTextbook.textbookKey, "beishida-6-upper");
      assert.deepEqual(snapshotLearningData(repository), before);

      const afterMistakes = repository.listMistakes();
      assert.equal(afterMistakes.length, 15);
      for (const mistake of afterMistakes) {
        assert.equal(mistake.textbookId, target.id);
      }
      assert.equal(repository.getStudent().textbookId, target.id);

      const replay = repository.executeCurriculumSwitch({
        targetTextbookId: target.id,
        previewToken: preview.previewToken,
        idempotencyKey: key,
        mappingChoices: {},
        confirmUnmapped: true
      });
      assert.equal(replay.id, result.id);
      assert.equal(replay.idempotentReplay, true);
      assert.equal(
        repository.db.prepare("SELECT COUNT(*) AS count FROM curriculum_switch_logs").get().count,
        1
      );
    } finally {
      repository.close();
    }
  });
});

test("切换只影响当前学生，另一个学生的教材和错题完全不变", () => {
  const repository = new LearningRepository();
  try {
    const studentOneMistake = createMistake(repository, "圆");
    const from = repository.getTextbook("renjiao-6-all");
    const target = repository.getTextbook("beishida-6-upper");
    const studentOne = repository.getStudent();
    const studentTwoId = Number(
      repository.db
        .prepare("INSERT INTO students (name, grade, created_at, textbook_id, textbook_selected_at) VALUES (?, ?, ?, ?, ?)")
        .run("另一位同学", 6, "2026-01-01T00:00:00.000Z", from.id, "2026-01-01T00:00:00.000Z")
        .lastInsertRowid
    );
    const circlePoint = repository.db
      .prepare("SELECT id FROM curriculum_points WHERE textbook_id = ? AND name = ?")
      .get(from.id, "圆");
    const studentTwoMistakeId = Number(
      repository.db
        .prepare(
          `INSERT INTO mistakes (
            student_id, question, student_answer, correct_answer, analysis,
            knowledge_point, textbook_id, curriculum_point_id, curriculum_status,
            error_type, hint, status, due_at, created_at, updated_at
          ) VALUES (?, ?, '', ?, '', ?, ?, ?, 'mapped', '不会做', '', 'new', ?, ?, ?)`
        )
        .run(
          studentTwoId,
          "另一位同学的圆",
          "2",
          "圆",
          from.id,
          circlePoint.id,
          "2026-01-01T00:00:00.000Z",
          "2026-01-01T00:00:00.000Z",
          "2026-01-01T00:00:00.000Z"
        ).lastInsertRowid
    );
    const studentTwoBefore = repository.db
      .prepare("SELECT * FROM mistakes WHERE id = ?")
      .get(studentTwoMistakeId);

    switchTextbook(repository, "beishida-6-upper");
    repository.recordAttempt(studentOneMistake.id, "2");

    assert.equal(repository.getStudent().id, studentOne.id);
    assert.equal(repository.getStudent().textbookId, target.id);
    const studentTwoAfter = repository.db
      .prepare("SELECT * FROM students WHERE id = ?")
      .get(studentTwoId);
    assert.equal(studentTwoAfter.textbook_id, from.id);
    assert.deepEqual(
      repository.db.prepare("SELECT * FROM mistakes WHERE id = ?").get(studentTwoMistakeId),
      studentTwoBefore
    );
    assert.equal(
      repository.db
        .prepare("SELECT COUNT(*) AS count FROM curriculum_switch_logs WHERE student_id = ?")
        .get(studentTwoId).count,
      0
    );
    const bounds = dayBounds(new Date());
    const studentOneDaily = repository.buildDailySummary({
      ...bounds,
      studentId: studentOne.id
    });
    const studentTwoDaily = repository.buildDailySummary({
      ...bounds,
      studentId: studentTwoId
    });
    assert.equal(studentOneDaily.totals.attempts, 1);
    assert.equal(studentTwoDaily.totals.attempts, 0);
    assert.equal(studentTwoDaily.totals.hints, 0);
    assert.equal(studentTwoDaily.totals.mistakes, 0);
  } finally {
    repository.close();
  }
});

test("A→B→A 可按审计明细还原，并可逐题追溯", () => {
  const repository = new LearningRepository();
  try {
    const original = [
      createMistake(repository, "圆"),
      createMistake(repository, "百分数"),
      createMistake(repository, "负数")
    ];
    const originalKnowledge = new Map(
      repository.listMistakes().map((mistake) => [mistake.id, mistake.knowledgePoint])
    );
    const first = switchTextbook(repository, "beishida-6-upper");
    assert.equal(first.result.items.length, 3);

    const second = switchTextbook(repository, "renjiao-6-all");
    assert.equal(second.result.fromTextbook.textbookKey, "beishida-6-upper");
    assert.equal(second.result.toTextbook.textbookKey, "renjiao-6-all");
    assert.equal(
      second.result.items.every((item) => item.resolutionMode === "restored"),
      true
    );

    const restored = repository.listMistakes();
    assert.equal(restored.length, 3);
    for (const mistake of restored) {
      assert.equal(mistake.textbookId, repository.getTextbook("renjiao-6-all").id);
      assert.equal(mistake.knowledgePoint, originalKnowledge.get(mistake.id));
    }
    for (const mistake of original) {
      const trace = repository.getCurriculumSwitchLogs({ mistakeId: mistake.id });
      assert.equal(trace.length, 2);
      assert.equal(trace[0].toTextbook.textbookKey, "renjiao-6-all");
      assert.equal(trace[1].toTextbook.textbookKey, "beishida-6-upper");
    }
  } finally {
    repository.close();
  }
});

test("切换后可按北师大知识点编辑和新增错题，重复保存不改变数据", () => {
  const repository = new LearningRepository();
  try {
    const mistake = createMistake(repository, "圆");
    switchTextbook(repository, "beishida-6-upper");
    const target = repository.getTextbook("beishida-6-upper");
    const mathFun = repository
      .getCurriculumPoints(target.id)
      .find((point) => point.name === "数学好玩");

    const updated = repository.updateMistake(mistake.id, {
      knowledgePoint: "数学好玩"
    });
    assert.equal(updated.mistake.knowledgePoint, "数学好玩");
    assert.equal(updated.mistake.curriculumPointId, mathFun.id);
    assert.equal(updated.mistake.curriculumStatus, "mapped");
    const noop = repository.updateMistake(mistake.id, {
      knowledgePoint: "数学好玩"
    });
    assert.deepEqual(noop.changedFields, []);
    const alias = repository.updateMistake(mistake.id, {
      knowledgePoint: "看图找关系"
    });
    assert.equal(alias.mistake.knowledgePoint, "数学好玩");

    const created = createMistake(repository, "整理与复习");
    assert.equal(created.knowledgePoint, "整理与复习");
    assert.equal(created.textbookId, target.id);
    assert.equal(created.curriculumStatus, "mapped");
    assert.ok(created.curriculumPointId);
  } finally {
    repository.close();
  }
});

test("切换后旧多小问知识点同步迁移，无改动保存不重置掌握进度", () => {
  const repository = new LearningRepository();
  try {
    const mistake = repository.createMistake({
      question: "甲、乙工作效率比和时间比分别是多少？",
      analysis: "先分别写出效率比和时间比。",
      knowledgePoint: "比和比例",
      errorType: "前后项对应反了",
      parts: [
        {
          label: "工作效率比",
          prompt: "甲队和乙队的工作效率比",
          studentAnswer: "",
          answerType: "ratio",
          comparisonRule: "ratio",
          knowledgePoint: "比和比例",
          acceptedAnswers: ["1:6"]
        },
        {
          label: "时间比",
          prompt: "甲队和乙队完成同一项工程所需时间比",
          studentAnswer: "",
          answerType: "ratio",
          comparisonRule: "ratio",
          knowledgePoint: "比和比例",
          acceptedAnswers: ["6:1"]
        }
      ]
    });
    const attempt = repository.recordAttempt(mistake.id, "", {
      independent: true,
      answers: [
        { partId: mistake.parts[0].id, value: "1:6" },
        { partId: mistake.parts[1].id, value: "1:6" }
      ]
    });
    assert.equal(attempt.mistake.status, "practicing");
    const before = repository.getMistake(mistake.id, { includeSolution: true });

    switchTextbook(repository, "beishida-6-upper");
    const switched = repository.getMistake(mistake.id, {
      includeSolution: true
    });
    assert.equal(switched.knowledgePoint, "比的认识");
    for (const part of switched.parts) {
      assert.equal(part.knowledgePoint, "比的认识");
    }

    const saved = repository.updateMistake(mistake.id, {
      question: switched.question,
      studentAnswer: switched.studentAnswer,
      correctAnswer: switched.correctAnswer,
      analysis: switched.analysis,
      knowledgePoint: switched.knowledgePoint,
      errorType: switched.errorType,
      parts: switched.parts.map((part) => ({
        label: part.label,
        prompt: part.prompt,
        studentAnswer: part.studentAnswer,
        answerType: part.answerType,
        comparisonRule: part.comparisonRule,
        knowledgePoint: "",
        acceptedAnswers: part.acceptedAnswers,
        hint: part.hint,
        explanation: part.explanation
      }))
    });
    assert.deepEqual(saved.changedFields, []);
    assert.equal(saved.learningReset, false);
    const after = repository.getMistake(mistake.id, { includeSolution: true });
    assert.equal(after.status, before.status);
    assert.equal(after.attemptCount, before.attemptCount);
    assert.equal(after.consecutiveCorrect, before.consecutiveCorrect);
    assert.equal(after.dueAt, before.dueAt);
    assert.equal(after.revision, before.revision);
  } finally {
    repository.close();
  }
});

test("未映射项保留待归类，人工归类写入审计且审计不可编辑或删除", () => {
  const repository = new LearningRepository();
  try {
    const mistake = createMistake(repository, "负数");
    const { result } = switchTextbook(repository, "beishida-6-upper");
    const unmapped = repository.getUnmappedCurriculumMistakes();
    assert.equal(unmapped.some((item) => item.id === mistake.id), true);
    const current = repository.getMistake(mistake.id);
    assert.equal(current.knowledgePoint, "待归类");
    assert.equal(current.curriculumStatus, "unmapped");

    const target = repository.getTextbook("beishida-6-upper");
    const dataPoint = repository
      .getCurriculumPoints(target.id)
      .find((point) => point.name === "数据处理");
    const resolveKey = randomUUID();
    const resolved = repository.assignMistakeCurriculum({
      mistakeId: mistake.id,
      targetCurriculumPointId: dataPoint.id,
      idempotencyKey: resolveKey,
      actor: "测试操作人",
      confirmer: "测试确认人"
    });
    assert.equal(resolved.operation, "manual_resolve");
    assert.equal(resolved.items[0].afterKnowledgePoint, "数据处理");
    assert.equal(repository.getMistake(mistake.id).knowledgePoint, "数据处理");
    assert.equal(
      repository.getMistake(mistake.id, { includeSolution: true }).parts[0]
        .knowledgePoint,
      "数据处理"
    );
    assert.equal(repository.getUnmappedCurriculumMistakes().length, 0);

    const replay = repository.assignMistakeCurriculum({
      mistakeId: mistake.id,
      targetCurriculumPointId: dataPoint.id,
      idempotencyKey: resolveKey
    });
    assert.equal(replay.id, resolved.id);
    assert.equal(replay.idempotentReplay, true);
    const trace = repository.getCurriculumSwitchLogs({ mistakeId: mistake.id });
    assert.equal(trace.length, 2);
    assert.equal(trace[0].operation, "manual_resolve");

    switchTextbook(repository, "renjiao-6-all");
    const restored = repository.getMistake(mistake.id);
    assert.equal(restored.textbookId, repository.getTextbook("renjiao-6-all").id);
    assert.equal(restored.knowledgePoint, "负数");

    assert.throws(
      () => repository.db.prepare("UPDATE curriculum_switch_logs SET actor = ? WHERE id = ?").run("篡改", result.id),
      /不可修改/
    );
    assert.throws(
      () => repository.db.prepare("UPDATE curriculum_switch_items SET after_knowledge_point = ? WHERE switch_log_id = ?").run("篡改", result.id),
      /不可修改/
    );
    assert.throws(
      () => repository.db.prepare("DELETE FROM curriculum_switch_logs WHERE id = ?").run(result.id),
      /不可删除/
    );
    assert.throws(
      () => repository.db.prepare("DELETE FROM curriculum_switch_items WHERE switch_log_id = ?").run(result.id),
      /不可删除/
    );
  } finally {
    repository.close();
  }
});

test("切换中途失败会完整回滚，不留下部分教材、错题或审计写入", () => {
  const repository = new LearningRepository();
  try {
    createMistake(repository, "圆");
    createMistake(repository, "百分数");
    const studentBefore = repository.getStudent();
    const mistakesBefore = repository.db.prepare("SELECT * FROM mistakes ORDER BY id").all();
    const target = repository.getTextbook("beishida-6-upper");
    const preview = repository.buildCurriculumSwitchPreview({
      targetTextbookId: target.id
    });
    repository.db.exec(`
      CREATE TRIGGER test_force_switch_failure
      BEFORE UPDATE ON mistakes
      BEGIN
        SELECT RAISE(ABORT, 'forced switch failure');
      END;
    `);
    assert.throws(
      () =>
        repository.executeCurriculumSwitch({
          targetTextbookId: target.id,
          previewToken: preview.previewToken,
          mappingChoices: buildMappingChoices(preview),
          confirmUnmapped: true,
          idempotencyKey: randomUUID()
        }),
      /forced switch failure/
    );
    repository.db.exec("DROP TRIGGER test_force_switch_failure");
    assert.equal(repository.getStudent().textbookId, studentBefore.textbookId);
    assert.deepEqual(
      repository.db.prepare("SELECT * FROM mistakes ORDER BY id").all(),
      mistakesBefore
    );
    assert.equal(
      repository.db.prepare("SELECT COUNT(*) AS count FROM curriculum_switch_logs").get().count,
      0
    );
    assert.equal(
      repository.db.prepare("SELECT COUNT(*) AS count FROM curriculum_switch_items").get().count,
      0
    );
    assert.equal(
      repository.db.prepare("SELECT COUNT(*) AS count FROM report_snapshots").get().count,
      0
    );
  } finally {
    repository.close();
  }
});

test("历史日/周报在切换前生成快照并标注按当时教材，不追溯重算", () => {
  const repository = new LearningRepository();
  try {
    const mistake = createMistake(repository, "百分数");
    repository.recordAttempt(mistake.id, "1");
    const date = new Date(Date.now() - 2 * 86400000);
    const pastIso = date.toISOString();
    repository.db
      .prepare("UPDATE mistakes SET created_at = ?, updated_at = ? WHERE id = ?")
      .run(pastIso, pastIso, mistake.id);
    repository.db
      .prepare("UPDATE attempts SET created_at = ? WHERE mistake_id = ?")
      .run(pastIso, mistake.id);
    repository.db
      .prepare("UPDATE mastery_evidence SET created_at = ? WHERE mistake_id = ?")
      .run(pastIso, mistake.id);
    const bounds = dayBounds(date);
    switchTextbook(repository, "beishida-6-upper");

    const daily = repository.buildDailySummary({
      ...bounds,
      studentId: repository.getStudent().id
    });
    assert.equal(daily.textbookScope.label, "人教版六年级（上册/下册）");
    assert.equal(daily.textbookScope.note, "按当时教材");
    const weekly = repository.buildWeeklyReport({
      from: new Date(date.getTime() - 6 * 86400000).toISOString(),
      to: bounds.to,
      studentId: repository.getStudent().id
    });
    assert.equal(weekly.textbookScope.label, "人教版六年级（上册/下册）");
    assert.equal(weekly.textbookScope.note, "按当时教材");
    assert.ok(
      repository.db.prepare("SELECT COUNT(*) AS count FROM report_snapshots").get().count >= 2
    );
  } finally {
    repository.close();
  }
});

test("切换当天和当周反馈保持实时，不用切换快照冻结新作答", () => {
  const repository = new LearningRepository();
  try {
    const mistake = createMistake(repository, "圆");
    const bounds = dayBounds(new Date());
    switchTextbook(repository, "beishida-6-upper");
    const result = repository.recordAttempt(mistake.id, "2");
    assert.equal(result.outcome, "correct");

    const daily = repository.buildDailySummary({
      ...bounds,
      studentId: repository.getStudent().id
    });
    assert.equal(daily.totals.attempts, 1);
    assert.equal(daily.textbookScope.note, "当前教材");
    assert.equal(daily.textbookScope.label, "北师大版六年级上册");
    const today = localDateKeyForTest(new Date());
    assert.equal(
      repository.db
        .prepare(
          "SELECT COUNT(*) AS count FROM report_snapshots WHERE report_type = 'daily' AND period_key = ?"
        )
        .get(today).count,
      0
    );
    assert.equal(
      repository.db
        .prepare(
          "SELECT COUNT(*) AS count FROM report_snapshots WHERE report_type = 'weekly' AND period_key = ?"
        )
        .get(today).count,
      0
    );
  } finally {
    repository.close();
  }
});

test("切换后知识地图和搜索只显示北师大单元，未覆盖项不伪造结果", () => {
  const repository = new LearningRepository();
  try {
    createMistake(repository, "圆");
    createMistake(repository, "统计与扇形统计图");
    switchTextbook(repository, "beishida-6-upper");
    const target = repository.getTextbook("beishida-6-upper");
    const student = repository.getStudent();
    const summary = repository.getCurriculumKnowledgeSummary(target.id, student.id);
    assert.ok(summary.length > 0);
    for (const point of summary) {
      assert.equal(point.unit.includes("人教版"), false);
      assert.equal(point.textbookLabel, "北师大版六年级上册");
    }
    assert.ok(summary.some((point) => point.name === "数据处理"));
    assert.equal(summary.some((point) => point.name === "统计与扇形统计图"), false);

    const aliasHit = repository.searchKnowledge({
      query: "扇形统计图",
      textbookId: target.id,
      limit: 3
    });
    assert.equal(aliasHit.items[0].knowledgePoint, "数据处理");
    assert.equal(aliasHit.coverage.status, "covered");
    const noCoverage = repository.searchKnowledge({
      query: "负数",
      textbookId: target.id,
      limit: 3
    });
    assert.equal(noCoverage.items.length, 0);
    assert.equal(noCoverage.coverage.status, "not_covered");
  } finally {
    repository.close();
  }
});

test("100 条错题切换预演与执行在可接受时间内完成", () => {
  const repository = new LearningRepository();
  try {
    for (let index = 0; index < 100; index += 1) {
      createMistake(repository, RENJIAO_POINTS[index % RENJIAO_POINTS.length], {
        question: `批量题 ${index + 1}`
      });
    }
    const target = repository.getTextbook("beishida-6-upper");
    const start = Date.now();
    const preview = repository.buildCurriculumSwitchPreview({
      targetTextbookId: target.id
    });
    const result = repository.executeCurriculumSwitch({
      targetTextbookId: target.id,
      previewToken: preview.previewToken,
      mappingChoices: buildMappingChoices(preview),
      confirmUnmapped: true,
      idempotencyKey: randomUUID()
    });
    const elapsed = Date.now() - start;
    assert.equal(result.affectedCount, 100);
    assert.equal(repository.listMistakes().length, 100);
    assert.ok(elapsed < 8000, `切换耗时 ${elapsed}ms，超过 8 秒`);
  } finally {
    repository.close();
  }
});

test("备份与恢复保留教材选择、错题映射、审计和附件", () => {
  withTemporaryDirectory((directory) => {
    const { repository, store, databasePath } = createFixture(directory);
    try {
      const attachment = saveAttachment(repository, store);
      const mistake = createMistake(repository, "圆", {
        attachmentIds: [attachment.id]
      });
      switchTextbook(repository, "beishida-6-upper");
      const beforeLogs = repository.getCurriculumSwitchLogs();
      const storageKey = repository
        .db.prepare("SELECT storage_key FROM attachments WHERE mistake_id = ?")
        .get(mistake.id).storage_key;
      assert.ok(storageKey);
      repository.close();

      const backupRoot = path.join(directory, "backups");
      const backup = createLearningBackup({
        databasePath,
        attachmentsDir: path.join(directory, "attachments"),
        backupRoot
      });
      const restoredDirectory = path.join(directory, "restored");
      const restoredDatabase = path.join(restoredDirectory, "learning.sqlite");
      const restoredAttachments = path.join(restoredDirectory, "attachments");
      const restoredInfo = restoreLearningBackup({
        backupDir: backup.outputDir,
        databasePath: restoredDatabase,
        attachmentsDir: restoredAttachments
      });
      assert.ok(restoredInfo.attachmentCount >= 1);
      const restored = new LearningRepository(restoredDatabase);
      try {
        assert.equal(restored.getStudent().textbook.textbookKey, "beishida-6-upper");
        const restoredMistake = restored.getMistake(mistake.id);
        assert.equal(restoredMistake.attachments.length, 1);
        assert.equal(restoredMistake.knowledgePoint, "圆");
        assert.equal(restored.getCurriculumSwitchLogs().length, beforeLogs.length);
        assert.equal(
          fs.existsSync(path.join(restoredAttachments, storageKey)),
          true
        );
      } finally {
        restored.close();
      }
    } catch (error) {
      if (repository.db?.open) repository.close();
      throw error;
    }
  });
});

test("v11 数据库升级到 v12 后旧错题自动绑定人教版且保留原数据", () => {
  withTemporaryDirectory((directory) => {
    const databasePath = path.join(directory, "learning.sqlite");
    const db = new DatabaseSync(databasePath);
    migrateDatabase(db, { migrations: SCHEMA_MIGRATIONS.slice(0, 11) });
    assert.equal(Number(db.prepare("PRAGMA user_version").get().user_version), 11);
    const studentId = Number(
      db
        .prepare("INSERT INTO students (name, grade, created_at) VALUES (?, ?, ?)")
        .run("升级学生", 6, "2026-01-01T00:00:00.000Z").lastInsertRowid
    );
    const mistakeId = Number(
      db
        .prepare(
          `INSERT INTO mistakes (
            student_id, question, student_answer, correct_answer, analysis,
            knowledge_point, error_type, hint, status, due_at, created_at, updated_at
          ) VALUES (?, ?, '', ?, '', ?, ?, '', 'new', ?, ?, ?)`
        )
        .run(
          studentId,
          "升级前的圆题",
          "2",
          "圆",
          "不会做",
          "2026-01-01T00:00:00.000Z",
          "2026-01-01T00:00:00.000Z",
          "2026-01-01T00:00:00.000Z"
        ).lastInsertRowid
    );
    db.close();

    const repository = new LearningRepository(databasePath);
    try {
      assert.equal(repository.getSchemaVersion(), 12);
      const mistake = repository.getMistake(mistakeId);
      const textbook = repository.getTextbook("renjiao-6-all");
      assert.equal(mistake.textbookId, textbook.id);
      assert.ok(mistake.curriculumPointId);
      assert.equal(mistake.curriculumStatus, "mapped");
      assert.equal(mistake.question, "升级前的圆题");
      assert.equal(repository.getStudent(studentId).textbookId, textbook.id);
    } finally {
      repository.close();
    }
  });
});

test("教材切换 UI 提供预演/确认/结果、审计追溯和移动端无溢出兜底", () => {
  const html = fs.readFileSync(
    path.join(process.cwd(), "public/index.html"),
    "utf8"
  );
  const app = fs.readFileSync(
    path.join(process.cwd(), "public/app.js"),
    "utf8"
  );
  const css = fs.readFileSync(
    path.join(process.cwd(), "public/styles.css"),
    "utf8"
  );
  for (const id of [
    "curriculum-switch-button",
    "curriculum-dialog",
    "curriculum-preview-button",
    "curriculum-confirm-button",
    "curriculum-execute-button",
    "curriculum-done-button",
    "curriculum-unmapped-list",
    "curriculum-history-filter",
    "curriculum-history-list"
  ]) {
    assert.ok(html.includes(`id="${id}"`), `缺少 ${id}`);
  }
  assert.match(html, /aria-labelledby="curriculum-dialog-title"/);
  assert.match(html, /id="daily-scope"/);
  assert.match(html, /id="weekly-scope"/);
  for (const id of [
    "curriculum-switch-button",
    "curriculum-preview-button",
    "curriculum-confirm-button",
    "curriculum-execute-button",
    "curriculum-done-button",
    "curriculum-history-filter"
  ]) {
    assert.ok(app.includes(`#${id}`), `缺少事件绑定 ${id}`);
  }
  assert.match(css, /\.curriculum-dialog\s*\{[^}]*max-width:\s*calc\(100vw - 32px\)/s);
  assert.match(css, /\.curriculum-toolbar\s*\{[^}]*min-width:\s*0/s);
  assert.match(css, /\.knowledge-unit-heading\s*\{[^}]*grid-column:\s*1 \/ -1/s);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*\.curriculum-dialog/);
  assert.match(css, /\.curriculum-mapping-row[\s\S]*min-width:\s*0/);
  assert.match(app, /function updateCurriculumConfirmButton\(\)/);
  assert.match(app, /button\.disabled = !ready/);
});
