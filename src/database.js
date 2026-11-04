import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  answersMatch,
  diagnoseMistake
} from "./agent.js";
import {
  getSchemaVersion,
  migrateDatabase
} from "./migrations.js";

const nowIso = () => new Date().toISOString();

const toIsoAfterDays = (days) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
};

function parseJson(text) {
  if (!text) return [];
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function mapMistake(row, { includeSolution = false } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    question: row.question,
    studentAnswer: row.student_answer,
    correctAnswer: includeSolution ? row.correct_answer : undefined,
    analysis: includeSolution ? row.analysis : "",
    knowledgePoint: row.knowledge_point,
    errorType: row.error_type,
    hint: includeSolution ? row.hint : "",
    methodSteps: includeSolution ? parseJson(row.method_steps) : [],
    commonErrors: includeSolution ? parseJson(row.common_errors) : [],
    diagnosis: includeSolution ? row.diagnosis : "",
    status: row.status,
    consecutiveCorrect: row.consecutive_correct,
    attemptCount: row.attempt_count,
    dueAt: row.due_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastReviewedAt: row.last_reviewed_at
  };
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

  createMistake(input) {
    const student = this.getStudent();
    const diagnosis = diagnoseMistake(input);
    const timestamp = nowIso();
    const result = this.db
      .prepare(
        `INSERT INTO mistakes (
          student_id, question, student_answer, correct_answer, analysis,
          knowledge_point, error_type, hint, method_steps, common_errors,
          diagnosis, status, due_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', NULL, ?, ?)`
      )
      .run(
        student.id,
        input.question,
        input.studentAnswer || "",
        input.correctAnswer,
        input.analysis || "",
        diagnosis.knowledgePoint,
        diagnosis.errorType,
        diagnosis.hint,
        JSON.stringify(diagnosis.methodSteps),
        JSON.stringify(diagnosis.commonErrors),
        diagnosis.diagnosis,
        timestamp,
        timestamp
      );

    return this.getMistake(Number(result.lastInsertRowid), {
      includeSolution: true
    });
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
    return mapMistake(row, { includeSolution });
  }

  listMistakes({ status = "all" } = {}) {
    const validStatus = ["new", "practicing", "mastered"].includes(status)
      ? status
      : "all";
    const where = validStatus === "all" ? "" : "WHERE m.status = ?";
    const statement = this.db.prepare(
      `SELECT m.*, k.name AS knowledge_point
       FROM mistakes m
       JOIN knowledge_points k ON k.name = m.knowledge_point
       ${where}
       ORDER BY
         CASE m.status WHEN 'new' THEN 0 WHEN 'practicing' THEN 1 ELSE 2 END,
         COALESCE(m.due_at, m.created_at) ASC,
         m.id DESC`
    );
    const rows =
      validStatus === "all" ? statement.all() : statement.all(validStatus);
    return rows.map((row) => mapMistake(row));
  }

  deleteMistake(id) {
    const result = this.db.prepare("DELETE FROM mistakes WHERE id = ?").run(id);
    return result.changes > 0;
  }

  getNextReview() {
    const timestamp = nowIso();
    const row = this.db
      .prepare(
        `SELECT m.*, k.name AS knowledge_point
         FROM mistakes m
         JOIN knowledge_points k ON k.name = m.knowledge_point
         WHERE m.status != 'mastered'
           AND (m.due_at IS NULL OR m.due_at <= ?)
         ORDER BY
           CASE WHEN m.attempt_count = 0 THEN 0 ELSE 1 END,
           COALESCE(m.due_at, m.created_at) ASC,
           m.id ASC
         LIMIT 1`
      )
      .get(timestamp);
    return mapMistake(row, { includeSolution: true });
  }

  recordAttempt(id, answer) {
    const mistake = this.getMistake(id, { includeSolution: true });
    if (!mistake) {
      return null;
    }

    const correct = answersMatch(answer, mistake.correctAnswer);
    const timestamp = nowIso();
    const nextConsecutiveCorrect = correct
      ? mistake.consecutiveCorrect + 1
      : 0;
    const mastered = correct && nextConsecutiveCorrect >= 2;
    const nextStatus = mastered ? "mastered" : "practicing";
    const dueDays = correct ? (mastered ? 7 : 1) : 1;
    const dueAt = mastered ? toIsoAfterDays(7) : toIsoAfterDays(dueDays);
    const feedback = correct
      ? mastered
        ? "连续两次独立做对，已标记为掌握。7 天后再回顾一次。"
        : "这次做对了。明天再独立做一次，确认不是临时记住答案。"
      : "这次还没做对。先对照讲解补全缺失步骤，明天再独立重做。";

    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT INTO attempts
           (mistake_id, answer, is_correct, outcome, evaluation_source,
            feedback, created_at)
           VALUES (?, ?, ?, ?, 'rule', ?, ?)`
        )
        .run(
          id,
          String(answer || ""),
          correct ? 1 : 0,
          correct ? "correct" : "incorrect",
          feedback,
          timestamp
        );
      this.db
        .prepare(
          `UPDATE mistakes
           SET status = ?, consecutive_correct = ?, attempt_count = attempt_count + 1,
               due_at = ?, last_reviewed_at = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          nextStatus,
          nextConsecutiveCorrect,
          dueAt,
          timestamp,
          timestamp,
          id
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return {
      correct,
      mastered,
      feedback,
      answer: mistake.correctAnswer,
      analysis: mistake.analysis,
      hint: mistake.hint,
      methodSteps: mistake.methodSteps,
      commonErrors: mistake.commonErrors,
      diagnosis: mistake.diagnosis,
      nextReviewAt: dueAt,
      mistake: this.getMistake(id)
    };
  }

  getDashboard() {
    const timestamp = nowIso();
    const counts = this.db
      .prepare(
        `SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) AS new_count,
          SUM(CASE WHEN status = 'practicing' THEN 1 ELSE 0 END) AS practicing_count,
          SUM(CASE WHEN status = 'mastered' THEN 1 ELSE 0 END) AS mastered_count,
          SUM(CASE WHEN status != 'mastered'
                    AND (due_at IS NULL OR due_at <= ?)
                   THEN 1 ELSE 0 END) AS due_count
         FROM mistakes`
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
      const newCount = items.filter((item) => item.status === "new").length;
      const score = items.length
        ? Math.round(
            items.reduce((total, item) => {
              if (item.status === "mastered") return total + 100;
              if (item.status === "practicing") {
                return total + Math.min(80, 25 + item.consecutive_correct * 25);
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
        mastered,
        mastery: score
      };
    });
  }

  addDemoData() {
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
