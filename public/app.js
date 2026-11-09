const state = {
  student: null,
  knowledgePoints: [],
  dashboard: null,
  mistakes: [],
  knowledge: [],
  filter: "all",
  review: null,
  reviewAttemptsThisSession: 0,
  reviewHintLevel: 0,
  dialogMode: "create",
  editingMistakeId: null,
  editSubmissionKey: null,
  lastDiagnosis: null,
  busy: false,
  diagnosisRequest: 0
};

const viewLabels = {
  home: "今日学习",
  review: "开始复习",
  mistakes: "我的错题",
  knowledge: "知识点地图"
};

const statusLabels = {
  new: "待复习",
  practicing: "练习中",
  mastered: "已掌握"
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [
  ...root.querySelectorAll(selector)
];

function createElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "请求失败，请稍后再试");
  }
  return data;
}

function formatDate(value, options = {}) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    ...options
  }).format(date);
}

function formatRelativeDate(value) {
  if (!value) return "还未复习";
  const date = new Date(value);
  const today = new Date();
  const dayStart = (input) =>
    new Date(input.getFullYear(), input.getMonth(), input.getDate()).getTime();
  const difference = Math.round((dayStart(date) - dayStart(today)) / 86400000);
  if (difference < 0) return `逾期 ${Math.abs(difference)} 天`;
  if (difference === 0) return "今天复习";
  if (difference === 1) return "明天复习";
  return `${formatDate(value)} 复习`;
}

function statusBadge(status) {
  return createElement(
    "span",
    `status-badge status-${status}`,
    statusLabels[status] || status
  );
}

function knowledgeTag(name) {
  return createElement("span", "tag", name);
}

function showToast(message, isError = false) {
  const region = $("#toast-region");
  const toast = createElement("div", `toast${isError ? " is-error" : ""}`, message);
  region.append(toast);
  window.setTimeout(() => toast.remove(), 3200);
}

function setBusy(button, busy, busyText = "正在处理…") {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.innerHTML;
    button.textContent = busyText;
    button.disabled = true;
  } else {
    if (button.dataset.originalText) {
      button.innerHTML = button.dataset.originalText;
      delete button.dataset.originalText;
    }
    button.disabled = false;
  }
}

function showView(name, { updateHash = true } = {}) {
  if (!viewLabels[name]) name = "home";
  $$("[data-view-panel]").forEach((panel) => {
    panel.classList.toggle("is-active", panel.dataset.viewPanel === name);
  });
  $$(".nav-item").forEach((item) => {
    item.classList.toggle("is-active", item.dataset.view === name);
  });
  $("#page-label").textContent = viewLabels[name];
  $(".sidebar").classList.remove("is-open");
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (updateHash && window.location.hash !== `#${name}`) {
    history.pushState(null, "", `#${name}`);
  }
}

function readRoute() {
  const [rawView, rawId] = window.location.hash.slice(1).split("/");
  const view = viewLabels[rawView] ? rawView : "home";
  const mistakeId =
    view === "review" && /^\d+$/.test(rawId || "") ? Number(rawId) : null;
  return { view, mistakeId };
}

function navigateTo(name) {
  showView(name);
  if (name === "review") {
    loadNextReview();
  }
}

async function loadBootstrap() {
  const data = await api("/api/bootstrap");
  state.student = data.student;
  state.knowledgePoints = data.knowledgePoints;
  $("#student-name").textContent = data.student.name;

  const select = $("#knowledge-point-select");
  for (const point of data.knowledgePoints) {
    const option = createElement("option", "", point.name);
    option.value = point.name;
    select.append(option);
  }
}

async function loadDashboard() {
  state.dashboard = await api("/api/dashboard");
  renderDashboard();
}

function renderDashboard() {
  const dashboard = state.dashboard;
  if (!dashboard) return;
  const { stats, nextReview, recent } = dashboard;
  $("#stat-due").textContent = stats.due;
  $("#stat-total").textContent = stats.total;
  $("#stat-mastered").textContent = stats.mastered;
  $("#stat-rate").textContent = stats.total
    ? Math.round((stats.mastered / stats.total) * 100)
    : "--";
  $("#nav-due-count").textContent = stats.due;
  $("#nav-due-count").hidden = stats.due === 0;

  const priority = $("#priority-content");
  priority.replaceChildren();
  if (nextReview) {
    const box = createElement("div", "priority-question");
    const tags = createElement("div", "priority-tags");
    tags.append(knowledgeTag(nextReview.knowledgePoint));
    tags.append(createElement("span", "tag is-coral", nextReview.errorType));
    box.append(tags);
    box.append(createElement("p", "", nextReview.question));

    const footer = createElement("div", "priority-footer");
    const meta = createElement(
      "span",
      "",
      nextReview.attemptCount
        ? `已经练习 ${nextReview.attemptCount} 次，继续把思路补完整`
        : "这是第一次独立重做"
    );
    const button = createElement("button", "primary-button compact", "开始这道题");
    button.type = "button";
    button.dataset.reviewId = nextReview.id;
    footer.append(meta, button);
    box.append(footer);
    priority.append(box);
  } else if (stats.total === 0) {
    const empty = createElement("div", "priority-empty");
    const content = createElement("div");
    content.append(
      createElement("strong", "", "先录入一道最近不会的题"),
      createElement("br"),
      createElement("span", "", "系统会自动判断知识点，并把它放到复习首位。")
    );
    empty.append(content);
    priority.append(empty);
  } else {
    const empty = createElement("div", "priority-empty");
    empty.textContent = "今天需要复习的题已经处理完了，休息一下再回来巩固。";
    priority.append(empty);
  }

  renderWeakness();
  renderRecent(recent);
}

