import {
  applyVocabReview,
  buildDailyReviewQueue,
  resolveDictationPrompt,
  scheduleNewItem,
  toDateKey
} from "./schedule.js";

const nowIso = () => new Date().toISOString();

export class VocabStoreError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const ITEM_SELECT = `
  SELECT i.id, i.student_id, i.subject, i.term_id, i.interval_index,
         i.due_at, i.status, i.consecutive_correct, i.lapses,
         i.source_occurrence_id, i.last_reviewed_at, i.created_at,
         i.updated_at,
         z.word AS zh_word, z.kind AS zh_kind,
         z.pinyin_primary AS zh_pinyin, z.meaning AS zh_meaning,
         e.term AS en_term, e.phonetic AS en_phonetic, e.pos AS en_pos,
         e.meaning_zh AS en_meaning,
         o.pinyin_in_book AS occurrence_pinyin
  FROM vocab_items i
  LEFT JOIN zh_terms z ON z.id = i.term_id AND i.subject = 'chinese'
  LEFT JOIN en_terms e ON e.id = i.term_id AND i.subject = 'english'
  LEFT JOIN zh_occurrences o
    ON o.id = i.source_occurrence_id AND i.subject = 'chinese'
`;

function mapItem(row) {
  const chinese = row.subject === "chinese";
  return {
    id: row.id,
    studentId: row.student_id,
    subject: row.subject,
    termId: row.term_id,
    term: chinese ? row.zh_word : row.en_term,
    kind: chinese ? row.zh_kind : null,
    pinyin: chinese ? row.zh_pinyin || null : null,
    phonetic: chinese ? null : row.en_phonetic || null,
    pos: chinese ? null : row.en_pos || null,
    meaning: (chinese ? row.zh_meaning : row.en_meaning) || "",
    intervalIndex: row.interval_index,
    dueAt: row.due_at,
    status: row.status,
    consecutiveCorrect: row.consecutive_correct,
    lapses: row.lapses,
    sourceOccurrenceId: row.source_occurrence_id,
    lastReviewedAt: row.last_reviewed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    occurrencePinyin: row.occurrence_pinyin || null
  };
}

function localDayBounds(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return {
    start: new Date(year, month - 1, day, 0, 0, 0, 0).toISOString(),
    end: new Date(year, month - 1, day + 1, 0, 0, 0, 0).toISOString()
  };
}

