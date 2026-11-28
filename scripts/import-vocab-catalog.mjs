import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LearningRepository } from "../src/database.js";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

const SUBJECTS = new Set(["chinese", "english"]);
const SEMESTERS = new Set(["full", "upper", "lower"]);
const REVIEW_STATUSES = new Set([
  "unreviewed",
  "self_reviewed",
  "teacher_reviewed"
]);
const ZH_LIST_TYPES = new Set(["会认", "会写", "词语"]);
const EN_LIST_TYPES = new Set(["单词", "短语"]);

function text(value, label, { required = true } = {}) {
  const result = String(value ?? "").trim();
  if (required && !result) throw new Error(`缺少${label}`);
  return result;
}

function positiveInt(value, label) {
  const result = Number(value);
  if (!Number.isInteger(result) || result <= 0) {
    throw new Error(`${label} 必须是正整数`);
  }
  return result;
}

function reviewStatus(value, fallback, label) {
  const status = text(value ?? fallback, `${label} review_status`);
  if (!REVIEW_STATUSES.has(status)) {
    throw new Error(`${label} review_status 无效：${status}`);
  }
  return status;
}

export function importVocabCatalog(db, catalog) {
  if (!catalog || !Array.isArray(catalog.textbooks)) {
    throw new Error("目录文件缺少 textbooks 数组");
  }
  const meta = catalog.meta || {};
  const metaReviewStatus = reviewStatus(
    meta.reviewStatus ?? "unreviewed",
    "unreviewed",
    "meta"
  );
  const timestamp = new Date().toISOString();
  const stats = {
    textbooks: 0,
    units: 0,
    lessons: 0,
    terms: 0,
    occurrences: 0
  };

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const textbook of catalog.textbooks) {
      const subject = text(textbook.subject, "subject");
      if (!SUBJECTS.has(subject)) {
        throw new Error(`subject 只能是 chinese 或 english：${subject}`);
      }
      const semester = text(textbook.semester, "semester");
      if (!SEMESTERS.has(semester)) {
        throw new Error(`semester 无效：${semester}`);
      }
      const textbookKey = text(textbook.textbookKey, "textbookKey");
      const textbookStatus = reviewStatus(
        textbook.reviewStatus,
        metaReviewStatus,
        textbookKey
      );
      db.prepare(
        `INSERT INTO textbooks
         (textbook_key, edition_key, publisher, edition, grade, semester,
          display_name, selectable, review_status, source_key, subject,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
         ON CONFLICT(textbook_key) DO UPDATE SET
           edition_key = excluded.edition_key,
           publisher = excluded.publisher,
           edition = excluded.edition,
           grade = excluded.grade,
           semester = excluded.semester,
           display_name = excluded.display_name,
           review_status = excluded.review_status,
           source_key = excluded.source_key,
           subject = excluded.subject,
           updated_at = excluded.updated_at`
      ).run(
        textbookKey,
        text(textbook.editionKey, "editionKey"),
        text(textbook.publisher, "publisher"),
        text(textbook.edition, "edition"),
        positiveInt(textbook.grade, "grade"),
        semester,
        text(textbook.displayName, "displayName"),
        textbookStatus,
        text(textbook.sourceKey ?? textbookKey, "sourceKey"),
        subject,
        timestamp,
        timestamp
      );
      const textbookId = db
        .prepare("SELECT id FROM textbooks WHERE textbook_key = ?")
        .get(textbookKey).id;
      stats.textbooks += 1;

      for (const unit of textbook.units || []) {
        const unitNo = positiveInt(unit.unitNo, "unitNo");
        const unitStatus = reviewStatus(
          unit.reviewStatus,
          textbookStatus,
          `单元 ${unitNo}`
        );
        db.prepare(
          `INSERT INTO textbook_units
           (textbook_id, unit_no, title, position, review_status, source_key,
            note, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(textbook_id, unit_no) DO UPDATE SET
             title = excluded.title,
             position = excluded.position,
             review_status = excluded.review_status,
             source_key = excluded.source_key,
             note = excluded.note,
             updated_at = excluded.updated_at`
        ).run(
          textbookId,
          unitNo,
          text(unit.title, `单元 ${unitNo} 标题`),
          Number.isInteger(unit.position) ? unit.position : unitNo,
          unitStatus,
          text(unit.sourceKey ?? `${textbookKey}:u${unitNo}`, "sourceKey"),
          text(unit.note, "note", { required: false }),
          timestamp,
          timestamp
        );
        const unitId = db
          .prepare(
            "SELECT id FROM textbook_units WHERE textbook_id = ? AND unit_no = ?"
          )
          .get(textbookId, unitNo).id;
        stats.units += 1;

        const lessonIds = new Map();
        for (const lesson of unit.lessons || []) {
          const lessonNo = positiveInt(lesson.lessonNo, "lessonNo");
          const lessonStatus = reviewStatus(
            lesson.reviewStatus,
            unitStatus,
            `课文 ${lessonNo}`
          );
          db.prepare(
            `INSERT INTO textbook_lessons
             (textbook_id, unit_id, lesson_no, title, position, review_status,
              source_key, note, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(unit_id, lesson_no) DO UPDATE SET
               title = excluded.title,
               position = excluded.position,
               review_status = excluded.review_status,
               source_key = excluded.source_key,
               note = excluded.note,
               updated_at = excluded.updated_at`
          ).run(
            textbookId,
            unitId,
            lessonNo,
            text(lesson.title, `课文 ${lessonNo} 标题`),
            Number.isInteger(lesson.position) ? lesson.position : lessonNo,
            lessonStatus,
            text(
              lesson.sourceKey ?? `${textbookKey}:u${unitNo}:l${lessonNo}`,
              "sourceKey"
            ),
            text(lesson.note, "note", { required: false }),
            timestamp,
            timestamp
          );
          lessonIds.set(
            lessonNo,
            db
              .prepare(
                "SELECT id FROM textbook_lessons WHERE unit_id = ? AND lesson_no = ?"
              )
              .get(unitId, lessonNo).id
          );
          stats.lessons += 1;
        }

        const chinese = subject === "chinese";
        const entries = unit.entries || [];
        entries.forEach((entry, index) => {
          const termText = text(
            entry.term ?? entry.word,
            `单元 ${unitNo} 第 ${index + 1} 条词条`
          );
          const listType = text(
            entry.listType ?? (chinese ? "会写" : "单词"),
            "listType"
          );
          const validListTypes = chinese ? ZH_LIST_TYPES : EN_LIST_TYPES;
          if (!validListTypes.has(listType)) {
            throw new Error(`listType 无效：${listType}`);
          }
          const entryStatus = reviewStatus(
            entry.reviewStatus,
            unitStatus,
            `词条 ${termText}`
          );
          const lessonNo =
            entry.lessonNo === undefined || entry.lessonNo === null
              ? null
              : positiveInt(entry.lessonNo, "lessonNo");
          if (lessonNo !== null && !lessonIds.has(lessonNo)) {
            throw new Error(`词条 ${termText} 引用了不存在的课文 ${lessonNo}`);
          }
          const position = Number.isInteger(entry.position)
            ? entry.position
            : index + 1;
          const sourceKey = text(
            entry.sourceKey ??
              `${textbookKey}:u${unitNo}:l${lessonNo ?? 0}:${listType}:${position}`,
            "sourceKey"
          );

          let termId;
          if (chinese) {
            const kind = text(entry.kind ?? "", "kind", { required: false });
            if (kind && kind !== "char" && kind !== "word") {
              throw new Error(`kind 只能是 char 或 word：${kind}`);
            }
            db.prepare(
              `INSERT INTO zh_terms
               (word, kind, pinyin_primary, meaning, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(word) DO UPDATE SET
                 kind = excluded.kind,
                 pinyin_primary = CASE
                   WHEN excluded.pinyin_primary = '' THEN zh_terms.pinyin_primary
                   ELSE excluded.pinyin_primary END,
                 meaning = CASE
                   WHEN excluded.meaning = '' THEN zh_terms.meaning
                   ELSE excluded.meaning END,
                 updated_at = excluded.updated_at`
            ).run(
              termText,
              kind || ([...termText].length === 1 ? "char" : "word"),
              text(entry.pinyin, "pinyin", { required: false }),
              text(entry.meaning, "meaning", { required: false }),
              timestamp,
              timestamp
            );
            termId = db
              .prepare("SELECT id FROM zh_terms WHERE word = ?")
              .get(termText).id;
            db.prepare(
              `INSERT INTO zh_occurrences
               (term_id, textbook_id, unit_id, lesson_id, list_type,
                pinyin_in_book, position, review_status, source_key,
                created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(term_id, textbook_id, unit_id, list_type)
               DO UPDATE SET
                 lesson_id = excluded.lesson_id,
                 pinyin_in_book = excluded.pinyin_in_book,
                 position = excluded.position,
                 review_status = excluded.review_status,
                 source_key = excluded.source_key,
                 updated_at = excluded.updated_at`
            ).run(
              termId,
              textbookId,
              unitId,
              lessonNo === null ? null : lessonIds.get(lessonNo),
              listType,
              text(entry.pinyinInBook ?? entry.pinyin, "pinyinInBook", {
                required: false
              }),
              position,
              entryStatus,
              sourceKey,
              timestamp,
              timestamp
            );
          } else {
            db.prepare(
              `INSERT INTO en_terms
               (term, phonetic, pos, meaning_zh, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(term) DO UPDATE SET
                 phonetic = CASE
                   WHEN excluded.phonetic = '' THEN en_terms.phonetic
                   ELSE excluded.phonetic END,
                 pos = CASE
                   WHEN excluded.pos = '' THEN en_terms.pos
                   ELSE excluded.pos END,
                 meaning_zh = CASE
                   WHEN excluded.meaning_zh = '' THEN en_terms.meaning_zh
                   ELSE excluded.meaning_zh END,
                 updated_at = excluded.updated_at`
            ).run(
              termText,
              text(entry.phonetic, "phonetic", { required: false }),
              text(entry.pos, "pos", { required: false }),
              text(entry.meaning, "meaning", { required: false }),
              timestamp,
              timestamp
            );
            termId = db
              .prepare("SELECT id FROM en_terms WHERE term = ?")
              .get(termText).id;
            db.prepare(
              `INSERT INTO en_occurrences
               (term_id, textbook_id, unit_id, lesson_id, list_type,
                position, review_status, source_key, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(term_id, textbook_id, unit_id, list_type)
               DO UPDATE SET
                 lesson_id = excluded.lesson_id,
                 position = excluded.position,
                 review_status = excluded.review_status,
                 source_key = excluded.source_key,
                 updated_at = excluded.updated_at`
            ).run(
              termId,
              textbookId,
              unitId,
              lessonNo === null ? null : lessonIds.get(lessonNo),
              listType,
              position,
              entryStatus,
              sourceKey,
              timestamp,
              timestamp
            );
          }
          stats.terms += 1;
          stats.occurrences += 1;
        });
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return stats;
}

function parseArgs(argv) {
  const options = {
    file: path.join(projectRoot, "data", "vocab", "sample.json"),
    db: path.join(projectRoot, "data", "learning.sqlite")
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--file" || arg === "--db") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} 缺少参数值`);
      options[arg.slice(2)] = path.resolve(value);
      index += 1;
    } else if (arg.startsWith("--file=") || arg.startsWith("--db=")) {
      const [key, value] = arg.slice(2).split("=");
      options[key] = path.resolve(value);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const raw = fs.readFileSync(options.file, "utf8").replace(/^\uFEFF/, "");
  const catalog = JSON.parse(raw);
  const repository = new LearningRepository(options.db);
  try {
    const stats = importVocabCatalog(repository.db, catalog);
    console.log(
      JSON.stringify(
        {
          file: options.file,
          database: options.db,
          schemaVersion: repository.getSchemaVersion(),
          stats
        },
        null,
        2
      )
    );
  } finally {
    repository.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
