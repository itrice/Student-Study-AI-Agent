export function monthKeyOf(dateKey) {
  return String(dateKey || "").slice(0, 7);
}

export function parseMonthParts(monthKey) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(monthKey || ""));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

export function shiftMonthKey(monthKey, delta) {
  const parsed = parseMonthParts(monthKey);
  if (!parsed) return monthKey;
  const index = parsed.year * 12 + (parsed.month - 1) + delta;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

export function formatMonthLabel(monthKey) {
  const parsed = parseMonthParts(monthKey);
  return parsed ? `${parsed.year}年${parsed.month}月` : monthKey;
}

export function formatDayDetailTitle(dateKey) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ""));
  return match
    ? `${Number(match[2])}月${Number(match[3])}日完成情况`
    : "完成情况";
}

export function calendarGridItems(monthKey, todayKey) {
  const parsed = parseMonthParts(monthKey);
  if (!parsed) return [];
  const daysInMonth = new Date(
    Date.UTC(parsed.year, parsed.month, 0)
  ).getUTCDate();
  const leading = (new Date(
    Date.UTC(parsed.year, parsed.month - 1, 1)
  ).getUTCDay() + 6) % 7;
  const cells = [];
  for (let index = 0; index < leading; index += 1) {
    cells.push({ blank: true, key: `blank-${index}` });
  }
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = `${parsed.year}-${String(parsed.month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    cells.push({
      blank: false,
      date,
      day,
      future: date > todayKey,
      today: date === todayKey
    });
  }
  return cells;
}