function renderWeakness() {
  const target = $("#weakness-list");
  target.replaceChildren();
  const weak = state.knowledge
    .filter((item) => item.total > 0 && item.mastery < 100)
    .sort((a, b) => a.mastery - b.mastery || b.total - a.total)
    .slice(0, 4);

  if (!weak.length) {
    target.append(createElement("div", "empty-mini", "还没有需要重点关注的知识点"));
    return;
  }

  for (const point of weak) {
    const item = createElement("div", "weakness-item");
    item.append(
      createElement("strong", "", point.name),
      createElement("b", "", `${point.mastery}%`)
    );
    const track = createElement("div", "mastery-track");
    const bar = createElement("i");
    bar.style.width = `${point.mastery}%`;
    track.append(bar);
    item.append(track);
    target.append(item);
  }
}

function renderRecent(recent) {
  const target = $("#recent-list");
  target.replaceChildren();
  if (!recent.length) {
    const empty = createElement("div", "recent-empty");
    empty.append(createElement("span", "", "错题库还是空的，录入第一道题开始积累学习证据。"));
    const button = createElement("button", "text-button", "载入示例题看看");
    button.type = "button";
    button.dataset.loadDemo = "true";
    empty.append(button);
    target.append(empty);
    return;
  }

  for (const mistake of recent) {
    const item = createElement("article", "recent-item");
    item.tabIndex = 0;
    item.dataset.reviewId = mistake.id;
    const top = createElement("div", "recent-item-top");
    top.append(
      knowledgeTag(mistake.knowledgePoint),
      createElement("time", "", formatDate(mistake.createdAt))
    );
    item.append(
      top,
      createElement("p", "", mistake.question),
      createElement("small", "", `${statusLabels[mistake.status]} · ${mistake.errorType}`)
    );
    target.append(item);
  }
}

async function loadMistakes() {
  state.mistakes = await api("/api/mistakes");
  renderMistakeCounts();
  renderMistakes();
}

function renderMistakeCounts() {
  const counts = {
    all: state.mistakes.length,
    new: state.mistakes.filter((item) => item.status === "new").length,
    practicing: state.mistakes.filter((item) => item.status === "practicing").length,
    mastered: state.mistakes.filter((item) => item.status === "mastered").length
  };
  for (const [status, count] of Object.entries(counts)) {
    $(`#filter-count-${status}`).textContent = count;
  }
}

function renderMistakes() {
  const target = $("#mistake-list");
  target.replaceChildren();
  const items =
    state.filter === "all"
      ? state.mistakes
      : state.mistakes.filter((item) => item.status === state.filter);

  if (!items.length) {
    const empty = createElement("div", "list-empty");
    empty.append(
      createElement(
        "strong",
        "",
        state.mistakes.length
          ? "这个分类里还没有错题"
          : "错题库还是空的"
      ),
      createElement(
        "span",
        "",
        state.mistakes.length
          ? "切换其他状态看看，或继续录入新错题。"
          : "从一道当前不会的题开始，先诊断知识点，再通过重做确认掌握。"
      )
    );
    if (!state.mistakes.length) {
      const button = createElement("button", "primary-button", "录入第一道错题");
      button.type = "button";
      button.dataset.openAdd = "true";
      empty.append(button);
    }
    target.append(empty);
    return;
  }

  items.forEach((mistake, index) => {
    const card = createElement("article", "mistake-card");
    const number = createElement(
      "div",
      "mistake-index",
      String(state.mistakes.indexOf(mistake) + 1).padStart(2, "0")
    );
    const main = createElement("div", "mistake-main");
    const line = createElement("div", "mistake-topline");
    line.append(
      statusBadge(mistake.status),
      knowledgeTag(mistake.knowledgePoint),
      createElement("span", "tag", mistake.errorType)
    );
    const question = createElement("p", "mistake-question", mistake.question);
    const detail = createElement("div", "mistake-detail");
    detail.append(
      createElement(
        "span",
        "",
        `录入于 ${formatDate(mistake.createdAt)}`
      ),
      createElement(
        "span",
        "",
        mistake.attemptCount
          ? `已重做 ${mistake.attemptCount} 次`
          : "还没有重做"
      ),
      createElement("span", "", formatRelativeDate(mistake.dueAt))
    );
    main.append(line, question, detail);

    const actions = createElement("div", "mistake-actions");
    const reviewButton = createElement(
      "button",
      "small-action",
      mistake.status === "mastered" ? "再巩固" : "去重做"
    );
    reviewButton.type = "button";
    reviewButton.dataset.reviewId = mistake.id;

    const editButton = createElement("button", "small-action", "修改");
    editButton.type = "button";
    editButton.title = "修改这道错题";
    editButton.dataset.editId = mistake.id;
    editButton.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 4.2-1 10.6-10.6-3.2-3.2L5 15.8 4 20ZM13.8 7l3.2 3.2" /></svg><span>修改</span>';

    const deleteButton = createElement("button", "small-action danger");
    deleteButton.type = "button";
    deleteButton.title = "删除这道错题";
    deleteButton.dataset.deleteId = mistake.id;
    deleteButton.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M9 7V4.5h6V7M7 7l1 12h8l1-12M10 10.5v5M14 10.5v5" /></svg>';
    actions.append(reviewButton, editButton, deleteButton);
    card.append(number, main, actions);
    target.append(card);
  });
}

