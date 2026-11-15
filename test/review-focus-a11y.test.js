import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const html = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "public/app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "public/styles.css"), "utf8");

function section(startMarker, endMarker) {
  const start = app.indexOf(startMarker);
  assert.notEqual(start, -1, `缺少 ${startMarker}`);
  const end = endMarker ? app.indexOf(endMarker, start) : app.length;
  assert.notEqual(end, -1, `缺少 ${endMarker}`);
  return app.slice(start, end);
}

test("复习全屏入口与退出按钮有清晰名称，题目区可程序化聚焦", () => {
  assert.match(
    html,
    /id="review-enter-focus-button"[\s\S]{0,80}aria-label="进入全屏"/
  );
  assert.match(
    html,
    /id="review-exit-focus-button"[\s\S]{0,80}aria-label="退出全屏"/
  );
  assert.match(
    html,
    /<div class="question-block" id="review-question-block" tabindex="-1">/
  );
  assert.match(
    html,
    /<div class="review-focus-bar" id="review-focus-bar" hidden>/
  );
  assert.match(html, /id="review-focus-progress">第 1 题</);
  assert.match(html, /id="review-focus-point"><\/span>/);
  assert.match(
    html,
    /id="menu-button"[\s\S]{0,160}aria-expanded="false"/
  );
});

test("全屏模式覆盖导航并保留响应式、键盘焦点样式", () => {
  assert.match(
    css,
    /body\.review-focus-mode #view-review\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0;[^}]*overflow-y:\s*auto;/s
  );
  assert.match(
    css,
    /body\.review-focus-mode \.sidebar,[\s\S]{0,80}body\.review-focus-mode \.topbar\s*\{[^}]*display:\s*none;/s
  );
  assert.match(
    css,
    /body\.review-focus-mode #view-review \.page-heading,[\s\S]{0,120}\.review-instruction\s*\{[^}]*display:\s*none;/s
  );
  assert.match(
    css,
    /body\.review-focus-mode #view-review \.review-focus-bar\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;/s
  );
  assert.match(
    css,
    /body\.review-focus-mode #view-review #review-point,[\s\S]{0,120}\.review-focus-button\s*\{[^}]*display:\s*none;/s
  );
  assert.match(
    css,
    /body\.review-focus-mode #view-review \.review-card,[\s\S]{0,160}max-width:\s*880px/s
  );
  assert.match(
    css,
    /\.review-focus-button:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--green\)/s
  );
  assert.match(
    css,
    /@media \(max-width: 560px\)[\s\S]*?\.review-focus-button\s*\{[^}]*min-height:\s*44px/
  );
});

