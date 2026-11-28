export const VOCAB_INTERVALS = [1, 2, 4, 7, 15];
export const VOCAB_MAX_INTERVAL_INDEX = VOCAB_INTERVALS.length - 1;
export const VOCAB_SUBJECTS = ["chinese", "english"];
export const ENGLISH_MODES = ["zh_to_en", "en_to_zh"];
export const DEFAULT_DAILY_LIMIT = 25;
export const MIN_DAILY_LIMIT = 5;
export const MAX_DAILY_LIMIT = 100;

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad2(value) {
  return String(value).padStart(2, "0");
}

export function toDateKey(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(
    date.getDate()
  )}`;
}

export function parseDateKey(value) {
  const text = String(value ?? "").trim();
  const match = DATE_KEY_PATTERN.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return text;
}

export function addDays(dateKey, days) {
  const parsed = parseDateKey(dateKey);
  if (!parsed) throw new Error(`无效的日期：${dateKey}`);
  const [year, month, day] = parsed.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + days);
  return toDateKey(date);
}

function assertIntervalIndex(value, label = "interval_index") {
  if (
    !Number.isInteger(value) ||
    value < 0 ||
    value > VOCAB_MAX_INTERVAL_INDEX
  ) {
    throw new Error(`${label} 必须是 0～${VOCAB_MAX_INTERVAL_INDEX} 的整数`);
  }
}

export function scheduleNewItem({ now = new Date() } = {}) {
  const today = toDateKey(now);
  return {
    intervalIndex: 0,
    status: "active",
    consecutiveCorrect: 0,
    lapses: 0,
    dueAt: addDays(today, VOCAB_INTERVALS[0]),
    lastReviewedAt: null
  };
}

export function applyVocabReview({ item, result, now = new Date() }) {
  if (result !== "correct" && result !== "incorrect") {
    throw new Error("review result 只能是 correct 或 incorrect");
  }
  const intervalIndex = Number(item?.intervalIndex ?? 0);
  assertIntervalIndex(intervalIndex);
  const lapses = Number(item?.lapses ?? 0);
  const today = toDateKey(now);

  if (result === "incorrect") {
    return {
      intervalIndex: 0,
      status: "active",
      consecutiveCorrect: 0,
      lapses: lapses + 1,
      dueAt: addDays(today, VOCAB_INTERVALS[0]),
      lastReviewedAt: now.toISOString()
    };
  }

  if (intervalIndex === VOCAB_MAX_INTERVAL_INDEX) {
    return {
      intervalIndex: VOCAB_MAX_INTERVAL_INDEX,
      status: "mastered",
      consecutiveCorrect: VOCAB_MAX_INTERVAL_INDEX,
      lapses,
      dueAt: null,
      lastReviewedAt: now.toISOString()
    };
  }

  const nextIndex = intervalIndex + 1;
  return {
    intervalIndex: nextIndex,
    status: "active",
    consecutiveCorrect: nextIndex,
    lapses,
    dueAt: addDays(today, VOCAB_INTERVALS[nextIndex]),
    lastReviewedAt: now.toISOString()
  };
}

export function buildDailyReviewQueue({ items = [], todayKey, dailyLimit }) {
  const today = parseDateKey(todayKey);
  if (!today) throw new Error(`无效的日期：${todayKey}`);
  if (
    !Number.isInteger(dailyLimit) ||
    dailyLimit < 0 ||
    dailyLimit > MAX_DAILY_LIMIT
  ) {
    throw new Error(`daily_limit 必须是 0～${MAX_DAILY_LIMIT} 的整数`);
  }

  const due = items
    .filter(
      (item) =>
        item?.status === "active" &&
        typeof item.dueAt === "string" &&
        parseDateKey(item.dueAt) &&
        item.dueAt <= today
    )
    .sort((left, right) => {
      if (left.dueAt !== right.dueAt) {
        return left.dueAt < right.dueAt ? -1 : 1;
      }
      return Number(left.id || 0) - Number(right.id || 0);
    });

  return {
    dueCount: due.length,
    deferredCount: Math.max(0, due.length - dailyLimit),
    items: due.slice(0, dailyLimit)
  };
}

export function resolveDictationPrompt({
  subject,
  mode,
  term,
  occurrence
}) {
  if (subject === "chinese") {
    const prompt =
      occurrence?.pinyinInBook || term?.pinyinPrimary || "";
    return { mode: "pinyin_to_hanzi", prompt };
  }
  if (subject !== "english") {
    throw new Error("subject 只能是 chinese 或 english");
  }
  const englishMode = mode || "zh_to_en";
  if (!ENGLISH_MODES.includes(englishMode)) {
    throw new Error("英语听写模式只能是 zh_to_en 或 en_to_zh");
  }
  const prompt =
    englishMode === "en_to_zh" ? term?.term || "" : term?.meaningZh || "";
  return { mode: englishMode, prompt };
}