async function loadKnowledge() {
  state.knowledge = await api("/api/knowledge-points");
  renderKnowledge();
  renderWeakness();
}

function renderKnowledge() {
  const summary = $("#knowledge-summary");
  const grid = $("#knowledge-grid");
  summary.replaceChildren();
  grid.replaceChildren();

  const studied = state.knowledge.filter((item) => item.total > 0);
  const weak = studied.filter((item) => item.mastery < 70);
  const totalMistakes = studied.reduce((total, item) => total + item.total, 0);
  const mastered = studied.reduce((total, item) => total + item.mastered, 0);

  const summaryItems = [
    {
      label: "已覆盖知识点",
      value: studied.length,
      note: `共 ${state.knowledge.length} 个六年级重点知识点`
    },
    {
      label: "需要重点巩固",
      value: weak.length,
      note: "掌握度低于 70%"
    },
    {
      label: "错题掌握率",
      value: totalMistakes ? `${Math.round((mastered / totalMistakes) * 100)}%` : "--",
      note: `已掌握 ${mastered} / ${totalMistakes} 道`
    }
  ];

  for (const item of summaryItems) {
    const card = createElement("article", "knowledge-hero-stat");
    card.append(
      createElement("small", "", item.label),
      createElement("strong", "", item.value),
      createElement("span", "", item.note)
    );
    summary.append(card);
  }

  const sorted = [...state.knowledge].sort((a, b) => {
    if (a.mastery === null && b.mastery === null) return a.id - b.id;
    if (a.mastery === null) return 1;
    if (b.mastery === null) return -1;
    return a.mastery - b.mastery || b.total - a.total;
  });

  for (const point of sorted) {
    const card = createElement(
      "article",
      `knowledge-card${point.mastery === null ? " is-empty" : point.mastery < 70 ? " is-weak" : ""}`
    );
    const head = createElement("div", "knowledge-card-head");
    head.append(createElement("h3", "", point.name));
    const score = createElement("div", "knowledge-score");
    if (point.mastery === null) {
      score.append(document.createTextNode("--"));
    } else {
      score.append(document.createTextNode(String(point.mastery)));
      score.append(createElement("small", "", "%"));
    }
    head.append(score);
    card.append(head);

    const track = createElement("div", "mastery-track");
    const bar = createElement("i", point.mastery >= 70 ? "is-good" : "");
    bar.style.width = `${point.mastery ?? 0}%`;
    track.append(bar);
    card.append(track);

    const meta = createElement("div", "knowledge-meta");
    meta.append(
      createElement("span", "", point.total ? `${point.total} 道错题` : "暂无题目"),
      createElement(
        "span",
        "",
        point.total ? `待复习 ${point.new} · 练习中 ${point.practicing}` : "尚未覆盖"
      )
    );
    card.append(meta);

    if (point.mastery !== null && point.mastery < 70) {
      card.append(
        createElement(
          "p",
          "knowledge-card-note",
          "建议先独立重做错题，再用同类练习确认是否真正掌握。"
        )
      );
    }
    grid.append(card);
  }
}

async function refreshAll() {
  await Promise.all([loadDashboard(), loadMistakes(), loadKnowledge()]);
}

async function loadNextReview() {
  const loading = $("#review-loading");
  const card = $("#review-card");
  const empty = $("#review-empty");
  loading.hidden = false;
  card.hidden = true;
  empty.hidden = true;
  try {
    const review = await api("/api/review/next");
    if (!review) {
      state.review = null;
      showReviewEmpty();
      return;
    }
    state.review = review;
    renderReview();
  } catch (error) {
    loading.hidden = true;
    showToast(error.message, true);
    showReviewEmpty("复习内容暂时加载失败", "请稍后重新进入当前页面。");
  }
}

function showReviewEmpty(
  title = "今天暂时没有要复习的题",
  copy = "可以录入一道最近不会的题，系统会把它放到优先位置。"
) {
  $("#review-loading").hidden = true;
  $("#review-card").hidden = true;
  const empty = $("#review-empty");
  $("#review-empty-title").textContent = title;
  $("#review-empty-copy").textContent = copy;
  empty.hidden = false;
  $("#review-progress").style.width = "100%";
  $("#review-session-label").textContent = "本轮复习已完成";
}

function splitAnswerVariants(value) {
  return String(value || "")
    .split(/[或;；\n]/)
    .map((answer) => answer.trim())
    .filter(Boolean);
}

function appendField(container, labelText, control) {
  const label = createElement("label", "field");
  label.append(createElement("span", "", labelText), control);
  container.append(label);
  return control;
}

