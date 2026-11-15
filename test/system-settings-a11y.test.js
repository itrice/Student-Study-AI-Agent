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

test("结果页主按钮导航知识地图，次按钮留在设置并聚焦当前教材", () => {
  assert.match(
    html,
    /id="curriculum-stay-button" hidden>留在系统配置</
  );
  assert.match(
    html,
    /id="curriculum-done-button" hidden>查看知识点地图</
  );
  assert.equal(html.includes("返回知识地图"), false);
  assert.match(html, /id="knowledge-title" tabindex="-1"/);
  assert.match(html, /id="settings-title" tabindex="-1"/);
  assert.match(app, /finishCurriculumSwitch\("settings"\)/);
  assert.match(app, /finishCurriculumSwitch\("knowledge"\)/);

  const finish = appSection(
    "async function finishCurriculumSwitch",
    "function resetKnowledgeSearch"
  );
  assert.match(finish, /destination === "knowledge"/);
  assert.match(finish, /navigateTo\("knowledge"\)/);
  assert.match(finish, /focusKnowledgeAfterSwitch\(\)/);
  assert.match(finish, /await syncSettingsAfterSwitch\(\)/);
  assert.match(finish, /focusCurrentTextbookCard\(\)/);

  const focusCurrent = appSection(
    "function focusCurrentTextbookCard",
    "function focusKnowledgeAfterSwitch"
  );
  assert.match(focusCurrent, /settings-textbook-title-/);
  assert.match(focusCurrent, /#settings-title/);
  assert.match(app, /title\.tabIndex = -1;/);
  assert.match(
    css,
    /\.settings-textbook-title:focus,[\s\S]*#knowledge-title:focus/
  );
});
