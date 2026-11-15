import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const html = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "public/app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "public/styles.css"), "utf8");

function appSection(startMarker, endMarker) {
  const start = app.indexOf(startMarker);
  assert.notEqual(start, -1, `缺少 ${startMarker}`);
  const end = endMarker ? app.indexOf(endMarker, start) : app.length;
  assert.notEqual(end, -1, `缺少 ${endMarker}`);
  return app.slice(start, end);
}

test("教材卡片提供可区分按钮名称与可跳转标题", () => {
  assert.match(app, /createElement\("h3", "settings-textbook-title"\)/);
  assert.match(app, /title\.id = titleId;/);
  assert.match(app, /card\.setAttribute\("aria-labelledby", titleId\);/);
  assert.match(
    app,
    /button\.setAttribute\("aria-label", `切换到 \$\{textbook\.displayName\}`\);/
  );
  assert.match(css, /\.settings-textbook-title\s*\{[^}]*margin:\s*0/s);
});

test("预演/确认/结果阶段切换后焦点落到标题，关闭时回到触发按钮", () => {
  assert.match(
    html,
    /<h2 id="curriculum-dialog-title" tabindex="-1">/
  );
  const stage = appSection(
    "function setCurriculumStage(stage)",
    "function curriculumSplitChoicesComplete"
  );
  assert.match(stage, /focusCurriculumStageTitle\(\);/);
  assert.match(
    app,
    /function focusCurriculumStageTitle\(\)[\s\S]*?#curriculum-dialog-title"\)\?\.focus\(\{ preventScroll: true \}\)/
  );
  const open = appSection(
    "async function openCurriculumDialog",
    "function closeCurriculumDialog"
  );
  assert.match(open, /state\.curriculumTrigger =/);
  const close = appSection(
    "function closeCurriculumDialog",
    "function curriculumMetric"
  );
  assert.match(close, /trigger\?\.isConnected/);
  assert.match(close, /trigger\.focus\(\{ preventScroll: true \}\)/);
});

test("重新进入设置页时审计筛选输入与列表状态一起归零", () => {
  const load = appSection(
    "async function loadSettings",
    "function syncSettingsAfterSwitch"
  );
  const resetIndex = load.indexOf('historyInput.value = "";');
  const requestIndex = load.indexOf("Promise.allSettled");
  assert.notEqual(resetIndex, -1);
  assert.notEqual(requestIndex, -1);
  assert.ok(resetIndex < requestIndex, "应先清空筛选再请求审计列表");
  assert.match(load, /state\.curriculumHistoryMistake = null;/);
});

test("移动端侧栏关闭时 inert，焦点回到菜单按钮", () => {
  assert.match(html, /<aside class="sidebar" id="main-sidebar">/);
  assert.match(html, /aria-controls="main-sidebar"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(app, /sidebar\.inert = !open;/);
  assert.match(app, /menuButton\.setAttribute\("aria-expanded", String\(open\)\)/);
  assert.match(app, /menuButton\.focus\(\{ preventScroll: true \}\)/);
  assert.match(
    app,
    /setSidebarState\(!\$\("\.sidebar"\)\.classList\.contains\("is-open"\)[\s\S]{0,80}restoreFocus: true/
  );
  assert.match(app, /window\.addEventListener\("resize", \(\) => \{[\s\S]{0,80}syncSidebarForViewport\(\)/);
  assert.match(app, /if \(event\.key === "Escape"\) closeSidebar\(\{ restoreFocus: true \}\)/);
});

test("教师审核状态与导航当前项使用可读中文和 aria-current", () => {
  assert.match(
    app,
    /if \(status === "teacher_reviewed"\) return "教师已审核";/
  );
  assert.match(html, /data-view="home" aria-current="page"/);
  assert.match(app, /item\.setAttribute\("aria-current", "page"\)/);
  assert.match(app, /item\.removeAttribute\("aria-current"\)/);
  assert.match(css, /\.settings-badge-teacher_reviewed\s*\{/);
});