function createPartEditor(part = {}, index = 0) {
  const editor = createElement("article", "part-editor");
  const heading = createElement("div", "part-editor-heading");
  heading.append(
    createElement("strong", "part-editor-title", `小问 ${index + 1}`)
  );
  const headingActions = createElement("div", "part-editor-actions");
  const moveUp = createElement("button", "part-move-button", "↑");
  moveUp.type = "button";
  moveUp.dataset.movePart = "-1";
  moveUp.title = "上移这个小问";
  const moveDown = createElement("button", "part-move-button", "↓");
  moveDown.type = "button";
  moveDown.dataset.movePart = "1";
  moveDown.title = "下移这个小问";
  const removeButton = createElement("button", "part-remove-button");
  removeButton.type = "button";
  removeButton.dataset.removePart = "true";
  removeButton.title = "删除这个小问";
  removeButton.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M9 7V4.5h6V7M7 7l1 12h8l1-12M10 10.5v5M14 10.5v5" /></svg>';
  headingActions.append(moveUp, moveDown, removeButton);
  heading.append(headingActions);
  editor.append(heading);

  const grid = createElement("div", "part-editor-grid");
  const labelInput = document.createElement("input");
  labelInput.dataset.partField = "label";
  labelInput.maxLength = 200;
  labelInput.placeholder = "例如：工作效率比";
  labelInput.value = part.label || "";
  appendField(grid, "小问名称", labelInput);

  const typeSelect = document.createElement("select");
  typeSelect.dataset.partField = "answerType";
  for (const [value, label] of [
    ["auto", "自动判断"],
    ["number", "数值"],
    ["fraction", "分数"],
    ["percent", "百分数"],
    ["ratio", "比"],
    ["text", "文本"]
  ]) {
    const option = createElement("option", "", label);
    option.value = value;
    typeSelect.append(option);
  }
  typeSelect.value = part.answerType || "auto";
  appendField(grid, "答案类型", typeSelect);

  const promptInput = document.createElement("input");
  promptInput.dataset.partField = "prompt";
  promptInput.maxLength = 2000;
  promptInput.placeholder = "可选：这个小问的具体问题";
  promptInput.value = part.prompt || "";
  appendField(grid, "小问题干", promptInput);

  const studentAnswerInput = document.createElement("input");
  studentAnswerInput.dataset.partField = "studentAnswer";
  studentAnswerInput.maxLength = 1000;
  studentAnswerInput.placeholder = "不会做可以留空";
  studentAnswerInput.value = part.studentAnswer || "";
  appendField(grid, "你当时的答案", studentAnswerInput);

  const answerInput = document.createElement("input");
  answerInput.dataset.partField = "acceptedAnswers";
  answerInput.maxLength = 2000;
  answerInput.required = true;
  answerInput.placeholder = "例如：1:6；2:12";
  answerInput.value = (part.acceptedAnswers || []).join("；");
  appendField(grid, "可接受答案", answerInput);

  const pointSelect = document.createElement("select");
  pointSelect.dataset.partField = "knowledgePoint";
  const autoPoint = createElement("option", "", "跟随整题知识点");
  autoPoint.value = "";
  pointSelect.append(autoPoint);
  for (const point of state.knowledgePoints) {
    const option = createElement("option", "", point.name);
    option.value = point.name;
    pointSelect.append(option);
  }
  pointSelect.value = part.knowledgePoint || "";
  appendField(grid, "小问知识点", pointSelect);

  editor.append(grid);
  return editor;
}

function renumberPartEditors() {
  const editors = $$(".part-editor", $("#parts-list"));
  editors.forEach((editor, index) => {
    $(".part-editor-title", editor).textContent = `小问 ${index + 1}`;
    $('[data-move-part="-1"]', editor).disabled = index === 0;
    $('[data-move-part="1"]', editor).disabled = index === editors.length - 1;
  });
}

function renderPartsEditor(parts = []) {
  const list = $("#parts-list");
  list.replaceChildren();
  const source = parts.length
    ? parts
    : [{ label: "", acceptedAnswers: [] }];
  source.forEach((part, index) => {
    list.append(createPartEditor(part, index));
  });
  renumberPartEditors();
}

function collectMistakeParts({ requireAnswers = true } = {}) {
  const parts = $$(".part-editor", $("#parts-list")).map((editor, index) => {
    const acceptedAnswers = splitAnswerVariants(
      $('[data-part-field="acceptedAnswers"]', editor).value
    );
    if (requireAnswers && !acceptedAnswers.length) {
      throw new Error(`请填写小问 ${index + 1} 的答案`);
    }
    const answerType = $('[data-part-field="answerType"]', editor).value;
    return {
      label: $('[data-part-field="label"]', editor).value.trim(),
      prompt: $('[data-part-field="prompt"]', editor).value.trim(),
      studentAnswer: $(
        '[data-part-field="studentAnswer"]',
        editor
      ).value.trim(),
      answerType,
      comparisonRule: answerType === "ratio" ? "ratio" : "auto",
      knowledgePoint: $(
        '[data-part-field="knowledgePoint"]',
        editor
      ).value,
      acceptedAnswers
    };
  });
  if (!parts.length) throw new Error("请至少添加一个小问");
  return parts;
}

