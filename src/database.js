import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseSync } from "node:sqlite";
import { diagnoseMistake } from "./agent.js";
import {
  LEARNING_POLICY_VERSION,
  REVIEW_INTERVAL_DAYS,
  evaluateAttemptState,
  toIsoAfterDays
} from "./domain/learning-policy.js";
import {
  evaluatePartResponses,
  validateSubmittedPartAnswers
} from "./domain/part-evaluation.js";
import { LearningValidationError } from "./domain/errors.js";
import {
  getSchemaVersion,
  migrateDatabase
} from "./migrations.js";
import {
  KNOWLEDGE_CARDS,
  KNOWLEDGE_CONTENT_VERSION,
  KNOWLEDGE_SOURCES
} from "./knowledge/catalog.js";
import {
  buildKnowledgeFtsQuery,
  searchKnowledgeCards,
  segmentKnowledgeText
} from "./knowledge/search.js";

const nowIso = () => new Date().toISOString();
const toolWriteLeaseStorage = new AsyncLocalStorage();

function safeRatio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

export function runWithToolWriteLease(lease, callback) {
  return toolWriteLeaseStorage.run(lease, callback);
}

function assertToolWriteAllowed() {
  const lease = toolWriteLeaseStorage.getStore();
  if (lease?.aborted) {
    throw new Error("工具执行已超时，禁止继续写入数据");
  }
}

function parseJson(text) {
  if (!text) return [];
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function parseJsonObject(text) {
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  } catch {
    return {};
  }
}

function buildMistakeDiagnosis(input) {
  const base = diagnoseMistake(input);
  const confirmed = input.confirmedDiagnosis;
  if (!confirmed || typeof confirmed !== "object") {
    return {
      ...base,
      _meta: {
        acceptedByUser: false,
        provider: "rules",
        model: "",
        promptVersion: "",
        rawOutput: {}
      }
    };
  }

  const knowledgePoint =
    String(input.knowledgePoint || "").trim() ||
    String(confirmed.knowledgePoint || "").trim() ||
    base.knowledgePoint;
  const errorType =
    String(input.errorType || "").trim() ||
    String(confirmed.errorType || "").trim() ||
    base.errorType;
  const hint =
    String(confirmed.initialHint || "").trim() || base.hint;
  const diagnosis = [
    `初步归因：${errorType}。`,
    confirmed.errorStep
      ? `可能出错步骤：${confirmed.errorStep}`
      : "",
    confirmed.missingConcept
      ? `需要补足：${confirmed.missingConcept}`
      : "",
    ...(confirmed.evidence || []).map((item) => `依据：${item}`)
  ]
    .filter(Boolean)
    .join("\n");

  return {
    ...base,
    knowledgePoint,
    errorType,
    hint,
    diagnosis,
    confidence: confirmed.confidence ?? base.confidence,
    knowledgeSources: confirmed.knowledgeSources || [],
    partAnalyses: confirmed.partAnalyses || [],
    _meta: {
      acceptedByUser: true,
      provider: confirmed.provider || "rules",
      model: confirmed.model || "",
      promptVersion: confirmed.promptVersion || "",
      agentRunId: confirmed.agentRunId || null,
      rawOutput: confirmed.rawOutput || confirmed
    }
  };
}

function mapDraft(row) {
  if (!row) return null;
  return {
    id: row.id,
    studentId: row.student_id,
    question: row.question,
    studentAnswer: row.student_answer,
    correctAnswer: row.correct_answer,
    analysis: row.analysis,
    knowledgePoint: row.knowledge_point,
    errorType: row.error_type,
    diagnosis: parseJsonObject(row.diagnosis_json),
    parts: parseJson(row.parts_json),
    status: row.status,
    savedMistakeId: row.saved_mistake_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at
  };
}

function splitAcceptedAnswers(value) {
  return String(value || "")
    .split(/[或;；\n]/)
    .map((answer) => answer.trim())
    .filter(Boolean);
}

function normalizeParts(input) {
  const sourceParts =
    Array.isArray(input.parts) && input.parts.length
      ? input.parts
      : [
          {
            label: "",
            prompt: "",
            studentAnswer: input.studentAnswer || "",
            answerType: "auto",
            comparisonRule: "auto",
            knowledgePoint: input.knowledgePoint || "",
            acceptedAnswers: splitAcceptedAnswers(input.correctAnswer)
          }
        ];

  return sourceParts.map((part, index) => {
    const acceptedAnswers = Array.isArray(part.acceptedAnswers)
      ? part.acceptedAnswers
          .map((answer) => String(answer || "").trim())
          .filter(Boolean)
      : splitAcceptedAnswers(part.correctAnswer);
    return {
      partNo: index + 1,
      label: String(part.label || "").trim(),
      prompt: String(part.prompt || "").trim(),
      studentAnswer: String(part.studentAnswer || "").trim(),
      answerType: String(part.answerType || "auto"),
      comparisonRule: String(part.comparisonRule || "auto"),
      knowledgePoint: String(part.knowledgePoint || "").trim(),
      hint: String(part.hint || "").trim(),
      explanation: String(part.explanation || "").trim(),
      acceptedAnswers
    };
  });
}

function mapPart(row, answers = [], { includeSolution = false } = {}) {
  const part = {
    id: row.id,
    partNo: row.part_no,
    label: row.label,
    prompt: row.prompt,
    studentAnswer: row.student_answer,
    answerType: row.answer_type,
    comparisonRule: row.comparison_rule,
    knowledgePoint: row.knowledge_point
  };
  if (includeSolution) {
    part.hint = row.hint;
    part.explanation = row.explanation;
    part.acceptedAnswers = answers;
  }
  return part;
}

function mapMistake(row, { includeSolution = false } = {}) {
  if (!row) return null;
  const mistake = {
    id: row.id,
    question: row.question,
    studentAnswer: row.student_answer,
    knowledgePoint: row.knowledge_point,
    errorType: row.error_type,
    revision: row.revision,
    status: row.status,
    consecutiveCorrect: row.consecutive_correct,
    attemptCount: row.attempt_count,
    dueAt: row.due_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastReviewedAt: row.last_reviewed_at
  };
  if (includeSolution) {
    Object.assign(mistake, {
      correctAnswer: row.correct_answer,
      analysis: row.analysis,
      hint: row.hint,
      methodSteps: parseJson(row.method_steps),
      commonErrors: parseJson(row.common_errors),
      diagnosis: row.diagnosis
    });
  }
  return mistake;
}

