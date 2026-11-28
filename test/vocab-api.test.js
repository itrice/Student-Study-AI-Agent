import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LearningRepository } from "../src/database.js";
import { addDays, toDateKey } from "../src/vocab/schedule.js";
import { importVocabCatalog } from "../scripts/import-vocab-catalog.mjs";
import {
  startServer,
  stopServer
} from "./helpers/http-fixture.js";

const TODAY = toDateKey(new Date());
const TOMORROW = addDays(TODAY, 1);

const VOCAB_SEED = {
  meta: { reviewStatus: "unreviewed" },
  textbooks: [
    {
      textbookKey: "test-zh-6",
      subject: "chinese",
      editionKey: "test-edition-zh",
      publisher: "测试出版社",
      edition: "测试版",
      grade: 6,
      semester: "upper",
      displayName: "测试语文六年级上册",
      units: [
        {
          unitNo: 1,
          title: "第一单元",
          lessons: [
            { lessonNo: 1, title: "课文一" },
            { lessonNo: 2, title: "课文二" }
          ],
          entries: [
            {
              term: "山",
              kind: "char",
              pinyin: "shān",
              listType: "会写",
              lessonNo: 1,
              position: 1
            },
            {
              term: "月亮",
              kind: "word",
              pinyin: "yuè liàng",
              pinyinInBook: "yuè liang",
              listType: "词语",
              lessonNo: 2,
              position: 2
            }
          ]
        }
      ]
    },
    {
      textbookKey: "test-en-6",
      subject: "english",
      editionKey: "test-edition-en",
      publisher: "测试出版社",
      edition: "测试版",
      grade: 6,
      semester: "upper",
      displayName: "测试英语六年级上册",
      units: [
        {
          unitNo: 1,
          title: "Unit 1",
          lessons: [{ lessonNo: 1, title: "Part A" }],
          entries: [
            {
              term: "apple",
              phonetic: "ˈæpl",
              pos: "n.",
              meaning: "苹果",
              listType: "单词",
              lessonNo: 1,
              position: 1
            },
            {
              term: "banana",
              phonetic: "bəˈnɑːnə",
              pos: "n.",
              meaning: "香蕉",
              listType: "单词",
              lessonNo: 1,
              position: 2
            }
          ]
        }
      ]
    }
  ]
};

function seedDatabase(directory) {
  const repository = new LearningRepository(
    path.join(directory, "learning.sqlite")
  );
  try {
    importVocabCatalog(repository.db, VOCAB_SEED);
    const queryOne = (sql, ...params) =>
      repository.db.prepare(sql).get(...params).id;
    const zhUnitId = queryOne(
      `SELECT id FROM textbook_units
       WHERE textbook_id = (SELECT id FROM textbooks WHERE textbook_key = 'test-zh-6')
         AND unit_no = 1`
    );
    const enUnitId = queryOne(
      `SELECT id FROM textbook_units
       WHERE textbook_id = (SELECT id FROM textbooks WHERE textbook_key = 'test-en-6')
         AND unit_no = 1`
    );
    return {
      zhUnitId,
      zhLesson1Id: queryOne(
        "SELECT id FROM textbook_lessons WHERE unit_id = ? AND lesson_no = 1",
        zhUnitId
      ),
      zhLesson2Id: queryOne(
        "SELECT id FROM textbook_lessons WHERE unit_id = ? AND lesson_no = 2",
        zhUnitId
      ),
      enUnitId,
      enLessonId: queryOne(
        "SELECT id FROM textbook_lessons WHERE unit_id = ? AND lesson_no = 1",
        enUnitId
      )
    };
  } finally {
    repository.close();
  }
}