function renderReviewPartInputs(review) {
  const container = $("#review-parts");
  container.replaceChildren();
  for (const part of review.parts || []) {
    const wrapper = createElement("div", "review-part");
    const label = createElement(
      "label",
      "",
      part.label || (review.partCount > 1 ? `小问 ${part.partNo}` : "你的答案")
    );
    if (part.prompt) {
      label.append(createElement("small", "", part.prompt));
    }
    const input = document.createElement("input");
    input.dataset.reviewPartId = String(part.id);
    input.placeholder = part.answerType === "ratio" ? "例如：1:6" : "写出答案";
    input.autocomplete = "off";
    input.maxLength = 3000;
    label.append(input);
    wrapper.append(label);
    container.append(wrapper);
  }
}

function renderReview() {
  const review = state.review;
  $("#review-loading").hidden = true;
  $("#review-empty").hidden = true;
  $("#review-card").hidden = false;
  $("#review-point").textContent = review.knowledgePoint;
  $("#review-attempt").textContent = review.attemptCount
    ? `第 ${review.attemptCount + 1} 次独立练习`
    : "第一次独立重做";
  $("#review-question").textContent = review.question;
  $("#review-hint").textContent = review.hint;

  const steps = $("#review-steps");
  steps.replaceChildren();
  for (const step of review.methodSteps || []) {
    steps.append(createElement("li", "", step));
  }

  $("#review-answer-area").hidden = false;
  $("#review-pre-actions").hidden = false;
  $("#hint-panel").hidden = true;
  $("#answer-form").hidden = true;
  $("#answer-form").reset();
  renderReviewPartInputs(review);
  $("#review-result").hidden = true;
  $("#review-result").replaceChildren();
  state.reviewHintLevel = 0;
  $("#review-progress").style.width = `${Math.min(
    90,
    20 + state.reviewAttemptsThisSession * 18
  )}%`;
  $("#review-session-label").textContent =
    review.status === "new" ? "优先处理当前不会的题" : "逐步把思路补完整";
}

async function openReview(id, { updateHash = true } = {}) {
  try {
    const review = await api(`/api/mistakes/${id}`);
    state.review = review;
    showView("review", { updateHash: false });
    renderReview();
    if (updateHash && window.location.hash !== `#review/${id}`) {
      history.pushState(null, "", `#review/${id}`);
    }
  } catch (error) {
    showToast(error.message, true);
  }
}

function showHint() {
  state.reviewHintLevel = Math.max(1, state.reviewHintLevel);
  $("#review-pre-actions").hidden = true;
  $("#hint-panel").hidden = false;
}

function showAnswerForm() {
  $("#review-pre-actions").hidden = true;
  $("#hint-panel").hidden = true;
  $("#answer-form").hidden = false;
  $("#review-parts input")?.focus();
}

async function submitAttempt(event) {
  event.preventDefault();
  if (!state.review || state.busy) return;
  const answers = $$("[data-review-part-id]", $("#review-parts")).map(
    (input) => ({
      partId: Number(input.dataset.reviewPartId),
      value: input.value.trim()
    })
  );
  const button = $("#answer-form button[type='submit']");
  state.busy = true;
  setBusy(button, true, "正在判断…");
  try {
    const result = await api(`/api/mistakes/${state.review.id}/attempts`, {
      method: "POST",
      body: JSON.stringify({
        answer: answers.length === 1 ? answers[0].value : "",
        answers,
        independent: state.reviewHintLevel === 0,
        hintLevel: state.reviewHintLevel
      })
    });
    state.reviewAttemptsThisSession += 1;
    renderReviewResult(result);
    await Promise.all([loadDashboard(), loadMistakes(), loadKnowledge()]);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    state.busy = false;
    setBusy(button, false);
  }
}

