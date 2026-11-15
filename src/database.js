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
import {
  defaultAttachmentsDirectory,
  MAX_ATTACHMENTS_PER_MISTAKE,
  MAX_ATTACHMENTS_TOTAL_BYTES
} from "./attachments.js";
import {
  CURRICULUM_MAPPING_VERSION,
  CURRICULUM_POINTS,
  CURRICULUM_SOURCES,
  TEXTBOOK_BY_KEY,
  TEXTBOOK_CATALOGS
} from "./curriculum/catalog.js";

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

const ATTACHMENT_SELECT = `
  SELECT a.*,
         c.storage_key AS crop_storage_key,
         c.mime_type AS crop_mime_type,
         c.byte_size AS crop_byte_size,
         c.width AS crop_width_px,
         c.height AS crop_height_px,
         c.sha256 AS crop_sha256,
         c.crop_x,
         c.crop_y,
         c.crop_width,
         c.crop_height,
         c.rotation,
         c.source_width,
         c.source_height,
         c.updated_at AS crop_updated_at
  FROM attachments a
  LEFT JOIN attachment_crops c ON c.attachment_id = a.id
`;

function mapAttachment(row) {
  if (!row) return null;
  const hasCrop = Boolean(row.crop_storage_key);
  const version = encodeURIComponent(row.crop_updated_at || row.created_at);
  return {
    id: row.id,
    kind: row.kind,
    mimeType: hasCrop ? row.crop_mime_type : row.mime_type,
    byteSize: hasCrop ? row.crop_byte_size : row.byte_size,
    width: hasCrop ? row.crop_width_px : row.width,
    height: hasCrop ? row.crop_height_px : row.height,
    url: `/api/attachments/${row.id}`,
    displayUrl: `/api/attachments/${row.id}?variant=${
      hasCrop ? "crop" : "original"
    }&v=${version}`,
    originalUrl: `/api/attachments/${row.id}?variant=original`,
    hasCrop,
    crop: hasCrop
      ? {
          x: row.crop_x,
          y: row.crop_y,
          width: row.crop_width,
          height: row.crop_height,
          rotation: row.rotation,
          sourceWidth: row.source_width,
          sourceHeight: row.source_height,
          updatedAt: row.crop_updated_at
        }
      : null,
    createdAt: row.created_at
  };
}

function normalizeAttachmentIds(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new LearningValidationError(
      "INVALID_ATTACHMENTS",
      "图片附件列表格式无效"
    );
  }
  const ids = [];
  for (const valueId of value) {
    const id = Number(valueId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new LearningValidationError(
        "INVALID_ATTACHMENTS",
        "图片附件编号无效"
      );
    }
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length > MAX_ATTACHMENTS_PER_MISTAKE) {
    throw new LearningValidationError(
      "TOO_MANY_ATTACHMENTS",
      `每道错题最多添加 ${MAX_ATTACHMENTS_PER_MISTAKE} 张图片`
    );
  }
  return ids;
}