async function withVocabServer(callback, { seed = false } = {}) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "math-coach-vocab-http-")
  );
  try {
    const seedIds = seed ? seedDatabase(directory) : null;
    const server = await startServer({
      directory,
      prefix: "math-coach-vocab-http-"
    });
    try {
      return await callback({ ...server, seedIds });
    } finally {
      await stopServer(server.child);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function api(server, pathname, { method = "GET", body } = {}) {
  const response = await fetch(`${server.baseUrl}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, data: await response.json() };
}

test("字词设置默认每日 25 条、默认中译英并校验范围", async () => {
  await withVocabServer(async (server) => {
    const defaults = await api(server, "/api/vocab/settings");
    assert.equal(defaults.status, 200);
    assert.equal(defaults.data.dailyLimit, 25);
    assert.equal(defaults.data.englishMode, "zh_to_en");

    assert.equal(
      (await api(server, "/api/vocab/settings", { method: "PUT", body: {} }))
        .status,
      400
    );
    for (const dailyLimit of [4, 0, 101, 3.5]) {
      const invalid = await api(server, "/api/vocab/settings", {
        method: "PUT",
        body: { dailyLimit }
      });
      assert.equal(invalid.status, 400);
    }
    assert.equal(
      (
        await api(server, "/api/vocab/settings", {
          method: "PUT",
          body: { englishMode: "pinyin" }
        })
      ).status,
      400
    );

    const updated = await api(server, "/api/vocab/settings", {
      method: "PUT",
      body: { dailyLimit: 10 }
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.dailyLimit, 10);
    assert.equal(updated.data.englishMode, "zh_to_en");

    const modeUpdated = await api(server, "/api/vocab/settings", {
      method: "PUT",
      body: { englishMode: "en_to_zh" }
    });
    assert.equal(modeUpdated.data.englishMode, "en_to_zh");
    assert.equal(modeUpdated.data.dailyLimit, 10);
  });
});

test("批量粘贴录入去重重复词条并默认次日到期", async () => {
  await withVocabServer(async (server) => {
    const pasted = await api(server, "/api/vocab/items", {
      method: "POST",
      body: {
        subject: "chinese",
        text: "# 单元一生字\n山 shān 高山\n水 shuǐ\n\n"
      }
    });
    assert.equal(pasted.status, 201);
    assert.equal(pasted.data.created, 2);
    assert.equal(pasted.data.existing, 0);
    const [mountain, water] = pasted.data.items;
    assert.equal(mountain.term, "山");
    assert.equal(mountain.kind, "char");
    assert.equal(mountain.pinyin, "shān");
    assert.equal(mountain.meaning, "高山");
    assert.equal(mountain.dueAt, TOMORROW);
    assert.equal(mountain.status, "active");
    assert.equal(water.term, "水");
    assert.equal(water.pinyin, "shuǐ");

    const repeated = await api(server, "/api/vocab/items", {
      method: "POST",
      body: { subject: "chinese", text: "山 shān 高山\n水 shuǐ" }
    });
    assert.equal(repeated.status, 201);
    assert.equal(repeated.data.created, 0);
    assert.equal(repeated.data.existing, 2);
    assert.deepEqual(
      repeated.data.items.map((item) => item.id),
      pasted.data.items.map((item) => item.id)
    );

    const english = await api(server, "/api/vocab/items", {
      method: "POST",
      body: { subject: "english", text: "apple 苹果\nbanana 香蕉" }
    });
    assert.equal(english.data.created, 2);
    assert.deepEqual(
      english.data.items.map((item) => [item.term, item.meaning]),
      [
        ["apple", "苹果"],
        ["banana", "香蕉"]
      ]
    );

    const chineseList = await api(
      server,
      "/api/vocab/items?subject=chinese&status=active"
    );
    assert.equal(chineseList.data.count, 2);
    assert.equal(
      (await api(server, "/api/vocab/items?subject=math")).status,
      400
    );
    assert.equal(
      (await api(server, "/api/vocab/items?status=done")).status,
      400
    );
    assert.equal(
      (
        await api(server, "/api/vocab/items", {
          method: "POST",
          body: { subject: "chinese", text: "   \n# 只有注释" }
        })
      ).status,
      400
    );
  });
});

test("到期清单最旧优先、按上限截断且不提前泄露答案", async () => {
  await withVocabServer(async (server) => {
    await api(server, "/api/vocab/settings", {
      method: "PUT",
      body: { dailyLimit: 5 }
    });
    const entries = Array.from({ length: 6 }, (_, index) => ({
      term: `字${index + 1}`,
      pinyin: `zi${index + 1}`
    }));
    const created = await api(server, "/api/vocab/items", {
      method: "POST",
      body: { subject: "chinese", dueAt: TODAY, entries }
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.created, 6);
    await api(server, "/api/vocab/items", {
      method: "POST",
      body: { subject: "chinese", term: "新词", pinyin: "xin" }
    });

    const today = await api(server, "/api/vocab/review/today");
    assert.equal(today.status, 200);
    assert.equal(today.data.date, TODAY);
    assert.equal(today.data.dailyLimit, 5);
    assert.equal(today.data.dueCount, 6);
    assert.equal(today.data.deferredCount, 1);
    assert.equal(today.data.items.length, 5);
    assert.deepEqual(
      today.data.items.map((item) => item.prompt),
      ["zi1", "zi2", "zi3", "zi4", "zi5"]
    );
    for (const entry of today.data.items) {
      assert.equal(entry.subject, "chinese");
      assert.equal("answer" in entry, false);
      assert.equal("term" in entry, false);
    }
    assert.equal(JSON.stringify(today.data).includes("新词"), false);

    const listed = await api(server, "/api/vocab/review/today?date=2026-02-30");
    assert.equal(listed.status, 400);
  });
});

test("同日重复提交以最后一次为准，历史事件保留", async () => {
  await withVocabServer(async (server) => {
    const created = await api(server, "/api/vocab/items", {
      method: "POST",
      body: { subject: "chinese", term: "甲", pinyin: "jiǎ" }
    });
    const itemId = created.data.items[0].id;

    const first = await api(server, "/api/vocab/reviews", {
      method: "POST",
      body: { reviews: [{ itemId, result: "correct" }] }
    });
    assert.equal(first.status, 200);
    assert.equal(first.data.updated[0].intervalIndex, 1);
    assert.equal(first.data.updated[0].status, "active");
    assert.equal(first.data.updated[0].dueAt, addDays(TODAY, 2));

    const second = await api(server, "/api/vocab/reviews", {
      method: "POST",
      body: { reviews: [{ itemId, result: "incorrect", surface: "eink" }] }
    });
    assert.equal(second.status, 200);
    assert.equal(second.data.updated[0].intervalIndex, 0);
    assert.equal(second.data.updated[0].dueAt, TOMORROW);

    const third = await api(server, "/api/vocab/reviews", {
      method: "POST",
      body: { reviews: [{ itemId, result: "correct" }] }
    });
    assert.equal(third.data.updated[0].intervalIndex, 1);
    assert.equal(third.data.updated[0].dueAt, addDays(TODAY, 2));

    const items = await api(server, "/api/vocab/items?subject=chinese");
    const item = items.data.items.find((entry) => entry.id === itemId);
    assert.equal(item.intervalIndex, 1);
    assert.equal(item.consecutiveCorrect, 1);
    assert.equal(item.lapses, 0);
    assert.ok(item.lastReviewedAt);

    const today = await api(server, "/api/vocab/review/today");
    assert.equal(today.data.reviewedToday, 1);
    assert.equal(today.data.dueCount, 0);

    assert.equal(
      (
        await api(server, "/api/vocab/reviews", {
          method: "POST",
          body: { reviews: [] }
        })
      ).status,
      400
    );
    assert.equal(
      (
        await api(server, "/api/vocab/reviews", {
          method: "POST",
          body: { reviews: [{ itemId, result: "skipped" }] }
        })
      ).status,
      400
    );
    assert.equal(
      (
        await api(server, "/api/vocab/reviews", {
          method: "POST",
          body: { reviews: [{ itemId: 9999, result: "correct" }] }
        })
      ).status,
      404
    );

    const db = new DatabaseSync(server.databasePath);
    try {
      const events = db
        .prepare(
          `SELECT result, surface, interval_before, interval_after
           FROM vocab_review_events WHERE item_id = ? ORDER BY id`
        )
        .all(itemId);
      assert.deepEqual(
        events.map((event) => event.result),
        ["correct", "incorrect", "correct"]
      );
      assert.deepEqual(
        events.map((event) => event.surface),
        ["web", "eink", "web"]
      );
      assert.deepEqual(
        events.map((event) => event.interval_before),
        [0, 0, 0]
      );
      assert.deepEqual(
        events.map((event) => event.interval_after),
        [1, 0, 1]
      );
    } finally {
      db.close();
    }
  });
});

test("字词条目支持调整到期日、归档掌握与删除", async () => {
  await withVocabServer(async (server) => {
    const created = await api(server, "/api/vocab/items", {
      method: "POST",
      body: { subject: "english", term: "apple", meaning: "苹果" }
    });
    const itemId = created.data.items[0].id;
    assert.equal(created.data.items[0].dueAt, TOMORROW);

    const moved = await api(server, `/api/vocab/items/${itemId}`, {
      method: "PATCH",
      body: { dueAt: TODAY }
    });
    assert.equal(moved.status, 200);
    assert.equal(moved.data.dueAt, TODAY);

    const today = await api(server, "/api/vocab/review/today");
    const due = today.data.items.find((entry) => entry.itemId === itemId);
    assert.equal(due.prompt, "苹果");

    const mastered = await api(server, `/api/vocab/items/${itemId}`, {
      method: "PATCH",
      body: { status: "mastered" }
    });
    assert.equal(mastered.status, 200);
    assert.equal(mastered.data.status, "mastered");
    assert.equal(mastered.data.dueAt, null);

    const afterMastered = await api(server, "/api/vocab/review/today");
    assert.equal(
      afterMastered.data.items.some((entry) => entry.itemId === itemId),
      false
    );
    const masteredList = await api(
      server,
      "/api/vocab/items?subject=english&status=mastered"
    );
    assert.equal(masteredList.data.count, 1);

    assert.equal(
      (
        await api(server, `/api/vocab/items/${itemId}`, {
          method: "PATCH",
          body: {}
        })
      ).status,
      400
    );
    assert.equal(
      (
        await api(server, `/api/vocab/items/${itemId}`, {
          method: "PATCH",
          body: { status: "paused" }
        })
      ).status,
      400
    );
    assert.equal(
      (
        await api(server, "/api/vocab/items/9999", {
          method: "PATCH",
          body: { status: "mastered" }
        })
      ).status,
      404
    );

    const deleted = await api(server, `/api/vocab/items/${itemId}`, {
      method: "DELETE"
    });
    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.data, { deleted: true });
    assert.equal(
      (await api(server, `/api/vocab/items/${itemId}`, { method: "DELETE" }))
        .status,
      404
    );
  });
});

test("语文听写按课文出课本拼音且不下发汉字答案", async () => {
  await withVocabServer(
    async (server) => {
      const { zhUnitId, zhLesson1Id, zhLesson2Id, enLessonId } =
        server.seedIds;

      const lesson = await api(
        server,
        `/api/vocab/dictation?subject=chinese&lessonId=${zhLesson2Id}`
      );
      assert.equal(lesson.status, 200);
      assert.equal(lesson.data.mode, "pinyin_to_hanzi");
      assert.equal(lesson.data.items.length, 1);
      assert.equal(lesson.data.items[0].prompt, "yuè liang");
      assert.ok(lesson.data.items[0].occurrenceId);
      assert.equal("answer" in lesson.data.items[0], false);
      assert.equal(JSON.stringify(lesson.data).includes("月亮"), false);

      const lessonOne = await api(
        server,
        `/api/vocab/dictation?subject=chinese&lessonId=${zhLesson1Id}`
      );
      assert.deepEqual(
        lessonOne.data.items.map((item) => item.prompt),
        ["shān"]
      );

      const unit = await api(
        server,
        `/api/vocab/dictation?subject=chinese&unitId=${zhUnitId}`
      );
      assert.deepEqual(
        unit.data.items.map((item) => item.prompt),
        ["shān", "yuè liang"]
      );

      assert.equal(
        (
          await api(
            server,
            `/api/vocab/dictation?subject=chinese&lessonId=${enLessonId}`
          )
        ).status,
        404
      );
      assert.equal(
        (await api(server, "/api/vocab/dictation")).status,
        400
      );
    },
    { seed: true }
  );
});

test("英语听写默认中译英并支持切换英译中，跟随设置默认值", async () => {
  await withVocabServer(
    async (server) => {
      const { enUnitId } = server.seedIds;

      const defaults = await api(
        server,
        `/api/vocab/dictation?subject=english&unitId=${enUnitId}`
      );
      assert.equal(defaults.status, 200);
      assert.equal(defaults.data.mode, "zh_to_en");
      assert.deepEqual(
        defaults.data.items.map((item) => item.prompt),
        ["苹果", "香蕉"]
      );
      assert.equal(JSON.stringify(defaults.data).includes("apple"), false);

      const reversed = await api(
        server,
        `/api/vocab/dictation?subject=english&unitId=${enUnitId}&mode=en_to_zh`
      );
      assert.equal(reversed.data.mode, "en_to_zh");
      assert.deepEqual(
        reversed.data.items.map((item) => item.prompt),
        ["apple", "banana"]
      );

      await api(server, "/api/vocab/settings", {
        method: "PUT",
        body: { englishMode: "en_to_zh" }
      });
      const followed = await api(
        server,
        `/api/vocab/dictation?subject=english&unitId=${enUnitId}`
      );
      assert.equal(followed.data.mode, "en_to_zh");
      assert.deepEqual(
        followed.data.items.map((item) => item.prompt),
        ["apple", "banana"]
      );

      assert.equal(
        (
          await api(
            server,
            `/api/vocab/dictation?subject=english&unitId=${enUnitId}&mode=pinyin`
          )
        ).status,
        400
      );
    },
    { seed: true }
  );
});

const DUP_OCCURRENCE_CATALOG = {
  meta: { reviewStatus: "unreviewed" },
  textbooks: [
    {
      textbookKey: "test-dup-zh",
      subject: "chinese",
      editionKey: "test-dup-edition",
      publisher: "测试出版社",
      edition: "测试版",
      grade: 6,
      semester: "upper",
      displayName: "测试同字跨课",
      units: [
        {
          unitNo: 1,
          title: "第一单元",
          lessons: [
            { lessonNo: 1, title: "课文一" },
            { lessonNo: 2, title: "课文二" }
          ],
          entries: [
            {
              term: "重",
              kind: "char",
              pinyin: "zhòng",
              listType: "会写",
              lessonNo: 1,
              position: 1
            },
            {
              term: "重",
              kind: "char",
              pinyin: "chóng",
              listType: "会写",
              lessonNo: 2,
              position: 1
            }
          ]
        }
      ]
    }
  ]
};

test("同单元两课同一字保留两条 occurrence 且重复导入幂等", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "math-coach-vocab-dup-")
  );
  const repository = new LearningRepository(
    path.join(directory, "learning.sqlite")
  );
  try {
    const first = importVocabCatalog(repository.db, DUP_OCCURRENCE_CATALOG);
    assert.deepEqual(first, {
      textbooks: 1,
      units: 1,
      lessons: 2,
      terms: 2,
      occurrences: 2
    });
    const readOccurrences = () =>
      repository.db
        .prepare(
          `SELECT o.id, o.lesson_id, o.pinyin_in_book
           FROM zh_occurrences o
           JOIN zh_terms t ON t.id = o.term_id
           WHERE t.word = '重'
           ORDER BY o.lesson_id`
        )
        .all();
    const rows = readOccurrences();
    assert.equal(rows.length, 2);
    assert.equal(new Set(rows.map((row) => row.lesson_id)).size, 2);
    assert.deepEqual(
      rows.map((row) => row.pinyin_in_book),
      ["zhòng", "chóng"]
    );
    assert.equal(
      repository.db
        .prepare("SELECT COUNT(*) AS count FROM zh_terms WHERE word = '重'")
        .get().count,
      1
    );

    const second = importVocabCatalog(repository.db, DUP_OCCURRENCE_CATALOG);
    assert.deepEqual(second, first);
    const rerunRows = readOccurrences();
    assert.deepEqual(
      rerunRows.map((row) => row.id),
      rows.map((row) => row.id)
    );
    assert.equal(rerunRows.length, 2);
  } finally {
    repository.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("同一字录入不同课保留两条出现位置", async () => {
  await withVocabServer(
    async (server) => {
      const { zhLesson1Id, zhLesson2Id } = server.seedIds;
      const posted = await api(server, "/api/vocab/items", {
        method: "POST",
        body: {
          subject: "chinese",
          term: "山",
          pinyin: "shān",
          lessonId: zhLesson2Id
        }
      });
      assert.equal(posted.status, 201);
      assert.equal(posted.data.created, 1);
      assert.ok(posted.data.items[0].sourceOccurrenceId);

      const lessonOne = await api(
        server,
        `/api/vocab/dictation?subject=chinese&lessonId=${zhLesson1Id}`
      );
      assert.deepEqual(
        lessonOne.data.items.map((item) => item.prompt),
        ["shān"]
      );
      const lessonTwo = await api(
        server,
        `/api/vocab/dictation?subject=chinese&lessonId=${zhLesson2Id}`
      );
      assert.deepEqual(
        lessonTwo.data.items.map((item) => item.prompt),
        ["shān", "yuè liang"]
      );

      const db = new DatabaseSync(server.databasePath);
      try {
        assert.equal(
          db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM zh_occurrences o
               JOIN zh_terms t ON t.id = o.term_id
               WHERE t.word = '山'`
            )
            .get().count,
          2
        );
      } finally {
        db.close();
      }
    },
    { seed: true }
  );
});