function renderReviewResult(result) {
  const area = $("#review-answer-area");
  const target = $("#review-result");
  area.hidden = true;
  target.hidden = false;
  target.className = `review-result ${
    result.outcome === "correct"
      ? "is-correct"
      : result.outcome === "partial"
        ? "is-partial"
        : "is-wrong"
  }`;
  target.replaceChildren();

  const heading = createElement("div", "result-heading");
  const mark = createElement("span", "result-mark");
  mark.innerHTML = result.correct
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 7" /></svg>'
    : result.outcome === "partial"
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" /></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" /></svg>';
  const headingText = createElement("span");
  headingText.append(
    createElement(
      "strong",
      "",
      result.correct
        ? "这次做对了"
        : result.outcome === "partial"
          ? "部分小问答对了"
          : "先把这个缺口补上"
    ),
    createElement(
      "small",
      "",
      result.correct
        ? result.mastered
          ? "你已经能独立、稳定地做对这道题"
          : "离真正掌握还差一次独立重做"
        : `下次复习：${formatRelativeDate(result.nextReviewAt)}`
    )
  );
  heading.append(mark, headingText);
  target.append(heading);

  target.append(createElement("p", "result-copy", result.feedback));
  if (result.partResults?.length) {
    const partList = createElement("div", "result-parts");
    for (const part of result.partResults) {
      const item = createElement(
        "div",
        `result-part ${part.outcome === "correct" ? "is-correct" : "is-wrong"}`
      );
      const itemHeading = createElement("div", "result-part-heading");
      itemHeading.append(
        createElement(
          "strong",
          "",
          part.label || `小问 ${part.partNo}`
        ),
        createElement(
          "span",
          "",
          part.outcome === "correct" ? "正确" : "需订正"
        )
      );
      item.append(
        itemHeading,
        createElement("p", "", `你的答案：${part.rawAnswer || "未填写"}`)
      );
      if (part.outcome !== "correct") {
        item.append(
          createElement(
            "p",
            "",
            `参考答案：${(part.acceptedAnswers || []).join(" 或 ")}`
          )
        );
      }
      partList.append(item);
    }
    target.append(partList);
  } else if (!result.correct) {
    const answer = createElement("div", "result-answer");
    answer.append(
      document.createTextNode("正确答案"),
      createElement("b", "", result.answer)
    );
    target.append(answer);
    if (result.analysis) {
      target.append(createElement("p", "result-copy", `订正思路：${result.analysis}`));
    }
    if (result.diagnosis) {
      target.append(createElement("p", "result-copy", result.diagnosis));
    }
  }
  if (result.correct && result.mastered) {
    target.append(
      createElement(
        "p",
        "result-copy",
        "掌握不是永远不忘。7 天后系统会安排一次简短回顾。"
      )
    );
  }

  const actions = createElement("div", "result-actions");
  const next = createElement("button", "primary-button", "继续下一题");
  next.type = "button";
  next.id = "next-review-button";
  const library = createElement("button", "secondary-button", "回到错题库");
  library.type = "button";
  library.dataset.goView = "mistakes";
  actions.append(next, library);
  target.append(actions);
  $("#review-progress").style.width = result.mastered ? "100%" : "72%";
}

function openAddDialog() {
  const dialog = $("#add-dialog");
  $("#add-form").reset();
  renderPartsEditor();
  $("#diagnosis-preview").hidden = true;
  state.dialogMode = "create";
  state.editingMistakeId = null;
  state.editSubmissionKey = null;
  state.lastDiagnosis = null;
  $("#dialog-eyebrow").textContent = "建立学习证据";
  $("#dialog-title").textContent = "录入一道错题";
  $("#dialog-footnote").textContent = "保存后会优先进入今日复习。";
  $("#save-mistake-button").textContent = "保存并开始复习";
  if (!dialog.open) dialog.showModal();
  window.setTimeout(() => $("#question-input").focus(), 80);
}

async function openEditDialog(id) {
  try {
    const mistake = await api(`/api/mistakes/${id}`);
    const form = $("#add-form");
    form.reset();
    form.elements.question.value = mistake.question;
    form.elements.knowledgePoint.value = mistake.knowledgePoint;
    form.elements.errorType.value = mistake.errorType;
    form.elements.analysis.value = mistake.analysis || "";
    renderPartsEditor(mistake.parts || []);
    state.dialogMode = "edit";
    state.editingMistakeId = id;
    state.editSubmissionKey = null;
    state.lastDiagnosis = null;
    $("#dialog-eyebrow").textContent = "修正录入信息";
    $("#dialog-title").textContent = "修改错题";
    $("#dialog-footnote").textContent =
      "修改题目、正确答案或知识点会重置掌握进度，历史作答仍会保留。";
    $("#save-mistake-button").textContent = "保存修改";
    $("#diagnosis-preview").hidden = true;
    const dialog = $("#add-dialog");
    if (!dialog.open) dialog.showModal();
    window.setTimeout(() => $("#question-input").focus(), 80);
  } catch (error) {
    showToast(error.message, true);
  }
}

function closeAddDialog() {
  const dialog = $("#add-dialog");
  if (dialog.open) dialog.close();
  state.dialogMode = "create";
  state.editingMistakeId = null;
  state.editSubmissionKey = null;
  state.lastDiagnosis = null;
}

let diagnosisTimer;
function invalidateDiagnosis() {
  state.lastDiagnosis = null;
  $("#diagnosis-preview").hidden = true;
  $("#diagnosis-details").replaceChildren();
}

function renderDiagnosisPreview(result) {
  const details = $("#diagnosis-details");
  details.replaceChildren();
  const facts = createElement("div", "diagnosis-facts");
  facts.append(
    createElement(
      "span",
      "diagnosis-fact",
      result.source === "llm" ? "AI 诊断" : "规则诊断"
    ),
    createElement(
      "span",
      "diagnosis-fact",
      `置信度 ${Math.round(Number(result.confidence || 0) * 100)}%`
    )
  );
  details.append(facts);

  if (result.evidence?.length) {
    const list = createElement("ul", "diagnosis-list");
    list.append(createElement("li", "", "诊断依据"));
    for (const evidence of result.evidence) {
      list.append(createElement("li", "", `• ${evidence}`));
    }
    details.append(list);
  }
  if (result.knowledgeSources?.length) {
    details.append(
      createElement(
        "p",
        "diagnosis-source",
        `知识来源：${result.knowledgeSources.join("；")}`
      )
    );
  }
  if (result.partAnalyses?.length) {
    const heading = createElement(
      "p",
      "diagnosis-source",
      "请核对分问诊断（保存即确认）："
    );
    const list = createElement("ul", "diagnosis-part-list");
    for (const part of result.partAnalyses) {
      const item = document.createElement("li");
      const title = createElement(
        "strong",
        "",
        `${part.partNo}. ${part.label}`
      );
      item.append(
        title,
        document.createTextNode(
          ` · ${part.errorType}${part.missingConcept ? ` · ${part.missingConcept}` : ""}${
            part.initialHint ? ` · 提示：${part.initialHint}` : ""
          }`
        )
      );
      list.append(item);
    }
    details.append(heading, list);
  }
}

