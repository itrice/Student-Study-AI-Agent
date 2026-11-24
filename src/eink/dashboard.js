import { createHash } from "node:crypto";
import { EINK_FONT_FAMILY } from "./fonts.js";
import {
  EINK_HEIGHT,
  EINK_WIDTH,
  rasterizeSvg
} from "./render.js";

export const EINK_DASHBOARD_LAYOUT_VERSION = "eink-dashboard-v1";
export const EINK_QUOTE_VERSION = "eink-quotes-v1";

export const EINK_QUOTES = Object.freeze([
  "每天迈出的一小步，都会成为以后看得见的进步。",
  "把不会的题弄明白，就是今天最实在的收获。",
  "先完成眼前这一题，再继续下一题。",
  "认真订正一道题，也是在为下一次独立完成做准备。",
  "今天多弄懂一点，明天就会多一分从容。"
]);

const WEEKDAYS = Object.freeze([
  "周日",
  "周一",
  "周二",
  "周三",
  "周四",
  "周五",
  "周六"
]);

const FONT_STACK =
  `${EINK_FONT_FAMILY}, Microsoft YaHei, Noto Sans CJK SC, sans-serif`;

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function textElement({
  x,
  y,
  text,
  size,
  weight = 400,
  anchor = "start"
}) {
  return (
    `<text x="${x}" y="${y}" font-size="${size}" ` +
    `font-weight="${weight}" text-anchor="${anchor}">` +
    `${escapeXml(text)}</text>`
  );
}

function svgDocument(elements) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `width="${EINK_WIDTH}" height="${EINK_HEIGHT}" ` +
    `viewBox="0 0 ${EINK_WIDTH} ${EINK_HEIGHT}" ` +
    `font-family="${escapeXml(FONT_STACK)}" fill="black">` +
    `${elements.join("")}</svg>`
  );
}

function dateParts(dateKey) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) throw new TypeError("无效看板日期");
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3])
  };
}

export function formatDashboardDate(dateKey) {
  const { year, month, day } = dateParts(dateKey);
  const weekday = WEEKDAYS[
    new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  ];
  return `${year}年${month}月${day}日  ${weekday}`;
}

export function selectDailyQuote(dateKey, quotes = EINK_QUOTES) {
  const digest = createHash("sha256")
    .update(`${EINK_QUOTE_VERSION}:${dateKey}`)
    .digest();
  return quotes[digest.readUInt32BE(0) % quotes.length];
}

export function buildDashboardCalendar(monthKey, calendarDays = []) {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!match) throw new TypeError("无效看板月份");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const activityByDate = new Map(
    (Array.isArray(calendarDays) ? calendarDays : []).map((day) => [
      day.date,
      Boolean(day.hasActivity)
    ])
  );
  const firstWeekday = new Date(
    Date.UTC(year, month - 1, 1)
  ).getUTCDay();
  const leading = (firstWeekday + 6) % 7;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cells = Array.from({ length: leading }, (_, index) => ({
    blank: true,
    key: `blank-${index}`
  }));
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date =
      `${year}-${String(month).padStart(2, "0")}-` +
      String(day).padStart(2, "0");
    cells.push({
      blank: false,
      date,
      day,
      hasActivity: activityByDate.get(date) === true
    });
  }
  while (cells.length < 42) {
    cells.push({ blank: true, key: `trailing-${cells.length}` });
  }
  return cells;
}

export function formatDueCount(value) {
  const count = Math.max(0, Math.trunc(Number(value) || 0));
  return count > 999 ? "999+" : String(count);
}