test("批量录入中途失败时整批回滚", async () => {
  await withVocabServer(async (server) => {
    const failed = await api(server, "/api/vocab/items", {
      method: "POST",
      body: {
        subject: "chinese",
        entries: [{ term: "半批甲", pinyin: "ban" }, { term: "" }]
      }
    });
    assert.equal(failed.status, 400);

    const list = await api(server, "/api/vocab/items?subject=chinese");
    assert.equal(list.data.count, 0);
    const db = new DatabaseSync(server.databasePath);
    try {
      assert.equal(
        db
          .prepare("SELECT COUNT(*) AS count FROM zh_terms WHERE word = '半批甲'")
          .get().count,
        0
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM vocab_items").get().count,
        0
      );
    } finally {
      db.close();
    }
  });
});

test("可按词条与出现位置直接补录条目并校验学科", async () => {
  await withVocabServer(
    async (server) => {
      const { zhLesson2Id, enUnitId } = server.seedIds;
      const chinese = await api(
        server,
        `/api/vocab/dictation?subject=chinese&lessonId=${zhLesson2Id}`
      );
      const target = chinese.data.items.find(
        (item) => item.prompt === "yuè liang"
      );
      assert.ok(target.termId);
      assert.ok(target.occurrenceId);

      const created = await api(server, "/api/vocab/items", {
        method: "POST",
        body: {
          subject: "chinese",
          termId: target.termId,
          sourceOccurrenceId: target.occurrenceId
        }
      });
      assert.equal(created.status, 201);
      assert.equal(created.data.created, 1);
      assert.equal(created.data.items[0].term, "月亮");
      assert.equal(created.data.items[0].dueAt, TOMORROW);
      assert.equal(
        created.data.items[0].sourceOccurrenceId,
        target.occurrenceId
      );

      const repeated = await api(server, "/api/vocab/items", {
        method: "POST",
        body: {
          subject: "chinese",
          termId: target.termId,
          sourceOccurrenceId: target.occurrenceId
        }
      });
      assert.equal(repeated.data.created, 0);
      assert.equal(repeated.data.existing, 1);
      assert.equal(repeated.data.items[0].id, created.data.items[0].id);

      const dictation = await api(
        server,
        `/api/vocab/dictation?subject=chinese&lessonId=${zhLesson2Id}`
      );
      const dictationItem = dictation.data.items.find(
        (item) => item.prompt === "yuè liang"
      );
      assert.equal(dictationItem.itemId, created.data.items[0].id);

      const english = await api(
        server,
        `/api/vocab/dictation?subject=english&unitId=${enUnitId}`
      );
      const englishTerm = english.data.items[0];
      const crossOccurrence = await api(server, "/api/vocab/items", {
        method: "POST",
        body: {
          subject: "chinese",
          termId: target.termId,
          sourceOccurrenceId: englishTerm.occurrenceId
        }
      });
      assert.equal(crossOccurrence.status, 404);

      const zhThird = await api(server, "/api/vocab/items", {
        method: "POST",
        body: { subject: "chinese", term: "雨", pinyin: "yǔ" }
      });
      const zhTermId = zhThird.data.items[0].termId;
      const wrongSubject = await api(server, "/api/vocab/items", {
        method: "POST",
        body: { subject: "english", termId: zhTermId }
      });
      assert.equal(wrongSubject.status, 404);

      const missing = await api(server, "/api/vocab/items", {
        method: "POST",
        body: { subject: "chinese", termId: 999999 }
      });
      assert.equal(missing.status, 404);

      const conflict = await api(server, "/api/vocab/items", {
        method: "POST",
        body: { subject: "chinese", termId: target.termId, term: "月亮" }
      });
      assert.equal(conflict.status, 400);
    },
    { seed: true }
  );
});