async function updateDiagnosis() {
  const question = $("#question-input").value.trim();
  const preview = $("#diagnosis-preview");
  const copy = $("#diagnosis-copy");
  if (question.length < 4) {
    invalidateDiagnosis();
    return;
  }

  const requestNumber = ++state.diagnosisRequest;
  const form = new FormData($("#add-form"));
  const parts = collectMistakeParts({ requireAnswers: false });
  const firstAnswer = splitAnswerVariants(
    $('[data-part-field="acceptedAnswers"]', $("#parts-list"))?.value || ""
  )[0];
  try {
    const result = await api("/api/diagnose", {
      method: "POST",
      body: JSON.stringify({
        question,
        studentAnswer:
          $('[data-part-field="studentAnswer"]', $("#parts-list"))?.value || "",
        correctAnswer: firstAnswer || "",
        analysis: form.get("analysis") || "",
        knowledgePoint: form.get("knowledgePoint") || "",
        errorType: form.get("errorType") || "",
        parts
      })
    });
    if (requestNumber !== state.diagnosisRequest) return;
    state.lastDiagnosis = result;
    const sourceLabel = result.source === "llm" ? "AI 诊断" : "规则诊断";
    copy.textContent = `${sourceLabel}：${result.knowledgePoint} · ${result.errorType}。${result.hint}`;
    renderDiagnosisPreview(result);
    preview.hidden = false;
  } catch {
    if (requestNumber === state.diagnosisRequest) preview.hidden = true;
  }
}

function queueDiagnosis() {
  window.clearTimeout(diagnosisTimer);
  diagnosisTimer = window.setTimeout(updateDiagnosis, 450);
}

async function saveMistake(event) {
  event.preventDefault();
  if (state.busy) return;
  const form = $("#add-form");
  const data = Object.fromEntries(new FormData(form).entries());
  if (!data.question.trim()) {
    showToast("请填写题目", true);
    return;
  }
  let parts;
  try {
    parts = collectMistakeParts();
  } catch (error) {
    showToast(error.message, true);
    return;
  }
  data.parts = parts;
  data.studentAnswer = parts.map((part) => part.studentAnswer).join("；");
  data.correctAnswer = parts
    .map((part) => part.acceptedAnswers[0])
    .join("；");
  if (state.lastDiagnosis) data.diagnosis = state.lastDiagnosis;
  const button = $("#save-mistake-button");
  const isEdit = state.dialogMode === "edit" && state.editingMistakeId;
  if (isEdit && !state.editSubmissionKey) {
    state.editSubmissionKey = crypto.randomUUID();
  }
  state.busy = true;
  setBusy(button, true, isEdit ? "正在保存修改…" : "正在诊断并保存…");
  try {
    const result = isEdit
      ? await api(`/api/mistakes/${state.editingMistakeId}`, {
          method: "PATCH",
          headers: {
            "Idempotency-Key": state.editSubmissionKey
          },
          body: JSON.stringify(data)
        })
      : await api("/api/mistakes", {
          method: "POST",
          body: JSON.stringify(data)
        });
    closeAddDialog();
    await refreshAll();
    if (isEdit) {
      showView("mistakes");
      showToast(
        result.learningReset
          ? "错题已修改，掌握进度已重置，历史作答仍保留"
          : "错题信息已更新"
      );
    } else {
      state.reviewAttemptsThisSession = 0;
      state.review = result;
      showView("review");
      renderReview();
      showToast(`已归入“${result.knowledgePoint}”，开始独立重做`);
    }
  } catch (error) {
    showToast(error.message, true);
  } finally {
    state.busy = false;
    setBusy(button, false);
  }
}

async function deleteMistake(id) {
  const item = state.mistakes.find((mistake) => mistake.id === id);
  if (!item) return;
  const confirmed = window.confirm(
    `确定删除这道错题吗？\n\n${item.question.slice(0, 80)}${
      item.question.length > 80 ? "…" : ""
    }\n\n删除后无法恢复。`
  );
  if (!confirmed) return;
  try {
    await api(`/api/mistakes/${id}`, { method: "DELETE" });
    await refreshAll();
    showToast("错题已删除");
  } catch (error) {
    showToast(error.message, true);
  }
}

async function loadDemo() {
  try {
    const result = await api("/api/demo", { method: "POST" });
    if (result.added) {
      await refreshAll();
      showToast(`已载入 ${result.added} 道六年级数学示例错题`);
    } else {
      showToast("错题库中已有内容，示例数据未载入");
    }
  } catch (error) {
    showToast(error.message, true);
  }
}

