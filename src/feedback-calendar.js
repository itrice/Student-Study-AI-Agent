const SHANGHAI_OFFSET = "+08:00";
const DAY_MS = 24 * 60 * 60 * 1000;

function pad(value) {
  return String(value).padStart(2, "0");
}

export function parseMonthKey(value) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(value || "").trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 1970 || year > 9999 || month < 1 || month > 12) return null;
  return { year, month };
}

export function parseDateKey(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

export function shanghaiDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

export function shanghaiMonthKey(value = new Date()) {
  return shanghaiDateKey(value).slice(0, 7);
}

export function shiftMonthKey(monthKey, delta) {
  const parsed = parseMonthKey(monthKey);
  if (!parsed) throw new TypeError("无效月份");
  const index = parsed.year * 12 + (parsed.month - 1) + delta;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${year}-${pad(month)}`;
}

export function shanghaiDayBounds(dateKey) {
  const parsed = parseDateKey(dateKey);
  if (!parsed) throw new TypeError("无效日期");
  const from = new Date(`${dateKey}T00:00:00${SHANGHAI_OFFSET}`);
  const to = new Date(from.getTime() + DAY_MS);
  return { from: from.toISOString(), to: to.toISOString() };
}

export function shanghaiMonthBounds(monthKey) {
  const parsed = parseMonthKey(monthKey);
  if (!parsed) throw new TypeError("无效月份");
  const daysInMonth = new Date(
    Date.UTC(parsed.year, parsed.month, 0)
  ).getUTCDate();
  const days = [];
  for (let day = 1; day <= daysInMonth; day += 1) {
    days.push(`${parsed.year}-${pad(parsed.month)}-${pad(day)}`);
  }
  return {
    from: shanghaiDayBounds(days[0]).from,
    to: shanghaiDayBounds(
      shiftMonthKey(monthKey, 1) + "-01"
    ).from,
    days
  };
}