function mapMistake(row, { includeSolution = false } = {}) {
  if (!row) return null;
  const mistake = {
    id: row.id,
    question: row.question,
    studentAnswer: row.student_answer,
    knowledgePoint: row.knowledge_point,
    textbookId: row.textbook_id ?? null,
    curriculumPointId: row.curriculum_point_id ?? null,
    curriculumStatus: row.curriculum_status || "legacy",
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

function mapTextbook(row) {
  if (!row) return null;
  return {
    id: row.id,
    textbookKey: row.textbook_key,
    editionKey: row.edition_key,
    publisher: row.publisher,
    edition: row.edition,
    grade: row.grade,
    semester: row.semester,
    displayName: row.display_name,
    selectable: row.selectable === 1,
    reviewStatus: row.review_status,
    sourceKey: row.source_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapCurriculumPoint(row) {
  if (!row) return null;
  return {
    id: row.id,
    textbookId: row.textbook_id,
    unitId: row.unit_id,
    unitNo: row.unit_no,
    unitTitle: row.unit_title,
    name: row.name,
    slug: row.slug,
    aliases: parseJson(row.aliases_json),
    semanticKeys: parseJson(row.semantic_keys_json),
    sourceKnowledgeSlug: row.source_knowledge_slug,
    position: row.position,
    reviewStatus: row.review_status,
    sourceKey: row.source_key,
    contentVersion: row.content_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapCurriculumMapping(row) {
  if (!row) return null;
  return {
    id: row.id,
    mappingVersion: row.mapping_version,
    sourceTextbookId: row.source_textbook_id,
    targetTextbookId: row.target_textbook_id,
    sourcePointId: row.source_point_id,
    targetPointId: row.target_point_id,
    status: row.status,
    requiresConfirmation: row.requires_confirmation === 1,
    confidence: row.confidence,
    note: row.note,
    sourcePointName: row.source_point_name || "",
    targetPointName: row.target_point_name || "",
    targetUnitTitle: row.target_unit_title || ""
  };
}

function slugToken(value) {
  const normalized = String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || createHash("sha1").update(String(value || "")).digest("hex").slice(0, 12);
}

function localDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dayRangeForKey(key) {
  const [year, month, day] = key.split("-").map(Number);
  const start = new Date(year, month - 1, day);
  const end = new Date(year, month - 1, day + 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function withTextbookScope(report, textbook, note = "按当时教材") {
  if (!textbook) return report;
  return {
    ...report,
    textbookScope: {
      textbookId: textbook.id,
      label: textbook.displayName,
      semester: textbook.semester,
      grade: textbook.grade,
      note
    }
  };
}

function curriculumValidationError(code, message, status = 400) {
  const error = new LearningValidationError(code, message);
  error.status = status;
  return error;
}

export class LearningRepository {
  constructor(filePath = ":memory:", { attachmentDirectory } = {}) {
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
    this.attachmentDirectory = attachmentDirectory
      ? path.resolve(attachmentDirectory)
      : defaultAttachmentsDirectory(filePath);

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
      this.syncCurriculum();
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
    const escapedBackupPath = backupPath.replaceAll("'", "''");
    this.db.exec(`VACUUM INTO '${escapedBackupPath}'`);

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

  getStudent(studentId = null) {
    const row = studentId
      ? this.db
          .prepare(
            `SELECT id, name, grade, textbook_id, textbook_selected_at
             FROM students WHERE id = ?`
          )
          .get(studentId)
      : this.db
          .prepare(
            `SELECT id, name, grade, textbook_id, textbook_selected_at
             FROM students ORDER BY id LIMIT 1`
          )
          .get();
    if (!row) return null;
    const textbook = this.getTextbook(row.textbook_id);
    return {
      id: row.id,
      name: row.name,
      grade: row.grade,
      textbookId: row.textbook_id,
      textbookSelectedAt: row.textbook_selected_at,
      textbook
    };
  }

  getKnowledgePoints() {
    return this.db
      .prepare("SELECT id, name FROM knowledge_points ORDER BY position, id")
      .all();
  }

  getKnowledgePoint(name, studentId = null) {
    const student = this.getStudent(studentId);
    const textbook = student?.textbook;
    if (textbook) {
      const point = this.resolveCurriculumPointByName(textbook.id, name);
      if (point) {
        return {
          id: point.id,
          name: point.name,
          position: point.position,
          curriculumPointId: point.id,
          textbookId: textbook.id
        };
      }
    }
    return (
      this.db
        .prepare(
          "SELECT id, name, position FROM knowledge_points WHERE name = ?"
        )
        .get(name) || null
    );
  }

  insertAttachment(input) {
    const timestamp = input.createdAt || nowIso();
    const result = this.db
      .prepare(
        `INSERT INTO attachments (
          mistake_id, kind, storage_key, mime_type, byte_size, width, height,
          sha256, original_name, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.mistakeId ?? null,
        input.kind || "question",
        input.storageKey,
        input.mimeType,
        input.byteSize,
        input.width,
        input.height,
        input.sha256,
        input.originalName || "",
        timestamp
      );
    return this.getAttachment(Number(result.lastInsertRowid));
  }

  getAttachment(id, { includeStorageKey = false } = {}) {
    const row = this.db
      .prepare(`${ATTACHMENT_SELECT} WHERE a.id = ?`)
      .get(id);
    if (!row) return null;
    if (!includeStorageKey) return mapAttachment(row);
    return {
      ...mapAttachment(row),
      mistakeId: row.mistake_id,
      storageKey: row.storage_key,
      sha256: row.sha256,
      originalMimeType: row.mime_type,
      originalByteSize: row.byte_size,
      originalWidth: row.width,
      originalHeight: row.height,
      cropStorageKey: row.crop_storage_key || null,
      cropMimeType: row.crop_mime_type || null,
      cropSha256: row.crop_sha256 || null
    };
  }

  listMistakeAttachments(mistakeId) {
    return this.db
      .prepare(
        `${ATTACHMENT_SELECT}
         WHERE a.mistake_id = ?
         ORDER BY a.created_at, a.id`
      )
      .all(mistakeId)
      .map(mapAttachment);
  }

  getReferencedAttachmentKeys() {
    return this.db
      .prepare(
        `SELECT storage_key FROM attachments
         UNION
         SELECT storage_key FROM attachment_crops
         ORDER BY storage_key`
      )
      .all()
      .map((row) => row.storage_key);
  }

  deleteStaleUnboundAttachments(cutoffIso) {
    const rows = this.db
      .prepare(
        `SELECT a.id, a.storage_key, c.storage_key AS crop_storage_key
         FROM attachments a
         LEFT JOIN attachment_crops c ON c.attachment_id = a.id
         WHERE a.mistake_id IS NULL AND a.created_at < ?`
      )
      .all(cutoffIso);
    const remove = this.db.prepare(
      "DELETE FROM attachments WHERE id = ? AND mistake_id IS NULL"
    );
    for (const row of rows) remove.run(row.id);
    return rows.flatMap((row) =>
      [row.storage_key, row.crop_storage_key].filter(Boolean)
    );
  }

  saveAttachmentCrop(input) {
    const attachment = this.db
      .prepare("SELECT id FROM attachments WHERE id = ?")
      .get(input.attachmentId);
    if (!attachment) {
      throw new LearningValidationError(
        "ATTACHMENT_NOT_FOUND",
        "没有找到这张题目图片"
      );
    }
    const previous = this.db
      .prepare(
        "SELECT storage_key FROM attachment_crops WHERE attachment_id = ?"
      )
      .get(input.attachmentId);
    const timestamp = input.updatedAt || nowIso();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO attachment_crops (
            attachment_id, storage_key, mime_type, byte_size, width, height,
            sha256, crop_x, crop_y, crop_width, crop_height, rotation,
            source_width, source_height, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(attachment_id) DO UPDATE SET
            storage_key = excluded.storage_key,
            mime_type = excluded.mime_type,
            byte_size = excluded.byte_size,
            width = excluded.width,
            height = excluded.height,
            sha256 = excluded.sha256,
            crop_x = excluded.crop_x,
            crop_y = excluded.crop_y,
            crop_width = excluded.crop_width,
            crop_height = excluded.crop_height,
            rotation = excluded.rotation,
            source_width = excluded.source_width,
            source_height = excluded.source_height,
            updated_at = excluded.updated_at`
        )
        .run(
          input.attachmentId,
          input.storageKey,
          input.mimeType,
          input.byteSize,
          input.width,
          input.height,
          input.sha256,
          input.cropX,
          input.cropY,
          input.cropWidth,
          input.cropHeight,
          input.rotation,
          input.sourceWidth,
          input.sourceHeight,
          input.createdAt || timestamp,
          timestamp
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return {
      attachment: this.getAttachment(input.attachmentId, {
        includeStorageKey: true
      }),
      previousStorageKey: previous?.storage_key || null
    };
  }

  getAttachmentCrop(attachmentId) {
    return (
      this.db
        .prepare("SELECT * FROM attachment_crops WHERE attachment_id = ?")
        .get(attachmentId) || null
    );
  }

  deleteAttachmentCrop(attachmentId) {
    const row = this.getAttachmentCrop(attachmentId);
    if (!row) return { deleted: false, storageKey: null };
    this.db
      .prepare("DELETE FROM attachment_crops WHERE attachment_id = ?")
      .run(attachmentId);
    return { deleted: true, storageKey: row.storage_key };
  }

  saveAttachmentExtraction(input) {
    const result = this.db
      .prepare(
        `INSERT INTO attachment_extractions (
          attachment_id, raw_output, normalized_text, confidence, provider,
          model, prompt_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.attachmentId,
        input.rawOutput || "",
        input.normalizedText || "",
        input.confidence ?? null,
        input.provider || "",
        input.model || "",
        input.promptVersion || "",
        input.createdAt || nowIso()
      );
    return Number(result.lastInsertRowid);
  }

  getLatestAttachmentExtraction(attachmentId) {
    return (
      this.db
        .prepare(
          `SELECT * FROM attachment_extractions
           WHERE attachment_id = ?
           ORDER BY id DESC LIMIT 1`
        )
        .get(attachmentId) || null
    );
  }

  deleteUnboundAttachment(id) {
    const row = this.db
      .prepare(
        `SELECT a.id, a.mistake_id, a.storage_key,
                c.storage_key AS crop_storage_key
         FROM attachments a
         LEFT JOIN attachment_crops c ON c.attachment_id = a.id
         WHERE a.id = ?`
      )
      .get(id);
    if (!row) return { deleted: false, missing: true, bound: false };
    if (row.mistake_id !== null) {
      return { deleted: false, missing: false, bound: true };
    }
    this.db.prepare("DELETE FROM attachments WHERE id = ?").run(id);
    return {
      deleted: true,
      missing: false,
      bound: false,
      storageKey: row.storage_key,
      storageKeys: [row.storage_key, row.crop_storage_key].filter(Boolean)
    };
  }

  validateAttachmentSelection(attachmentIds, { mistakeId = null } = {}) {
    const ids = normalizeAttachmentIds(attachmentIds);
    const find = this.db.prepare(
      "SELECT id, mistake_id, byte_size, storage_key FROM attachments WHERE id = ?"
    );
    const rows = [];
    let totalBytes = 0;
    for (const id of ids) {
      const row = find.get(id);
      if (!row) {
        throw new LearningValidationError(
          "ATTACHMENT_NOT_FOUND",
          "题目图片不存在或已失效，请重新上传"
        );
      }
      if (row.mistake_id !== null && row.mistake_id !== mistakeId) {
        throw new LearningValidationError(
          "ATTACHMENT_ALREADY_BOUND",
          "这张图片已关联到其他错题"
        );
      }
      totalBytes += Number(row.byte_size || 0);
      rows.push(row);
    }
    if (totalBytes > MAX_ATTACHMENTS_TOTAL_BYTES) {
      throw new LearningValidationError(
        "ATTACHMENTS_TOO_LARGE",
        "这道题的图片总大小不能超过 30 MB"
      );
    }
    return rows;
  }

  bindNewAttachments(mistakeId, attachmentIds, timestamp) {
    const rows = this.validateAttachmentSelection(attachmentIds);
    const update = this.db.prepare(
      `UPDATE attachments
       SET mistake_id = ?
       WHERE id = ? AND mistake_id IS NULL`
    );
    for (const row of rows) {
      const result = update.run(mistakeId, row.id);
      if (result.changes !== 1) {
        throw new LearningValidationError(
          "ATTACHMENT_ALREADY_BOUND",
          "图片已被其他错题使用，请重新上传"
        );
      }
    }
    return rows.length;
  }

  replaceMistakeAttachments(mistakeId, attachmentIds) {
    const proposedIds = normalizeAttachmentIds(attachmentIds);
    const currentRows = this.db
      .prepare(
        `SELECT a.id, a.storage_key, c.storage_key AS crop_storage_key
         FROM attachments a
         LEFT JOIN attachment_crops c ON c.attachment_id = a.id
         WHERE a.mistake_id = ?
         ORDER BY a.id`
      )
      .all(mistakeId);
    const currentIds = currentRows.map((row) => row.id);
    const proposedRows = this.validateAttachmentSelection(proposedIds, {
      mistakeId
    });
    const removed = currentRows.filter((row) => !proposedIds.includes(row.id));
    const added = proposedRows.filter((row) => !currentIds.includes(row.id));
    const remove = this.db.prepare("DELETE FROM attachments WHERE id = ?");
    for (const row of removed) remove.run(row.id);
    this.bindNewAttachments(mistakeId, added.map((row) => row.id), nowIso());
    return {
      changed:
        removed.length > 0 ||
        added.length > 0 ||
        proposedIds.length !== currentIds.length,
      removedStorageKeys: removed.flatMap((row) =>
        [row.storage_key, row.crop_storage_key].filter(Boolean)
      )
    };
  }

  removeAttachmentFiles(storageKeys) {
    if (!this.attachmentDirectory) return;
    for (const storageKey of new Set(storageKeys || [])) {
      if (!/^[a-f0-9-]{36}\.(?:jpg|png|webp)$/.test(storageKey)) continue;
      try {
        fs.unlinkSync(path.join(this.attachmentDirectory, storageKey));
      } catch (error) {
        if (error.code !== "ENOENT") {
          // Files are best-effort; startup GC handles persistent failures.
        }
      }
    }
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

  syncCurriculum() {
    const timestamp = nowIso();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const insertSource = this.db.prepare(`
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
      for (const source of CURRICULUM_SOURCES) {
        insertSource.run(
          source.key,
          source.kind,
          source.title,
          source.publisher,
          source.edition,
          source.locator,
          source.note,
          source.verifiedAt,
          timestamp,
          timestamp
        );
      }

      const upsertTextbook = this.db.prepare(`
        INSERT INTO textbooks (
          textbook_key, edition_key, publisher, edition, grade, semester,
          display_name, selectable, review_status, source_key,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(textbook_key) DO UPDATE SET
          edition_key = excluded.edition_key,
          publisher = excluded.publisher,
          edition = excluded.edition,
          grade = excluded.grade,
          semester = excluded.semester,
          display_name = excluded.display_name,
          selectable = excluded.selectable,
          review_status = excluded.review_status,
          source_key = excluded.source_key,
          updated_at = excluded.updated_at
      `);
      const upsertUnit = this.db.prepare(`
        INSERT INTO textbook_units (
          textbook_id, unit_no, title, position, review_status, source_key,
          note, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, '', ?, ?)
        ON CONFLICT(textbook_id, unit_no) DO UPDATE SET
          title = excluded.title,
          position = excluded.position,
          review_status = excluded.review_status,
          source_key = excluded.source_key,
          updated_at = excluded.updated_at
      `);
      const upsertPoint = this.db.prepare(`
        INSERT INTO curriculum_points (
          textbook_id, unit_id, name, slug, aliases_json, semantic_keys_json,
          source_knowledge_slug, position, review_status, source_key,
          content_version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(textbook_id, name) DO UPDATE SET
          unit_id = excluded.unit_id,
          slug = excluded.slug,
          aliases_json = excluded.aliases_json,
          semantic_keys_json = excluded.semantic_keys_json,
          source_knowledge_slug = excluded.source_knowledge_slug,
          position = excluded.position,
          review_status = excluded.review_status,
          source_key = excluded.source_key,
          content_version = excluded.content_version,
          updated_at = excluded.updated_at
      `);

      for (const textbook of TEXTBOOK_CATALOGS) {
        upsertTextbook.run(
          textbook.key,
          textbook.editionKey,
          textbook.publisher,
          textbook.edition,
          textbook.grade,
          textbook.semester,
          textbook.displayName,
          textbook.selectable ? 1 : 0,
          textbook.reviewStatus,
          textbook.sourceKey,
          timestamp,
          timestamp
        );
        const textbookRow = this.db
          .prepare("SELECT id FROM textbooks WHERE textbook_key = ?")
          .get(textbook.key);
        for (const entry of textbook.units) {
          upsertUnit.run(
            textbookRow.id,
            entry.unitNo,
            entry.title,
            entry.unitNo,
            textbook.reviewStatus,
            textbook.sourceKey,
            timestamp,
            timestamp
          );
          const unitRow = this.db
            .prepare(
              "SELECT id FROM textbook_units WHERE textbook_id = ? AND unit_no = ?"
            )
            .get(textbookRow.id, entry.unitNo);
          entry.points.forEach((point, index) => {
            const slug = `${textbook.key}-${slugToken(point.sourceKnowledgeSlug || point.name)}-${entry.unitNo}-${index + 1}`;
            upsertPoint.run(
              textbookRow.id,
              unitRow.id,
              point.name,
              slug,
              JSON.stringify(point.aliases || []),
              JSON.stringify(point.semanticKeys || []),
              point.sourceKnowledgeSlug || null,
              entry.unitNo * 100 + index + 1,
              textbook.reviewStatus,
              textbook.sourceKey,
              KNOWLEDGE_CONTENT_VERSION,
              timestamp,
              timestamp
            );
          });
        }
      }

      const legacyTextbook = this.db
        .prepare("SELECT id FROM textbooks WHERE textbook_key = ?")
        .get("renjiao-6-all");
      this.db
        .prepare(
          `UPDATE students
           SET textbook_id = COALESCE(textbook_id, ?),
               textbook_selected_at = COALESCE(textbook_selected_at, ?)`
        )
        .run(legacyTextbook.id, timestamp);
      this.db
        .prepare(
          `UPDATE mistakes
           SET textbook_id = (
             SELECT s.textbook_id FROM students s WHERE s.id = mistakes.student_id
           )
           WHERE textbook_id IS NULL`
        )
        .run();

      const pendingMistakes = this.db
        .prepare(
          `SELECT m.id, m.textbook_id, m.knowledge_point
           FROM mistakes m
           WHERE m.textbook_id IS NOT NULL
             AND (m.curriculum_point_id IS NULL OR m.curriculum_status = 'legacy')`
        )
        .all();
      const pointByName = this.db.prepare(
        "SELECT id FROM curriculum_points WHERE textbook_id = ? AND name = ?"
      );
      const updateMistakeCurriculum = this.db.prepare(
        `UPDATE mistakes
         SET curriculum_point_id = ?, curriculum_status = ?, updated_at = updated_at
         WHERE id = ?`
      );
      for (const mistake of pendingMistakes) {
        const point = pointByName.get(
          mistake.textbook_id,
          mistake.knowledge_point
        );
        updateMistakeCurriculum.run(
          point?.id ?? null,
          point ? "mapped" : "unmapped",
          mistake.id
        );
      }

      this.generateCurriculumMappings(timestamp);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  generateCurriculumMappings(timestamp = nowIso()) {
    this.db
      .prepare("DELETE FROM curriculum_mappings WHERE mapping_version = ?")
      .run(CURRICULUM_MAPPING_VERSION);
    const textbooks = this.db
      .prepare("SELECT * FROM textbooks ORDER BY id")
      .all();
    const rows = this.db
      .prepare(
        `SELECT p.*, u.unit_no, u.title AS unit_title
         FROM curriculum_points p
         JOIN textbook_units u ON u.id = p.unit_id
         ORDER BY p.textbook_id, p.position, p.id`
      )
      .all();
    const pointsByTextbook = new Map();
    for (const row of rows) {
      const list = pointsByTextbook.get(row.textbook_id) || [];
      list.push({
        ...row,
        semanticKeys: new Set(parseJson(row.semantic_keys_json))
      });
      pointsByTextbook.set(row.textbook_id, list);
    }
    const insertMapping = this.db.prepare(`
      INSERT INTO curriculum_mappings (
        mapping_version, source_textbook_id, target_textbook_id,
        source_point_id, target_point_id, status, requires_confirmation,
        confidence, note, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const sourceTextbook of textbooks) {
      for (const targetTextbook of textbooks) {
        if (sourceTextbook.id === targetTextbook.id) continue;
        const sourcePoints = pointsByTextbook.get(sourceTextbook.id) || [];
        const targetPoints = pointsByTextbook.get(targetTextbook.id) || [];
        const matchesBySource = new Map();
        const incomingCount = new Map();
        for (const sourcePoint of sourcePoints) {
          const matches = targetPoints.filter((targetPoint) =>
            [...sourcePoint.semanticKeys].some((key) =>
              targetPoint.semanticKeys.has(key)
            )
          );
          matchesBySource.set(sourcePoint.id, matches);
          for (const match of matches) {
            incomingCount.set(match.id, (incomingCount.get(match.id) || 0) + 1);
          }
        }

        for (const sourcePoint of sourcePoints) {
          const matches = matchesBySource.get(sourcePoint.id) || [];
          if (!matches.length) {
            insertMapping.run(
              CURRICULUM_MAPPING_VERSION,
              sourceTextbook.id,
              targetTextbook.id,
              sourcePoint.id,
              null,
              "uncovered",
              0,
              0,
              "目标教材没有对应知识点，切换后标记为当前教材未覆盖/待归类。",
              timestamp
            );
            continue;
          }

          const coveredKeys = new Set(
            matches.flatMap((match) => [...match.semanticKeys])
          );
          const allSourceKeysCovered = [...sourcePoint.semanticKeys].every(
            (key) => coveredKeys.has(key)
          );
          for (const match of matches) {
            let status;
            if (matches.length > 1 || !allSourceKeysCovered) {
              status = "split";
            } else if ((incomingCount.get(match.id) || 0) > 1) {
              status = "merged";
            } else if (match.name === sourcePoint.name) {
              status = "exact";
            } else {
              status = "renamed";
            }
            const confidence =
              status === "exact"
                ? 1
                : status === "renamed"
                  ? 0.95
                  : status === "merged"
                    ? 0.9
                    : 0.7;
            const note =
              status === "split"
                ? "知识点在目标教材中拆分或跨单元，需要本次人工确认。"
                : status === "merged"
                  ? "多个来源知识点合并到目标教材同一知识点。"
                  : status === "renamed"
                    ? "目标教材使用不同名称，按映射表自动对应。"
                    : "目标教材知识点名称一致，自动对应。";
            insertMapping.run(
              CURRICULUM_MAPPING_VERSION,
              sourceTextbook.id,
              targetTextbook.id,
              sourcePoint.id,
              match.id,
              status,
              status === "split" ? 1 : 0,
              confidence,
              note,
              timestamp
            );
          }
        }
      }
    }
  }

  getTextbooks({ selectable = false } = {}) {
    const where = selectable ? "WHERE selectable = 1" : "";
    return this.db
      .prepare(`SELECT * FROM textbooks ${where} ORDER BY id`)
      .all()
      .map(mapTextbook);
  }

  getTextbook(identifier) {
    if (identifier === null || identifier === undefined || identifier === "") {
      return null;
    }
    const row = /^\d+$/.test(String(identifier))
      ? this.db.prepare("SELECT * FROM textbooks WHERE id = ?").get(Number(identifier))
      : this.db
          .prepare("SELECT * FROM textbooks WHERE textbook_key = ?")
          .get(String(identifier));
    return mapTextbook(row);
  }

  getCurriculumPoints(textbookId) {
    return this.db
      .prepare(
        `SELECT p.*, u.unit_no, u.title AS unit_title
         FROM curriculum_points p
         JOIN textbook_units u ON u.id = p.unit_id
         WHERE p.textbook_id = ?
         ORDER BY p.position, p.id`
      )
      .all(textbookId)
      .map(mapCurriculumPoint);
  }

  getCurriculumPoint(textbookId, identifier) {
    if (identifier === null || identifier === undefined || identifier === "") {
      return null;
    }
    const value = String(identifier);
    const row = this.db
      .prepare(
        `SELECT p.*, u.unit_no, u.title AS unit_title
         FROM curriculum_points p
         JOIN textbook_units u ON u.id = p.unit_id
         WHERE p.textbook_id = ?
           AND (p.id = ? OR p.slug = ? OR p.name = ?)
         ORDER BY p.id
         LIMIT 1`
      )
      .get(
        textbookId,
        /^\d+$/.test(value) ? Number(value) : -1,
        value,
        value
      );
    return mapCurriculumPoint(row);
  }

  resolveCurriculumPointByName(textbookId, name) {
    const value = String(name || "").trim();
    if (!value) return null;
    const exact = this.getCurriculumPoint(textbookId, value);
    if (exact) return exact;
    return (
      this.getCurriculumPoints(textbookId).find((point) =>
        point.aliases.includes(value)
      ) || null
    );
  }

  resolveDiagnosisKnowledgePoint(knowledgePoint, student = this.getStudent()) {
    const textbook = student?.textbook;
    const requested = String(knowledgePoint || "").trim();
    if (!textbook || !requested) return null;
    const point = this.resolveCurriculumPointByName(textbook.id, requested);
    if (!point) return null;
    const source = point.sourceKnowledgeSlug
      ? CURRICULUM_POINTS.find(
          (candidate) =>
            candidate.textbookKey === "renjiao-6-all" &&
            candidate.slug === point.sourceKnowledgeSlug
        )
      : null;
    return { point, diagnosisName: source?.name || point.name };
  }

  buildCurriculumAwareDiagnosis(input, student = this.getStudent()) {
    const resolved = this.resolveDiagnosisKnowledgePoint(
      input.knowledgePoint,
      student
    );
    const diagnosis = buildMistakeDiagnosis({
      ...input,
      knowledgePoint: resolved?.diagnosisName || input.knowledgePoint
    });
    if (!resolved) return { diagnosis, resolvedPoint: null };
    diagnosis.knowledgePoint = resolved.point.name;
    if (!resolved.point.sourceKnowledgeSlug) {
      diagnosis.hint = `这个知识点（${resolved.point.name}）的讲解内容还在教师审核中。先回到教材例题，标出已知条件和要求，再独立写出第一步。`;
      diagnosis.methodSteps = [
        "读题并标出已知条件",
        "对照教材例题确定第一步",
        "完成后检查单位与答案是否合理"
      ];
      diagnosis.commonErrors = ["没有先梳理已知条件", "跳步计算"];
      diagnosis.diagnosis = `初步归因：${diagnosis.errorType}。该知识点属于教材新增编排，知识讲解待教师审核；先按教材例题梳理条件与第一步。`;
    }
    return { diagnosis, resolvedPoint: resolved.point };
  }

  getCurriculumUnits(textbookId) {
    return this.db
      .prepare(
        `SELECT id, unit_no, title, position, review_status, source_key
         FROM textbook_units
         WHERE textbook_id = ?
         ORDER BY position, id`
      )
      .all(textbookId)
      .map((row) => ({
        id: row.id,
        unitNo: row.unit_no,
        title: row.title,
        position: row.position,
        reviewStatus: row.review_status,
        sourceKey: row.source_key
      }));
  }

  getCurriculumMappingRows(sourceTextbookId, targetTextbookId) {
    return this.db
      .prepare(
        `SELECT m.*, sp.name AS source_point_name,
                tp.name AS target_point_name,
                tu.title AS target_unit_title
         FROM curriculum_mappings m
         JOIN curriculum_points sp ON sp.id = m.source_point_id
         LEFT JOIN curriculum_points tp ON tp.id = m.target_point_id
         LEFT JOIN textbook_units tu ON tu.id = tp.unit_id
         WHERE m.mapping_version = ?
           AND m.source_textbook_id = ?
           AND m.target_textbook_id = ?
         ORDER BY sp.position, m.id`
      )
      .all(
        CURRICULUM_MAPPING_VERSION,
        sourceTextbookId,
        targetTextbookId
      )
      .map(mapCurriculumMapping);
  }

  getCurriculumMappingTable(sourceTextbookId, targetTextbookId) {
    const rows = this.getCurriculumMappingRows(
      sourceTextbookId,
      targetTextbookId
    );
    const grouped = new Map();
    for (const row of rows) {
      const key = row.sourcePointId;
      if (!grouped.has(key)) {
        grouped.set(key, {
          sourcePointId: row.sourcePointId,
          sourcePointName: row.sourcePointName,
          status: row.status,
          requiresConfirmation: row.requiresConfirmation,
          mappings: []
        });
      }
      const group = grouped.get(key);
      if (row.targetPointId) {
        group.mappings.push({
          id: row.id,
          targetPointId: row.targetPointId,
          targetPointName: row.targetPointName,
          targetUnitTitle: row.targetUnitTitle,
          status: row.status,
          requiresConfirmation: row.requiresConfirmation,
          confidence: row.confidence,
          note: row.note
        });
      }
    }
    return [...grouped.values()];
  }

  getCurriculumBaseData(studentId = null) {
    const student = this.getStudent(studentId);
    const textbook = student?.textbook;
    return {
      student,
      currentTextbook: textbook,
      textbooks: this.getTextbooks({ selectable: true }),
      mappingVersion: CURRICULUM_MAPPING_VERSION,
      units: textbook ? this.getCurriculumUnits(textbook.id) : [],
      knowledgePoints: textbook
        ? this.getCurriculumPoints(textbook.id)
        : this.getKnowledgePoints()
    };
  }

  getUnmappedCurriculumMistakes(studentId = null) {
    const student = this.getStudent(studentId);
    if (!student) return [];
    const rows = this.db
      .prepare(
        `SELECT id FROM mistakes
         WHERE student_id = ?
           AND curriculum_status IN ('unmapped', 'needs_confirmation')
         ORDER BY id DESC`
      )
      .all(student.id);
    return rows
      .map((row) => this.getMistake(row.id))
      .filter(Boolean)
      .map((mistake) => ({
        id: mistake.id,
        question: mistake.question,
        knowledgePoint: mistake.knowledgePoint,
        curriculumStatus: mistake.curriculumStatus,
        attachments: mistake.attachments
      }));
  }

  getCurriculumPointById(id) {
    if (!id) return null;
    const row = this.db
      .prepare(
        `SELECT p.*, u.unit_no, u.title AS unit_title
         FROM curriculum_points p
         JOIN textbook_units u ON u.id = p.unit_id
         WHERE p.id = ?`
      )
      .get(id);
    return mapCurriculumPoint(row);
  }

  getLatestCurriculumRestoration({
    mistakeId,
    studentId = null,
    currentTextbookId,
    targetTextbookId,
    currentPointId
  }) {
    const clauses = ["i.mistake_id = ?"];
    const parameters = [mistakeId];
    if (studentId) {
      clauses.push("l.student_id = ?");
      parameters.push(studentId);
    }
    const rows = this.db
      .prepare(
        `SELECT i.before_textbook_id, i.before_curriculum_point_id,
                i.before_knowledge_point, i.after_textbook_id,
                i.after_curriculum_point_id
         FROM curriculum_switch_items i
         JOIN curriculum_switch_logs l ON l.id = i.switch_log_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY i.id DESC`
      )
      .all(...parameters);
    let textbookId = currentTextbookId;
    let pointId = currentPointId ?? null;
    for (const row of rows) {
      if (
        row.after_textbook_id !== textbookId ||
        (row.after_curriculum_point_id ?? null) !== pointId
      ) {
        continue;
      }
      textbookId = row.before_textbook_id;
      pointId = row.before_curriculum_point_id ?? null;
      if (textbookId === targetTextbookId) {
        return {
          before_curriculum_point_id: pointId,
          before_knowledge_point: row.before_knowledge_point
        };
      }
    }
    return null;
  }

  getHistoricalReportDayCount(studentId) {
    const student = this.getStudent(studentId);
    if (!student) return 0;
    const rows = this.db
      .prepare(
        `SELECT m.created_at AS created_at FROM mistakes m WHERE m.student_id = ?
         UNION ALL
         SELECT a.created_at FROM attempts a
           JOIN mistakes m ON m.id = a.mistake_id WHERE m.student_id = ?
         UNION ALL
         SELECT h.created_at FROM hint_events h
           JOIN mistakes m ON m.id = h.mistake_id WHERE m.student_id = ?
         UNION ALL
         SELECT e.created_at FROM mastery_evidence e
           JOIN mistakes m ON m.id = e.mistake_id WHERE m.student_id = ?`
      )
      .all(student.id, student.id, student.id, student.id);
    return new Set(
      rows
        .map((row) => row.created_at)
        .filter(Boolean)
        .map((value) => localDateKey(value))
    ).size;
  }

  getMistakeImpactCounts(mistakeIds) {
    if (!mistakeIds.length) {
      return {
        attachments: 0,
        attempts: 0,
        hintEvents: 0,
        masteryEvidence: 0,
        activeReviews: 0
      };
    }
    const placeholders = mistakeIds.map(() => "?").join(",");
    const scalar = (sql) =>
      Number(this.db.prepare(sql).get(...mistakeIds).count || 0);
    return {
      attachments: scalar(
        `SELECT COUNT(*) AS count FROM attachments WHERE mistake_id IN (${placeholders})`
      ),
      attempts: scalar(
        `SELECT COUNT(*) AS count FROM attempts WHERE mistake_id IN (${placeholders})`
      ),
      hintEvents: scalar(
        `SELECT COUNT(*) AS count FROM hint_events WHERE mistake_id IN (${placeholders})`
      ),
      masteryEvidence: scalar(
        `SELECT COUNT(*) AS count FROM mastery_evidence WHERE mistake_id IN (${placeholders})`
      ),
      activeReviews: scalar(
        `SELECT COUNT(*) AS count FROM review_schedule WHERE active = 1 AND mistake_id IN (${placeholders})`
      )
    };
  }

  buildCurriculumSwitchPreview({
    studentId = null,
    targetTextbookId,
    mappingChoices = {}
  } = {}) {
    const student = this.getStudent(studentId);
    if (!student) {
      throw curriculumValidationError("STUDENT_NOT_FOUND", "没有找到当前学生", 404);
    }
    const fromTextbook = student.textbook;
    const targetTextbook = this.getTextbook(targetTextbookId);
    if (!targetTextbook) {
      throw curriculumValidationError(
        "TEXTBOOK_NOT_FOUND",
        "没有找到目标教材",
        404
      );
    }
    if (!fromTextbook) {
      throw curriculumValidationError(
        "CURRENT_TEXTBOOK_MISSING",
        "当前学生还没有教材记录，请先完成数据迁移",
        409
      );
    }
    const mistakes = this.db
      .prepare(
        `SELECT * FROM mistakes WHERE student_id = ? ORDER BY id`
      )
      .all(student.id);
    const fromPoints = this.getCurriculumPoints(fromTextbook.id);
    const fromById = new Map(fromPoints.map((point) => [point.id, point]));
    const fromByName = new Map(fromPoints.map((point) => [point.name, point]));
    const targetPoints = this.getCurriculumPoints(targetTextbook.id);
    const targetById = new Map(targetPoints.map((point) => [point.id, point]));
    const mappingTable = this.getCurriculumMappingTable(
      fromTextbook.id,
      targetTextbook.id
    );
    const mappingBySource = new Map(
      mappingTable.map((group) => [group.sourcePointId, group])
    );

    const items = mistakes.map((mistake) => {
      let sourcePoint = mistake.curriculum_point_id
        ? fromById.get(mistake.curriculum_point_id)
        : null;
      if (!sourcePoint) {
        sourcePoint = fromByName.get(mistake.knowledge_point) || null;
      }
      const mapping = sourcePoint
        ? mappingBySource.get(sourcePoint.id)
        : null;
      const mappingTargets = mapping?.mappings || [];
      const restoration = this.getLatestCurriculumRestoration({
        mistakeId: mistake.id,
        studentId: student.id,
        currentTextbookId: fromTextbook.id,
        targetTextbookId: targetTextbook.id,
        currentPointId: sourcePoint?.id || null
      });
      const restoredPoint = restoration?.before_curriculum_point_id
        ? targetById.get(restoration.before_curriculum_point_id)
        : null;
      const resolutionKey = sourcePoint
        ? String(sourcePoint.id)
        : `mistake:${mistake.id}`;
      const explicitChoice = Object.hasOwn(mappingChoices, resolutionKey)
        ? mappingChoices[resolutionKey]
        : undefined;
      const candidateTarget = restoredPoint || mappingTargets[0]?.targetPointId
        ? targetById.get(
            restoredPoint?.id || mappingTargets[0]?.targetPointId
          )
        : null;
      const chosenTarget =
        explicitChoice !== undefined
          ? explicitChoice === null || explicitChoice === "unmapped"
            ? null
            : targetById.get(Number(explicitChoice)) || null
          : candidateTarget;

      let mappingStatus = restoredPoint
        ? "restored"
        : mapping?.status || (sourcePoint ? "uncovered" : "conflict");
      let resolutionMode = restoredPoint
        ? "restored"
        : mappingTargets.length && !mapping?.requiresConfirmation
          ? "automatic"
          : candidateTarget
            ? "manual"
            : "unmapped";
      if (explicitChoice !== undefined) {
        resolutionMode = chosenTarget ? "manual" : "unmapped";
        mappingStatus = chosenTarget
          ? mapping?.status === "uncovered"
            ? "manual"
            : mapping?.status || "manual"
          : "unmapped";
      }
      const conflict = !sourcePoint && !restoredPoint;
      const unmapped = !chosenTarget;
      const needsConfirmation = restoredPoint
        ? false
        : Boolean(mapping?.requiresConfirmation) || conflict || unmapped;
      return {
        mistakeId: mistake.id,
        question: String(mistake.question || "").slice(0, 120),
        hasAttachments: Boolean(
          this.db
            .prepare("SELECT 1 AS found FROM attachments WHERE mistake_id = ? LIMIT 1")
            .get(mistake.id)
        ),
        beforeTextbookId: fromTextbook.id,
        beforeCurriculumPointId: sourcePoint?.id || null,
        beforeKnowledgePoint: mistake.knowledge_point,
        mappingStatus,
        resolutionMode,
        requiresConfirmation: needsConfirmation,
        conflict,
        unmapped,
        resolutionKey,
        candidateTargetPointIds: mappingTargets.map(
          (target) => target.targetPointId
        ),
        targetPointId: chosenTarget?.id || null,
        targetKnowledgePoint: chosenTarget?.name || "待归类",
        targetUnit: chosenTarget
          ? `${targetTextbook.displayName} 第${chosenTarget.unitNo}单元 ${chosenTarget.unitTitle}`
          : `${targetTextbook.displayName} · 当前教材未覆盖/待归类`,
        preservedStatus: mistake.status,
        preservedDueAt:
          this.db
            .prepare(
              `SELECT next_review_at FROM review_schedule
               WHERE mistake_id = ? AND active = 1`
            )
            .get(mistake.id)?.next_review_at ||
          mistake.due_at ||
          null,
        note:
          restoredPoint
            ? "按历史切换记录还原到之前的教材知识点。"
            : mapping?.mappings?.[0]?.note || ""
      };
    });

    const summary = {
      totalMistakes: mistakes.length,
      affectedMistakes: items.length,
      autoMapped: items.filter((item) => item.resolutionMode === "automatic")
        .length,
      restored: items.filter((item) => item.resolutionMode === "restored")
        .length,
      needsConfirmation: items.filter((item) => item.requiresConfirmation)
        .length,
      unmapped: items.filter((item) => item.unmapped).length,
      conflicts: items.filter((item) => item.conflict).length,
      manualSelections: items.filter((item) => item.resolutionMode === "manual")
        .length
    };
    const impact = this.getMistakeImpactCounts(
      items.map((item) => item.mistakeId)
    );
    const affectedGroups = new Map();
    for (const item of items) {
      const key = item.beforeKnowledgePoint || "未分类";
      const group = affectedGroups.get(key) || {
        knowledgePoint: key,
        count: 0,
        statuses: new Set(),
        targetPoints: new Set()
      };
      group.count += 1;
      group.statuses.add(item.mappingStatus);
      group.targetPoints.add(item.targetKnowledgePoint);
      affectedGroups.set(key, group);
    }
    const previewCore = {
      studentId: student.id,
      fromTextbookId: fromTextbook.id,
      targetTextbookId: targetTextbook.id,
      mappingVersion: CURRICULUM_MAPPING_VERSION,
      items: items.map((item) => ({
        mistakeId: item.mistakeId,
        beforeCurriculumPointId: item.beforeCurriculumPointId,
        beforeKnowledgePoint: item.beforeKnowledgePoint,
        targetPointId: item.targetPointId,
        mappingStatus: item.mappingStatus
      }))
    };
    const previewToken = createHash("sha256")
      .update(stableJson(previewCore))
      .digest("hex");
    return {
      previewToken,
      alreadyCurrent: fromTextbook.id === targetTextbook.id,
      mappingVersion: CURRICULUM_MAPPING_VERSION,
      student: {
        id: student.id,
        name: student.name,
        grade: student.grade
      },
      fromTextbook,
      targetTextbook,
      mappingTable,
      targetPoints,
      items,
      summary: {
        ...summary,
        ...impact,
        historicalReportDays: this.getHistoricalReportDayCount(student.id)
      },
      affectedKnowledgePoints: [...affectedGroups.values()].map((group) => ({
        knowledgePoint: group.knowledgePoint,
        count: group.count,
        statuses: [...group.statuses],
        targetPoints: [...group.targetPoints]
      })),
      impacts: {
        mistakes: "仅更新当前教材关系；题目、答案和附件保留。",
        attempts: "作答历史保留，不重算。",
        hints: "提示记录保留，不重算。",
        mastery: "掌握状态、连续答对次数和掌握证据保留，不清零。",
        review: "复习队列和到期时间保留。",
        reports: "历史日/周报按切换前教材快照保留，并标注“按当时教材”。",
        search: "切换后按目标教材知识点和别名检索；未覆盖项不会伪造结果。"
      }
    };
  }

  executeCurriculumSwitch({
    studentId = null,
    targetTextbookId,
    previewToken,
    mappingChoices = {},
    confirmUnmapped = false,
    idempotencyKey,
    actor = "",
    confirmer = ""
  } = {}) {
    const student = this.getStudent(studentId);
    if (!student) {
      throw curriculumValidationError("STUDENT_NOT_FOUND", "没有找到当前学生", 404);
    }
    const key = String(idempotencyKey || "").trim();
    if (!key) {
      throw curriculumValidationError(
        "IDEMPOTENCY_KEY_REQUIRED",
        "切换教材请求缺少幂等键"
      );
    }
    const existing = this.db
      .prepare("SELECT * FROM curriculum_switch_logs WHERE idempotency_key = ?")
      .get(key);
    if (existing) {
      if (existing.student_id !== student.id) {
        throw curriculumValidationError(
          "IDEMPOTENCY_KEY_CONFLICT",
          "幂等键已被其他学生使用",
          409
        );
      }
      return {
        ...this.mapCurriculumSwitchLog(existing),
        idempotentReplay: true
      };
    }
    const preview = this.buildCurriculumSwitchPreview({
      studentId: student.id,
      targetTextbookId
    });
    if (preview.alreadyCurrent) {
      return {
        alreadyCurrent: true,
        student,
        textbook: preview.targetTextbook,
        previewToken: preview.previewToken,
        mappingVersion: CURRICULUM_MAPPING_VERSION,
        affected: 0
      };
    }
    if (!previewToken || previewToken !== preview.previewToken) {
      throw curriculumValidationError(
        "PREVIEW_STALE",
        "预演结果已过期，请重新预演后再确认",
        409
      );
    }

    const targetById = new Map(
      preview.targetPoints.map((point) => [point.id, point])
    );
    const blocking = [];
    const resolvedItems = preview.items.map((item) => {
      const rawChoice = Object.hasOwn(mappingChoices, item.resolutionKey)
        ? mappingChoices[item.resolutionKey]
        : Object.hasOwn(mappingChoices, String(item.mistakeId))
          ? mappingChoices[item.mistakeId]
          : undefined;
      let targetPoint = item.targetPointId
        ? targetById.get(item.targetPointId)
        : null;
      let resolutionMode = item.resolutionMode;

      if (resolutionMode === "restored" || resolutionMode === "automatic") {
        if (!targetPoint) {
          blocking.push({
            mistakeId: item.mistakeId,
            reason: "自动映射目标缺失"
          });
        }
      } else if (rawChoice === undefined) {
        if (item.mappingStatus === "split") {
          blocking.push({
            mistakeId: item.mistakeId,
            reason: "拆分映射需要人工确认"
          });
        } else if (item.unmapped) {
          if (!confirmUnmapped) {
            blocking.push({
              mistakeId: item.mistakeId,
              reason: "未覆盖项需要确认保留为待归类"
            });
          }
          targetPoint = null;
          resolutionMode = "unmapped";
        } else {
          blocking.push({
            mistakeId: item.mistakeId,
            reason: "映射冲突需要人工选择目标知识点"
          });
        }
      } else if (rawChoice === null || rawChoice === "unmapped") {
        if (!confirmUnmapped) {
          blocking.push({
            mistakeId: item.mistakeId,
            reason: "标记待归类需要明确确认"
          });
        }
        targetPoint = null;
        resolutionMode = "unmapped";
      } else {
        targetPoint = targetById.get(Number(rawChoice)) || null;
        if (!targetPoint) {
          blocking.push({
            mistakeId: item.mistakeId,
            reason: "选择的目标知识点不属于当前目标教材"
          });
        }
        resolutionMode = targetPoint ? "manual" : "unmapped";
      }

      const mapped = Boolean(targetPoint);
      return {
        mistakeId: item.mistakeId,
        beforeKnowledgePoint: item.beforeKnowledgePoint,
        beforeCurriculumPointId: item.beforeCurriculumPointId,
        afterCurriculumPointId: targetPoint?.id || null,
        afterKnowledgePoint: targetPoint?.name || "待归类",
        mappingStatus: mapped
          ? resolutionMode === "manual" && item.mappingStatus === "uncovered"
            ? "manual"
            : item.mappingStatus
          : "unmapped",
        resolutionMode,
        conflict: item.conflict ? 1 : 0,
        unmapped: mapped ? 0 : 1,
        curriculumStatus: mapped ? "mapped" : "unmapped",
        detail: {
          targetUnit: targetPoint
            ? `${preview.targetTextbook.displayName} 第${targetPoint.unitNo}单元 ${targetPoint.unitTitle}`
            : "当前教材未覆盖/待归类",
          note: item.note
        }
      };
    });
    if (blocking.length) {
      const error = curriculumValidationError(
        "MAPPING_CONFIRMATION_REQUIRED",
        `还有 ${blocking.length} 道题需要人工确认或处理未映射项`,
        409
      );
      error.details = { blocking };
      throw error;
    }

    const rollbackPlan = {
      strategy: "single_transaction",
      student: {
        id: student.id,
        textbookId: preview.fromTextbook.id
      },
      mistakes: preview.items.map((item) => ({
        mistakeId: item.mistakeId,
        textbookId: item.beforeTextbookId,
        curriculumPointId: item.beforeCurriculumPointId,
        knowledgePoint: item.beforeKnowledgePoint,
        status: item.preservedStatus,
        dueAt: item.preservedDueAt
      }))
    };
    const snapshots = this.collectHistoricalReportSnapshots({
      studentId: student.id,
      textbook: preview.fromTextbook
    });
    const timestamp = nowIso();
    const autoCount = resolvedItems.filter((item) =>
      ["automatic", "restored"].includes(item.resolutionMode)
    ).length;
    const manualCount = resolvedItems.filter(
      (item) => item.resolutionMode === "manual"
    ).length;
    const unmappedCount = resolvedItems.filter(
      (item) => item.resolutionMode === "unmapped"
    ).length;
    const conflictCount = resolvedItems.filter((item) => item.conflict).length;
    const resultPayload = {
      mappingVersion: CURRICULUM_MAPPING_VERSION,
      previewHash: preview.previewToken,
      fromTextbook: preview.fromTextbook,
      targetTextbook: preview.targetTextbook,
      summary: {
        affectedMistakes: resolvedItems.length,
        autoMapped: autoCount,
        manualMapped: manualCount,
        unmapped: unmappedCount,
        conflicts: conflictCount,
        reportSnapshots: snapshots.length,
        preserved: {
          attachments: preview.summary.attachments,
          attempts: preview.summary.attempts,
          hintEvents: preview.summary.hintEvents,
          masteryEvidence: preview.summary.masteryEvidence,
          activeReviews: preview.summary.activeReviews
        }
      },
      items: resolvedItems,
      rollbackPlan
    };

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const updateMistake = this.db.prepare(
        `UPDATE mistakes
         SET textbook_id = ?, curriculum_point_id = ?, knowledge_point = ?,
             curriculum_status = ?, updated_at = ?
         WHERE id = ? AND student_id = ?`
      );
      const selectActiveParts = this.db.prepare(
        `SELECT id, knowledge_point FROM mistake_parts
         WHERE mistake_id = ? AND active = 1`
      );
      const updatePartKnowledgePoint = this.db.prepare(
        "UPDATE mistake_parts SET knowledge_point = ?, updated_at = ? WHERE id = ?"
      );
      for (const item of resolvedItems) {
        const result = updateMistake.run(
          preview.targetTextbook.id,
          item.afterCurriculumPointId,
          item.afterKnowledgePoint,
          item.curriculumStatus,
          timestamp,
          item.mistakeId,
          student.id
        );
        if (!result.changes) {
          throw new Error(`错题 ${item.mistakeId} 不属于当前学生，切换已回滚`);
        }
        for (const part of selectActiveParts.all(item.mistakeId)) {
          let nextKnowledgePoint = part.knowledge_point;
          if (
            !nextKnowledgePoint ||
            nextKnowledgePoint === item.beforeKnowledgePoint
          ) {
            nextKnowledgePoint = item.afterKnowledgePoint;
          } else {
            const resolved = this.resolveMistakeCurriculum(
              nextKnowledgePoint,
              { textbook: preview.targetTextbook }
            );
            nextKnowledgePoint =
              resolved.curriculumStatus === "mapped"
                ? resolved.knowledgePoint
                : item.afterKnowledgePoint;
          }
          if (nextKnowledgePoint !== part.knowledge_point) {
            updatePartKnowledgePoint.run(
              nextKnowledgePoint,
              timestamp,
              part.id
            );
          }
        }
      }
      const logResult = this.db
        .prepare(
          `INSERT INTO curriculum_switch_logs (
            student_id, operation, from_textbook_id, to_textbook_id,
            from_grade, from_semester, to_grade, to_semester,
            mapping_version, preview_hash, idempotency_key, actor, confirmer,
            status, affected_count, auto_count, manual_count, unmapped_count,
            conflict_count, result_json, rollback_json, created_at
          ) VALUES (?, 'switch', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed',
                    ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          student.id,
          preview.fromTextbook.id,
          preview.targetTextbook.id,
          preview.fromTextbook.grade,
          preview.fromTextbook.semester,
          preview.targetTextbook.grade,
          preview.targetTextbook.semester,
          CURRICULUM_MAPPING_VERSION,
          preview.previewToken,
          key,
          String(actor || student.name || "当前用户"),
          String(confirmer || actor || student.name || "当前用户"),
          resolvedItems.length,
          autoCount,
          manualCount,
          unmappedCount,
          conflictCount,
          JSON.stringify(resultPayload),
          JSON.stringify(rollbackPlan),
          timestamp
        );
      const switchLogId = Number(logResult.lastInsertRowid);
      const insertItem = this.db.prepare(
        `INSERT INTO curriculum_switch_items (
          switch_log_id, mistake_id, before_textbook_id, after_textbook_id,
          before_curriculum_point_id, after_curriculum_point_id,
          before_knowledge_point, after_knowledge_point, mapping_status,
          resolution_mode, conflict, unmapped, detail_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const item of resolvedItems) {
        insertItem.run(
          switchLogId,
          item.mistakeId,
          preview.fromTextbook.id,
          preview.targetTextbook.id,
          item.beforeCurriculumPointId,
          item.afterCurriculumPointId,
          item.beforeKnowledgePoint,
          item.afterKnowledgePoint,
          item.mappingStatus,
          item.resolutionMode,
          item.conflict,
          item.unmapped,
          JSON.stringify(item.detail),
          timestamp
        );
      }
      this.insertReportSnapshots(snapshots, {
        studentId: student.id,
        textbook: preview.fromTextbook,
        switchLogId
      });
      this.db
        .prepare(
          `UPDATE students
           SET textbook_id = ?, textbook_selected_at = ?
           WHERE id = ?`
        )
        .run(preview.targetTextbook.id, timestamp, student.id);
      this.db.exec("COMMIT");
      return this.getCurriculumSwitchLog(switchLogId);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  mapCurriculumSwitchLog(row) {
    if (!row) return null;
    const items = this.db
      .prepare(
        `SELECT * FROM curriculum_switch_items
         WHERE switch_log_id = ?
         ORDER BY id`
      )
      .all(row.id)
      .map((item) => ({
        id: item.id,
        mistakeId: item.mistake_id,
        beforeTextbookId: item.before_textbook_id,
        afterTextbookId: item.after_textbook_id,
        beforeCurriculumPointId: item.before_curriculum_point_id,
        afterCurriculumPointId: item.after_curriculum_point_id,
        beforeKnowledgePoint: item.before_knowledge_point,
        afterKnowledgePoint: item.after_knowledge_point,
        mappingStatus: item.mapping_status,
        resolutionMode: item.resolution_mode,
        conflict: item.conflict === 1,
        unmapped: item.unmapped === 1,
        detail: parseJsonObject(item.detail_json),
        createdAt: item.created_at
      }));
    return {
      id: row.id,
      studentId: row.student_id,
      operation: row.operation,
      fromTextbook: this.getTextbook(row.from_textbook_id),
      toTextbook: this.getTextbook(row.to_textbook_id),
      fromGrade: row.from_grade,
      fromSemester: row.from_semester,
      toGrade: row.to_grade,
      toSemester: row.to_semester,
      mappingVersion: row.mapping_version,
      previewHash: row.preview_hash,
      idempotencyKey: row.idempotency_key,
      actor: row.actor,
      confirmer: row.confirmer,
      status: row.status,
      affectedCount: row.affected_count,
      autoCount: row.auto_count,
      manualCount: row.manual_count,
      unmappedCount: row.unmapped_count,
      conflictCount: row.conflict_count,
      result: parseJsonObject(row.result_json),
      rollback: parseJsonObject(row.rollback_json),
      items,
      createdAt: row.created_at
    };
  }

  getCurriculumSwitchLog(id) {
    return this.mapCurriculumSwitchLog(
      this.db
        .prepare("SELECT * FROM curriculum_switch_logs WHERE id = ?")
        .get(id)
    );
  }

  getCurriculumSwitchLogs({ studentId = null, mistakeId = null, limit = 20 } = {}) {
    const student = this.getStudent(studentId);
    if (!student) return [];
    const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
    const rows = mistakeId
      ? this.db
          .prepare(
            `SELECT DISTINCT l.*
             FROM curriculum_switch_logs l
             JOIN curriculum_switch_items i ON i.switch_log_id = l.id
             WHERE l.student_id = ? AND i.mistake_id = ?
             ORDER BY l.id DESC
             LIMIT ?`
          )
          .all(student.id, mistakeId, safeLimit)
      : this.db
          .prepare(
            `SELECT * FROM curriculum_switch_logs
             WHERE student_id = ?
             ORDER BY id DESC
             LIMIT ?`
          )
          .all(student.id, safeLimit);
    return rows.map((row) => this.mapCurriculumSwitchLog(row));
  }

  assignMistakeCurriculum({
    studentId = null,
    mistakeId,
    targetCurriculumPointId,
    idempotencyKey,
    actor = "",
    confirmer = ""
  } = {}) {
    const student = this.getStudent(studentId);
    if (!student) {
      throw curriculumValidationError("STUDENT_NOT_FOUND", "没有找到当前学生", 404);
    }
    const key = String(idempotencyKey || "").trim();
    if (!key) {
      throw curriculumValidationError(
        "IDEMPOTENCY_KEY_REQUIRED",
        "未映射处理请求缺少幂等键"
      );
    }
    const existing = this.db
      .prepare("SELECT * FROM curriculum_switch_logs WHERE idempotency_key = ?")
      .get(key);
    if (existing) {
      if (existing.student_id !== student.id) {
        throw curriculumValidationError(
          "IDEMPOTENCY_KEY_CONFLICT",
          "幂等键已被其他学生使用",
          409
        );
      }
      return {
        ...this.mapCurriculumSwitchLog(existing),
        idempotentReplay: true
      };
    }
    const mistake = this.db
      .prepare("SELECT * FROM mistakes WHERE id = ? AND student_id = ?")
      .get(mistakeId, student.id);
    if (!mistake) {
      throw curriculumValidationError("MISTAKE_NOT_FOUND", "没有找到这道错题", 404);
    }
    const textbook = student.textbook;
    const targetPoint = this.getCurriculumPoint(
      textbook.id,
      targetCurriculumPointId
    );
    if (!targetPoint) {
      throw curriculumValidationError(
        "TARGET_POINT_NOT_FOUND",
        "目标知识点不属于当前教材",
        400
      );
    }
    if (
      mistake.textbook_id === textbook.id &&
      mistake.curriculum_point_id === targetPoint.id
    ) {
      return {
        alreadyResolved: true,
        mistake: this.getMistake(mistake.id, { includeSolution: true })
      };
    }
    const timestamp = nowIso();
    const previewHash = createHash("sha256")
      .update(
        stableJson({
          operation: "manual_resolve",
          studentId: student.id,
          mistakeId: mistake.id,
          textbookId: textbook.id,
          beforePointId: mistake.curriculum_point_id,
          targetPointId: targetPoint.id
        })
      )
      .digest("hex");
    const rollbackPlan = {
      strategy: "single_transaction",
      mistakeId: mistake.id,
      textbookId: mistake.textbook_id,
      curriculumPointId: mistake.curriculum_point_id,
      knowledgePoint: mistake.knowledge_point
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `UPDATE mistakes
           SET textbook_id = ?, curriculum_point_id = ?, knowledge_point = ?,
               curriculum_status = 'mapped', updated_at = ?
           WHERE id = ? AND student_id = ?`
        )
        .run(
          textbook.id,
          targetPoint.id,
          targetPoint.name,
          timestamp,
          mistake.id,
          student.id
        );
      this.db
        .prepare(
          `UPDATE mistake_parts
           SET knowledge_point = ?, updated_at = ?
           WHERE mistake_id = ? AND active = 1
             AND (knowledge_point = ? OR knowledge_point = '')`
        )
        .run(
          targetPoint.name,
          timestamp,
          mistake.id,
          mistake.knowledge_point
        );
      const logResult = this.db
        .prepare(
          `INSERT INTO curriculum_switch_logs (
            student_id, operation, from_textbook_id, to_textbook_id,
            from_grade, from_semester, to_grade, to_semester,
            mapping_version, preview_hash, idempotency_key, actor, confirmer,
            status, affected_count, auto_count, manual_count, unmapped_count,
            conflict_count, result_json, rollback_json, created_at
          ) VALUES (?, 'manual_resolve', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    'confirmed', 1, 0, 1, 0, 0, ?, ?, ?)`
        )
        .run(
          student.id,
          textbook.id,
          textbook.id,
          textbook.grade,
          textbook.semester,
          textbook.grade,
          textbook.semester,
          CURRICULUM_MAPPING_VERSION,
          previewHash,
          key,
          String(actor || student.name || "当前用户"),
          String(confirmer || actor || student.name || "当前用户"),
          JSON.stringify({
            mappingVersion: CURRICULUM_MAPPING_VERSION,
            operation: "manual_resolve",
            mistakeId: mistake.id,
            beforeKnowledgePoint: mistake.knowledge_point,
            afterKnowledgePoint: targetPoint.name,
            targetPoint
          }),
          JSON.stringify(rollbackPlan),
          timestamp
        );
      const switchLogId = Number(logResult.lastInsertRowid);
      this.db
        .prepare(
          `INSERT INTO curriculum_switch_items (
            switch_log_id, mistake_id, before_textbook_id, after_textbook_id,
            before_curriculum_point_id, after_curriculum_point_id,
            before_knowledge_point, after_knowledge_point, mapping_status,
            resolution_mode, conflict, unmapped, detail_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', 'manual', 0, 0, ?, ?)`
        )
        .run(
          switchLogId,
          mistake.id,
          mistake.textbook_id,
          textbook.id,
          mistake.curriculum_point_id,
          targetPoint.id,
          mistake.knowledge_point,
          targetPoint.name,
          JSON.stringify({
            targetUnit: `${textbook.displayName} 第${targetPoint.unitNo}单元 ${targetPoint.unitTitle}`
          }),
          timestamp
        );
      this.db.exec("COMMIT");
      return this.getCurriculumSwitchLog(switchLogId);
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

  getCurriculumKnowledgeCards(textbookId) {
    const textbook = this.getTextbook(textbookId);
    if (!textbook) return [];
    const cards = this.getKnowledgeCards();
    const cardsBySlug = new Map(cards.map((card) => [card.slug, card]));
    const sources = this.db
      .prepare("SELECT * FROM knowledge_sources ORDER BY id")
      .all();
    const sourceByKey = new Map(
      sources.map((source) => [source.source_key, source])
    );
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

    return this.getCurriculumPoints(textbook.id)
      .map((point) => {
        const base = cardsBySlug.get(point.sourceKnowledgeSlug);
        const summarySourceRow = sourceByKey.get(point.sourceKey);
        const outlineSourceRow = sourceByKey.get(
          textbook.editionKey === "beishida"
            ? "beishida-outline-v1"
            : "renjiao-outline-v1"
        );
        const summarySource = summarySourceRow
          ? mapSource(summarySourceRow)
          : null;
        const outlineSource = outlineSourceRow
          ? mapSource(outlineSourceRow)
          : null;
        const targetSources = [summarySource, outlineSource].filter(Boolean);
        if (!base) {
          return {
            id: point.id,
            sourceCardId: null,
            curriculumPointId: point.id,
            name: point.name,
            slug: point.slug,
            unit: `${textbook.displayName} 第${point.unitNo}单元 ${point.unitTitle}`,
            unitNo: point.unitNo,
            unitTitle: point.unitTitle,
            textbookVersion: textbook.displayName,
            textbookId: textbook.id,
            aliases: point.aliases,
            prerequisites: [],
            keywords: point.semanticKeys,
            summary:
              "该知识点属于北师大版新增编排内容，教材摘要尚未通过任课教师审核，暂不提供自动知识讲解。",
            hint: "",
            steps: [],
            commonErrors: [],
            contentVersion: point.contentVersion,
            reviewStatus: "unreviewed",
            updatedAt: point.updatedAt,
            position: point.position,
            chunks: [],
            sources: targetSources
          };
        }
        const chunks = base.chunks.map((chunk) => ({
          ...chunk,
          citation: summarySource
            ? `${summarySource.title} · ${point.name} / ${chunk.title} [${summarySource.key}]`
            : `${point.name} / ${chunk.title}`,
          source: summarySource
        }));
        return {
          ...base,
          id: point.id,
          sourceCardId: base.id,
          curriculumPointId: point.id,
          name: point.name,
          slug: point.slug,
          unit: `${textbook.displayName} 第${point.unitNo}单元 ${point.unitTitle}`,
          unitNo: point.unitNo,
          unitTitle: point.unitTitle,
          textbookVersion: textbook.displayName,
          textbookId: textbook.id,
          aliases: [
            ...new Set([
              ...point.aliases,
              ...base.aliases,
              ...(base.name !== point.name ? [base.name] : [])
            ])
          ],
          reviewStatus: point.reviewStatus,
          contentVersion: point.contentVersion,
          chunks,
          sources: targetSources
        };
      })
      .filter(Boolean);
  }

  getCurriculumKnowledgeBaseData(textbookId) {
    const cards = this.getCurriculumKnowledgeCards(textbookId);
    const textbook = this.getTextbook(textbookId);
    const reviewCounts = {};
    for (const card of cards) {
      reviewCounts[card.reviewStatus] =
        (reviewCounts[card.reviewStatus] || 0) + 1;
    }
    const sourceKeys = new Set(
      cards.flatMap((card) => card.sources.map((source) => source.key))
    );
    return {
      stats: {
        knowledgePoints: cards.length,
        units: new Set(cards.map((card) => card.unitNo)).size,
        chunks: cards.reduce((total, card) => total + card.chunks.length, 0),
        sources: sourceKeys.size,
        reviewCounts,
        textbookVersion: textbook?.displayName || "",
        textbookId: textbook?.id || null,
        contentVersion: KNOWLEDGE_CONTENT_VERSION
      },
      cards
    };
  }

  searchKnowledge({
    query,
    knowledgePoint = null,
    limit = 3,
    includeCard = false,
    textbookId = null
  }) {
    const cards = textbookId
      ? this.getCurriculumKnowledgeCards(textbookId)
      : this.getKnowledgeCards();
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

  getKnowledgeBaseStats({ textbookId = null } = {}) {
    if (textbookId) {
      return this.getCurriculumKnowledgeBaseData(textbookId).stats;
    }
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
    for (const part of parts) {
      if (!part.knowledgePoint) continue;
      const resolvedPart = this.resolveDiagnosisKnowledgePoint(
        part.knowledgePoint,
        student
      );
      if (resolvedPart) part.knowledgePoint = resolvedPart.point.name;
    }
    const diagnosisInput = {
      ...input,
      studentAnswer:
        input.studentAnswer || parts.map((part) => part.studentAnswer).join("；"),
      correctAnswer:
        input.correctAnswer || parts[0]?.acceptedAnswers[0] || ""
    };
    const { diagnosis } = this.buildCurriculumAwareDiagnosis(
      diagnosisInput,
      student
    );
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
    const draftStudent = this.getStudent(draft.studentId);
    for (const part of parts) {
      if (!part.knowledgePoint) continue;
      const resolvedPart = this.resolveDiagnosisKnowledgePoint(
        part.knowledgePoint,
        draftStudent
      );
      if (resolvedPart) part.knowledgePoint = resolvedPart.point.name;
    }
    const curriculum = this.resolveMistakeCurriculum(
      draft.knowledgePoint,
      draftStudent
    );
    const timestamp = nowIso();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare(
          `INSERT INTO mistakes (
            student_id, question, student_answer, correct_answer, analysis,
            knowledge_point, textbook_id, curriculum_point_id,
            curriculum_status, error_type, hint, method_steps, common_errors,
            diagnosis, status, due_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)`
        )
        .run(
          draft.studentId,
          draft.question,
          draft.studentAnswer,
          draft.correctAnswer,
          draft.analysis,
          curriculum.knowledgePoint,
          curriculum.textbookId,
          curriculum.curriculumPointId,
          curriculum.curriculumStatus,
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
        curriculum.knowledgePoint
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

  resolveMistakeCurriculum(knowledgePoint, student = this.getStudent()) {
    const sourceName = String(knowledgePoint || "").trim();
    const textbook = student?.textbook;
    if (!textbook) {
      return {
        textbookId: null,
        curriculumPointId: null,
        curriculumStatus: "legacy",
        knowledgePoint: sourceName
      };
    }
    const direct = this.resolveCurriculumPointByName(textbook.id, sourceName);
    if (direct) {
      return {
        textbookId: textbook.id,
        curriculumPointId: direct.id,
        curriculumStatus: "mapped",
        knowledgePoint: direct.name
      };
    }

    const legacy = this.getTextbook("renjiao-6-all");
    const sourcePoint =
      legacy && this.resolveCurriculumPointByName(legacy.id, sourceName);
    if (sourcePoint && legacy.id !== textbook.id) {
      const rows = this.getCurriculumMappingRows(legacy.id, textbook.id).filter(
        (row) => row.sourcePointId === sourcePoint.id
      );
      const targets = [
        ...new Map(
          rows
            .filter((row) => row.targetPointId)
            .map((row) => [row.targetPointId, row])
        ).values()
      ];
      if (targets.length === 1 && !targets[0].requiresConfirmation) {
        return {
          textbookId: textbook.id,
          curriculumPointId: targets[0].targetPointId,
          curriculumStatus: "mapped",
          knowledgePoint: targets[0].targetPointName
        };
      }
      if (targets.length) {
        return {
          textbookId: textbook.id,
          curriculumPointId: null,
          curriculumStatus: "needs_confirmation",
          knowledgePoint: "待归类"
        };
      }
    }

    return {
      textbookId: textbook.id,
      curriculumPointId: null,
      curriculumStatus: "unmapped",
      knowledgePoint: "待归类"
    };
  }

  createMistake(input) {
    assertToolWriteAllowed();
    const student = this.getStudent();
    const attachmentIds = normalizeAttachmentIds(input.attachmentIds);
    const question = String(input.question || "").trim();
    if (!question && !attachmentIds.length) {
      throw new LearningValidationError(
        "EMPTY_MISTAKE",
        "请填写题目或添加题目图片"
      );
    }
    const parts = normalizeParts(input);
    for (const part of parts) {
      if (!part.knowledgePoint) continue;
      const resolvedPart = this.resolveDiagnosisKnowledgePoint(
        part.knowledgePoint,
        student
      );
      if (resolvedPart) part.knowledgePoint = resolvedPart.point.name;
    }
    const combinedStudentAnswer = parts
      .map((part) => part.studentAnswer)
      .join("；");
    const combinedCorrectAnswer = parts
      .map((part) => part.acceptedAnswers[0] || "")
      .join("；");
    const { diagnosis } = this.buildCurriculumAwareDiagnosis(
      {
        ...input,
        studentAnswer: input.studentAnswer || combinedStudentAnswer,
        correctAnswer: input.correctAnswer || combinedCorrectAnswer
      },
      student
    );
    const curriculum = this.resolveMistakeCurriculum(
      diagnosis.knowledgePoint,
      student
    );
    const timestamp = nowIso();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare(
          `INSERT INTO mistakes (
            student_id, question, student_answer, correct_answer, analysis,
            knowledge_point, textbook_id, curriculum_point_id,
            curriculum_status, error_type, hint, method_steps, common_errors,
            diagnosis, status, due_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)`
        )
        .run(
          student.id,
          question,
          combinedStudentAnswer,
          combinedCorrectAnswer,
          input.analysis || "",
          curriculum.knowledgePoint,
          curriculum.textbookId,
          curriculum.curriculumPointId,
          curriculum.curriculumStatus,
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
      this.bindNewAttachments(mistakeId, attachmentIds, timestamp);
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
        `SELECT m.*, COALESCE(k.name, m.knowledge_point) AS knowledge_point
         FROM mistakes m
         LEFT JOIN knowledge_points k ON k.name = m.knowledge_point
         WHERE m.id = ?`
      )
      .get(id);
    const mistake = mapMistake(row, { includeSolution });
    if (mistake) {
      mistake.parts = this.getMistakeParts(id, { includeSolution });
      mistake.partCount = mistake.parts.length;
      mistake.attachments = this.listMistakeAttachments(id);
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
    const attachmentsProvided = Object.hasOwn(input, "attachmentIds");
    const proposedAttachmentIds = attachmentsProvided
      ? normalizeAttachmentIds(input.attachmentIds)
      : (current.attachments || []).map((attachment) => attachment.id);
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
    proposedParts.forEach((part, index) => {
      if (!part.knowledgePoint) {
        part.knowledgePoint =
          current.parts[index]?.knowledgePoint || current.knowledgePoint || "";
        return;
      }
      const resolvedPart = this.resolveDiagnosisKnowledgePoint(
        part.knowledgePoint,
        this.getStudent()
      );
      if (resolvedPart) part.knowledgePoint = resolvedPart.point.name;
    });
    if (!String(proposed.question || "").trim() && !proposedAttachmentIds.length) {
      throw new LearningValidationError(
        "EMPTY_MISTAKE",
        "请填写题目或保留至少一张题目图片"
      );
    }
    const { diagnosis } = this.buildCurriculumAwareDiagnosis(
      proposed,
      this.getStudent()
    );
    const finalFields = {
      ...proposed,
      knowledgePoint: diagnosis.knowledgePoint,
      errorType: diagnosis.errorType
    };
    const curriculum = this.resolveMistakeCurriculum(
      finalFields.knowledgePoint,
      this.getStudent()
    );
    finalFields.knowledgePoint = curriculum.knowledgePoint;
    finalFields.textbookId = curriculum.textbookId;
    finalFields.curriculumPointId = curriculum.curriculumPointId;
    finalFields.curriculumStatus = curriculum.curriculumStatus;
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
    const currentAttachmentIds = (current.attachments || []).map(
      (attachment) => attachment.id
    );
    const attachmentIdsChanged =
      attachmentsProvided &&
      JSON.stringify([...proposedAttachmentIds].sort()) !==
        JSON.stringify([...currentAttachmentIds].sort());
    if (attachmentIdsChanged) changedFields.push("attachments");
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
        ["question", "correctAnswer", "knowledgePoint", "attachments"].includes(
          field
        )
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
      parts: current.parts,
      attachments: current.attachments
    };
    const afterSnapshot = {
      ...finalFields,
      ...nextLearningState,
      parts: proposedParts,
      attachments: attachmentIdsChanged
        ? proposedAttachmentIds.map((attachmentId) =>
            this.getAttachment(attachmentId)
          )
        : current.attachments
    };

    let removedAttachmentKeys = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `UPDATE mistakes SET
             question = ?, student_answer = ?, correct_answer = ?, analysis = ?,
             knowledge_point = ?, textbook_id = ?, curriculum_point_id = ?,
             curriculum_status = ?, error_type = ?, hint = ?, method_steps = ?,
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
          finalFields.textbookId,
          finalFields.curriculumPointId,
          finalFields.curriculumStatus,
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
      if (attachmentIdsChanged) {
        const attachmentResult = this.replaceMistakeAttachments(
          id,
          proposedAttachmentIds
        );
        removedAttachmentKeys = attachmentResult.removedStorageKeys;
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
    this.removeAttachmentFiles(removedAttachmentKeys);

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
      `SELECT m.*, COALESCE(k.name, m.knowledge_point) AS knowledge_point
       FROM mistakes m
       LEFT JOIN knowledge_points k ON k.name = m.knowledge_point
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
    const partsByMistake = new Map();
    if (rows.length) {
      const placeholders = rows.map(() => "?").join(",");
      const partRows = this.db
        .prepare(
          `SELECT mistake_id, label, prompt FROM mistake_parts
           WHERE active = 1 AND mistake_id IN (${placeholders})
           ORDER BY mistake_id, part_no, id`
        )
        .all(...rows.map((row) => row.id));
      for (const part of partRows) {
        const list = partsByMistake.get(part.mistake_id) || [];
        list.push({ label: part.label, prompt: part.prompt });
        partsByMistake.set(part.mistake_id, list);
      }
    }
    return rows.map((row) => {
      const mistake = mapMistake(row);
      mistake.parts = partsByMistake.get(row.id) || [];
      mistake.attachments = this.listMistakeAttachments(mistake.id);
      return mistake;
    });
  }

  deleteMistake(id) {
    assertToolWriteAllowed();
    const storageKeys = this.db
      .prepare(
        `SELECT a.storage_key, c.storage_key AS crop_storage_key
         FROM attachments a
         LEFT JOIN attachment_crops c ON c.attachment_id = a.id
         WHERE a.mistake_id = ?`
      )
      .all(id)
      .flatMap((row) => [row.storage_key, row.crop_storage_key].filter(Boolean));
    this.db.exec("BEGIN IMMEDIATE");
    let deleted = false;
    try {
      const result = this.db.prepare("DELETE FROM mistakes WHERE id = ?").run(id);
      deleted = result.changes > 0;
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    if (deleted) this.removeAttachmentFiles(storageKeys);
    return deleted;
  }

  getNextReview() {
    const timestamp = nowIso();
    const row = this.db
      .prepare(
        `SELECT m.*, COALESCE(k.name, m.knowledge_point) AS knowledge_point,
                rs.next_review_at AS scheduled_review_at,
                rs.interval_days AS review_interval_days,
                rs.reason AS review_reason
         FROM mistakes m
         LEFT JOIN knowledge_points k ON k.name = m.knowledge_point
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
      mistake.attachments = this.listMistakeAttachments(mistake.id);
    }
    return mistake;
  }

  listDueReviews({ limit = 5, at = nowIso() } = {}) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 5, 20));
    return this.db
      .prepare(
        `SELECT m.*, COALESCE(k.name, m.knowledge_point) AS knowledge_point,
                rs.next_review_at AS scheduled_review_at,
                rs.interval_days AS review_interval_days,
                rs.reason AS review_reason
         FROM mistakes m
         LEFT JOIN knowledge_points k ON k.name = m.knowledge_point
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

  buildOperationalMetrics({
    from = null,
    to = null,
    costPer1kInput = 0,
    costPer1kOutput = 0
  } = {}) {
    const buildRange = (column) => {
      const clauses = [];
      const parameters = [];
      if (from) {
        clauses.push(`${column} >= ?`);
        parameters.push(from);
      }
      if (to) {
        clauses.push(`${column} <= ?`);
        parameters.push(to);
      }
      return {
        sql: clauses.length ? ` AND ${clauses.join(" AND ")}` : "",
        parameters
      };
    };
    const llmRange = buildRange("created_at");
    const toolRange = buildRange("created_at");
    const runRange = buildRange("started_at");
    const diagnosisRange = buildRange("created_at");

    const llm = this.db
      .prepare(
        `SELECT
          COUNT(*) AS total,
          COALESCE(SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END), 0) AS succeeded,
          COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
          COALESCE(SUM(input_tokens), 0) AS input_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens
         FROM llm_calls WHERE 1 = 1${llmRange.sql}`
      )
      .get(...llmRange.parameters);
    const llmLatencies = this.db
      .prepare(
        `SELECT latency_ms FROM llm_calls
         WHERE latency_ms IS NOT NULL${llmRange.sql}
         ORDER BY latency_ms ASC`
      )
      .all(...llmRange.parameters)
      .map((row) => Number(row.latency_ms));
    const percentile = (values, ratio) => {
      if (!values.length) return null;
      const index = Math.min(
        values.length - 1,
        Math.max(0, Math.ceil(values.length * ratio) - 1)
      );
      return values[index];
    };

    const tools = this.db
      .prepare(
        `SELECT
          COUNT(*) AS total,
          COALESCE(SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END), 0) AS succeeded,
          COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
          COALESCE(SUM(CASE WHEN error_message LIKE '%TOOL_TIMEOUT%' THEN 1 ELSE 0 END), 0) AS timeouts,
          AVG(latency_ms) AS average_latency_ms
         FROM tool_calls WHERE 1 = 1${toolRange.sql}`
      )
      .get(...toolRange.parameters);
    const runs = this.db
      .prepare(
        `SELECT
          COUNT(*) AS total,
          COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
          COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
          COALESCE(SUM(CASE WHEN status IN ('created', 'in_progress', 'awaiting_user') THEN 1 ELSE 0 END), 0) AS active
         FROM agent_runs WHERE 1 = 1${runRange.sql}`
      )
      .get(...runRange.parameters);
    const diagnoses = this.db
      .prepare(
        `SELECT
          COUNT(*) AS total,
          COALESCE(SUM(CASE WHEN provider = 'rules' THEN 1 ELSE 0 END), 0) AS rules,
          COALESCE(SUM(CASE WHEN provider != 'rules' AND provider != '' THEN 1 ELSE 0 END), 0) AS llm,
          COALESCE(SUM(CASE WHEN accepted_by_user = 1 THEN 1 ELSE 0 END), 0) AS accepted
         FROM diagnoses WHERE 1 = 1${diagnosisRange.sql}`
      )
      .get(...diagnosisRange.parameters);

    const inputTokens = Number(llm.input_tokens || 0);
    const outputTokens = Number(llm.output_tokens || 0);
    const totalDiagnoses = Number(diagnoses.total || 0);
    const ruleDiagnoses = Number(diagnoses.rules || 0);
    const estimatedCost =
      (inputTokens / 1000) * Number(costPer1kInput || 0) +
      (outputTokens / 1000) * Number(costPer1kOutput || 0);

    return {
      generatedAt: nowIso(),
      period: { from, to },
      llm: {
        calls: Number(llm.total || 0),
        succeeded: Number(llm.succeeded || 0),
        failed: Number(llm.failed || 0),
        inputTokens,
        outputTokens,
        averageLatencyMs: llmLatencies.length
          ? Math.round(
              llmLatencies.reduce((total, value) => total + value, 0) /
                llmLatencies.length
            )
          : null,
        p50LatencyMs: percentile(llmLatencies, 0.5),
        p95LatencyMs: percentile(llmLatencies, 0.95)
      },
      tools: {
        calls: Number(tools.total || 0),
        succeeded: Number(tools.succeeded || 0),
        failed: Number(tools.failed || 0),
        timeouts: Number(tools.timeouts || 0),
        averageLatencyMs:
          tools.average_latency_ms === null
            ? null
            : Math.round(Number(tools.average_latency_ms))
      },
      agentRuns: {
        total: Number(runs.total || 0),
        completed: Number(runs.completed || 0),
        failed: Number(runs.failed || 0),
        active: Number(runs.active || 0)
      },
      diagnoses: {
        total: totalDiagnoses,
        rules: ruleDiagnoses,
        llm: Number(diagnoses.llm || 0),
        accepted: Number(diagnoses.accepted || 0),
        degradationRate: totalDiagnoses ? ruleDiagnoses / totalDiagnoses : null
      },
      cost: {
        currency: "USD",
        inputTokens,
        outputTokens,
        costPer1kInput: Number(costPer1kInput || 0),
        costPer1kOutput: Number(costPer1kOutput || 0),
        estimated: Number(estimatedCost.toFixed(6))
      }
    };
  }

  deleteAllLearningData() {
    const tables = [
      "attachment_extractions",
      "attachment_crops",
      "attachments",
      "attempt_part_results",
      "attempt_evaluations",
      "mastery_evidence",
      "review_schedule",
      "hint_events",
      "attempts",
      "diagnoses",
      "mistake_parts",
      "mistake_edits",
      "mistake_drafts",
      "mistakes",
      "tool_calls",
      "llm_calls",
      "agent_runs"
    ];
    const storageKeys = this.db
      .prepare(
        `SELECT storage_key FROM attachments
         UNION ALL
         SELECT storage_key FROM attachment_crops`
      )
      .all()
      .map((row) => row.storage_key);
    const deleted = {};
    this.db.exec("BEGIN");
    try {
      for (const table of tables) {
        deleted[table] = Number(
          this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()
            .count || 0
        );
        this.db.prepare(`DELETE FROM ${table}`).run();
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.removeAttachmentFiles(storageKeys);
    return {
      deleted,
      total: Object.values(deleted).reduce((sum, value) => sum + value, 0)
    };
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
            attemptCount: nextReview.attemptCount,
            attachments: nextReview.attachments || []
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

  getCurriculumKnowledgeSummary(textbookId, studentId = null) {
    const textbook = this.getTextbook(textbookId);
    if (!textbook) return [];
    const points = this.getCurriculumPoints(textbook.id);
    const clauses = ["m.textbook_id = ?"];
    const parameters = [textbook.id];
    if (studentId) {
      clauses.push("m.student_id = ?");
      parameters.push(studentId);
    }
    const rows = this.db
      .prepare(
        `SELECT m.curriculum_point_id, m.knowledge_point, m.status,
                m.consecutive_correct, m.attempt_count
         FROM mistakes m
         WHERE ${clauses.join(" AND ")}`
      )
      .all(...parameters);
    const grouped = new Map();
    for (const row of rows) {
      const key = row.curriculum_point_id ?? "unmapped";
      const list = grouped.get(key) || [];
      list.push(row);
      grouped.set(key, list);
    }

    const summarize = (items) => {
      const mastered = items.filter((item) => item.status === "mastered").length;
      const practicing = items.filter(
        (item) => item.status === "practicing"
      ).length;
      const relearning = items.filter(
        (item) => item.status === "relearning"
      ).length;
      const newCount = items.filter((item) => item.status === "new").length;
      const mastery = items.length
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
        total: items.length,
        new: newCount,
        practicing,
        relearning,
        mastered,
        mastery
      };
    };

    const result = points.map((point) => ({
      id: point.id,
      name: point.name,
      unitNo: point.unitNo,
      unitTitle: point.unitTitle,
      unit: `${textbook.displayName} 第${point.unitNo}单元 ${point.unitTitle}`,
      textbookId: textbook.id,
      textbookLabel: textbook.displayName,
      reviewStatus: point.reviewStatus,
      mapped: true,
      ...summarize(grouped.get(point.id) || [])
    }));
    const unmapped = grouped.get("unmapped") || [];
    if (unmapped.length) {
      result.push({
        id: "unmapped",
        name: "待归类",
        unitNo: null,
        unitTitle: "当前教材未覆盖/待归类",
        unit: `${textbook.displayName} · 当前教材未覆盖/待归类`,
        textbookId: textbook.id,
        textbookLabel: textbook.displayName,
        reviewStatus: textbook.reviewStatus,
        mapped: false,
        ...summarize(unmapped)
      });
    }
    return result;
  }

  buildLearningSummary({
    from,
    to,
    knowledgePoint = null,
    studentId = null
  }) {
    const student = this.getStudent(studentId);
    const mistakeClauses = ["m.created_at >= ?", "m.created_at <= ?"];
    const mistakeParameters = [from, to];
    if (student) {
      mistakeClauses.push("m.student_id = ?");
      mistakeParameters.push(student.id);
    }
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
    if (student) {
      attemptClauses.push("m.student_id = ?");
      attemptParameters.push(student.id);
    }
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
    if (student) {
      hintClauses.push("m.student_id = ?");
      hintParameters.push(student.id);
    }
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
    if (student) {
      evidenceClauses.push("m.student_id = ?");
      evidenceParameters.push(student.id);
    }
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

    const legacyClauses = [
      "(e.evidence_type IN ('legacy_backfill', 'legacy_seed') OR e.rule_version = 'legacy')"
    ];
    const legacyParameters = [];
    if (student) {
      legacyClauses.push("m.student_id = ?");
      legacyParameters.push(student.id);
    }
    const legacyEvidence = Number(
      this.db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM mastery_evidence e
           JOIN mistakes m ON m.id = e.mistake_id
           WHERE ${legacyClauses.join(" AND ")}`
        )
        .get(...legacyParameters).count || 0
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

  countDueReviews({ at = nowIso(), studentId = null } = {}) {
    const student = this.getStudent(studentId);
    const clause = student ? " AND m.student_id = ?" : "";
    const parameters = student ? [at, student.id] : [at];
    return Number(
      this.db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM mistakes m
           LEFT JOIN review_schedule rs
             ON rs.mistake_id = m.id AND rs.active = 1
           WHERE COALESCE(rs.next_review_at, m.due_at, m.created_at) <= ?${clause}`
        )
        .get(...parameters).count || 0
    );
  }

  isReportPeriodClosed(reportType, periodKey) {
    if (reportType !== "daily" && reportType !== "weekly") return true;
    return String(periodKey) < localDateKey(nowIso());
  }

  getReportSnapshot(reportType, periodKey, studentId = null) {
    if (!this.isReportPeriodClosed(reportType, periodKey)) return null;
    const student = this.getStudent(studentId);
    if (!student) return null;
    const row = this.db
      .prepare(
        `SELECT payload_json FROM report_snapshots
         WHERE student_id = ? AND report_type = ? AND period_key = ?`
      )
      .get(student.id, reportType, periodKey);
    if (!row) return null;
    try {
      return JSON.parse(row.payload_json);
    } catch {
      return null;
    }
  }

  collectHistoricalReportSnapshots({ studentId = null, textbook = null } = {}) {
    const student = this.getStudent(studentId);
    if (!student) return [];
    const currentTextbook = textbook || student.textbook;
    const activityRows = this.db
      .prepare(
        `SELECT m.created_at AS created_at FROM mistakes m WHERE m.student_id = ?
         UNION ALL
         SELECT a.created_at FROM attempts a
           JOIN mistakes m ON m.id = a.mistake_id WHERE m.student_id = ?
         UNION ALL
         SELECT h.created_at FROM hint_events h
           JOIN mistakes m ON m.id = h.mistake_id WHERE m.student_id = ?
         UNION ALL
         SELECT e.created_at FROM mastery_evidence e
           JOIN mistakes m ON m.id = e.mistake_id WHERE m.student_id = ?`
      )
      .all(student.id, student.id, student.id, student.id);
    const dateKeys = [
      ...new Set(
        activityRows
          .map((row) => row.created_at)
          .filter(Boolean)
          .map((value) => localDateKey(value))
      )
    ].sort();
    const closedPeriodCutoff = localDateKey(nowIso());
    const existing = new Set(
      this.db
        .prepare(
          `SELECT report_type, period_key FROM report_snapshots
           WHERE student_id = ?`
        )
        .all(student.id)
        .map((row) => `${row.report_type}:${row.period_key}`)
    );
    const snapshots = [];
    for (const dateKey of dateKeys) {
      if (dateKey >= closedPeriodCutoff) continue;
      const [year, month, day] = dateKey.split("-").map(Number);
      const dayStart = new Date(year, month - 1, day);
      const dayEnd = new Date(year, month - 1, day + 1);
      if (!existing.has(`daily:${dateKey}`)) {
        const payload = this.buildDailySummary({
          from: dayStart.toISOString(),
          to: dayEnd.toISOString(),
          at: dayEnd.toISOString(),
          studentId: student.id,
          useSnapshot: false
        });
        snapshots.push({
          reportType: "daily",
          periodKey: dateKey,
          payload: withTextbookScope(payload, currentTextbook)
        });
      }
      if (!existing.has(`weekly:${dateKey}`)) {
        const weeklyStart = new Date(year, month - 1, day - 6);
        const payload = this.buildWeeklyReport({
          from: weeklyStart.toISOString(),
          to: dayEnd.toISOString(),
          at: dayEnd.toISOString(),
          studentId: student.id,
          useSnapshot: false
        });
        snapshots.push({
          reportType: "weekly",
          periodKey: dateKey,
          payload: withTextbookScope(payload, currentTextbook)
        });
      }
    }
    return snapshots;
  }

  insertReportSnapshots(snapshots, { studentId, textbook, switchLogId }) {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO report_snapshots (
        student_id, report_type, period_key, textbook_id, textbook_label,
        payload_json, switch_log_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const timestamp = nowIso();
    for (const snapshot of snapshots) {
      insert.run(
        studentId,
        snapshot.reportType,
        snapshot.periodKey,
        textbook?.id ?? null,
        textbook?.displayName || "",
        JSON.stringify(snapshot.payload),
        switchLogId,
        timestamp
      );
    }
    return snapshots.length;
  }

  buildDailySummary({
    from,
    to,
    knowledgePoint = null,
    at = null,
    studentId = null,
    useSnapshot = true
  }) {
    if (useSnapshot) {
      const snapshot = this.getReportSnapshot(
        "daily",
        localDateKey(to),
        studentId
      );
      if (snapshot) return snapshot;
    }
    const summary = this.buildLearningSummary({
      from,
      to,
      knowledgePoint,
      studentId
    });
    const dueCount = this.countDueReviews({ at: at || to, studentId });
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

    const report = {
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
    const student = this.getStudent(studentId);
    return withTextbookScope(report, student?.textbook, "当前教材");
  }

  buildWeeklyReport({
    from,
    to,
    knowledgePoint = null,
    at = null,
    studentId = null,
    useSnapshot = true
  }) {
    if (useSnapshot) {
      const snapshot = this.getReportSnapshot(
        "weekly",
        localDateKey(to),
        studentId
      );
      if (snapshot) return snapshot;
    }
    const summary = this.buildLearningSummary({
      from,
      to,
      knowledgePoint,
      studentId
    });
    const dueCount = this.countDueReviews({ at: at || to, studentId });
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

    const report = {
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
    const student = this.getStudent(studentId);
    return withTextbookScope(report, student?.textbook, "当前教材");
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

export function createRepository(filePath, options) {
  return new LearningRepository(filePath, options);
}