function calendarElements(monthKey, calendarDays, todayKey) {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
  const month = Number(match[2]);
  const grid = buildDashboardCalendar(monthKey, calendarDays);
  const left = 24;
  const leftWidth = 496;
  const cellWidth = leftWidth / 7;
  const gridTop = 142;
  const rowHeight = 32;
  const elements = [
    textElement({
      x: left,
      y: 100,
      text: `${month}月学习日历`,
      size: 22,
      weight: 700
    })
  ];
  for (const [index, label] of ["一", "二", "三", "四", "五", "六", "日"].entries()) {
    elements.push(
      textElement({
        x: left + cellWidth * (index + 0.5),
        y: 128,
        text: label,
        size: 16,
        weight: 700,
        anchor: "middle"
      })
    );
  }
  grid.forEach((cell, index) => {
    if (cell.blank) return;
    const column = index % 7;
    const row = Math.floor(index / 7);
    const cellX = left + column * cellWidth;
    const cellY = gridTop + row * rowHeight;
    const centerX = cellX + cellWidth / 2;
    if (cell.date === todayKey) {
      elements.push(
        `<rect x="${cellX + 5}" y="${cellY + 1}" width="${cellWidth - 10}" ` +
          `height="28" fill="none" stroke="black" stroke-width="2"/>`
      );
    }
    elements.push(
      textElement({
        x: centerX,
        y: cellY + 21,
        text: String(cell.day),
        size: 18,
        anchor: "middle"
      })
    );
    if (cell.hasActivity) {
      elements.push(
        `<path class="completion-check" d="` +
          `M ${cellX + cellWidth - 21} ${cellY + 22} ` +
          `L ${cellX + cellWidth - 17} ${cellY + 26} ` +
          `L ${cellX + cellWidth - 10} ${cellY + 16}" ` +
          `fill="none" stroke="black" stroke-width="2" ` +
          `stroke-linecap="square" stroke-linejoin="miter"/>`
      );
    }
  });
  return elements;
}

function dueElements(dueCount, dueAvailable) {
  const elements = [
    `<rect x="544" y="76" width="232" height="278" ` +
      `fill="white" stroke="black" stroke-width="2"/>`,
    textElement({
      x: 660,
      y: 108,
      text: "今天要复习",
      size: 20,
      weight: 700,
      anchor: "middle"
    })
  ];
  if (!dueAvailable) {
    elements.push(
      textElement({
        x: 660,
        y: 208,
        text: "数据暂不可用",
        size: 26,
        weight: 700,
        anchor: "middle"
      }),
      textElement({
        x: 660,
        y: 250,
        text: "请稍后刷新看板",
        size: 20,
        anchor: "middle"
      })
    );
    return elements;
  }
  elements.push(
    textElement({
      x: 660,
      y: 220,
      text: formatDueCount(dueCount),
      size: 72,
      weight: 700,
      anchor: "middle"
    })
  );
  if (dueCount === 0) {
    elements.push(
      textElement({
        x: 660,
        y: 264,
        text: "今天没有到期题目",
        size: 20,
        anchor: "middle"
      })
    );
  } else {
    elements.push(
      textElement({
        x: 660,
        y: 258,
        text: "道题待复习",
        size: 22,
        anchor: "middle"
      }),
      textElement({
        x: 660,
        y: 300,
        text: "按复习队列顺序完成",
        size: 20,
        anchor: "middle"
      })
    );
  }
  return elements;
}

function quoteElements(quote) {
  return [
    `<rect x="24" y="364" width="752" height="2" fill="black"/>`,
    textElement({
      x: 24,
      y: 408,
      text: quote,
      size: 22
    })
  ];
}

export function dashboardSvg(model) {
  return svgDocument([
    `<rect width="${EINK_WIDTH}" height="${EINK_HEIGHT}" fill="white"/>`,
    textElement({
      x: 24,
      y: 44,
      text: "学习看板",
      size: 28,
      weight: 700
    }),
    textElement({
      x: 776,
      y: 42,
      text: formatDashboardDate(model.dateKey),
      size: 20,
      anchor: "end"
    }),
    `<rect x="0" y="64" width="${EINK_WIDTH}" height="2" fill="black"/>`,
    ...calendarElements(
      model.monthKey,
      model.calendarDays,
      model.dateKey
    ),
    ...dueElements(model.dueCount, model.dueAvailable),
    ...quoteElements(model.quote)
  ]);
}

export async function renderEinkDashboard(model) {
  const rendered = await rasterizeSvg(dashboardSvg(model));
  if (rendered.frame.length !== EINK_WIDTH / 8 * EINK_HEIGHT) {
    throw new Error("墨水屏看板帧长度错误");
  }
  return rendered;
}