export class LearningRepository {
  constructor(filePath = ":memory:") {
    let existingDatabase = false;
    if (filePath !== ":memory:") {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      try {
        const stats = fs.statSync(filePath);
        existingDatabase = stats.isFile() && stats.size > 0;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }

    this.db = new DatabaseSync(filePath);
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.lastBackupPath = null;

    try {
      migrateDatabase(this.db, {
        beforeMigration: ({ targetVersion }) => {
          if (existingDatabase) {
            this.lastBackupPath = this.createMigrationBackup(
              filePath,
              targetVersion
            );
          }
        }
      });
      this.syncKnowledgeBase();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  createMigrationBackup(filePath, targetVersion) {
    const backupDirectory = path.join(path.dirname(filePath), "backups");
    fs.mkdirSync(backupDirectory, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupName = `${path.basename(filePath)}.before-v${targetVersion}-${timestamp}-${process.pid}.bak`;
    const backupPath = path.join(backupDirectory, backupName);
    fs.writeFileSync(backupPath, Buffer.from(this.db.serialize()), {
      flag: "wx"
    });

    const verification = new DatabaseSync(backupPath, { readOnly: true });
    try {
      const result = verification.prepare("PRAGMA quick_check").get();
      if (result.quick_check !== "ok") {
        throw new Error("迁移备份完整性检查失败");
      }
    } finally {
      verification.close();
      for (const suffix of ["-shm", "-wal"]) {
        const sidecarPath = `${backupPath}${suffix}`;
        if (fs.existsSync(sidecarPath)) {
          fs.unlinkSync(sidecarPath);
        }
      }
    }
    return backupPath;
  }

  getSchemaVersion() {
    return getSchemaVersion(this.db);
  }

  getStudent() {
    return this.db
      .prepare("SELECT id, name, grade FROM students ORDER BY id LIMIT 1")
      .get();
  }

  getKnowledgePoints() {
    return this.db
      .prepare("SELECT id, name FROM knowledge_points ORDER BY position, id")
      .all();
  }

  getKnowledgePoint(name) {
    return (
      this.db
        .prepare(
          "SELECT id, name, position FROM knowledge_points WHERE name = ?"
        )
        .get(name) || null
    );
  }

  knowledgeContentVersion(card) {
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          name: card.name,
          aliases: card.aliases,
          unit: card.unit,
          prerequisites: card.prerequisites,
          keywords: card.keywords,
          summary: card.summary,
          hint: card.hint,
          steps: card.steps,
          commonErrors: card.commonErrors,
          sourceKeys: card.sourceKeys,
          chunks: card.chunks
        })
      )
      .digest("hex")
      .slice(0, 12);
    return `${KNOWLEDGE_CONTENT_VERSION}:${fingerprint}`;
  }

  knowledgeCitation(source, card, chunk) {
    const sourceKey = source.source_key || source.key;
    return `${source.title}（${source.edition}）· ${card.name} / ${chunk.title} [${sourceKey}]`;
  }

  rebuildKnowledgeFts() {
    this.db.prepare("DELETE FROM knowledge_chunks_fts").run();
    const rows = this.db
      .prepare("SELECT id, title, content, citation FROM knowledge_chunks")
      .all();
    const insert = this.db.prepare(
      "INSERT INTO knowledge_chunks_fts (chunk_id, document) VALUES (?, ?)"
    );
    for (const row of rows) {
      insert.run(
        row.id,
        segmentKnowledgeText(`${row.title} ${row.content} ${row.citation}`)
      );
    }
  }

  syncKnowledgeBase() {
    const timestamp = nowIso();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const sourceByKey = new Map();
      const upsertSource = this.db.prepare(`
        INSERT INTO knowledge_sources (
          source_key, kind, title, publisher, edition, locator, note,
          verified_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_key) DO UPDATE SET
          kind = excluded.kind,
          title = excluded.title,
          publisher = excluded.publisher,
          edition = excluded.edition,
          locator = excluded.locator,
          note = excluded.note,
          verified_at = excluded.verified_at,
          updated_at = excluded.updated_at
      `);
      for (const source of KNOWLEDGE_SOURCES) {
        upsertSource.run(
          source.key,
          source.kind,
          source.title,
          source.publisher,
          source.edition,
          source.locator,
          source.note,
          source.verifiedAt || null,
          timestamp,
          timestamp
        );
        const row = this.db
          .prepare("SELECT * FROM knowledge_sources WHERE source_key = ?")
          .get(source.key);
        sourceByKey.set(source.key, row);
      }

      let changedPoints = 0;
      let insertedChunks = 0;
      for (const [position, card] of KNOWLEDGE_CARDS.entries()) {
        const contentVersion = this.knowledgeContentVersion(card);
        const existing = this.db
          .prepare(
            "SELECT id, content_version FROM knowledge_points WHERE slug = ? OR name = ? ORDER BY id LIMIT 1"
          )
          .get(card.slug, card.name);
        const values = [
          card.name,
          card.slug,
          JSON.stringify(card.aliases || []),
          card.unit || "",
          card.textbookVersion || "",
          JSON.stringify(card.prerequisites || []),
          JSON.stringify(card.keywords || []),
          card.summary || "",
          card.hint || "",
          JSON.stringify(card.steps || []),
          JSON.stringify(card.commonErrors || []),
          contentVersion,
          card.reviewStatus || "self_reviewed",
          timestamp,
          position
        ];

        let pointId;
        if (existing) {
          pointId = existing.id;
          this.db
            .prepare(`
              UPDATE knowledge_points SET
                name = ?, slug = ?, aliases_json = ?, unit = ?,
                textbook_version = ?, prerequisites_json = ?, keywords_json = ?,
                summary = ?, hint = ?, method_steps_json = ?,
                common_errors_json = ?, content_version = ?, review_status = ?,
                updated_at = ?, position = ?
              WHERE id = ?
            `)
            .run(...values, pointId);
        } else {
          const result = this.db
            .prepare(`
              INSERT INTO knowledge_points (
                name, slug, aliases_json, unit, textbook_version,
                prerequisites_json, keywords_json, summary, hint,
                method_steps_json, common_errors_json, content_version,
                review_status, updated_at, position
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `)
            .run(...values);
          pointId = Number(result.lastInsertRowid);
        }

        const chunkCount = Number(
          this.db
            .prepare(
              "SELECT COUNT(*) AS count FROM knowledge_chunks WHERE knowledge_point_id = ?"
            )
            .get(pointId).count
        );
        const needsChunkSync =
          !existing ||
          existing.content_version !== contentVersion ||
          chunkCount !== (card.chunks || []).length;

        if (needsChunkSync) {
          this.db
            .prepare(
              "DELETE FROM knowledge_chunks_fts WHERE chunk_id IN (SELECT id FROM knowledge_chunks WHERE knowledge_point_id = ?)"
            )
            .run(pointId);
          this.db
            .prepare("DELETE FROM knowledge_chunks WHERE knowledge_point_id = ?")
            .run(pointId);
          const insertChunk = this.db.prepare(`
            INSERT INTO knowledge_chunks (
              knowledge_point_id, chunk_key, kind, title, content, citation,
              source_id, position, content_version, review_status,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          (card.chunks || []).forEach((chunk, index) => {
            const source =
              sourceByKey.get(chunk.sourceKey) ||
              sourceByKey.get("self-authored-summary-v1");
            insertChunk.run(
              pointId,
              chunk.key,
              chunk.kind,
              chunk.title,
              chunk.content,
              this.knowledgeCitation(source, card, chunk),
              source.id,
              index + 1,
              contentVersion,
              card.reviewStatus || "self_reviewed",
              timestamp,
              timestamp
            );
            insertedChunks += 1;
          });
          changedPoints += 1;
        }

        this.db
          .prepare(`
            INSERT INTO knowledge_reviews (
              knowledge_point_id, content_version, checklist_version, status,
              reviewer, notes, reviewed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(knowledge_point_id, content_version) DO UPDATE SET
              checklist_version = excluded.checklist_version,
              status = excluded.status,
              reviewer = excluded.reviewer,
              notes = excluded.notes,
              reviewed_at = excluded.reviewed_at
          `)
          .run(
            pointId,
            contentVersion,
            "knowledge-review-v2",
            card.reviewStatus || "self_reviewed",
            "项目自检",
            card.reviewNote || "内容、例题和来源已完成项目自检。",
            timestamp
          );
      }

      this.rebuildKnowledgeFts();
      this.db.exec("COMMIT");
      return {
        cards: KNOWLEDGE_CARDS.length,
        changedPoints,
        insertedChunks,
        contentVersion: KNOWLEDGE_CONTENT_VERSION
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getKnowledgeCards() {
    const points = this.db
      .prepare(`
        SELECT id, name, slug, aliases_json, unit, textbook_version,
               prerequisites_json, keywords_json, summary, hint,
               method_steps_json, common_errors_json, content_version,
               review_status, updated_at, position
        FROM knowledge_points
        ORDER BY position, id
      `)
      .all();
    const sources = this.db
      .prepare("SELECT * FROM knowledge_sources ORDER BY id")
      .all();
    const sourceById = new Map(sources.map((source) => [source.id, source]));
    const sourceByKey = new Map(
      sources.map((source) => [source.source_key, source])
    );
    const catalogBySlug = new Map(
      KNOWLEDGE_CARDS.map((card) => [card.slug, card])
    );
    const chunks = this.db
      .prepare("SELECT * FROM knowledge_chunks ORDER BY position, id")
      .all();
    const chunksByPoint = new Map();
    for (const chunk of chunks) {
      if (!chunksByPoint.has(chunk.knowledge_point_id)) {
        chunksByPoint.set(chunk.knowledge_point_id, []);
      }
      chunksByPoint.get(chunk.knowledge_point_id).push(chunk);
    }

    const mapSource = (source) => ({
      key: source.source_key,
      kind: source.kind,
      title: source.title,
      publisher: source.publisher,
      edition: source.edition,
      locator: source.locator,
      note: source.note,
      verifiedAt: source.verified_at,
      citation: `${source.title}（${source.edition}）· ${source.locator} [${source.source_key}]`
    });

    return points.map((point) => {
      const pointChunks = (chunksByPoint.get(point.id) || []).map((chunk) => {
        const source = sourceById.get(chunk.source_id);
        return {
          id: chunk.id,
          chunkKey: chunk.chunk_key,
          kind: chunk.kind,
          title: chunk.title,
          content: chunk.content,
          citation: chunk.citation,
          reviewStatus: chunk.review_status,
          source: source ? mapSource(source) : null
        };
      });
      const sourceMap = new Map();
      for (const chunk of pointChunks) {
        if (chunk.source) sourceMap.set(chunk.source.key, chunk.source);
      }
      const catalogCard = catalogBySlug.get(point.slug);
      for (const sourceKey of catalogCard?.sourceKeys || []) {
        const source = sourceByKey.get(sourceKey);
        if (source) {
          const mapped = mapSource(source);
          sourceMap.set(mapped.key, mapped);
        }
      }
      return {
        id: point.id,
        name: point.name,
        slug: point.slug,
        aliases: parseJson(point.aliases_json),
        unit: point.unit,
        textbookVersion: point.textbook_version,
        prerequisites: parseJson(point.prerequisites_json),
        keywords: parseJson(point.keywords_json),
        summary: point.summary,
        hint: point.hint,
        steps: parseJson(point.method_steps_json),
        commonErrors: parseJson(point.common_errors_json),
        contentVersion: point.content_version,
        reviewStatus: point.review_status,
        updatedAt: point.updated_at,
        position: point.position,
        chunks: pointChunks,
        sources: [...sourceMap.values()]
      };
    });
  }

  getKnowledgeCard(identifier) {
    const value = String(identifier || "").trim();
    if (!value) return null;
    return (
      this.getKnowledgeCards().find(
        (card) =>
          String(card.id) === value ||
          card.slug === value ||
          card.name === value
      ) || null
    );
  }

  searchKnowledge({ query, knowledgePoint = null, limit = 3, includeCard = false }) {
    const cards = this.getKnowledgeCards();
    const ftsHits = new Map();
    const ftsQuery = buildKnowledgeFtsQuery(query);
    if (ftsQuery) {
      try {
        const rows = this.db
          .prepare(
            "SELECT chunk_id FROM knowledge_chunks_fts WHERE document MATCH ? LIMIT 400"
          )
          .all(ftsQuery);
        const pointByChunk = new Map();
        for (const card of cards) {
          for (const chunk of card.chunks) {
            pointByChunk.set(chunk.id, card.id);
          }
        }
        for (const row of rows) {
          const pointId = pointByChunk.get(Number(row.chunk_id));
          if (!pointId) continue;
          ftsHits.set(pointId, (ftsHits.get(pointId) || 0) + 1);
        }
      } catch {
        ftsHits.clear();
      }
    }
    return searchKnowledgeCards(cards, {
      query,
      knowledgePoint,
      limit,
      includeCard,
      ftsHits
    });
  }

  getKnowledgeBaseStats() {
    const cards = this.getKnowledgeCards();
    const reviewCounts = {};
    for (const card of cards) {
      reviewCounts[card.reviewStatus] = (reviewCounts[card.reviewStatus] || 0) + 1;
    }
    const sourceKeys = new Set(
      cards.flatMap((card) => card.sources.map((source) => source.key))
    );
    return {
      knowledgePoints: cards.length,
      chunks: cards.reduce((total, card) => total + card.chunks.length, 0),
      sources: sourceKeys.size,
      reviewCounts,
      textbookVersion: cards[0]?.textbookVersion || "",
      contentVersion: KNOWLEDGE_CONTENT_VERSION,
      cards: cards.map((card) => ({
        id: card.id,
        name: card.name,
        slug: card.slug,
        unit: card.unit,
        reviewStatus: card.reviewStatus,
        contentVersion: card.contentVersion,
        chunks: card.chunks.length,
        sources: card.sources.length,
        aliases: card.aliases,
        prerequisites: card.prerequisites
      }))
    };
  }

  createMistakeDraft(input) {
    assertToolWriteAllowed();
    const student = this.getStudent();
    const parts = normalizeParts(input);
    const diagnosisInput = {
      ...input,
      studentAnswer:
        input.studentAnswer || parts.map((part) => part.studentAnswer).join("；"),
      correctAnswer:
        input.correctAnswer || parts[0]?.acceptedAnswers[0] || ""
    };
    const diagnosis = buildMistakeDiagnosis(diagnosisInput);
    const id = randomUUID();
    const timestamp = nowIso();
    const expiresAt = toIsoAfterDays(1);

    this.db
      .prepare(
        `INSERT INTO mistake_drafts (
          id, student_id, question, student_answer, correct_answer, analysis,
          knowledge_point, error_type, diagnosis_json, parts_json, status,
          created_at, updated_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`
      )
      .run(
        id,
        student.id,
        input.question,
        diagnosisInput.studentAnswer,
        diagnosisInput.correctAnswer,
        input.analysis || "",
        diagnosis.knowledgePoint,
        diagnosis.errorType,
        JSON.stringify(diagnosis),
        JSON.stringify(parts),
        timestamp,
        timestamp,
        expiresAt
      );
    return this.getMistakeDraft(id);
  }

  getMistakeDraft(id) {
    return mapDraft(
      this.db.prepare("SELECT * FROM mistake_drafts WHERE id = ?").get(id)
    );
  }

  saveMistakeDraft(id) {
    assertToolWriteAllowed();
    const draft = this.getMistakeDraft(id);
    if (!draft) return null;
    if (draft.status === "saved" && draft.savedMistakeId) {
      return {
        status: "saved",
        alreadySaved: true,
        mistake: this.getMistake(draft.savedMistakeId, {
          includeSolution: true
        })
      };
    }
    if (draft.status === "expired" || draft.expiresAt <= nowIso()) {
      this.db
        .prepare(
          "UPDATE mistake_drafts SET status = 'expired', updated_at = ? WHERE id = ?"
        )
        .run(nowIso(), id);
      return { status: "expired", alreadySaved: false, mistake: null };
    }

    const diagnosis = draft.diagnosis;
    const parts = normalizeParts({
      parts: draft.parts,
      studentAnswer: draft.studentAnswer,
      correctAnswer: draft.correctAnswer,
      knowledgePoint: draft.knowledgePoint
    });
    const timestamp = nowIso();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare(
          `INSERT INTO mistakes (
            student_id, question, student_answer, correct_answer, analysis,
            knowledge_point, error_type, hint, method_steps, common_errors,
            diagnosis, status, due_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)`
        )
        .run(
          draft.studentId,
          draft.question,
          draft.studentAnswer,
          draft.correctAnswer,
          draft.analysis,
          draft.knowledgePoint,
          draft.errorType,
          diagnosis.hint || "",
          JSON.stringify(diagnosis.methodSteps || []),
          JSON.stringify(diagnosis.commonErrors || []),
          diagnosis.diagnosis || "",
          timestamp,
          timestamp,
          timestamp
        );
      const mistakeId = Number(result.lastInsertRowid);
      this.insertMistakeParts(
        mistakeId,
        parts,
        timestamp,
        diagnosis.knowledgePoint
      );
      this.insertDiagnosis(mistakeId, diagnosis, timestamp);
      const reviewScheduleId = this.insertReviewSchedule({
        mistakeId,
        nextReviewAt: timestamp,
        intervalDays: REVIEW_INTERVAL_DAYS.newMistake,
        reason: "new_mistake",
        ruleVersion: LEARNING_POLICY_VERSION,
        createdAt: timestamp
      });
      this.insertMasteryEvidence({
        mistakeId,
        evidenceType: "created",
        ruleVersion: LEARNING_POLICY_VERSION,
        previousStatus: "",
        nextStatus: "new",
        reviewScheduleId,
        reason: "mistake_created",
        detail: { source: "save_mistake_draft" },
        createdAt: timestamp
      });
      this.db
        .prepare(
          `UPDATE mistake_drafts
           SET status = 'saved', saved_mistake_id = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(mistakeId, timestamp, id);
      this.db.exec("COMMIT");
      return {
        status: "saved",
        alreadySaved: false,
        mistake: this.getMistake(mistakeId, { includeSolution: true })
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  createMistake(input) {
    assertToolWriteAllowed();
    const student = this.getStudent();
    const parts = normalizeParts(input);
    const combinedStudentAnswer = parts
      .map((part) => part.studentAnswer)
      .join("；");
    const combinedCorrectAnswer = parts
      .map((part) => part.acceptedAnswers[0] || "")
      .join("；");
    const diagnosis = buildMistakeDiagnosis({
      ...input,
      studentAnswer: input.studentAnswer || combinedStudentAnswer,
      correctAnswer: input.correctAnswer || combinedCorrectAnswer
    });
    const timestamp = nowIso();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare(
          `INSERT INTO mistakes (
            student_id, question, student_answer, correct_answer, analysis,
            knowledge_point, error_type, hint, method_steps, common_errors,
            diagnosis, status, due_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)`
        )
        .run(
          student.id,
          input.question,
          combinedStudentAnswer,
          combinedCorrectAnswer,
          input.analysis || "",
          diagnosis.knowledgePoint,
          diagnosis.errorType,
          diagnosis.hint,
          JSON.stringify(diagnosis.methodSteps),
          JSON.stringify(diagnosis.commonErrors),
          diagnosis.diagnosis,
          timestamp,
          timestamp,
          timestamp
        );
      const mistakeId = Number(result.lastInsertRowid);
      this.insertMistakeParts(
        mistakeId,
        parts,
        timestamp,
        diagnosis.knowledgePoint
      );
      this.insertDiagnosis(mistakeId, diagnosis, timestamp);
      const reviewScheduleId = this.insertReviewSchedule({
        mistakeId,
        nextReviewAt: timestamp,
        intervalDays: REVIEW_INTERVAL_DAYS.newMistake,
        reason: "new_mistake",
        ruleVersion: LEARNING_POLICY_VERSION,
        createdAt: timestamp
      });
      this.insertMasteryEvidence({
        mistakeId,
        evidenceType: "created",
        ruleVersion: LEARNING_POLICY_VERSION,
        previousStatus: "",
        nextStatus: "new",
        reviewScheduleId,
        reason: "mistake_created",
        detail: { source: "create_mistake" },
        createdAt: timestamp
      });
      this.db.exec("COMMIT");
      return this.getMistake(mistakeId, { includeSolution: true });
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getMistake(id, { includeSolution = false } = {}) {
    const row = this.db
      .prepare(
        `SELECT m.*, k.name AS knowledge_point
         FROM mistakes m
         JOIN knowledge_points k ON k.name = m.knowledge_point
         WHERE m.id = ?`
      )
      .get(id);
    const mistake = mapMistake(row, { includeSolution });
    if (mistake) {
      mistake.parts = this.getMistakeParts(id, { includeSolution });
      mistake.partCount = mistake.parts.length;
    }
    return mistake;
  }

  getMistakeParts(id, { includeSolution = false } = {}) {
    const rows = this.db
      .prepare(
        `SELECT * FROM mistake_parts
         WHERE mistake_id = ? AND active = 1
         ORDER BY part_no, id`
      )
      .all(id);
    const answersStatement = this.db.prepare(
      `SELECT answer FROM accepted_answers
       WHERE part_id = ? ORDER BY position, id`
    );

    return rows.map((row) => {
      const answers = includeSolution
        ? answersStatement.all(row.id).map((answer) => answer.answer)
        : [];
      return mapPart(row, answers, { includeSolution });
    });
  }

  insertMistakeParts(mistakeId, parts, timestamp, fallbackKnowledgePoint) {
    const insertPart = this.db.prepare(
      `INSERT INTO mistake_parts (
        mistake_id, part_no, label, prompt, student_answer, answer_type,
        comparison_rule, knowledge_point, hint, explanation, active,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    );
    const insertAnswer = this.db.prepare(
      `INSERT INTO accepted_answers (
        part_id, position, answer, variant_type, created_at
      ) VALUES (?, ?, ?, 'expected', ?)`
    );
    const inserted = [];
    for (const part of parts) {
      const result = insertPart.run(
        mistakeId,
        part.partNo,
        part.label,
        part.prompt,
        part.studentAnswer,
        part.answerType,
        part.comparisonRule,
        part.knowledgePoint || fallbackKnowledgePoint,
        part.hint,
        part.explanation,
        timestamp,
        timestamp
      );
      const partId = Number(result.lastInsertRowid);
      part.acceptedAnswers.forEach((answer, index) => {
        insertAnswer.run(partId, index + 1, answer, timestamp);
      });
      inserted.push({ ...part, id: partId });
    }
    return inserted;
  }

  insertDiagnosis(mistakeId, diagnosis, timestamp) {
    const meta = diagnosis._meta || {};
    this.db
      .prepare(
        `INSERT INTO diagnoses (
          mistake_id, agent_run_id, knowledge_point, error_type, error_step,
          missing_concept, initial_hint, confidence, evidence,
          knowledge_sources, raw_output, provider, model, prompt_version,
          accepted_by_user, accepted_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        mistakeId,
        meta.agentRunId || null,
        diagnosis.knowledgePoint || null,
        diagnosis.errorType || null,
        diagnosis.errorStep || "",
        diagnosis.missingConcept || "",
        diagnosis.hint || "",
        Number.isFinite(diagnosis.confidence)
          ? diagnosis.confidence
          : null,
        JSON.stringify(diagnosis.evidence || []),
        JSON.stringify(diagnosis.knowledgeSources || []),
        JSON.stringify(meta.rawOutput || diagnosis),
        meta.provider || "rules",
        meta.model || "",
        meta.promptVersion || "",
        meta.acceptedByUser ? 1 : 0,
        meta.acceptedByUser ? timestamp : null,
        timestamp
      );
  }

  getActiveReviewSchedule(mistakeId) {
    const row = this.db
      .prepare(
        `SELECT * FROM review_schedule
         WHERE mistake_id = ? AND active = 1
         ORDER BY id DESC LIMIT 1`
      )
      .get(mistakeId);
    if (!row) return null;
    return {
      id: row.id,
      mistakeId: row.mistake_id,
      nextReviewAt: row.next_review_at,
      intervalDays: row.interval_days,
      reason: row.reason,
      ruleVersion: row.rule_version,
      active: row.active === 1,
      createdAt: row.created_at,
      supersededAt: row.superseded_at
    };
  }

  getMasteryEvidence(mistakeId) {
    return this.db
      .prepare(
        `SELECT
          e.*,
          a.answer AS attempt_answer,
          a.outcome AS attempt_outcome,
          a.independent AS attempt_independent,
          a.created_at AS attempt_created_at
         FROM mastery_evidence e
         LEFT JOIN attempts a ON a.id = e.attempt_id
         WHERE e.mistake_id = ?
         ORDER BY e.created_at ASC, e.id ASC`
      )
      .all(mistakeId)
      .map((row) => ({
        id: row.id,
        mistakeId: row.mistake_id,
        attemptId: row.attempt_id,
        evidenceType: row.evidence_type,
        ruleVersion: row.rule_version,
        independent:
          row.independent === 1
            ? true
            : row.independent === 0
              ? false
              : null,
        previousStatus: row.previous_status,
        nextStatus: row.next_status,
        outcome: row.outcome,
        consecutiveIndependentCorrect:
          row.consecutive_independent_correct,
        reviewScheduleId: row.review_schedule_id,
        reason: row.reason,
        detail: parseJsonObject(row.detail_json),
        createdAt: row.created_at,
        attempt: row.attempt_id
          ? {
              answer: row.attempt_answer,
              outcome: row.attempt_outcome,
              independent:
                row.attempt_independent === 1
                  ? true
                  : row.attempt_independent === 0
                    ? false
                    : null,
              createdAt: row.attempt_created_at
            }
          : null
      }));
  }

  insertReviewSchedule({
    mistakeId,
    nextReviewAt,
    intervalDays,
    reason,
    ruleVersion,
    createdAt
  }) {
    const result = this.db
      .prepare(
        `INSERT INTO review_schedule (
          mistake_id, next_review_at, interval_days, reason, rule_version,
          active, created_at, superseded_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, NULL)`
      )
      .run(
        mistakeId,
        nextReviewAt,
        intervalDays,
        reason,
        ruleVersion,
        createdAt
      );
    return Number(result.lastInsertRowid);
  }

  replaceReviewSchedule({
    mistakeId,
    nextReviewAt,
    intervalDays,
    reason,
    ruleVersion,
    createdAt
  }) {
    this.db
      .prepare(
        `UPDATE review_schedule
         SET active = 0, superseded_at = ?
         WHERE mistake_id = ? AND active = 1`
      )
      .run(createdAt, mistakeId);
    return this.insertReviewSchedule({
      mistakeId,
      nextReviewAt,
      intervalDays,
      reason,
      ruleVersion,
      createdAt
    });
  }

  insertMasteryEvidence({
    mistakeId,
    attemptId = null,
    evidenceType,
    ruleVersion,
    independent = null,
    previousStatus = "",
    nextStatus,
    outcome = "",
    consecutiveIndependentCorrect = 0,
    reviewScheduleId = null,
    reason = "",
    detail = {},
    createdAt
  }) {
    const result = this.db
      .prepare(
        `INSERT INTO mastery_evidence (
          mistake_id, attempt_id, evidence_type, rule_version, independent,
          previous_status, next_status, outcome,
          consecutive_independent_correct, review_schedule_id, reason,
          detail_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        mistakeId,
        attemptId,
        evidenceType,
        ruleVersion,
        independent === true ? 1 : independent === false ? 0 : null,
        previousStatus,
        nextStatus,
        outcome,
        consecutiveIndependentCorrect,
        reviewScheduleId,
        reason,
        JSON.stringify(detail),
        createdAt
      );
    return Number(result.lastInsertRowid);
  }

  updateMistake(id, input) {
    assertToolWriteAllowed();
    const current = this.getMistake(id, { includeSolution: true });
    if (!current) return null;
    const partsProvided = Array.isArray(input.parts);
    const proposedParts = partsProvided
      ? normalizeParts({
          ...input,
          parts: input.parts.map((part, index) => {
            const existing = current.parts[index];
            return {
              ...part,
              hint: part.hint ?? existing?.hint ?? "",
              explanation: part.explanation ?? existing?.explanation ?? ""
            };
          })
        })
      : current.parts;
    const combinedStudentAnswer = proposedParts
      .map((part) => part.studentAnswer)
      .join("；");
    const combinedCorrectAnswer = proposedParts
      .map((part) => part.acceptedAnswers?.[0] || "")
      .join("；");

    const proposed = {
      question: input.question ?? current.question,
      studentAnswer:
        input.studentAnswer ??
        (partsProvided ? combinedStudentAnswer : current.studentAnswer),
      correctAnswer:
        input.correctAnswer ??
        (partsProvided ? combinedCorrectAnswer : current.correctAnswer),
      analysis: input.analysis ?? current.analysis,
      knowledgePoint: input.knowledgePoint ?? current.knowledgePoint,
      errorType: input.errorType ?? current.errorType
    };
    const diagnosis = diagnoseMistake(proposed);
    const finalFields = {
      ...proposed,
      knowledgePoint: diagnosis.knowledgePoint,
      errorType: diagnosis.errorType
    };
    const changedFields = Object.keys(finalFields).filter(
      (field) => finalFields[field] !== current[field]
    );
    const comparablePart = (part) => ({
      partNo: part.partNo,
      label: part.label || "",
      prompt: part.prompt || "",
      studentAnswer: part.studentAnswer || "",
      answerType: part.answerType || "auto",
      comparisonRule: part.comparisonRule || "auto",
      knowledgePoint: part.knowledgePoint || "",
      acceptedAnswers: part.acceptedAnswers || []
    });
    const partsContentChanged =
      partsProvided &&
      JSON.stringify(proposedParts.map(comparablePart)) !==
        JSON.stringify(current.parts.map(comparablePart));
    const partsMetadataChanged =
      partsProvided &&
      JSON.stringify(
        proposedParts.map((part) => ({
          hint: part.hint || "",
          explanation: part.explanation || ""
        }))
      ) !==
        JSON.stringify(
          current.parts.map((part) => ({
            hint: part.hint || "",
            explanation: part.explanation || ""
          }))
        );
    const partsChanged = partsContentChanged || partsMetadataChanged;
    if (partsChanged) changedFields.push("parts");
    if (!changedFields.length) {
      return {
        mistake: current,
        changedFields: [],
        learningReset: false,
        revisionBefore: current.revision,
        revisionAfter: current.revision
      };
    }

    const resetLearning =
      partsContentChanged ||
      changedFields.some((field) =>
        ["question", "correctAnswer", "knowledgePoint"].includes(field)
      );
    const revisionAfter = current.revision + 1;
    const timestamp = nowIso();
    const nextLearningState = resetLearning
      ? {
          status: "new",
          consecutiveCorrect: 0,
          attemptCount: 0,
          dueAt: timestamp,
          lastReviewedAt: null
        }
      : {
          status: current.status,
          consecutiveCorrect: current.consecutiveCorrect,
          attemptCount: current.attemptCount,
          dueAt: current.dueAt,
          lastReviewedAt: current.lastReviewedAt
        };
    const beforeSnapshot = {
      ...Object.fromEntries(
        Object.keys(finalFields).map((field) => [field, current[field]])
      ),
      status: current.status,
      consecutiveCorrect: current.consecutiveCorrect,
      attemptCount: current.attemptCount,
      dueAt: current.dueAt,
      parts: current.parts
    };
    const afterSnapshot = {
      ...finalFields,
      ...nextLearningState,
      parts: proposedParts
    };

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `UPDATE mistakes SET
             question = ?, student_answer = ?, correct_answer = ?, analysis = ?,
             knowledge_point = ?, error_type = ?, hint = ?, method_steps = ?,
             common_errors = ?, diagnosis = ?, revision = ?, status = ?,
             consecutive_correct = ?, attempt_count = ?, due_at = ?,
             last_reviewed_at = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          finalFields.question,
          finalFields.studentAnswer,
          finalFields.correctAnswer,
          finalFields.analysis,
          finalFields.knowledgePoint,
          finalFields.errorType,
          diagnosis.hint,
          JSON.stringify(diagnosis.methodSteps),
          JSON.stringify(diagnosis.commonErrors),
          diagnosis.diagnosis,
          revisionAfter,
          nextLearningState.status,
          nextLearningState.consecutiveCorrect,
          nextLearningState.attemptCount,
          nextLearningState.dueAt,
          nextLearningState.lastReviewedAt,
          timestamp,
          id
        );
      if (resetLearning) {
        const reviewScheduleId = this.replaceReviewSchedule({
          mistakeId: id,
          nextReviewAt: timestamp,
          intervalDays: REVIEW_INTERVAL_DAYS.newMistake,
          reason: "content_changed_reset",
          ruleVersion: LEARNING_POLICY_VERSION,
          createdAt: timestamp
        });
        this.insertMasteryEvidence({
          mistakeId: id,
          evidenceType: "learning_reset",
          ruleVersion: LEARNING_POLICY_VERSION,
          previousStatus: current.status,
          nextStatus: "new",
          reviewScheduleId,
          reason: "content_changed",
          detail: {
            changedFields,
            revisionBefore: current.revision,
            revisionAfter
          },
          createdAt: timestamp
        });
      }
      if (partsProvided && partsChanged) {
        this.db
          .prepare(
            `UPDATE mistake_parts
             SET active = 0, updated_at = ?
             WHERE mistake_id = ? AND active = 1`
          )
          .run(timestamp, id);
        this.insertMistakeParts(
          id,
          proposedParts,
          timestamp,
          finalFields.knowledgePoint
        );
      } else if (
        current.parts.length === 1 &&
        (Object.hasOwn(input, "correctAnswer") ||
          Object.hasOwn(input, "studentAnswer") ||
          Object.hasOwn(input, "knowledgePoint"))
      ) {
        const part = current.parts[0];
        const acceptedAnswers = splitAcceptedAnswers(finalFields.correctAnswer);
        this.db
          .prepare(
            `UPDATE mistake_parts
             SET student_answer = ?, knowledge_point = ?, updated_at = ?
             WHERE id = ?`
          )
          .run(
            finalFields.studentAnswer,
            finalFields.knowledgePoint,
            timestamp,
            part.id
          );
        this.db
          .prepare("DELETE FROM accepted_answers WHERE part_id = ?")
          .run(part.id);
        const insertAnswer = this.db.prepare(
          `INSERT INTO accepted_answers (
            part_id, position, answer, variant_type, created_at
          ) VALUES (?, ?, ?, 'expected', ?)`
        );
        acceptedAnswers.forEach((answer, index) => {
          insertAnswer.run(part.id, index + 1, answer, timestamp);
        });
      }
      this.db
        .prepare(
          `INSERT INTO mistake_edits (
            mistake_id, revision_before, revision_after,
            changed_fields_json, before_json, after_json,
            reset_learning, edited_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          current.revision,
          revisionAfter,
          JSON.stringify(changedFields),
          JSON.stringify(beforeSnapshot),
          JSON.stringify(afterSnapshot),
          resetLearning ? 1 : 0,
          timestamp
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return {
      mistake: this.getMistake(id, { includeSolution: true }),
      changedFields,
      learningReset: resetLearning,
      revisionBefore: current.revision,
      revisionAfter
    };
  }

  listMistakes({ status = "all" } = {}) {
    const validStatus = ["new", "practicing", "mastered", "relearning"].includes(status)
      ? status
      : "all";
    const where = validStatus === "all" ? "" : "WHERE m.status = ?";
    const statement = this.db.prepare(
      `SELECT m.*, k.name AS knowledge_point
       FROM mistakes m
       JOIN knowledge_points k ON k.name = m.knowledge_point
       ${where}
       ORDER BY
         CASE m.status
           WHEN 'new' THEN 0
           WHEN 'relearning' THEN 1
           WHEN 'practicing' THEN 2
           ELSE 3
         END,
         COALESCE(m.due_at, m.created_at) ASC,
         m.id DESC`
    );
    const rows =
      validStatus === "all" ? statement.all() : statement.all(validStatus);
    return rows.map((row) => mapMistake(row));
  }

  deleteMistake(id) {
    assertToolWriteAllowed();
    const result = this.db.prepare("DELETE FROM mistakes WHERE id = ?").run(id);
    return result.changes > 0;
  }

  getNextReview() {
    const timestamp = nowIso();
    const row = this.db
      .prepare(
        `SELECT m.*, k.name AS knowledge_point,
                rs.next_review_at AS scheduled_review_at,
                rs.interval_days AS review_interval_days,
                rs.reason AS review_reason
         FROM mistakes m
         JOIN knowledge_points k ON k.name = m.knowledge_point
         LEFT JOIN review_schedule rs
           ON rs.mistake_id = m.id AND rs.active = 1
         WHERE COALESCE(rs.next_review_at, m.due_at, m.created_at) <= ?
         ORDER BY
           CASE m.status
             WHEN 'new' THEN 0
             WHEN 'relearning' THEN 1
             WHEN 'practicing' THEN 2
             ELSE 3
           END,
           COALESCE(rs.next_review_at, m.due_at, m.created_at) ASC,
           m.id ASC
         LIMIT 1`
      )
      .get(timestamp);
    const mistake = mapMistake(row, { includeSolution: true });
    if (mistake) {
      mistake.parts = this.getMistakeParts(mistake.id, {
        includeSolution: true
      });
      mistake.partCount = mistake.parts.length;
    }
    return mistake;
  }

  listDueReviews({ limit = 5, at = nowIso() } = {}) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 5, 20));
    return this.db
      .prepare(
        `SELECT m.*, k.name AS knowledge_point,
                rs.next_review_at AS scheduled_review_at,
                rs.interval_days AS review_interval_days,
                rs.reason AS review_reason
         FROM mistakes m
         JOIN knowledge_points k ON k.name = m.knowledge_point
         LEFT JOIN review_schedule rs
           ON rs.mistake_id = m.id AND rs.active = 1
         WHERE COALESCE(rs.next_review_at, m.due_at, m.created_at) <= ?
         ORDER BY
           CASE m.status
             WHEN 'new' THEN 0
             WHEN 'relearning' THEN 1
             WHEN 'practicing' THEN 2
             ELSE 3
           END,
           COALESCE(rs.next_review_at, m.due_at, m.created_at) ASC,
           m.id ASC
         LIMIT ?`
      )
      .all(at, safeLimit)
      .map((row) =>
        this.getMistake(row.id, {
          includeSolution: false
        })
      );
  }

  recordAttempt(
    id,
    answer,
    {
      independent = null,
      hintLevel = null,
      evaluationSource = "rule",
      agentRunId = null,
      answers = null
    } = {}
  ) {
    assertToolWriteAllowed();
    const mistake = this.getMistake(id, { includeSolution: true });
    if (!mistake) {
      return null;
    }
    validateSubmittedPartAnswers(mistake.parts || [], answers);
    const pendingHints = this.getPendingHintContext(id);
    const effectiveIndependent =
      pendingHints.count > 0 ? false : independent;
    const effectiveHintLevel =
      pendingHints.count > 0 ? pendingHints.maxLevel : hintLevel;

    const submittedAnswers =
      Array.isArray(answers) && answers.length
        ? answers
        : [{ partNo: 1, value: answer }];
    const evaluation = evaluatePartResponses(
      mistake.parts || [],
      submittedAnswers
    );
    const timestamp = nowIso();
    const policy = evaluateAttemptState({
      mistake,
      correct: evaluation.allCorrect,
      outcome: evaluation.outcome,
      correctPartCount: evaluation.correctPartCount,
      totalPartCount: evaluation.totalPartCount,
      independent: effectiveIndependent,
      hintLevel: effectiveHintLevel,
      now: timestamp
    });

    let attemptId = null;
    let reviewScheduleId = null;
    this.db.exec("BEGIN");
    try {
      const attemptResult = this.db
        .prepare(
          `INSERT INTO attempts
           (mistake_id, answer, is_correct, outcome, hint_level, independent,
            evaluation_source, agent_run_id, feedback, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          Array.isArray(answers) && answers.length > 0
            ? JSON.stringify(answers)
            : String(answer || ""),
          policy.correct ? 1 : 0,
          policy.outcome,
          effectiveHintLevel,
          effectiveIndependent === true
            ? 1
            : effectiveIndependent === false
              ? 0
              : null,
          evaluationSource,
          agentRunId,
          policy.feedback,
          timestamp
        );
      attemptId = Number(attemptResult.lastInsertRowid);
      if (pendingHints.count > 0) {
        this.db
          .prepare(
            `UPDATE hint_events
             SET attempt_id = ?
             WHERE mistake_id = ? AND attempt_id IS NULL`
          )
          .run(attemptId, id);
      }
      const insertPartResult = this.db.prepare(
        `INSERT INTO attempt_part_results (
          attempt_id, part_id, raw_answer, outcome, feedback, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`
      );
      const partFeedbackById = new Map(
        evaluation.results.map((result) => [result.partId, result])
      );
      for (const part of mistake.parts || []) {
        const result = partFeedbackById.get(part.id);
        if (!result) continue;
        insertPartResult.run(
          attemptId,
          part.id,
          result.rawAnswer,
          result.outcome,
          result.outcome === "correct"
            ? "这一小问答对了。"
            : "这一小问还需要订正。",
          timestamp
        );
      }
      this.db
        .prepare(
          `UPDATE mistakes
           SET status = ?, consecutive_correct = ?, attempt_count = attempt_count + 1,
               due_at = ?, last_reviewed_at = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          policy.nextStatus,
          policy.nextConsecutiveCorrect,
          policy.dueAt,
          timestamp,
          timestamp,
          id
        );
      reviewScheduleId = this.replaceReviewSchedule({
        mistakeId: id,
        nextReviewAt: policy.dueAt,
        intervalDays: policy.intervalDays,
        reason: policy.reviewReason,
        ruleVersion: policy.policyVersion,
        createdAt: timestamp
      });
      this.insertMasteryEvidence({
        mistakeId: id,
        attemptId,
        evidenceType: policy.evidenceType,
        ruleVersion: policy.policyVersion,
        independent: effectiveIndependent,
        previousStatus: policy.previousStatus,
        nextStatus: policy.nextStatus,
        outcome: policy.outcome,
        consecutiveIndependentCorrect:
          policy.nextConsecutiveCorrect,
        reviewScheduleId,
        reason: policy.reviewReason,
        detail: {
          correctPartCount: evaluation.correctPartCount,
          totalPartCount: evaluation.totalPartCount,
          linkedHintCount: pendingHints.count,
          evaluationSource
        },
        createdAt: timestamp
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return {
      attemptId,
      independent: effectiveIndependent,
      hintLevel: effectiveHintLevel,
      linkedHintCount: pendingHints.count,
      correct: policy.correct,
      mastered: policy.mastered,
      previousStatus: policy.previousStatus,
      nextStatus: policy.nextStatus,
      statusChanged: policy.statusChanged,
      evidenceType: policy.evidenceType,
      intervalDays: policy.intervalDays,
      reviewReason: policy.reviewReason,
      reviewScheduleId,
      feedback: policy.feedback,
      answer: mistake.correctAnswer,
      analysis: mistake.analysis,
      hint: mistake.hint,
      methodSteps: mistake.methodSteps,
      commonErrors: mistake.commonErrors,
      diagnosis: mistake.diagnosis,
      nextReviewAt: policy.dueAt,
      policyVersion: policy.policyVersion,
      independentEvidence: policy.independentEvidence,
      usedHint: policy.usedHint,
      partResults: evaluation.results,
      correctPartCount: evaluation.correctPartCount,
      totalPartCount: evaluation.totalPartCount,
      outcome: evaluation.outcome,
      mistake: this.getMistake(id)
    };
  }

  recordHint(
    { mistakeId, hintLevel, content, source = "", partId = null },
    { agentRunId = null } = {}
  ) {
    assertToolWriteAllowed();
    const mistake = this.getMistake(mistakeId);
    if (!mistake) return null;
    if (partId !== null && partId !== undefined) {
      const part = (mistake.parts || []).find(
        (candidate) => Number(candidate.id) === Number(partId)
      );
      if (!part) {
        throw new LearningValidationError(
          "INVALID_ARGUMENTS",
          "提示关联的小问不属于当前错题"
        );
      }
    }
    const timestamp = nowIso();
    const result = this.db
      .prepare(
        `INSERT INTO hint_events (
          mistake_id, attempt_id, agent_run_id, hint_level, content, source,
          part_id, created_at
        ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        mistakeId,
        agentRunId,
        hintLevel,
        content,
        source,
        partId,
        timestamp
      );
    return {
      hintEventId: Number(result.lastInsertRowid),
      mistakeId,
      hintLevel,
      partId,
      createdAt: timestamp
    };
  }

  getMaxHintLevel(mistakeId, partId = null) {
    const row =
      partId === null
        ? this.db
            .prepare(
              `SELECT COALESCE(MAX(hint_level), 0) AS level
               FROM hint_events WHERE mistake_id = ?`
            )
            .get(mistakeId)
        : this.db
            .prepare(
              `SELECT COALESCE(MAX(hint_level), 0) AS level
               FROM hint_events
               WHERE mistake_id = ? AND part_id = ?`
            )
            .get(mistakeId, partId);
    return Number(row?.level || 0);
  }

  getPendingHintContext(mistakeId) {
    const row = this.db
      .prepare(
        `SELECT
          COUNT(*) AS count,
          COALESCE(MAX(hint_level), 0) AS max_level
         FROM hint_events
         WHERE mistake_id = ? AND attempt_id IS NULL`
      )
      .get(mistakeId);
    return {
      count: Number(row?.count || 0),
      maxLevel: Number(row?.max_level || 0)
    };
  }

  saveAttemptEvaluation({
    attemptId,
    outcome,
    finalAnswerAssessment = "",
    stepAssessment = [],
    firstError = "",
    feedback = "",
    nextHintLevel = 0,
    masteryEvidence = [],
    sources = [],
    provider = "",
    model = "",
    promptVersion = "",
    createdAt = nowIso()
  }) {
    this.db
      .prepare(
        `INSERT INTO attempt_evaluations (
          attempt_id, outcome, final_answer_assessment, step_assessment_json,
          first_error, feedback, next_hint_level, mastery_evidence_json,
          sources_json, provider, model, prompt_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        attemptId,
        outcome,
        finalAnswerAssessment,
        JSON.stringify(stepAssessment),
        firstError,
        feedback,
        nextHintLevel,
        JSON.stringify(masteryEvidence),
        JSON.stringify(sources),
        provider,
        model,
        promptVersion,
        createdAt
      );
    return this.db
      .prepare("SELECT * FROM attempt_evaluations WHERE attempt_id = ?")
      .get(attemptId);
  }

  getLatestAttemptEvaluation(mistakeId) {
    return (
      this.db
        .prepare(
          `SELECT e.*
           FROM attempt_evaluations e
           JOIN attempts a ON a.id = e.attempt_id
           WHERE a.mistake_id = ?
           ORDER BY e.id DESC LIMIT 1`
        )
        .get(mistakeId) || null
    );
  }

  createAgentRun({
    taskType,
    goal = "",
    status = "in_progress",
    startedAt = nowIso()
  }) {
    const result = this.db
      .prepare(
        `INSERT INTO agent_runs (task_type, goal, status, started_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(taskType, goal, status, startedAt);
    return Number(result.lastInsertRowid);
  }

  getAgentRun(id) {
    return (
      this.db.prepare("SELECT * FROM agent_runs WHERE id = ?").get(id) || null
    );
  }

  finishAgentRun(id, { status, errorMessage = null }) {
    this.db
      .prepare(
        `UPDATE agent_runs
         SET status = ?, finished_at = ?, error_message = ?
         WHERE id = ?`
      )
      .run(status, nowIso(), errorMessage, id);
  }

  recordLlmCall({
    runId,
    provider,
    model,
    promptVersion,
    inputSummary = "",
    outputSummary = "",
    inputTokens = 0,
    outputTokens = 0,
    latencyMs = null,
    status,
    errorMessage = null,
    createdAt = nowIso()
  }) {
    const result = this.db
      .prepare(
        `INSERT INTO llm_calls (
          run_id, provider, model, prompt_version, input_summary,
          output_summary, input_tokens, output_tokens, latency_ms, status,
          error_message, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        runId,
        provider,
        model,
        promptVersion,
        inputSummary,
        outputSummary,
        inputTokens,
        outputTokens,
        latencyMs,
        status,
        errorMessage,
        createdAt
      );
    return Number(result.lastInsertRowid);
  }

  beginToolCall({
    runId,
    toolName,
    argumentsJson,
    idempotencyKey = null
  }) {
    const timestamp = nowIso();
    const result = this.db
      .prepare(
        `INSERT INTO tool_calls (
          run_id, tool_name, arguments_json, result_json, status,
          idempotency_key, created_at, updated_at
        ) VALUES (?, ?, ?, '{}', 'running', ?, ?, ?)`
      )
      .run(
        runId,
        toolName,
        argumentsJson,
        idempotencyKey,
        timestamp,
        timestamp
      );
    return Number(result.lastInsertRowid);
  }

  finishToolCall(
    id,
    { status, resultJson = "{}", latencyMs = null, errorMessage = null }
  ) {
    this.db
      .prepare(
        `UPDATE tool_calls
         SET status = ?, result_json = ?, latency_ms = ?, error_message = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(
        status,
        resultJson,
        latencyMs,
        errorMessage,
        nowIso(),
        id
      );
  }

  findToolCallByIdempotency(toolName, idempotencyKey) {
    return (
      this.db
        .prepare(
          `SELECT * FROM tool_calls
           WHERE tool_name = ? AND idempotency_key = ?
           ORDER BY id DESC LIMIT 1`
        )
        .get(toolName, idempotencyKey) || null
    );
  }

  getDashboard() {
    const timestamp = nowIso();
    const counts = this.db
      .prepare(
        `SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN m.status = 'new' THEN 1 ELSE 0 END) AS new_count,
          SUM(CASE WHEN m.status = 'practicing' THEN 1 ELSE 0 END) AS practicing_count,
          SUM(CASE WHEN m.status = 'mastered' THEN 1 ELSE 0 END) AS mastered_count,
          SUM(CASE WHEN m.status = 'relearning' THEN 1 ELSE 0 END) AS relearning_count,
          SUM(CASE WHEN COALESCE(rs.next_review_at, m.due_at, m.created_at) <= ?
                   THEN 1 ELSE 0 END) AS due_count
         FROM mistakes m
         LEFT JOIN review_schedule rs
           ON rs.mistake_id = m.id AND rs.active = 1`
      )
      .get(timestamp);
    const nextReview = this.getNextReview();
    const recent = this.listMistakes().slice(0, 5);

    return {
      stats: {
        total: Number(counts.total || 0),
        new: Number(counts.new_count || 0),
        practicing: Number(counts.practicing_count || 0),
        mastered: Number(counts.mastered_count || 0),
        relearning: Number(counts.relearning_count || 0),
        due: Number(counts.due_count || 0)
      },
      nextReview: nextReview
        ? {
            id: nextReview.id,
            question: nextReview.question,
            knowledgePoint: nextReview.knowledgePoint,
            errorType: nextReview.errorType,
            attemptCount: nextReview.attemptCount
          }
        : null,
      recent
    };
  }

  getKnowledgeSummary() {
    const points = this.getKnowledgePoints();
    const rows = this.db
      .prepare(
        `SELECT knowledge_point, status, consecutive_correct, attempt_count
         FROM mistakes`
      )
      .all();
    const grouped = new Map();
    for (const row of rows) {
      if (!grouped.has(row.knowledge_point)) {
        grouped.set(row.knowledge_point, []);
      }
      grouped.get(row.knowledge_point).push(row);
    }

    return points.map((point) => {
      const items = grouped.get(point.name) || [];
      const mastered = items.filter((item) => item.status === "mastered").length;
      const practicing = items.filter(
        (item) => item.status === "practicing"
      ).length;
      const relearning = items.filter(
        (item) => item.status === "relearning"
      ).length;
      const newCount = items.filter((item) => item.status === "new").length;
      const score = items.length
        ? Math.round(
            items.reduce((total, item) => {
              if (item.status === "mastered") return total + 100;
              if (item.status === "practicing") {
                return total + Math.min(80, 25 + item.consecutive_correct * 25);
              }
              if (item.status === "relearning") {
                return total + Math.min(60, 10 + item.consecutive_correct * 20);
              }
              return total + 10;
            }, 0) / items.length
          )
        : null;

      return {
        id: point.id,
        name: point.name,
        total: items.length,
        new: newCount,
        practicing,
        relearning,
        mastered,
        mastery: score
      };
    });
  }

  buildLearningSummary({ from, to, knowledgePoint = null }) {
    const mistakeClauses = ["m.created_at >= ?", "m.created_at <= ?"];
    const mistakeParameters = [from, to];
    if (knowledgePoint) {
      mistakeClauses.push("m.knowledge_point = ?");
      mistakeParameters.push(knowledgePoint);
    }

    const mistakes = this.db
      .prepare(
        `SELECT m.knowledge_point, m.status, m.attempt_count
         FROM mistakes m
         WHERE ${mistakeClauses.join(" AND ")}`
      )
      .all(...mistakeParameters);

    const attemptClauses = ["a.created_at >= ?", "a.created_at <= ?"];
    const attemptParameters = [from, to];
    if (knowledgePoint) {
      attemptClauses.push("m.knowledge_point = ?");
      attemptParameters.push(knowledgePoint);
    }
    const attempts = this.db
      .prepare(
        `SELECT a.outcome, a.independent, m.knowledge_point
         FROM attempts a
         JOIN mistakes m ON m.id = a.mistake_id
         WHERE ${attemptClauses.join(" AND ")}`
      )
      .all(...attemptParameters);

    const hintClauses = ["h.created_at >= ?", "h.created_at <= ?"];
    const hintParameters = [from, to];
    if (knowledgePoint) {
      hintClauses.push("m.knowledge_point = ?");
      hintParameters.push(knowledgePoint);
    }
    const hints = this.db
      .prepare(
        `SELECT h.id, m.knowledge_point
         FROM hint_events h
         JOIN mistakes m ON m.id = h.mistake_id
         WHERE ${hintClauses.join(" AND ")}`
      )
      .all(...hintParameters);

    const evidenceClauses = [
      "e.created_at >= ?",
      "e.created_at <= ?",
      "e.attempt_id IS NOT NULL",
      "e.next_status != e.previous_status",
      "e.evidence_type NOT IN ('legacy_backfill', 'legacy_seed')",
      "e.rule_version != 'legacy'"
    ];
    const evidenceParameters = [from, to];
    if (knowledgePoint) {
      evidenceClauses.push("m.knowledge_point = ?");
      evidenceParameters.push(knowledgePoint);
    }
    const masteryChanges = this.db
      .prepare(
        `SELECT
          e.id, e.mistake_id, e.attempt_id, e.previous_status,
          e.next_status, e.outcome, e.independent, e.created_at,
          m.knowledge_point, m.question
         FROM mastery_evidence e
         JOIN mistakes m ON m.id = e.mistake_id
         WHERE ${evidenceClauses.join(" AND ")}
         ORDER BY e.created_at ASC, e.id ASC`
      )
      .all(...evidenceParameters)
      .map((row) => ({
        evidenceId: row.id,
        mistakeId: row.mistake_id,
        attemptId: row.attempt_id,
        knowledgePoint: row.knowledge_point,
        question: row.question,
        previousStatus: row.previous_status,
        nextStatus: row.next_status,
        outcome: row.outcome,
        independent:
          row.independent === 1 ? true : row.independent === 0 ? false : null,
        createdAt: row.created_at
      }));

    const legacyEvidence = Number(
      this.db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM mastery_evidence
           WHERE evidence_type IN ('legacy_backfill', 'legacy_seed')
              OR rule_version = 'legacy'`
        )
        .get().count || 0
    );

    const pointStatistics = new Map();
    const ensurePoint = (name) => {
      if (!pointStatistics.has(name)) {
        pointStatistics.set(name, {
          knowledgePoint: name,
          mistakes: 0,
          activeMistakes: 0,
          masteredMistakes: 0,
          relearningMistakes: 0,
          attempts: 0,
          correctAttempts: 0,
          independentCorrectAttempts: 0,
          hintDependentAttempts: 0,
          hints: 0
        });
      }
      return pointStatistics.get(name);
    };

    for (const mistake of mistakes) {
      const point = ensurePoint(mistake.knowledge_point);
      point.mistakes += 1;
      if (mistake.status === "mastered") {
        point.masteredMistakes += 1;
      } else {
        point.activeMistakes += 1;
      }
      if (mistake.status === "relearning") {
        point.relearningMistakes += 1;
      }
    }
    for (const attempt of attempts) {
      const point = ensurePoint(attempt.knowledge_point);
      point.attempts += 1;
      if (attempt.outcome === "correct") point.correctAttempts += 1;
      if (attempt.outcome === "correct" && attempt.independent === 1) {
        point.independentCorrectAttempts += 1;
      }
      if (attempt.independent === 0) point.hintDependentAttempts += 1;
    }
    for (const hint of hints) {
      ensurePoint(hint.knowledge_point).hints += 1;
    }

    const knowledgePoints = [...pointStatistics.values()]
      .map((point) => ({
        ...point,
        mastery: point.mistakes
          ? Math.round((point.masteredMistakes / point.mistakes) * 100)
          : null
      }))
      .sort(
        (a, b) =>
          (a.mastery ?? 101) - (b.mastery ?? 101) ||
          b.activeMistakes - a.activeMistakes
      );

    const correctAttempts = attempts.filter(
      (attempt) => attempt.outcome === "correct"
    ).length;
    const partialAttempts = attempts.filter(
      (attempt) => attempt.outcome === "partial"
    ).length;
    const incorrectAttempts = attempts.filter(
      (attempt) => attempt.outcome === "incorrect"
    ).length;
    const independentAttempts = attempts.filter(
      (attempt) => attempt.independent === 1
    ).length;
    const hintDependentAttempts = attempts.filter(
      (attempt) => attempt.independent === 0
    ).length;
    const unknownDependencyAttempts = attempts.filter(
      (attempt) => attempt.independent !== 0 && attempt.independent !== 1
    ).length;
    const independentCorrectAttempts = attempts.filter(
      (attempt) => attempt.outcome === "correct" && attempt.independent === 1
    ).length;
    const hintDependentCorrectAttempts = attempts.filter(
      (attempt) => attempt.outcome === "correct" && attempt.independent === 0
    ).length;
    const knownDependencyAttempts =
      independentAttempts + hintDependentAttempts;
    const mastered = mistakes.filter(
      (mistake) => mistake.status === "mastered"
    ).length;
    const relearning = mistakes.filter(
      (mistake) => mistake.status === "relearning"
    ).length;
    const toMastered = masteryChanges.filter(
      (change) => change.nextStatus === "mastered"
    ).length;
    const toRelearning = masteryChanges.filter(
      (change) => change.nextStatus === "relearning"
    ).length;

    return {
      period: { from, to },
      policyVersion: LEARNING_POLICY_VERSION,
      totals: {
        mistakes: mistakes.length,
        activeMistakes: mistakes.length - mastered,
        masteredMistakes: mastered,
        relearningMistakes: relearning,
        attempts: attempts.length,
        correctAttempts,
        partialAttempts,
        incorrectAttempts,
        independentCorrectAttempts,
        hintDependentCorrectAttempts,
        hints: hints.length
      },
      rates: {
        accuracy: safeRatio(correctAttempts, attempts.length),
        independentCorrectRate: safeRatio(
          independentCorrectAttempts,
          attempts.length
        ),
        hintDependencyRate: safeRatio(
          hintDependentAttempts,
          knownDependencyAttempts
        ),
        independentAnswerRate: safeRatio(
          independentAttempts,
          knownDependencyAttempts
        )
      },
      dependency: {
        knownAttempts: knownDependencyAttempts,
        independentAttempts,
        hintDependentAttempts,
        unknownAttempts: unknownDependencyAttempts,
        hintEvents: hints.length,
        rateAvailable: knownDependencyAttempts > 0
      },
      masteryChanges: {
        toMastered,
        toRelearning,
        items: masteryChanges
      },
      knowledgePoints,
      dataStatus: {
        hasData:
          mistakes.length > 0 ||
          attempts.length > 0 ||
          hints.length > 0 ||
          masteryChanges.length > 0,
        hasMistakes: mistakes.length > 0,
        hasAttempts: attempts.length > 0,
        hasHints: hints.length > 0,
        hasMasteryChanges: masteryChanges.length > 0,
        hasLegacyEvidence: legacyEvidence > 0,
        dependencyRateAvailable: knownDependencyAttempts > 0
      }
    };
  }

  countDueReviews({ at = nowIso() } = {}) {
    return Number(
      this.db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM mistakes m
           LEFT JOIN review_schedule rs
             ON rs.mistake_id = m.id AND rs.active = 1
           WHERE COALESCE(rs.next_review_at, m.due_at, m.created_at) <= ?`
        )
        .get(at).count || 0
    );
  }

  buildDailySummary({ from, to, knowledgePoint = null, at = null }) {
    const summary = this.buildLearningSummary({ from, to, knowledgePoint });
    const dueCount = this.countDueReviews({ at: at || to });
    const attempts = summary.totals.attempts;
    const hints = summary.totals.hints;
    const independentCorrect = summary.totals.independentCorrectAttempts;
    const sentences = [];
    if (attempts > 0) {
      sentences.push(
        `今天完成 ${attempts} 次作答，其中 ${summary.totals.correctAttempts} 次全部答对。`
      );
    }
    if (independentCorrect > 0) {
      sentences.push(`其中 ${independentCorrect} 次是独立答对。`);
    }
    if (hints > 0) {
      sentences.push(`今天使用了 ${hints} 次提示；提示帮助不计入独立掌握。`);
    }
    if (summary.masteryChanges.toMastered > 0) {
      sentences.push(
        `今天有 ${summary.masteryChanges.toMastered} 道题达到已掌握状态。`
      );
    }
    if (summary.masteryChanges.toRelearning > 0) {
      sentences.push(
        `今天有 ${summary.masteryChanges.toRelearning} 道题回到巩固阶段。`
      );
    }
    if (!attempts && !hints) {
      sentences.push("今天还没有作答或提示记录，暂时不能判断掌握变化。");
    }

    const nextStep =
      dueCount > 0
        ? `接下来可以先复习 ${dueCount} 道到期的题。`
        : attempts > 0
          ? "今天没有到期复习，可以休息一下，明天再巩固。"
          : "先选一道错题独立重做，日总结就会有内容。";

    return {
      ...summary,
      kind: "daily",
      hasData: summary.dataStatus.hasData,
      insufficientData: !summary.dataStatus.hasData,
      dueCount,
      childSummary: {
        headline:
          attempts > 0
            ? `今天完成了 ${attempts} 次作答`
            : hints > 0
              ? `今天有 ${hints} 次提示记录`
              : "今天还没有学习记录",
        sentences,
        nextStep
      },
      limitations: [
        ...(attempts === 0
          ? ["没有作答记录，无法判断今天的掌握变化。"]
          : []),
        ...(!summary.dataStatus.dependencyRateAvailable
          ? ["没有可用于判断独立作答与提示依赖的作答记录。"]
          : []),
        ...(summary.dataStatus.hasLegacyEvidence
          ? ["历史导入的掌握证据不计入今天的掌握变化统计。"]
          : [])
      ]
    };
  }

  buildWeeklyReport({ from, to, knowledgePoint = null, at = null }) {
    const summary = this.buildLearningSummary({ from, to, knowledgePoint });
    const dueCount = this.countDueReviews({ at: at || to });
    const statements = [];
    if (summary.totals.attempts > 0) {
      statements.push({
        text: `本周完成 ${summary.totals.attempts} 次作答，其中 ${summary.totals.correctAttempts} 次全部答对。`,
        basis: { metric: "attempts", value: summary.totals.attempts }
      });
      statements.push({
        text: `独立答对 ${summary.totals.independentCorrectAttempts} 次，提示后答对 ${summary.totals.hintDependentCorrectAttempts} 次。`,
        basis: {
          metric: "independentCorrectAttempts",
          value: summary.totals.independentCorrectAttempts
        }
      });
    }
    if (summary.totals.hints > 0) {
      statements.push({
        text: `本周共使用 ${summary.totals.hints} 次提示。`,
        basis: { metric: "hints", value: summary.totals.hints }
      });
    }
    if (summary.masteryChanges.toMastered > 0) {
      statements.push({
        text: `本周有 ${summary.masteryChanges.toMastered} 道题进入已掌握状态。`,
        basis: {
          metric: "toMastered",
          value: summary.masteryChanges.toMastered
        }
      });
    }
    if (summary.masteryChanges.toRelearning > 0) {
      statements.push({
        text: `本周有 ${summary.masteryChanges.toRelearning} 道题回到巩固阶段。`,
        basis: {
          metric: "toRelearning",
          value: summary.masteryChanges.toRelearning
        }
      });
    }

    return {
      ...summary,
      kind: "weekly",
      hasData: summary.dataStatus.hasData,
      insufficientData: !summary.dataStatus.hasData,
      dueCount,
      parentReport: {
        statements,
        summaryText: statements.map((statement) => statement.text).join(" "),
        limitations: [
          ...(summary.totals.attempts === 0
            ? ["本周没有作答记录，无法判断掌握变化。"]
            : []),
          ...(summary.dependency.knownAttempts > 0 &&
          summary.dependency.knownAttempts < 3
            ? ["本周可用于判断提示依赖的作答少于 3 次，比例仅供事实参考。"]
            : []),
          ...(summary.dependency.knownAttempts === 0
            ? ["本周没有可用于判断提示依赖的作答记录。"]
            : []),
          ...(summary.dataStatus.hasLegacyEvidence
            ? ["历史导入的掌握证据不计入本周掌握变化统计。"]
            : [])
        ],
        knowledgePoints: summary.knowledgePoints,
        masteryChanges: summary.masteryChanges.items
      }
    };
  }

  addDemoData() {
    assertToolWriteAllowed();
    const existing = this.getDashboard().stats.total;
    if (existing > 0) {
      return { added: 0 };
    }

    const samples = [
      {
        question:
          "一件商品原价 240 元，先涨价 20%，再降价 20%。现在的价格是多少元？",
        studentAnswer: "240元",
        correctAnswer: "230.4元",
        analysis:
          "涨价和降价对应的单位“1”不同。应依次计算 240×(1+20%)，再乘 (1-20%)。",
        knowledgePoint: "百分数",
        errorType: "单位“1”找错"
      },
      {
        question:
          "一个圆形花坛的直径是 8 米，在花坛周围修一条宽 1 米的小路。小路的面积是多少平方米？",
        studentAnswer: "28.26平方米",
        correctAnswer: "28.26平方米",
        analysis:
          "先分别求外圆和内圆面积，再用外圆面积减内圆面积。半径要先加 1 米。",
        knowledgePoint: "圆",
        errorType: "半径变化漏算"
      },
      {
        question:
          "把 3/4 升果汁平均倒入 3 个杯子，每杯有多少升？",
        studentAnswer: "9/4升",
        correctAnswer: "1/4升",
        analysis:
          "平均分求每份，应该用总量除以份数，即 3/4÷3。",
        knowledgePoint: "分数乘除法",
        errorType: "乘除法意义混淆"
      },
      {
        question:
          "甲数和乙数的比是 2:3，乙数是 18，甲数是多少？",
        studentAnswer: "27",
        correctAnswer: "12",
        analysis: "乙数对应 3 份，先求每份 18÷3=6，再求甲数 6×2=12。",
        knowledgePoint: "比和比例",
        errorType: "前后项对应反了"
      },
      {
        question:
          "一个圆柱的底面半径是 2 厘米，高是 5 厘米，它的体积是多少立方厘米？（π 取 3.14）",
        studentAnswer: "",
        correctAnswer: "62.8立方厘米",
        analysis: "圆柱体积 V=πr²h，先算 3.14×2×2，再乘高 5。",
        knowledgePoint: "圆柱与圆锥",
        errorType: "不会做"
      }
    ];

    for (const sample of samples) {
      this.createMistake(sample);
    }
    return { added: samples.length };
  }

  close() {
    this.db.close();
  }
}

export function createRepository(filePath) {
  return new LearningRepository(filePath);
}
