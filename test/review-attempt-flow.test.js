import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  REVIEW_AUTO_ADVANCE_DELAY_MS,
  reviewNavigationBoundaries,
  reviewNavigationTarget,
  reviewResultStatus,
  reviewResultTitle,
  reviewShouldAutoAdvance
} from "../public/review-flow.js";

const root = process.cwd();
const app = fs.readFileSync(path.join(root, "public/app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "public/styles.css"), "utf8");

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `缺少起始标记：${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `缺少结束标记：${endMarker}`);
  return source.slice(start, end);
}

test("复习队列上一题/下一题边界与顺序正确", () => {
  const queue = [{ id: 11 }, { id: 22 }, { id: 33 }];

  assert.deepEqual(reviewNavigationBoundaries(queue[0], queue), {
    previous: false,
    next: true
  });
  assert.deepEqual(reviewNavigationBoundaries(queue[1], queue), {
    previous: true,
    next: true
  });
  assert.deepEqual(reviewNavigationBoundaries(queue[2], queue), {
    previous: true,
    next: false
  });
  assert.deepEqual(reviewNavigationBoundaries({ id: 99 }, queue), {
    previous: false,
    next: false
  });

  assert.deepEqual(reviewNavigationTarget(queue[1], queue, "previous"), {
    id: 11,
    index: 0,
    total: 3
  });
  assert.deepEqual(reviewNavigationTarget(queue[1], queue, "next"), {
    id: 33,
    index: 2,
    total: 3
  });
  assert.equal(reviewNavigationTarget(queue[0], queue, "previous"), null);
  assert.equal(reviewNavigationTarget(queue[2], queue, "next"), null);
  assert.equal(reviewNavigationTarget({ id: 99 }, queue, "next"), null);
});

test("只有整题完全正确才允许自动切题", () => {
  assert.equal(
    reviewShouldAutoAdvance({
      correct: true,
      outcome: "correct"
    }),
    true
  );
  assert.equal(
    reviewShouldAutoAdvance({
      correct: false,
      outcome: "partial"
    }),
    false
  );
  assert.equal(
    reviewShouldAutoAdvance({
      correct: false,
      outcome: "incorrect"
    }),
    false
  );
  assert.equal(reviewShouldAutoAdvance(null), false);
  assert.ok(REVIEW_AUTO_ADVANCE_DELAY_MS >= 800);
  assert.ok(REVIEW_AUTO_ADVANCE_DELAY_MS <= 2000);
});

test("客观结果文案区分全对、部分正确和答错", () => {
  assert.equal(
    reviewResultTitle({ outcome: "correct" }),
    "这道题全部答对"
  );
  assert.equal(
    reviewResultTitle({ outcome: "partial" }),
    "部分小问正确，整题还没做对"
  );
  assert.equal(reviewResultTitle({ outcome: "incorrect" }), "这道题还没做对");

  assert.equal(
    reviewResultStatus({
      outcome: "partial",
      correctPartCount: 1,
      totalPartCount: 2
    }),
    "本次 1 / 2 个小问正确，整题尚未完成"
  );
  assert.equal(
    reviewResultStatus({ outcome: "incorrect" }),
    "本次作答未通过"
  );
});

test("答错或部分正确的结果只显示客观状态与重试/主动提示入口", () => {
  const result = section(
    app,
    "function renderReviewResult(result) {",
    "function openAddDialog() {"
  );

  assert.doesNotMatch(result, /result\.(answer|analysis|diagnosis|feedback)/);
  assert.doesNotMatch(
    result,
    /result\.(firstError|finalAnswerAssessment|stepAssessment)/
  );
  assert.doesNotMatch(result, /acceptedAnswers|参考答案：|订正思路：|步骤分析（/);
  assert.doesNotMatch(result, /loadHintLevel\(|showHint\(|loadNextReview\(/);
  assert.match(result, /review-result-retry-button/);
  assert.match(result, /review-result-hint-button/);
  assert.match(result, /主动查看提示/);
  assert.match(result, /target\.focus\(\{ preventScroll: true \}\)/);
  assert.match(
    html,
    /id="review-result"[\s\S]*?role="status"[\s\S]*?aria-live="polite"/
  );
});

test("提交答错不会加载提示或跳题，全对才安排短暂自动切换", () => {
  const submit = section(
    app,
    "async function submitAttempt(event) {",
    "function renderReviewResult(result) {"
  );

  assert.doesNotMatch(submit, /loadHintLevel\(|showHint\(\)/);
  assert.doesNotMatch(submit, /loadNextReview\(|navigateReview\(/);
  assert.match(submit, /if \(result && reviewShouldAutoAdvance\(result\)\) {/);
  assert.match(submit, /scheduleReviewAutoAdvance\(\)/);

  const schedule = section(
    app,
    "function scheduleReviewAutoAdvance() {",
    "function captureReviewDraft() {"
  );
  assert.match(schedule, /REVIEW_AUTO_ADVANCE_DELAY_MS/);
  assert.match(schedule, /window\.setTimeout/);
  assert.match(schedule, /advanceReviewAfterCorrect/);

  const advance = section(
    app,
    "async function advanceReviewAfterCorrect() {",
    "function scheduleReviewAutoAdvance() {"
  );
  assert.match(advance, /reviewNavigationTarget/);
  assert.match(advance, /completeReviewQueue\(\)/);
});

test("提示只在学生点击后加载，结果页提示入口也走点击事件", () => {
  const showHint = section(
    app,
    "function showHint({ fromResult = false } = {}) {",
    "function showAnswerForm() {"
  );
  assert.match(showHint, /loadHintLevel/);

  const loadHintCalls = app.match(/loadHintLevel\(/g) || [];
  assert.equal(loadHintCalls.length, 2);
  const resultListener = section(
    app,
    '  $("#review-result").addEventListener("click", (event) => {',
    '  $("#add-form").addEventListener'
  );
  assert.match(resultListener, /#review-result-hint-button/);
  assert.match(resultListener, /showHint\(\{ fromResult: true \}\)/);
});

test("手动切题只读取队列，不提交作答，并保存未提交输入", () => {
  const navigate = section(
    app,
    "async function navigateReview(direction) {",
    "function syncReviewFocusChrome() {"
  );
  assert.doesNotMatch(navigate, /attempts|submitAttempt|loadHintLevel/);
  assert.match(navigate, /captureReviewDraft\(\)/);
  assert.match(navigate, /openReview\(target\.id\)/);
  assert.match(navigate, /reviewNavigationTarget/);
});

test("切换离开再返回时恢复本次会话未提交输入和提示等级", () => {
  const capture = section(
    app,
    "function captureReviewDraft() {",
    "function restoreReviewDraft(review) {"
  );
  const restore = section(
    app,
    "function restoreReviewDraft(review) {",
    "async function navigateReview(direction) {"
  );
  const elements = new Map([
    ["#answer-form", { hidden: false }],
    ["#review-pre-actions", { hidden: true }],
    ["#hint-panel", { hidden: true }],
    ["#review-parts", {}]
  ]);
  const inputs = [
    { dataset: { reviewPartId: "11" }, value: "2:12" },
    { dataset: { reviewPartId: "12" }, value: "" }
  ];
  const state = {
    review: { id: 7 },
    reviewSubmitted: false,
    reviewDrafts: new Map(),
    reviewHintLevel: 2,
    hintRequestKey: "hint-key",
    followUpRequestKey: "follow-up-key",
    attemptRequestKey: "attempt-key"
  };
  const fakeQuery = (selector) => elements.get(selector) || null;
  const fakeQueryAll = () => inputs;
  const factory = new Function(
    "state",
    "$",
    "$$",
    `${capture}\n${restore}\nreturn { captureReviewDraft, restoreReviewDraft };`
  );
  const { captureReviewDraft, restoreReviewDraft } = factory(
    state,
    fakeQuery,
    fakeQueryAll
  );

  captureReviewDraft();
  const draft = state.reviewDrafts.get(7);
  assert.ok(draft);
  assert.deepEqual(draft.values, [
    { partId: 11, value: "2:12" },
    { partId: 12, value: "" }
  ]);
  assert.equal(draft.hintLevel, 2);
  assert.equal(draft.attemptRequestKey, "attempt-key");

  inputs[0].value = "";
  elements.get("#answer-form").hidden = true;
  elements.get("#review-pre-actions").hidden = false;
  elements.get("#hint-panel").hidden = false;
  state.reviewHintLevel = 0;
  state.attemptRequestKey = null;
  assert.equal(restoreReviewDraft({ id: 7 }), true);
  assert.equal(inputs[0].value, "2:12");
  assert.equal(state.reviewHintLevel, 2);
  assert.equal(state.attemptRequestKey, "attempt-key");
  assert.equal(elements.get("#answer-form").hidden, false);
  assert.equal(elements.get("#review-pre-actions").hidden, true);
});

test("复习页与全屏专注层使用同一套上一题/下一题边界", () => {
  for (const id of [
    "review-prev-button",
    "review-next-button",
    "review-focus-prev-button",
    "review-focus-next-button"
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /id="review-position">第 1 题/);
  assert.match(html, /aria-label="复习题目切换"/);
  const navListeners = section(
    app,
    '  $("#review-prev-button").addEventListener',
    '  $("#review-enter-focus-button").addEventListener'
  );
  assert.match(navListeners, /#review-prev-button/);
  assert.match(navListeners, /#review-next-button/);
  assert.match(navListeners, /navigateReview\("previous"\)/);
  assert.match(navListeners, /navigateReview\("next"\)/);
  assert.match(
    css,
    /body\.review-focus-mode #view-review \.review-navigation {\s*display: none;/
  );
  assert.match(css, /\.review-focus-nav/);
});