function bindEvents() {
  $$(".nav-item").forEach((button) => {
    button.addEventListener("click", () => navigateTo(button.dataset.view));
  });

  document.addEventListener("click", (event) => {
    const goView = event.target.closest("[data-go-view]");
    if (goView) {
      navigateTo(goView.dataset.goView);
      return;
    }
    const openAdd = event.target.closest("[data-open-add]");
    if (openAdd) {
      openAddDialog();
      return;
    }
    const reviewButton = event.target.closest("[data-review-id]");
    if (reviewButton) {
      openReview(Number(reviewButton.dataset.reviewId));
      return;
    }
    const editButton = event.target.closest("[data-edit-id]");
    if (editButton) {
      openEditDialog(Number(editButton.dataset.editId));
      return;
    }
    const deleteButton = event.target.closest("[data-delete-id]");
    if (deleteButton) {
      deleteMistake(Number(deleteButton.dataset.deleteId));
      return;
    }
    const demoButton = event.target.closest("[data-load-demo]");
    if (demoButton) {
      loadDemo();
    }
  });

  $("#top-add-button").addEventListener("click", openAddDialog);
  $("#quick-add-button").addEventListener("click", openAddDialog);
  $("#start-review-button").addEventListener("click", () => navigateTo("review"));
  $("#menu-button").addEventListener("click", () => {
    $(".sidebar").classList.toggle("is-open");
  });

  $$(".filter-chip").forEach((button) => {
    button.addEventListener("click", () => {
      state.filter = button.dataset.filter;
      $$(".filter-chip").forEach((chip) => {
        chip.classList.toggle("is-active", chip === button);
      });
      renderMistakes();
    });
  });

  $("#show-hint-button").addEventListener("click", showHint);
  $("#retry-button").addEventListener("click", showAnswerForm);
  $("#retry-after-hint-button").addEventListener("click", showAnswerForm);
  $("#review-edit-button").addEventListener("click", () => {
    if (state.review) openEditDialog(state.review.id);
  });
  $("#answer-form").addEventListener("submit", submitAttempt);
  $("#review-result").addEventListener("click", (event) => {
    if (event.target.closest("#next-review-button")) {
      loadNextReview();
    }
  });

  $("#add-form").addEventListener("submit", saveMistake);
  $("#add-part-button").addEventListener("click", () => {
    const list = $("#parts-list");
    list.append(createPartEditor({}, list.children.length));
    renumberPartEditors();
    $('[data-part-field="label"]', list.lastElementChild)?.focus();
  });
  $("#parts-list").addEventListener("click", (event) => {
    const move = event.target.closest("[data-move-part]");
    if (move) {
      const editor = move.closest(".part-editor");
      const direction = Number(move.dataset.movePart);
      const sibling =
        direction < 0 ? editor.previousElementSibling : editor.nextElementSibling;
      if (sibling) {
        if (direction < 0) {
          $("#parts-list").insertBefore(editor, sibling);
        } else {
          $("#parts-list").insertBefore(sibling, editor);
        }
        renumberPartEditors();
        move.focus();
      }
      return;
    }
    const remove = event.target.closest("[data-remove-part]");
    if (!remove) return;
    if ($("#parts-list").children.length === 1) {
      showToast("至少保留一个小问", true);
      return;
    }
    remove.closest(".part-editor").remove();
    renumberPartEditors();
  });
  $("#close-dialog-button").addEventListener("click", closeAddDialog);
  $("#cancel-dialog-button").addEventListener("click", closeAddDialog);
  $("#question-input").addEventListener("input", queueDiagnosis);
  $("#add-form").addEventListener("change", (event) => {
    state.editSubmissionKey = null;
    if (["knowledgePoint", "errorType"].includes(event.target.name)) {
      return;
    }
    invalidateDiagnosis();
    queueDiagnosis();
  });
  $("#add-form").addEventListener("input", () => {
    invalidateDiagnosis();
    state.editSubmissionKey = null;
    queueDiagnosis();
  });
  $("#add-dialog").addEventListener("click", (event) => {
    if (event.target === $("#add-dialog")) closeAddDialog();
  });

  window.addEventListener("hashchange", () => {
    const route = readRoute();
    showView(route.view, { updateHash: false });
    if (route.view === "review") {
      if (route.mistakeId) {
        openReview(route.mistakeId, { updateHash: false });
      } else {
        loadNextReview();
      }
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") $(".sidebar").classList.remove("is-open");
  });
}

async function init() {
  $("#today-label").textContent = new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "short"
  }).format(new Date());
  bindEvents();
  try {
    await loadBootstrap();
    await refreshAll();
    const initialRoute = readRoute();
    showView(initialRoute.view, { updateHash: false });
    if (initialRoute.view === "review") {
      if (initialRoute.mistakeId) {
        await openReview(initialRoute.mistakeId, { updateHash: false });
      } else {
        await loadNextReview();
      }
    }
  } catch (error) {
    showToast(`页面初始化失败：${error.message}`, true);
    $("#priority-content").replaceChildren(
      createElement("div", "priority-empty", "暂时无法连接学习服务，请刷新页面重试。")
    );
  }
}

init();
