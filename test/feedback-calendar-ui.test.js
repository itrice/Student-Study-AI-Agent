import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  calendarGridItems,
  formatDayDetailTitle,
  formatMonthLabel,
  monthKeyOf,
  shiftMonthKey
} from "../public/feedback-calendar.js";

const root = new URL("../", import.meta.url);
const html = fs.readFileSync(new URL("public/index.html", root), "utf8");
const app = fs.readFileSync(new URL("public/app.js", root), "utf8");
const css = fs.readFileSync(new URL("public/styles.css", root), "utf8");

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, "缺少起始标记：" + startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, "缺少结束标记：" + endMarker);
  return source.slice(start, end);
}

test("月份切换跨年且日历首日偏移正确", () => {
  assert.equal(shiftMonthKey("2026-12", 1), "2027-01");
  assert.equal(shiftMonthKey("2026-01", -1), "2025-12");
  assert.equal(monthKeyOf("2026-11-16"), "2026-11");
  assert.equal(formatMonthLabel("2026-11"), "2026年11月");
  assert.equal(formatDayDetailTitle("2026-11-16"), "11月16日完成情况");

  const cells = calendarGridItems("2026-11", "2026-11-16");
  const leading = cells.filter((cell) => cell.blank).length;
  assert.equal(leading, 6);
  const firstDay = cells.find((cell) => cell.date === "2026-11-01");
  assert.equal(firstDay.day, 1);
  assert.equal(firstDay.today, false);
  assert.equal(firstDay.future, false);
  const today = cells.find((cell) => cell.date === "2026-11-16");
  assert.equal(today.today, true);
  const future = cells.find((cell) => cell.date === "2026-11-17");
  assert.equal(future.future, true);
  assert.equal(cells.filter((cell) => !cell.blank).length, 30);
});

test("学习反馈页包含全宽打卡卡片与当日完成情况入口", () => {
  for (const id of [
    "feedback-calendar-card",
    "calendar-prev-month",
    "calendar-next-month",
    "calendar-current-month",
    "calendar-month-label",
    "calendar-summary",
    "calendar-grid",
    "daily-detail-button",
    "day-detail-dialog",
    "day-detail-title",
    "day-detail-close-button",
    "day-detail-metrics",
    "day-detail-list",
    "day-detail-empty"
  ]) {
    assert.match(html, new RegExp('id="' + id + '"'));
  }
  const weekly = html.indexOf("id=\"weekly-limitations\"");
  const calendarCard = html.indexOf("id=\"feedback-calendar-card\"");
  const feedbackContentEnd = html.indexOf("id=\"feedback-empty\"");
  assert.ok(weekly < calendarCard && calendarCard < feedbackContentEnd);
  assert.match(html, /查看今日完成情况/);
  assert.match(html, /这一天还没有作答记录/);
  assert.match(html, /aria-label="关闭完成情况"/);
  assert.match(html, /id="day-detail-title" tabindex="-1"/);
  assert.match(css, /\.feedback-calendar-card \{\s*grid-column: 1 \/ -1;/);
});

test("月历只请求聚合接口，未来日期不可进入", () => {
  const render = section(
    app,
    "function renderCalendar(calendar) {",
    "async function loadCalendar(month = state.feedbackCalendarMonth) {"
  );
  assert.match(render, /button\.disabled = cell\.future/);
  assert.match(render, /is-today/);
  assert.match(render, /is-empty/);
  assert.match(
    render,
    /#calendar-next-month"\)\.disabled = calendar\.month >= currentMonth/
  );
  const load = section(
    app,
    "async function loadCalendar(month = state.feedbackCalendarMonth) {",
    "async function changeCalendarMonth(delta) {"
  );
  assert.match(load, /\/api\/feedback\/calendar/);
  const feedbackLoad = section(
    app,
    "async function loadFeedback() {",
    "async function refreshAll() {"
  );
  assert.match(feedbackLoad, /\/api\/feedback\/calendar/);
});

test("日明细展示汇总与聚合题目，不泄露答案或提示正文", () => {
  const render = section(
    app,
    "function renderDayDetail(detail) {",
    "async function loadDayDetail(date) {"
  );
  assert.match(render, /detail\.summary\.completedCount/);
  assert.match(render, /detail\.summary\.attemptCount/);
  assert.match(render, /detail\.summary\.correctCount/);
  assert.match(render, /detail\.summary\.needsCorrectionCount/);
  assert.match(render, /item\.attemptCount/);
  assert.match(render, /item\.hintCount/);
  assert.match(render, /item\.lastOutcome/);
  assert.match(render, /item\.unitMapped/);
  assert.doesNotMatch(
    render,
    /item\.(correctAnswer|studentAnswer|answer|hintContent|content)/i
  );
  const load = section(
    app,
    "async function loadDayDetail(date) {",
    "function openDayDetail(date, trigger = document.activeElement) {"
  );
  assert.match(load, /\/api\/feedback\/day/);
  assert.doesNotMatch(load, /\/api\/feedback\/daily/);
  assert.doesNotMatch(app, /correct_answer/);
});

test("完成情况弹窗支持关闭按钮、Esc 与焦点返回", () => {
  const listeners = section(
    app,
    '$("#calendar-prev-month").addEventListener("click", () => {',
    '$("#knowledge-search-form").addEventListener'
  );
  assert.match(listeners, /#day-detail-close-button"\)\.addEventListener\("click", closeDayDetail\)/);
  assert.match(listeners, /addEventListener\("cancel"/);
  assert.match(listeners, /closeDayDetail\(\)/);
  assert.match(listeners, /state\.dayDetailTrigger/);
  assert.match(listeners, /trigger\.focus\(\)/);
  assert.match(html, /<dialog[\s\S]*id="day-detail-dialog"/);
});

test("月历与弹窗满足 44px 触控、14px 字号与滚动边界", () => {
  assert.match(
    css,
    /\.calendar-grid \{[\s\S]*?grid-template-columns: repeat\(7, minmax\(0, 1fr\)\)/
  );
  const dayBlock = section(css, ".calendar-day {", "}");
  assert.match(dayBlock, /min-height: 44px/);
  assert.match(dayBlock, /font-size: var\(--text-label\)/);
  assert.match(css, /\.calendar-nav-button \{\s*min-height: 44px/);
  assert.match(css, /\.calendar-today-link \{[\s\S]*?min-height: 44px/);
  const dialogBlock = section(css, ".day-detail-dialog {", "}");
  assert.match(dialogBlock, /max-height: calc\(100vh - 32px\)/);
  assert.match(dialogBlock, /overflow: hidden/);
  assert.match(
    css,
    /\.day-detail-dialog \.dialog-body \{\s*overflow-y: auto;/
  );
  assert.match(
    css,
    /@media \(max-width: 560px\) \{[\s\S]*?\.day-detail-dialog \{[\s\S]*?width: calc\(100vw - 20px\)/
  );
});