export function createVocabStore(db) {
  const selectItemById = db.prepare(`${ITEM_SELECT} WHERE i.id = ?`);

  function itemRow(studentId, itemId) {
    const row = selectItemById.get(itemId);
    if (!row || row.student_id !== studentId) return null;
    return row;
  }

  function requireItem(studentId, itemId) {
    const row = itemRow(studentId, itemId);
    if (!row) {
      throw new VocabStoreError(
        404,
        "VOCAB_ITEM_NOT_FOUND",
        "没有找到这个字词条目"
      );
    }
    return row;
  }

  function getSettings(studentId) {
    const row = db
      .prepare(
        `SELECT daily_limit, english_mode, updated_at
         FROM vocab_settings WHERE student_id = ?`
      )
      .get(studentId);
    if (row) {
      return {
        dailyLimit: row.daily_limit,
        englishMode: row.english_mode,
        updatedAt: row.updated_at
      };
    }
    db.prepare(
      `INSERT INTO vocab_settings (student_id, daily_limit, english_mode, updated_at)
       VALUES (?, 25, 'zh_to_en', ?)
       ON CONFLICT(student_id) DO NOTHING`
    ).run(studentId, nowIso());
    return getSettings(studentId);
  }

  function updateSettings(studentId, { dailyLimit, englishMode }) {
    const current = getSettings(studentId);
    db.prepare(
      `UPDATE vocab_settings
       SET daily_limit = ?, english_mode = ?, updated_at = ?
       WHERE student_id = ?`
    ).run(
      dailyLimit ?? current.dailyLimit,
      englishMode ?? current.englishMode,
      nowIso(),
      studentId
    );
    return getSettings(studentId);
  }

  function listItems({ studentId, subject = null, status = null }) {
    const clauses = ["i.student_id = ?"];
    const params = [studentId];
    if (subject) {
      clauses.push("i.subject = ?");
      params.push(subject);
    }
    if (status) {
      clauses.push("i.status = ?");
      params.push(status);
    }
    return db
      .prepare(
        `${ITEM_SELECT} WHERE ${clauses.join(" AND ")}
         ORDER BY i.subject, i.due_at, i.id`
      )
      .all(...params)
      .map(mapItem);
  }

  function getItem(studentId, itemId) {
    return mapItem(requireItem(studentId, itemId));
  }

  function findOrCreateZhTerm({ word, kind, pinyin = "", meaning = "" }) {
    const existing = db
      .prepare("SELECT id, pinyin_primary, meaning FROM zh_terms WHERE word = ?")
      .get(word);
    if (existing) {
      if (pinyin && !existing.pinyin_primary) {
        db.prepare(
          "UPDATE zh_terms SET pinyin_primary = ?, updated_at = ? WHERE id = ?"
        ).run(pinyin, nowIso(), existing.id);
      }
      if (meaning && !existing.meaning) {
        db.prepare("UPDATE zh_terms SET meaning = ?, updated_at = ? WHERE id = ?")
          .run(meaning, nowIso(), existing.id);
      }
      return existing.id;
    }
    const timestamp = nowIso();
    return Number(
      db.prepare(
        `INSERT INTO zh_terms (word, kind, pinyin_primary, meaning, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(word, kind, pinyin, meaning, timestamp, timestamp).lastInsertRowid
    );
  }

  function findOrCreateEnTerm({ term, phonetic = "", pos = "", meaning = "" }) {
    const existing = db
      .prepare(
        "SELECT id, phonetic, pos, meaning_zh FROM en_terms WHERE term = ?"
      )
      .get(term);
    if (existing) {
      if (phonetic && !existing.phonetic) {
        db.prepare("UPDATE en_terms SET phonetic = ?, updated_at = ? WHERE id = ?")
          .run(phonetic, nowIso(), existing.id);
      }
      if (pos && !existing.pos) {
        db.prepare("UPDATE en_terms SET pos = ?, updated_at = ? WHERE id = ?")
          .run(pos, nowIso(), existing.id);
      }
      if (meaning && !existing.meaning_zh) {
        db.prepare(
          "UPDATE en_terms SET meaning_zh = ?, updated_at = ? WHERE id = ?"
        ).run(meaning, nowIso(), existing.id);
      }
      return existing.id;
    }
    const timestamp = nowIso();
    return Number(
      db.prepare(
        `INSERT INTO en_terms (term, phonetic, pos, meaning_zh, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(term, phonetic, pos, meaning, timestamp, timestamp).lastInsertRowid
    );
  }

  function requireUnit(subject, unitId) {
    const row = db
      .prepare(
        `SELECT u.id, u.textbook_id, t.subject
         FROM textbook_units u
         JOIN textbooks t ON t.id = u.textbook_id
         WHERE u.id = ?`
      )
      .get(unitId);
    if (!row || row.subject !== subject) {
      throw new VocabStoreError(
        404,
        "VOCAB_UNIT_NOT_FOUND",
        "没有找到对应学科的教材单元"
      );
    }
    return row;
  }

  function requireLesson(subject, lessonId, unitId = null) {
    const row = db
      .prepare(
        `SELECT l.id, l.unit_id, l.textbook_id, t.subject
         FROM textbook_lessons l
         JOIN textbooks t ON t.id = l.textbook_id
         WHERE l.id = ?`
      )
      .get(lessonId);
    if (!row || row.subject !== subject || (unitId && row.unit_id !== unitId)) {
      throw new VocabStoreError(
        404,
        "VOCAB_LESSON_NOT_FOUND",
        "没有找到对应学科的课文"
      );
    }
    return row;
  }

  function requireTerm(subject, termId) {
    const table = subject === "chinese" ? "zh_terms" : "en_terms";
    const row = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(termId);
    if (!row) {
      throw new VocabStoreError(
        404,
        "VOCAB_TERM_NOT_FOUND",
        "没有找到对应学科的词条"
      );
    }
    return row;
  }

  function requireSourceOccurrence(subject, occurrenceId, termId) {
    const table = subject === "chinese" ? "zh_occurrences" : "en_occurrences";
    const row = db
      .prepare(`SELECT id, term_id FROM ${table} WHERE id = ?`)
      .get(occurrenceId);
    if (!row || row.term_id !== termId) {
      throw new VocabStoreError(
        404,
        "VOCAB_OCCURRENCE_NOT_FOUND",
        "没有找到对应学科的词条出现位置"
      );
    }
    return row;
  }

  function upsertZhOccurrence({
    termId,
    textbookId,
    unitId,
    lessonId = null,
    listType,
    pinyinInBook = "",
    position = 0
  }) {
    const existing = db
      .prepare(
        `SELECT id FROM zh_occurrences
         WHERE term_id = ? AND textbook_id = ? AND unit_id = ?
           AND lesson_id IS ? AND list_type = ?`
      )
      .get(termId, textbookId, unitId, lessonId, listType);
    const timestamp = nowIso();
    if (existing) {
      db.prepare(
        `UPDATE zh_occurrences
         SET lesson_id = ?, pinyin_in_book = ?, position = ?, updated_at = ?
         WHERE id = ?`
      ).run(lessonId, pinyinInBook, position, timestamp, existing.id);
      return Number(existing.id);
    }
    return Number(
      db.prepare(
        `INSERT INTO zh_occurrences
         (term_id, textbook_id, unit_id, lesson_id, list_type, pinyin_in_book,
          position, review_status, source_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'unreviewed', '', ?, ?)`
      ).run(
        termId,
        textbookId,
        unitId,
        lessonId,
        listType,
        pinyinInBook,
        position,
        timestamp,
        timestamp
      ).lastInsertRowid
    );
  }

  function upsertEnOccurrence({
    termId,
    textbookId,
    unitId,
    lessonId = null,
    listType,
    position = 0
  }) {
    const existing = db
      .prepare(
        `SELECT id FROM en_occurrences
         WHERE term_id = ? AND textbook_id = ? AND unit_id = ?
           AND lesson_id IS ? AND list_type = ?`
      )
      .get(termId, textbookId, unitId, lessonId, listType);
    const timestamp = nowIso();
    if (existing) {
      db.prepare(
        `UPDATE en_occurrences
         SET lesson_id = ?, position = ?, updated_at = ?
         WHERE id = ?`
      ).run(lessonId, position, timestamp, existing.id);
      return Number(existing.id);
    }
    return Number(
      db.prepare(
        `INSERT INTO en_occurrences
         (term_id, textbook_id, unit_id, lesson_id, list_type, position,
          review_status, source_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'unreviewed', '', ?, ?)`
      ).run(
        termId,
        textbookId,
        unitId,
        lessonId,
        listType,
        position,
        timestamp,
        timestamp
      ).lastInsertRowid
    );
  }

  function createItem({
    studentId,
    subject,
    termId,
    sourceOccurrenceId = null,
    dueAt = null,
    now = new Date()
  }) {
    const due = dueAt || scheduleNewItem({ now }).dueAt;
    const timestamp = nowIso();
    const result = db
      .prepare(
        `INSERT INTO vocab_items
         (student_id, subject, term_id, interval_index, due_at, status,
          consecutive_correct, lapses, source_occurrence_id, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, 'active', 0, 0, ?, ?, ?)
         ON CONFLICT(student_id, subject, term_id) DO NOTHING`
      )
      .run(studentId, subject, termId, due, sourceOccurrenceId, timestamp, timestamp);
    if (Number(result.changes) === 0) {
      const existing = db
        .prepare(
          `SELECT id FROM vocab_items
           WHERE student_id = ? AND subject = ? AND term_id = ?`
        )
        .get(studentId, subject, termId);
      return { item: mapItem(requireItem(studentId, existing.id)), created: false };
    }
    return {
      item: mapItem(requireItem(studentId, Number(result.lastInsertRowid))),
      created: true
    };
  }

  function updateItem({ studentId, itemId, status, dueAt, now = new Date() }) {
    const row = requireItem(studentId, itemId);
    const nextStatus = status ?? row.status;
    let nextDue;
    let nextInterval = row.interval_index;
    let nextConsecutive = row.consecutive_correct;
    if (nextStatus === "mastered") {
      nextDue = null;
    } else if (row.status === "mastered") {
      nextInterval = 0;
      nextConsecutive = 0;
      nextDue = dueAt === undefined ? scheduleNewItem({ now }).dueAt : dueAt;
    } else {
      nextDue = dueAt === undefined ? row.due_at : dueAt;
      if (!nextDue) nextDue = scheduleNewItem({ now }).dueAt;
    }
    db.prepare(
      `UPDATE vocab_items
       SET status = ?, due_at = ?, interval_index = ?, consecutive_correct = ?,
           updated_at = ?
       WHERE id = ?`
    ).run(nextStatus, nextDue, nextInterval, nextConsecutive, nowIso(), itemId);
    return mapItem(requireItem(studentId, itemId));
  }

  function deleteItem(studentId, itemId) {
    requireItem(studentId, itemId);
    db.prepare("DELETE FROM vocab_items WHERE id = ?").run(itemId);
    return true;
  }

  function dueItemRows(studentId, todayKey, subject = null) {
    const subjectClause = subject ? "AND i.subject = ?" : "";
    const params = subject
      ? [studentId, todayKey, subject]
      : [studentId, todayKey];
    return db
      .prepare(
        `${ITEM_SELECT}
         WHERE i.student_id = ? AND i.status = 'active'
           AND i.due_at IS NOT NULL AND i.due_at <= ?
           ${subjectClause}
         ORDER BY i.due_at, i.id`
      )
      .all(...params)
      .map(mapItem);
  }

  function reviewedTodayCount(studentId, todayKey) {
    const bounds = localDayBounds(todayKey);
    return db
      .prepare(
        `SELECT COUNT(DISTINCT e.item_id) AS count
         FROM vocab_review_events e
         JOIN vocab_items i ON i.id = e.item_id
         WHERE i.student_id = ?
           AND e.reviewed_at >= ? AND e.reviewed_at < ?`
      )
      .get(studentId, bounds.start, bounds.end).count;
  }

  function reviewPrompt(item, englishMode) {
    return resolveDictationPrompt({
      subject: item.subject,
      mode: item.subject === "english" ? englishMode : undefined,
      term:
        item.subject === "chinese"
          ? { pinyinPrimary: item.pinyin }
          : { term: item.term, meaningZh: item.meaning },
      occurrence:
        item.subject === "chinese"
          ? { pinyinInBook: item.occurrencePinyin }
          : undefined
    });
  }

  function reviewToday({ studentId, todayKey, englishMode }) {
    const settings = getSettings(studentId);
    const due = dueItemRows(studentId, todayKey);
    const queue = buildDailyReviewQueue({
      items: due,
      todayKey,
      dailyLimit: settings.dailyLimit
    });
    return {
      date: todayKey,
      dailyLimit: settings.dailyLimit,
      dueCount: queue.dueCount,
      deferredCount: queue.deferredCount,
      reviewedToday: reviewedTodayCount(studentId, todayKey),
      items: queue.items.map((item) => ({
        itemId: item.id,
        subject: item.subject,
        prompt: reviewPrompt(item, englishMode || settings.englishMode).prompt,
        intervalIndex: item.intervalIndex,
        dueAt: item.dueAt
      }))
    };
  }

  function submitReviews({
    studentId,
    reviews,
    surface = "web",
    now = new Date()
  }) {
    const todayKey = toDateKey(now);
    const bounds = localDayBounds(todayKey);
    const ids = reviews.map((review) => review.itemId);
    const placeholders = ids.map(() => "?").join(", ");
    const owned = new Set(
      db
        .prepare(
          `SELECT id FROM vocab_items
           WHERE student_id = ? AND id IN (${placeholders})`
        )
        .all(studentId, ...ids)
        .map((row) => row.id)
    );
    const missing = ids.find((id) => !owned.has(id));
    if (missing !== undefined) {
      throw new VocabStoreError(
        404,
        "VOCAB_ITEM_NOT_FOUND",
        `没有找到字词条目 ${missing}`
      );
    }

    const selectTodayEvents = db.prepare(
      `SELECT result, interval_before FROM vocab_review_events
       WHERE item_id = ? AND reviewed_at >= ? AND reviewed_at < ?
       ORDER BY id`
    );
    const update = db.prepare(
      `UPDATE vocab_items
       SET interval_index = ?, due_at = ?, status = ?, consecutive_correct = ?,
           lapses = ?, last_reviewed_at = ?, updated_at = ?
       WHERE id = ?`
    );
    const insertEvent = db.prepare(
      `INSERT INTO vocab_review_events
       (item_id, result, surface, reviewed_at, interval_before, interval_after)
       VALUES (?, ?, ?, ?, ?, ?)`
    );

    db.exec("BEGIN IMMEDIATE");
    try {
      for (const review of reviews) {
        const row = requireItem(studentId, review.itemId);
        const todayEvents = selectTodayEvents.all(
          review.itemId,
          bounds.start,
          bounds.end
        );
        const baselineInterval =
          todayEvents.length > 0
            ? todayEvents[0].interval_before
            : row.interval_index;
        const earlierIncorrect = todayEvents.filter(
          (event) => event.result === "incorrect"
        ).length;
        const baselineLapses = Math.max(0, row.lapses - earlierIncorrect);
        const next = applyVocabReview({
          item: { intervalIndex: baselineInterval, lapses: baselineLapses },
          result: review.result,
          now
        });
        update.run(
          next.intervalIndex,
          next.dueAt,
          next.status,
          next.consecutiveCorrect,
          next.lapses,
          next.lastReviewedAt,
          nowIso(),
          review.itemId
        );
        insertEvent.run(
          review.itemId,
          review.result,
          review.surface || surface,
          next.lastReviewedAt,
          baselineInterval,
          next.intervalIndex
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    return {
      updated: reviews.map((review) => {
        const item = mapItem(requireItem(studentId, review.itemId));
        return {
          itemId: item.id,
          status: item.status,
          intervalIndex: item.intervalIndex,
          dueAt: item.dueAt
        };
      })
    };
  }

  function occurrenceRows({ subject, unitId, lessonId }) {
    const chinese = subject === "chinese";
    const table = chinese ? "zh_occurrences" : "en_occurrences";
    const terms = chinese ? "zh_terms" : "en_terms";
    const termColumns = chinese
      ? "z.word, z.kind, z.pinyin_primary, z.meaning, NULL AS phonetic, NULL AS pos, NULL AS meaning_zh"
      : "e.term AS word, NULL AS kind, NULL AS pinyin_primary, NULL AS meaning, e.phonetic, e.pos, e.meaning_zh";
    const pinyinColumn = chinese
      ? "o.pinyin_in_book"
      : "'' AS pinyin_in_book";
    const joinKey = chinese ? "z.id = o.term_id" : "e.id = o.term_id";
    const filters = [];
    const params = [];
    if (lessonId) {
      filters.push("o.lesson_id = ?");
      params.push(lessonId);
    } else if (unitId) {
      filters.push("o.unit_id = ?");
      params.push(unitId);
    } else {
      return [];
    }
    return db
      .prepare(
        `SELECT o.id AS occurrence_id, o.term_id, o.unit_id, o.lesson_id,
                o.list_type, o.position, ${pinyinColumn}, ${termColumns}
         FROM ${table} o
         JOIN ${terms} ${chinese ? "z" : "e"} ON ${joinKey}
         WHERE ${filters.join(" AND ")}
         ORDER BY o.lesson_id, o.position, o.id`
      )
      .all(...params);
  }

  function itemIdForTerm({ studentId, subject, termId, occurrenceId }) {
    const byOccurrence = db
      .prepare(
        `SELECT id FROM vocab_items
         WHERE student_id = ? AND subject = ? AND term_id = ?
           AND source_occurrence_id = ?
         ORDER BY id LIMIT 1`
      )
      .get(studentId, subject, termId, occurrenceId);
    if (byOccurrence) return byOccurrence.id;
    const byTerm = db
      .prepare(
        `SELECT id FROM vocab_items
         WHERE student_id = ? AND subject = ? AND term_id = ?
         ORDER BY id LIMIT 1`
      )
      .get(studentId, subject, termId);
    return byTerm ? byTerm.id : null;
  }

  function dictation({
    studentId,
    subject,
    mode,
    unitId = null,
    lessonId = null,
    todayKey,
    englishMode
  }) {
    const settings = getSettings(studentId);
    const resolvedMode =
      subject === "chinese"
        ? "pinyin_to_hanzi"
        : mode || englishMode || settings.englishMode;
    const items = [];
    if (unitId || lessonId) {
      const rows = occurrenceRows({ subject, unitId, lessonId });
      for (const row of rows) {
        const term =
          subject === "chinese"
            ? {
                pinyinPrimary: row.pinyin_primary,
                word: row.word
              }
            : {
                term: row.word,
                meaningZh: row.meaning_zh
              };
        const prompt = resolveDictationPrompt({
          subject,
          mode: resolvedMode,
          term,
          occurrence:
            subject === "chinese"
              ? { pinyinInBook: row.pinyin_in_book }
              : undefined
        });
        items.push({
          itemId: itemIdForTerm({
            studentId,
            subject,
            termId: row.term_id,
            occurrenceId: row.occurrence_id
          }),
          occurrenceId: row.occurrence_id,
          termId: row.term_id,
          unitId: row.unit_id,
          lessonId: row.lesson_id,
          listType: row.list_type,
          position: row.position,
          prompt: prompt.prompt
        });
      }
      return { subject, mode: resolvedMode, items };
    }

    const due = dueItemRows(studentId, todayKey, subject);
    const queue = buildDailyReviewQueue({
      items: due,
      todayKey,
      dailyLimit: settings.dailyLimit
    });
    for (const item of queue.items) {
      items.push({
        itemId: item.id,
        termId: item.termId,
        unitId: null,
        lessonId: null,
        intervalIndex: item.intervalIndex,
        dueAt: item.dueAt,
        prompt: reviewPrompt(item, resolvedMode).prompt
      });
    }
    return { subject, mode: resolvedMode, items };
  }

  return {
    getSettings,
    updateSettings,
    listItems,
    getItem,
    findOrCreateZhTerm,
    findOrCreateEnTerm,
    requireUnit,
    requireLesson,
    requireTerm,
    requireSourceOccurrence,
    upsertZhOccurrence,
    upsertEnOccurrence,
    createItem,
    updateItem,
    deleteItem,
    reviewToday,
    submitReviews,
    dictation
  };
}