test("进入和退出全屏保存滚动位置、隔离背景并恢复焦点", () => {
  const enter = section("async function enterReviewFocus", "async function exitReviewFocus");
  assert.match(enter, /state\.reviewFocusScrollY = window\.scrollY;/);
  assert.match(enter, /setReviewFocusInert\(true\);/);
  assert.match(enter, /requestFullscreen/);
  assert.doesNotMatch(enter, /\bcloseSidebar\s*\(/);
  assert.match(enter, /sidebar\.classList\.remove\("is-open"\)/);
  assert.match(enter, /menuButton\.setAttribute\("aria-expanded", "false"\)/);
  assert.match(enter, /menuButton\.setAttribute\("aria-label", "打开菜单"\)/);
  assert.match(
    enter,
    /#review-question-block"\)\?\.focus\(\{ preventScroll: true \}\)/
  );
  assert.ok(
    enter.indexOf('document.body.classList.add("review-focus-mode")') <
      enter.indexOf('sidebar.classList.remove("is-open")'),
    "应先应用专注层，再处理侧栏"
  );

  const exit = section("async function exitReviewFocus", "function splitAnswerVariants");
  assert.match(exit, /setReviewFocusInert\(false\);/);
  assert.match(exit, /window\.scrollTo\(\{ top: state\.reviewFocusScrollY/);
  assert.match(
    exit,
    /#review-enter-focus-button"\)\?\.focus\(\{ preventScroll: true \}\)/
  );
  assert.match(
    app,
    /function setReviewFocusInert\(active\)[\s\S]*?element\.inert = true;/
  );
});

test("进入全屏在缺少 closeSidebar 时仍能应用 UI 并且不抛错", async () => {
  const enterSource = section(
    "async function enterReviewFocus",
    "async function exitReviewFocus"
  );
  const bodyClasses = new Set();
  const rootClasses = new Set();
  const sidebarClasses = new Set(["is-open"]);
  const menuAttributes = new Map();
  const sidebar = {
    inert: false,
    classList: {
      remove(name) {
        sidebarClasses.delete(name);
      }
    }
  };
  const menuButton = {
    setAttribute(name, value) {
      menuAttributes.set(name, String(value));
    }
  };
  const focusBar = { hidden: true };
  const questionBlock = {
    focused: false,
    focus() {
      this.focused = true;
    }
  };
  const fakeDocument = {
    body: {
      classList: {
        add(name) {
          bodyClasses.add(name);
        }
      }
    },
    documentElement: {
      classList: {
        add(name) {
          rootClasses.add(name);
        }
      },
      requestFullscreen: undefined
    },
    fullscreenElement: null,
    querySelector(selector) {
      if (selector === ".sidebar") return sidebar;
      if (selector === "#menu-button") return menuButton;
      if (selector === "#review-focus-bar") return focusBar;
      if (selector === "#view-review") return { scrollTop: 10 };
      if (selector === "#review-question-block") return questionBlock;
      return null;
    }
  };
  const fakeWindow = {
    scrollY: 240,
    scrollTo() {},
    matchMedia() {
      return { matches: false };
    }
  };
  const fakeState = {
    reviewFocusMode: false,
    reviewFocusScrollY: 0
  };
  let inertActive = null;
  let chromeSynced = false;
  const factory = new Function(
    "state",
    "document",
    "window",
    "$",
    "syncReviewFocusChrome",
    "setReviewFocusInert",
    `${enterSource}\nreturn enterReviewFocus;`
  );
  const enterReviewFocus = factory(
    fakeState,
    fakeDocument,
    fakeWindow,
    (selector) => fakeDocument.querySelector(selector),
    () => {
      chromeSynced = true;
    },
    (active) => {
      inertActive = active;
    }
  );

  await enterReviewFocus();

  assert.equal(fakeState.reviewFocusMode, true);
  assert.equal(fakeState.reviewFocusScrollY, 240);
  assert.equal(bodyClasses.has("review-focus-mode"), true);
  assert.equal(rootClasses.has("review-focus-mode"), true);
  assert.equal(focusBar.hidden, false);
  assert.equal(sidebarClasses.has("is-open"), false);
  assert.equal(menuAttributes.get("aria-expanded"), "false");
  assert.equal(menuAttributes.get("aria-label"), "打开菜单");
  assert.equal(inertActive, true);
  assert.equal(chromeSynced, true);
  assert.equal(questionBlock.focused, true);
});

test("原生全屏退出、Esc 和视图切换都会结束复习全屏", () => {
  assert.match(
    app,
    /document\.addEventListener\("fullscreenchange", \(\) => \{[\s\S]{0,160}exitReviewFocus\(\{ skipFullscreenExit: true \}\)/
  );
  assert.match(
    app,
    /event\.key === "Escape"[\s\S]{0,140}state\.reviewFocusMode[\s\S]{0,100}!document\.fullscreenElement[\s\S]{0,80}exitReviewFocus\(\)/
  );
  assert.match(
    app,
    /function showView\(name, \{ updateHash = true \} = \{\}\) \{[\s\S]{0,120}state\.reviewFocusMode && name !== "review"[\s\S]{0,100}exitReviewFocus\(\{ restoreFocus: false \}\)/
  );
  assert.match(
    app,
    /#review-enter-focus-button"\)\.addEventListener\("click", enterReviewFocus\)/
  );
  assert.match(app, /#review-exit-focus-button"\)\.addEventListener\("click"/);
});

test("全屏进度来自当前复习队列，队列不可用时安全回退", () => {
  const progress = section("function reviewFocusProgressText", "function syncReviewFocusChrome");
  assert.match(progress, /queue\.findIndex\(\(item\) => item\.id === review\.id\)/);
  assert.match(progress, /第 \$\{index \+ 1\} \/ \$\{queue\.length\} 题/);
  assert.match(progress, /return "第 1 题";/);
  assert.match(
    app,
    /api\("\/api\/review\/queue\?limit=20"\)\.catch\(\(\) => \(\{ items: \[\] \}\)\)/
  );
});

test("快速退出时原生全屏稍后才生效也会被清理", () => {
  const enter = section("async function enterReviewFocus", "async function exitReviewFocus");
  assert.match(
    enter,
    /if \(!state\.reviewFocusMode\) \{[\s\S]{0,180}document\.exitFullscreen\(\)/
  );
});
