import test from "node:test";
import assert from "node:assert/strict";
import {
  VOCAB_INTERVALS,
  addDays,
  applyVocabReview,
  buildDailyReviewQueue,
  parseDateKey,
  resolveDictationPrompt,
  scheduleNewItem,
  toDateKey
} from "../src/vocab/schedule.js";

function localDate(dateKey, hour = 9) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(year, month - 1, day, hour, 0, 0);
}

test("新词默认次日到期且从零间隔开始", () => {
  const now = localDate("2026-11-28", 10);
  const scheduled = scheduleNewItem({ now });
  assert.deepEqual(scheduled, {
    intervalIndex: 0,
    status: "active",
    consecutiveCorrect: 0,
    lapses: 0,
    dueAt: "2026-11-29",
    lastReviewedAt: null
  });
});

test("连续答对按 1/2/4/7/15 天推进并在第五阶掌握", () => {
  let item = scheduleNewItem({ now: localDate("2026-11-28") });
  const steps = [
    { reviewOn: "2026-11-29", intervalIndex: 1, dueAt: "2026-12-01" },
    { reviewOn: "2026-12-01", intervalIndex: 2, dueAt: "2026-12-05" },
    { reviewOn: "2026-12-05", intervalIndex: 3, dueAt: "2026-12-12" },
    { reviewOn: "2026-12-12", intervalIndex: 4, dueAt: "2026-12-27" }
  ];
  for (const step of steps) {
    item = applyVocabReview({
      item,
      result: "correct",
      now: localDate(step.reviewOn)
    });
    assert.equal(item.intervalIndex, step.intervalIndex);
    assert.equal(item.consecutiveCorrect, step.intervalIndex);
    assert.equal(item.dueAt, step.dueAt);
    assert.equal(item.status, "active");
    assert.equal(item.lapses, 0);
  }

  const mastered = applyVocabReview({
    item,
    result: "correct",
    now: localDate("2026-12-27")
  });
  assert.equal(mastered.status, "mastered");
  assert.equal(mastered.intervalIndex, VOCAB_INTERVALS.length - 1);
  assert.equal(mastered.dueAt, null);
  assert.equal(mastered.consecutiveCorrect, VOCAB_INTERVALS.length - 1);
  assert.equal(mastered.lastReviewedAt, localDate("2026-12-27").toISOString());

  const relapsed = applyVocabReview({
    item: mastered,
    result: "incorrect",
    now: localDate("2027-01-05")
  });
  assert.equal(relapsed.status, "active");
  assert.equal(relapsed.intervalIndex, 0);
  assert.equal(relapsed.consecutiveCorrect, 0);
  assert.equal(relapsed.lapses, 1);
  assert.equal(relapsed.dueAt, "2027-01-06");
});

test("答错任意阶段都回到第一阶且次日重来", () => {
  const item = applyVocabReview({
    item: { intervalIndex: 3, lapses: 2, status: "active", dueAt: "2026-12-12" },
    result: "incorrect",
    now: localDate("2026-12-12")
  });
  assert.deepEqual(item, {
    intervalIndex: 0,
    status: "active",
    consecutiveCorrect: 0,
    lapses: 3,
    dueAt: "2026-12-13",
    lastReviewedAt: localDate("2026-12-12").toISOString()
  });
  assert.equal(
    applyVocabReview({
      item,
      result: "incorrect",
      now: localDate("2026-12-13")
    }).lapses,
    4
  );
  assert.throws(
    () => applyVocabReview({ item, result: "skipped", now: new Date() }),
    /correct 或 incorrect/
  );
});

test("每日清单最旧逾期优先、超上限顺延且不混入新词", () => {
  const items = [
    { id: 5, status: "active", dueAt: "2026-11-28" },
    { id: 2, status: "active", dueAt: "2026-11-26" },
    { id: 9, status: "active", dueAt: "2026-11-26" },
    { id: 3, status: "active", dueAt: "2026-11-29" },
    { id: 4, status: "active", dueAt: "2026-11-30" },
    { id: 6, status: "mastered", dueAt: null },
    { id: 7, status: "active", dueAt: "not-a-date" }
  ];
  const queue = buildDailyReviewQueue({
    items,
    todayKey: "2026-11-28",
    dailyLimit: 2
  });
  assert.equal(queue.dueCount, 3);
  assert.equal(queue.deferredCount, 1);
  assert.deepEqual(queue.items.map((item) => item.id), [2, 9]);

  const full = buildDailyReviewQueue({
    items,
    todayKey: "2026-11-28",
    dailyLimit: 5
  });
  assert.equal(full.dueCount, 3);
  assert.equal(full.deferredCount, 0);
  assert.deepEqual(full.items.map((item) => item.id), [2, 9, 5]);

  assert.throws(
    () => buildDailyReviewQueue({ items, todayKey: "2026-11-28", dailyLimit: 101 }),
    /daily_limit/
  );
  assert.throws(
    () => buildDailyReviewQueue({ items, todayKey: "2026-02-30", dailyLimit: 5 }),
    /无效的日期/
  );
});

test("语文听写用课本拼音，英语按模式出题且提示中不含答案之外的字段", () => {
  const chinese = resolveDictationPrompt({
    subject: "chinese",
    term: { pinyinPrimary: "yuè liàng" },
    occurrence: { pinyinInBook: "yuè liang" }
  });
  assert.deepEqual(chinese, { mode: "pinyin_to_hanzi", prompt: "yuè liang" });
  assert.equal(
    resolveDictationPrompt({
      subject: "chinese",
      term: { pinyinPrimary: "shān" }
    }).prompt,
    "shān"
  );

  const englishTerm = { term: "apple", meaningZh: "苹果" };
  assert.deepEqual(
    resolveDictationPrompt({
      subject: "english",
      mode: "zh_to_en",
      term: englishTerm
    }),
    { mode: "zh_to_en", prompt: "苹果" }
  );
  assert.deepEqual(
    resolveDictationPrompt({
      subject: "english",
      mode: "en_to_zh",
      term: englishTerm
    }),
    { mode: "en_to_zh", prompt: "apple" }
  );
  assert.deepEqual(
    resolveDictationPrompt({ subject: "english", term: englishTerm }),
    { mode: "zh_to_en", prompt: "苹果" }
  );
  assert.throws(
    () =>
      resolveDictationPrompt({
        subject: "english",
        mode: "pinyin",
        term: englishTerm
      }),
    /zh_to_en 或 en_to_zh/
  );
  assert.throws(
    () => resolveDictationPrompt({ subject: "math", term: {} }),
    /chinese 或 english/
  );
});

test("日期工具处理跨年与非法日期", () => {
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(toDateKey(localDate("2026-11-28", 23)), "2026-11-28");
  assert.equal(parseDateKey("2026-11-28"), "2026-11-28");
  assert.equal(parseDateKey("2026-02-30"), null);
  assert.equal(parseDateKey("20261128"), null);
  assert.throws(() => addDays("2026-13-01", 1), /无效的日期/);
});
