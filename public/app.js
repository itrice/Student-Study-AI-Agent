import { createRequestKey } from "./request-key.js";
import {
  clampPage,
  getPageSize,
  pageForFirstItem,
  paginationWindow
} from "./pagination.js";
import {
  filterMistakes,
  normalizeSearchTerms
} from "./mistake-search.js";

const state = {
  student: null,
  knowledgePoints: [],
  dashboard: null,
  mistakes: [],
  knowledge: [],
  knowledgeBase: null,
  feedback: null,
  knowledgeSearch: null,
  knowledgeSearchRequest: 0,
  filter: "all",
  mistakeQuery: "",
  mistakeSearchTimer: null,
  mistakePage: 1,
  mistakePageSize: getPageSize(window.innerWidth),
  review: null,
  reviewSessionId: null,
  reviewAttemptsThisSession: 0,
  reviewHintLevel: 0,
  hintRequestKey: null,
  followUpRequestKey: null,
  attemptRequestKey: null,
  dialogMode: "create",
  editingMistakeId: null,
  editSubmissionKey: null,
  dialogAttachments: [],
  newAttachmentIds: new Set(),
  originalPreviewIds: new Set(),
  ocrAttachmentId: null,
  cropEditor: null,
  imageUploads: 0,
  lastDiagnosis: null,
  busy: false,
  diagnosisRequest: 0
};

const viewLabels = {
  home: "今日学习",
  review: "开始复习",
  mistakes: "我的错题",
  feedback: "学习反馈",
  knowledge: "知识点地图"
};

const statusLabels = {
  new: "待复习",
  practicing: "练习中",
  mastered: "已掌握",
  relearning: "需巩固"
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

function readableText(value) {
  if (typeof value === "string") {
    const text = value.trim();
    return /^\[object [A-Za-z]+\][。.]?$/.test(text) ? "" : text;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(readableText).filter(Boolean).join("；");
  }
  if (value && typeof value === "object") {
    const partNo = Number(value.partNo ?? value.part ?? value.partNumber);
    const hasPartNo = Number.isInteger(partNo) && partNo > 0;
    for (const key of [
      "message",
      "text",
      "description",
      "detail",
      "reason",
      "summary",
      "content",
      "assessment",
      "value"
    ]) {
      const text = readableText(value[key]);
      if (text) return hasPartNo ? `第 ${partNo} 小问：${text}` : text;
    }
    return hasPartNo ? `第 ${partNo} 小问` : "";
  }
  return "";
}

function displayQuestion(mistake) {
  const text = String(mistake?.question || "").trim();
  if (text) return text;
  return mistake?.attachments?.length ? "请查看题目图片" : "";
}

function createAttachmentImage(attachment, className = "") {
  const image = document.createElement("img");
  image.src = attachment.displayUrl || attachment.url;
  image.alt = attachment.hasCrop ? "已裁剪的题目图片" : "题目图片";
  image.loading = "lazy";
  image.decoding = "async";
  if (className) image.className = className;
  return image;
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

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_DIALOG_IMAGES = 6;
const MIN_CROP_SIZE_PX = 28;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function setImageUploadStatus(message, isError = false) {
  const status = $("#image-upload-status");
  status.textContent = message;
  status.classList.toggle("is-error", isError);
}

async function uploadAttachment(file) {
  const response = await fetch("/api/attachments?kind=question", {
    method: "POST",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "X-Original-Name": encodeURIComponent(file.name || "")
    },
    body: file
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "图片上传失败");
  }
  return data;
}

async function uploadImageFiles(fileList) {
  const files = [...(fileList || [])];
  const images = files.filter(
    (file) => !file.type || String(file.type).startsWith("image/")
  );
  if (!images.length) {
    showToast("没有找到可用的图片", true);
    return;
  }
  for (const file of images) {
    if (state.dialogAttachments.length >= MAX_DIALOG_IMAGES) {
      showToast(`每道题最多添加 ${MAX_DIALOG_IMAGES} 张图片`, true);
      break;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      showToast("单张图片不能超过 8 MB", true);
      continue;
    }
    if (file.type && !ALLOWED_IMAGE_TYPES.has(file.type)) {
      showToast("仅支持 JPG、PNG 或 WebP 图片", true);
      continue;
    }
    state.imageUploads += 1;
    setImageUploadStatus("正在上传图片…");
    try {
      const attachment = await uploadAttachment(file);
      state.dialogAttachments.push(attachment);
      state.newAttachmentIds.add(attachment.id);
      renderDialogAttachments();
      setImageUploadStatus(
        `已添加 ${state.dialogAttachments.length} 张图片，保存错题后完成关联。`
      );
    } catch (error) {
      setImageUploadStatus(error.message, true);
      showToast(error.message, true);
    } finally {
      state.imageUploads -= 1;
    }
  }
  if (state.imageUploads === 0 && state.dialogAttachments.length) {
    setImageUploadStatus(
      `已添加 ${state.dialogAttachments.length} 张图片，保存错题后完成关联。`
    );
  }
}

async function removeDialogAttachment(id) {
  if (state.cropEditor?.attachmentId === id) closeCropEditor();
  state.originalPreviewIds.delete(id);
  state.dialogAttachments = state.dialogAttachments.filter(
    (attachment) => attachment.id !== id
  );
  if (state.ocrAttachmentId === id) {
    state.ocrAttachmentId = null;
    $("#ocr-panel").hidden = true;
    $("#ocr-candidate").hidden = true;
  }
  if (state.newAttachmentIds.delete(id)) {
    try {
      await api(`/api/attachments/${id}`, { method: "DELETE" });
    } catch {
      // The startup GC will remove an unreferenced file if this request fails.
    }
  }
  renderDialogAttachments();
}

function renderDialogAttachments() {
  const list = $("#attachment-list");
  list.replaceChildren();
  state.dialogAttachments.forEach((attachment, index) => {
    const card = createElement("article", "attachment-card");
    const thumb = createElement("div", "attachment-thumb");
    const showOriginal = state.originalPreviewIds.has(attachment.id);
    thumb.append(
      createAttachmentImage({
        ...attachment,
        displayUrl: showOriginal ? attachment.originalUrl : attachment.displayUrl
      })
    );
    const body = createElement("div", "attachment-card-body");
    body.append(
      createElement("strong", "", `题目图片 ${index + 1}`),
      createElement(
        "small",
        "",
        `${Math.max(1, Math.round(attachment.byteSize / 1024))} KB${
          attachment.hasCrop ? " · 已裁剪" : " · 原图"
        }`
      )
    );
    const actions = createElement("div", "attachment-card-actions");
    const crop = createElement(
      "button",
      "text-button",
      attachment.hasCrop ? "重新裁剪" : "裁剪"
    );
    crop.type = "button";
    crop.dataset.cropAttachment = String(attachment.id);
    if (attachment.hasCrop) {
      const original = createElement(
        "button",
        "text-button",
        showOriginal ? "查看裁剪" : "查看原图"
      );
      original.type = "button";
      original.dataset.toggleOriginalAttachment = String(attachment.id);
      actions.append(original);
    }
    const extract = createElement("button", "text-button", "识别文字");
    extract.type = "button";
    extract.dataset.extractAttachment = String(attachment.id);
    const remove = createElement("button", "text-button danger", "移除");
    remove.type = "button";
    remove.dataset.removeAttachment = String(attachment.id);
    actions.prepend(crop);
    actions.append(extract, remove);
    body.append(actions);
    card.append(thumb, body);
    list.append(card);
  });
  if (!state.dialogAttachments.length) {
    setImageUploadStatus(
      "支持 JPG、PNG、WebP；单张不超过 8 MB，每道题最多 6 张。"
    );
  }
}

function findDialogAttachment(id) {
  return state.dialogAttachments.find((attachment) => attachment.id === id) || null;
}

function replaceDialogAttachment(updated) {
  const index = state.dialogAttachments.findIndex(
    (attachment) => attachment.id === updated.id
  );
  if (index >= 0) state.dialogAttachments[index] = updated;
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function rotatedSourceDimensions(attachment, rotation) {
  const sourceWidth = Number(
    attachment?.crop?.sourceWidth || attachment?.width || 0
  );
  const sourceHeight = Number(
    attachment?.crop?.sourceHeight || attachment?.height || 0
  );
  return {
    sourceWidth,
    sourceHeight,
    width: rotation === 90 || rotation === 270 ? sourceHeight : sourceWidth,
    height: rotation === 90 || rotation === 270 ? sourceWidth : sourceHeight
  };
}

function selectionForAttachment(attachment, rotation) {
  const dimensions = rotatedSourceDimensions(attachment, rotation);
  if (attachment?.crop) {
    return {
      x: clampNumber(Number(attachment.crop.x) / dimensions.width, 0, 1),
      y: clampNumber(Number(attachment.crop.y) / dimensions.height, 0, 1),
      width: clampNumber(Number(attachment.crop.width) / dimensions.width, 0.01, 1),
      height: clampNumber(Number(attachment.crop.height) / dimensions.height, 0.01, 1)
    };
  }
  return { x: 0.04, y: 0.04, width: 0.92, height: 0.92 };
}

function setCropStatus(message, isError = false) {
  const status = $("#crop-status");
  status.textContent = message;
  status.classList.toggle("is-error", isError);
}

function renderCropSelection() {
  const editor = state.cropEditor;
  if (!editor?.image) return;
  const selection = editor.selection;
  const element = $("#crop-selection");
  element.style.left = `${selection.x * editor.displayWidth}px`;
  element.style.top = `${selection.y * editor.displayHeight}px`;
  element.style.width = `${selection.width * editor.displayWidth}px`;
  element.style.height = `${selection.height * editor.displayHeight}px`;
  const width = Math.max(1, Math.round(selection.width * editor.rotatedWidth));
  const height = Math.max(1, Math.round(selection.height * editor.rotatedHeight));
  setCropStatus(
    `原图 ${editor.sourceWidth} × ${editor.sourceHeight}，当前裁剪区域 ${width} × ${height}。`
  );
}

function renderCropEditor() {
  const editor = state.cropEditor;
  if (!editor?.image) return;
  const canvas = $("#crop-canvas");
  const panel = $(".crop-editor-panel");
  const maxWidth = Math.max(260, Math.min(900, (panel?.clientWidth || 900) - 42));
  const maxHeight = Math.max(220, Math.min(window.innerHeight * 0.58, 580));
  const sourceWidth = editor.image.naturalWidth;
  const sourceHeight = editor.image.naturalHeight;
  const rotatedWidth = editor.rotation === 90 || editor.rotation === 270
    ? sourceHeight
    : sourceWidth;
  const rotatedHeight = editor.rotation === 90 || editor.rotation === 270
    ? sourceWidth
    : sourceHeight;
  const scale = Math.min(
    1,
    maxWidth / Math.max(1, rotatedWidth),
    maxHeight / Math.max(1, rotatedHeight)
  );
  const displayWidth = Math.max(1, Math.round(rotatedWidth * scale));
  const displayHeight = Math.max(1, Math.round(rotatedHeight * scale));
  canvas.width = displayWidth;
  canvas.height = displayHeight;
  canvas.style.width = `${displayWidth}px`;
  canvas.style.height = `${displayHeight}px`;

  const context = canvas.getContext("2d");
  context.clearRect(0, 0, displayWidth, displayHeight);
  context.fillStyle = "#132019";
  context.fillRect(0, 0, displayWidth, displayHeight);
  context.save();
  context.translate(displayWidth / 2, displayHeight / 2);
  context.rotate((editor.rotation * Math.PI) / 180);
  context.drawImage(
    editor.image,
    -(sourceWidth * scale) / 2,
    -(sourceHeight * scale) / 2,
    sourceWidth * scale,
    sourceHeight * scale
  );
  context.restore();

  editor.sourceWidth = sourceWidth;
  editor.sourceHeight = sourceHeight;
  editor.rotatedWidth = rotatedWidth;
  editor.rotatedHeight = rotatedHeight;
  editor.displayWidth = displayWidth;
  editor.displayHeight = displayHeight;
  editor.scale = scale;
  renderCropSelection();
}

function startCropDrag(event) {
  const editor = state.cropEditor;
  if (!editor?.image || (event.pointerType === "mouse" && event.button !== 0)) {
    return;
  }
  const selection = event.target.closest("#crop-selection");
  if (!selection) return;
  event.preventDefault();
  const handle = event.target.closest("[data-crop-handle]");
  editor.drag = {
    pointerId: event.pointerId,
    handle: handle?.dataset.cropHandle || "move",
    startX: event.clientX,
    startY: event.clientY,
    selection: { ...editor.selection }
  };
  try {
    selection.setPointerCapture(event.pointerId);
  } catch {
    // Document-level pointermove still handles browsers without capture.
  }
}

function moveCropDrag(event) {
  const editor = state.cropEditor;
  if (!editor?.drag || editor.drag.pointerId !== event.pointerId) return;
  event.preventDefault();
  const drag = editor.drag;
  const dx = (event.clientX - drag.startX) / editor.displayWidth;
  const dy = (event.clientY - drag.startY) / editor.displayHeight;
  const start = drag.selection;
  const minWidth = Math.min(1, MIN_CROP_SIZE_PX / editor.displayWidth);
  const minHeight = Math.min(1, MIN_CROP_SIZE_PX / editor.displayHeight);

  if (drag.handle === "move") {
    editor.selection = {
      x: clampNumber(start.x + dx, 0, 1 - start.width),
      y: clampNumber(start.y + dy, 0, 1 - start.height),
      width: start.width,
      height: start.height
    };
  } else {
    let left = start.x;
    let top = start.y;
    let right = start.x + start.width;
    let bottom = start.y + start.height;
    if (drag.handle.includes("w")) {
      left = clampNumber(start.x + dx, 0, right - minWidth);
    }
    if (drag.handle.includes("e")) {
      right = clampNumber(start.x + start.width + dx, left + minWidth, 1);
    }
    if (drag.handle.includes("n")) {
      top = clampNumber(start.y + dy, 0, bottom - minHeight);
    }
    if (drag.handle.includes("s")) {
      bottom = clampNumber(start.y + start.height + dy, top + minHeight, 1);
    }
    editor.selection = {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top
    };
  }
  renderCropSelection();
}

function endCropDrag(event) {
  const editor = state.cropEditor;
  if (!editor?.drag || editor.drag.pointerId !== event.pointerId) return;
  editor.drag = null;
  const selection = $("#crop-selection");
  try {
    selection.releasePointerCapture(event.pointerId);
  } catch {
    // The pointer may already have been released.
  }
}

function rotateCropEditor() {
  const editor = state.cropEditor;
  if (!editor?.image) return;
  const selection = editor.selection;
  editor.selection = {
    x: 1 - (selection.y + selection.height),
    y: selection.x,
    width: selection.height,
    height: selection.width
  };
  editor.rotation = (editor.rotation + 90) % 360;
  renderCropEditor();
}

function resetCropEditor() {
  const editor = state.cropEditor;
  if (!editor?.image) return;
  editor.rotation = 0;
  editor.selection = { x: 0.01, y: 0.01, width: 0.98, height: 0.98 };
  renderCropEditor();
}

function openCropEditor(attachmentId) {
  const attachment = findDialogAttachment(attachmentId);
  if (!attachment) return;
  closeCropEditor();
  const rotation = Number(attachment.crop?.rotation || 0);
  const editor = {
    attachmentId,
    attachment,
    image: null,
    rotation,
    selection: selectionForAttachment(attachment, rotation),
    drag: null,
    sourceWidth: 0,
    sourceHeight: 0,
    rotatedWidth: 0,
    rotatedHeight: 0,
    displayWidth: 0,
    displayHeight: 0,
    scale: 1
  };
  state.cropEditor = editor;
  $("#crop-editor").hidden = false;
  $("#restore-original-button").hidden = !attachment.hasCrop;
  setCropStatus("正在加载原图…");
  const image = new Image();
  image.decoding = "async";
  image.onload = () => {
    if (state.cropEditor !== editor) return;
    editor.image = image;
    renderCropEditor();
    $("#close-crop-editor-button").focus();
  };
  image.onerror = () => {
    if (state.cropEditor !== editor) return;
    setCropStatus("原图加载失败，请取消后重试。", true);
  };
  image.src = attachment.originalUrl || attachment.url;
}

function closeCropEditor() {
  const editor = state.cropEditor;
  state.cropEditor = null;
  if (editor?.image) editor.image.src = "";
  $("#crop-editor").hidden = true;
  $("#crop-status").textContent = "";
  $("#crop-status").classList.remove("is-error");
}

function toggleOriginalPreview(attachmentId) {
  if (state.originalPreviewIds.has(attachmentId)) {
    state.originalPreviewIds.delete(attachmentId);
  } else {
    state.originalPreviewIds.add(attachmentId);
  }
  renderDialogAttachments();
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("浏览器无法生成裁剪图片"));
      },
      type,
      quality
    );
  });
}

async function createCropBlob(canvas, preferredMime) {
  const attempts = [];
  if (ALLOWED_IMAGE_TYPES.has(preferredMime)) {
    attempts.push([
      preferredMime,
      preferredMime === "image/jpeg" ? 0.95 : undefined
    ]);
  }
  if (preferredMime !== "image/jpeg") {
    attempts.push(["image/jpeg", 0.92], ["image/jpeg", 0.8]);
  }
  for (const [type, quality] of attempts) {
    const blob = await canvasToBlob(canvas, type, quality);
    if (blob.size <= MAX_IMAGE_BYTES) return blob;
  }
  throw new Error("裁剪后的图片超过 8 MB，请缩小裁剪区域后重试");
}

async function applyCropEditor() {
  const editor = state.cropEditor;
  if (!editor?.image) return;
  const button = $("#apply-crop-button");
  const sourceWidth = editor.image.naturalWidth;
  const sourceHeight = editor.image.naturalHeight;
  const rotatedWidth = editor.rotation === 90 || editor.rotation === 270
    ? sourceHeight
    : sourceWidth;
  const rotatedHeight = editor.rotation === 90 || editor.rotation === 270
    ? sourceWidth
    : sourceHeight;
  const selection = editor.selection;
  const cropX = clampNumber(
    Math.round(selection.x * rotatedWidth),
    0,
    Math.max(0, rotatedWidth - 1)
  );
  const cropY = clampNumber(
    Math.round(selection.y * rotatedHeight),
    0,
    Math.max(0, rotatedHeight - 1)
  );
  const cropWidth = clampNumber(
    Math.round(selection.width * rotatedWidth),
    1,
    rotatedWidth - cropX
  );
  const cropHeight = clampNumber(
    Math.round(selection.height * rotatedHeight),
    1,
    rotatedHeight - cropY
  );

  const output = document.createElement("canvas");
  output.width = cropWidth;
  output.height = cropHeight;
  const context = output.getContext("2d");
  context.save();
  context.translate(-cropX, -cropY);
  context.translate(rotatedWidth / 2, rotatedHeight / 2);
  context.rotate((editor.rotation * Math.PI) / 180);
  context.drawImage(
    editor.image,
    -sourceWidth / 2,
    -sourceHeight / 2,
    sourceWidth,
    sourceHeight
  );
  context.restore();

  setBusy(button, true, "正在保存…");
  setCropStatus("正在保存裁剪结果…");
  try {
    const blob = await createCropBlob(output, editor.attachment.mimeType);
    const response = await fetch(`/api/attachments/${editor.attachmentId}/crop`, {
      method: "POST",
      headers: {
        "Content-Type": blob.type,
        "X-Crop-X": String(cropX),
        "X-Crop-Y": String(cropY),
        "X-Crop-Width": String(cropWidth),
        "X-Crop-Height": String(cropHeight),
        "X-Crop-Rotation": String(editor.rotation),
        "X-Crop-Source-Width": String(sourceWidth),
        "X-Crop-Source-Height": String(sourceHeight)
      },
      body: blob
    });
    const updated = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(updated.error || "裁剪图片保存失败");
    }
    replaceDialogAttachment(updated);
    state.originalPreviewIds.delete(updated.id);
    closeCropEditor();
    renderDialogAttachments();
    showToast("裁剪已应用，识别文字将只使用裁剪区域");
  } catch (error) {
    setCropStatus(error.message || "裁剪图片保存失败，原图未改变。", true);
  } finally {
    setBusy(button, false);
  }
}

async function restoreOriginalImage() {
  const editor = state.cropEditor;
  const attachment = editor ? findDialogAttachment(editor.attachmentId) : null;
  if (!attachment?.hasCrop) return;
  const button = $("#restore-original-button");
  setBusy(button, true, "正在恢复…");
  try {
    const updated = await api(`/api/attachments/${attachment.id}/crop`, {
      method: "DELETE"
    });
    replaceDialogAttachment(updated);
    state.originalPreviewIds.delete(updated.id);
    closeCropEditor();
    renderDialogAttachments();
    showToast("已恢复原图");
  } catch (error) {
    setCropStatus(error.message || "恢复原图失败，请稍后重试。", true);
  } finally {
    setBusy(button, false);
  }
}

function startOcrForAttachment(id) {
  const index = state.dialogAttachments.findIndex(
    (attachment) => attachment.id === id
  );
  if (index < 0) return;
  const attachment = state.dialogAttachments[index];
  state.ocrAttachmentId = id;
  $("#ocr-panel").hidden = false;
  $("#ocr-attachment-label").textContent = attachment.hasCrop
    ? `识别第 ${index + 1} 张图片裁剪区域中的文字（可选）`
    : `识别第 ${index + 1} 张图片中的文字（可选）`;
  $("#ocr-consent").checked = false;
  $("#ocr-message").textContent = "";
  $("#ocr-candidate").hidden = true;
  $("#ocr-text").value = "";
  $("#ocr-panel").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function runOcr() {
  const id = state.ocrAttachmentId;
  if (!id) return;
  if (!$("#ocr-consent").checked) {
    $("#ocr-message").textContent = "请先勾选同意，图片才会发送到外部视觉模型。";
    return;
  }
  const button = $("#run-ocr-button");
  setBusy(button, true, "识别中…");
  $("#ocr-message").textContent = "";
  $("#ocr-candidate").hidden = true;
  try {
    const result = await api(`/api/attachments/${id}/extract`, {
      method: "POST",
      body: JSON.stringify({ consent: true })
    });
    if (!result.available) {
      $("#ocr-message").textContent = result.message;
      return;
    }
    $("#ocr-text").value = result.text;
    $("#ocr-candidate").hidden = false;
    $("#ocr-message").textContent =
      "识别完成。请核对文字，确认无误后再使用；图片仍会作为原题保留。";
    $("#ocr-text").focus();
  } catch (error) {
    $("#ocr-message").textContent =
      error.message || "识别失败，可直接填写题目文字并使用图片保存。";
  } finally {
    setBusy(button, false);
  }
}

function useOcrText() {
  const text = $("#ocr-text").value.trim();
  if (!text) {
    $("#ocr-message").textContent = "识别结果为空，可以直接手动填写题目。";
    return;
  }
  const input = $("#question-input");
  const current = input.value.trim();
  input.value = current ? `${current}\n${text}` : text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  $("#ocr-panel").hidden = true;
  state.ocrAttachmentId = null;
  showToast("已填入识别文字，请核对后保存");
}

function discardNewAttachments() {
  const ids = [...state.newAttachmentIds];
  state.newAttachmentIds.clear();
  for (const id of ids) {
    api(`/api/attachments/${id}`, { method: "DELETE" }).catch(() => {});
  }
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
  } else if (name === "feedback") {
    loadFeedback();
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
    box.append(createElement("p", "", displayQuestion(nextReview)));
    if (nextReview.attachments?.length) {
      const preview = createElement("div", "priority-attachments");
      for (const attachment of nextReview.attachments.slice(0, 2)) {
        preview.append(createAttachmentImage(attachment));
      }
      box.append(preview);
    }

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
      createElement("p", "", displayQuestion(mistake))
    );
    if (mistake.attachments?.length) {
      const preview = createElement("div", "recent-attachments");
      for (const attachment of mistake.attachments.slice(0, 2)) {
        preview.append(createAttachmentImage(attachment));
      }
      item.append(preview);
    }
    item.append(
      createElement("small", "", `${statusLabels[mistake.status]} · ${mistake.errorType}`)
    );
    target.append(item);
  }
}

async function loadMistakes() {
  state.mistakes = await api("/api/mistakes");
  refreshMistakeList();
}

function searchMatchedMistakes() {
  return filterMistakes(state.mistakes, { query: state.mistakeQuery });
}

function renderMistakeCounts() {
  const matched = searchMatchedMistakes();
  const counts = {
    all: matched.length,
    new: matched.filter((item) => item.status === "new").length,
    practicing: matched.filter((item) => item.status === "practicing").length,
    relearning: matched.filter((item) => item.status === "relearning").length,
    mastered: matched.filter((item) => item.status === "mastered").length
  };
  for (const [status, count] of Object.entries(counts)) {
    $(`#filter-count-${status}`).textContent = count;
  }
}

function getFilteredMistakes() {
  return filterMistakes(state.mistakes, {
    status: state.filter,
    query: state.mistakeQuery
  });
}

function updateMistakeSearchClear() {
  const input = $("#mistake-search-input");
  const clear = $("#mistake-search-clear");
  if (!input || !clear) return;
  clear.hidden = !input.value;
}

function updateMistakeSearchStatus() {
  const status = $("#mistake-search-status");
  if (!status) return;
  if (!normalizeSearchTerms(state.mistakeQuery).length) {
    status.hidden = true;
    status.textContent = "";
    return;
  }
  const count = getFilteredMistakes().length;
  status.hidden = false;
  if (count) {
    status.textContent =
      state.filter === "all"
        ? `找到 ${count} 道错题`
        : `在当前分类中找到 ${count} 道错题`;
  } else {
    status.textContent =
      state.filter === "all"
        ? "没有找到匹配的错题"
        : "当前分类中没有找到匹配的错题";
  }
}

function refreshMistakeList() {
  renderMistakeCounts();
  renderMistakes();
  updateMistakeSearchStatus();
  updateMistakeSearchClear();
}

function clearMistakeSearch({ focus = true } = {}) {
  const input = $("#mistake-search-input");
  window.clearTimeout(state.mistakeSearchTimer);
  state.mistakeSearchTimer = null;
  state.mistakeQuery = "";
  state.mistakePage = 1;
  if (input) input.value = "";
  updateMistakeSearchClear();
  refreshMistakeList();
  if (focus) input?.focus();
}

function setPaginationStep(button, disabled) {
  button.disabled = disabled;
  button.setAttribute("aria-disabled", String(disabled));
}

function focusFirstMistake() {
  const card = $("#mistake-list .mistake-card");
  if (card) card.focus({ preventScroll: true });
}

function renderMistakePagination(totalItems) {
  const nav = $("#mistake-pagination");
  const list = $("#mistake-list");
  const pageCount = Math.max(1, Math.ceil(totalItems / state.mistakePageSize));
  nav.hidden = totalItems === 0 || pageCount <= 1;
  list.classList.toggle("has-pagination", !nav.hidden);
  if (nav.hidden) {
    $("#mistake-page-numbers").replaceChildren();
    $("#mistake-pagination-status").textContent = "";
    return;
  }

  const page = state.mistakePage;
  const numbers = $("#mistake-page-numbers");
  numbers.replaceChildren();
  for (const value of paginationWindow(page, pageCount)) {
    if (value === "gap") {
      numbers.append(createElement("span", "pagination-ellipsis", "…"));
      continue;
    }
    const button = createElement("button", "pagination-button", String(value));
    button.type = "button";
    button.dataset.page = String(value);
    button.setAttribute("aria-label", `第 ${value} 页`);
    if (value === page) button.setAttribute("aria-current", "page");
    numbers.append(button);
  }

  $("#mistake-pagination-status").textContent =
    `第 ${page} / ${pageCount} 页 · 共 ${totalItems} 道`;

  const prev = $("#mistake-page-prev");
  prev.dataset.page = String(page - 1);
  setPaginationStep(prev, page <= 1);

  const next = $("#mistake-page-next");
  next.dataset.page = String(page + 1);
  setPaginationStep(next, page >= pageCount);
}

function renderMistakes() {
  const target = $("#mistake-list");
  target.replaceChildren();
  const items = getFilteredMistakes();

  if (!items.length) {
    renderMistakePagination(0);
    const empty = createElement("div", "list-empty");
    const hasQuery = normalizeSearchTerms(state.mistakeQuery).length > 0;
    let title;
    let copy;
    if (hasQuery) {
      title =
        state.filter === "all"
          ? "没有找到匹配的错题"
          : "这个分类里没有匹配的错题";
      copy =
        state.filter === "all"
          ? "换个关键词，或清除搜索查看全部错题。"
          : "清除搜索，或切换其他分类看看。";
    } else {
      title = state.mistakes.length
        ? "这个分类里还没有错题"
        : "错题库还是空的";
      copy = state.mistakes.length
        ? "切换其他状态看看，或继续录入新错题。"
        : "从一道当前不会的题开始，先诊断知识点，再通过重做确认掌握。";
    }
    empty.append(
      createElement("strong", "", title),
      createElement("span", "", copy)
    );
    if (hasQuery) {
      const button = createElement("button", "secondary-button", "清除搜索");
      button.type = "button";
      button.dataset.clearSearch = "true";
      empty.append(button);
    } else if (!state.mistakes.length) {
      const button = createElement("button", "primary-button", "录入第一道错题");
      button.type = "button";
      button.dataset.openAdd = "true";
      empty.append(button);
    }
    target.append(empty);
    return;
  }

  const pageCount = Math.max(1, Math.ceil(items.length / state.mistakePageSize));
  state.mistakePage = clampPage(state.mistakePage, pageCount);
  const start = (state.mistakePage - 1) * state.mistakePageSize;
  const pageItems = items.slice(start, start + state.mistakePageSize);

  pageItems.forEach((mistake, index) => {
    const card = createElement("article", "mistake-card");
    card.tabIndex = -1;
    card.setAttribute("aria-label", `第 ${start + index + 1} 道错题`);
    const number = createElement(
      "div",
      "mistake-index",
      String(start + index + 1).padStart(2, "0")
    );
    const main = createElement("div", "mistake-main");
    const line = createElement("div", "mistake-topline");
    line.append(
      statusBadge(mistake.status),
      knowledgeTag(mistake.knowledgePoint),
      createElement("span", "tag", mistake.errorType)
    );
    const question = createElement("p", "mistake-question", displayQuestion(mistake));
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
    main.append(line, question);
    if (mistake.attachments?.length) {
      const images = createElement("div", "mistake-attachments");
      for (const attachment of mistake.attachments) {
        images.append(createAttachmentImage(attachment));
      }
      main.append(images);
    }
    main.append(detail);

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

  renderMistakePagination(items.length);
}

async function loadKnowledge() {
  const [summaryResult, baseResult] = await Promise.allSettled([
    api("/api/knowledge-points"),
    api("/api/knowledge-base")
  ]);
  if (summaryResult.status === "fulfilled") {
    state.knowledge = summaryResult.value;
  }
  if (baseResult.status === "fulfilled") {
    state.knowledgeBase = baseResult.value;
  }
  renderKnowledge();
  renderKnowledgeBase();
  renderWeakness();
  const failures = [
    summaryResult.status === "rejected"
      ? `知识点统计：${summaryResult.reason?.message || "加载失败"}`
      : null,
    baseResult.status === "rejected"
      ? `知识库：${baseResult.reason?.message || "加载失败"}`
      : null
  ].filter(Boolean);
  if (failures.length) {
    throw new Error(failures.join("；"));
  }
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
        point.total
          ? `待复习 ${point.new ?? 0} · 练习中 ${point.practicing ?? 0} · 需巩固 ${point.relearning ?? 0}`
          : "尚未覆盖"
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

const reviewLabels = {
  unreviewed: "未审核",
  self_reviewed: "项目自检",
  teacher_reviewed: "教师已审"
};

const chunkKindLabels = {
  concept: "核心概念",
  method: "方法与步骤",
  condition: "适用条件",
  common_error: "常见错误",
  example: "典型例题"
};

function knowledgeMetaLine(label, values) {
  const row = createElement("div", "knowledge-meta-row");
  row.append(createElement("span", "knowledge-meta-label", label));
  const content = createElement("div", "knowledge-meta-values");
  for (const value of values) {
    content.append(createElement("span", "tag", value));
  }
  row.append(content);
  return row;
}

function renderKnowledgeBase() {
  const meta = $("#knowledge-base-meta");
  const list = $("#knowledge-library-list");
  if (!meta || !list || !state.knowledgeBase) return;
  const { stats, cards } = state.knowledgeBase;
  meta.textContent = `${stats.knowledgePoints} 张知识卡片 · ${stats.chunks} 个知识片段 · ${stats.sources} 个来源 · ${stats.textbookVersion}`;
  list.replaceChildren();

  for (const card of cards) {
    const details = createElement("details", "knowledge-library-card");
    const summary = createElement("summary", "knowledge-library-summary");
    const titleWrap = createElement("div", "knowledge-library-title");
    titleWrap.append(
      createElement("strong", "", card.name),
      createElement("span", "", card.unit)
    );
    summary.append(
      titleWrap,
      createElement(
        "span",
        `review-badge review-${card.reviewStatus}`,
        reviewLabels[card.reviewStatus] || card.reviewStatus
      )
    );
    details.append(summary);

    const body = createElement("div", "knowledge-library-body");
    body.append(createElement("p", "knowledge-summary-text", card.summary));
    if (card.aliases.length) {
      body.append(knowledgeMetaLine("别名", card.aliases));
    }
    if (card.prerequisites.length) {
      body.append(knowledgeMetaLine("前置知识", card.prerequisites));
    }

    const method = createElement("div", "knowledge-method");
    method.append(createElement("h4", "", "方法与步骤"));
    const ordered = document.createElement("ol");
    for (const step of card.steps) ordered.append(createElement("li", "", step));
    method.append(ordered);
    body.append(method);

    const common = createElement("div", "knowledge-common-errors");
    common.append(createElement("h4", "", "常见误区"));
    const commonList = document.createElement("ul");
    for (const error of card.commonErrors) {
      commonList.append(createElement("li", "", error));
    }
    common.append(commonList);
    body.append(common);

    const chunkGrid = createElement("div", "knowledge-chunk-grid");
    for (const chunk of card.chunks) {
      const article = createElement("article", "knowledge-chunk");
      article.append(
        createElement(
          "span",
          "knowledge-chunk-kind",
          chunkKindLabels[chunk.kind] || chunk.kind
        ),
        createElement("h4", "", chunk.title),
        createElement("p", "", chunk.content),
        createElement("small", "knowledge-citation", chunk.citation)
      );
      chunkGrid.append(article);
    }
    body.append(chunkGrid);

    const sources = createElement("div", "knowledge-sources");
    sources.append(createElement("h4", "", "来源与版本"));
    for (const source of card.sources) {
      const item = createElement("div", "knowledge-source");
      item.append(
        createElement("strong", "", source.title),
        createElement("span", "", `${source.publisher} · ${source.edition}`),
        createElement("p", "", source.note),
        createElement("small", "knowledge-citation", source.citation)
      );
      sources.append(item);
    }
    body.append(sources);
    details.append(body);
    list.append(details);
  }
}

function resetKnowledgeSearch() {
  state.knowledgeSearch = null;
  state.knowledgeSearchRequest += 1;
  const target = $("#knowledge-search-result");
  if (target) {
    target.hidden = true;
    target.replaceChildren();
  }
  const input = $("#knowledge-search-input");
  if (input) {
    input.value = "";
    input.focus({ preventScroll: true });
  }
  $(".knowledge-library")?.scrollIntoView({ block: "start" });
}

function renderKnowledgeSearch(result) {
  const target = $("#knowledge-search-result");
  if (!target) return;
  target.hidden = false;
  target.replaceChildren();

  const head = createElement("div", "knowledge-search-head");
  const headMain = createElement("div", "knowledge-search-head-main");
  headMain.append(
    createElement("strong", "", `检索：${result.query}`),
    createElement(
      "span",
      `coverage-badge coverage-${result.coverage.status}`,
      result.coverage.status === "covered"
        ? "已覆盖"
        : result.coverage.status === "insufficient"
          ? "覆盖不足"
          : "未覆盖"
    )
  );
  const reset = createElement("button", "text-button", "返回默认视图");
  reset.type = "button";
  reset.addEventListener("click", resetKnowledgeSearch);
  head.append(headMain, reset);
  target.append(head, createElement("p", "knowledge-search-note", result.coverage.note));

  if (result.coverage.status === "not_covered") {
    const suggestions = createElement("div", "knowledge-suggestions");
    suggestions.append(createElement("span", "knowledge-meta-label", "可检索的知识点"));
    for (const name of result.coverage.suggestions || []) {
      suggestions.append(createElement("span", "tag", name));
    }
    target.append(suggestions);
    return;
  }

  for (const item of result.items) {
    const card = createElement("article", "knowledge-search-item");
    const title = createElement("div", "knowledge-search-item-head");
    title.append(
      createElement("h3", "", item.knowledgePoint),
      createElement("span", "knowledge-score-chip", `匹配分 ${item.score}`)
    );
    card.append(title, createElement("p", "", item.summary));

    const chunks = createElement("div", "knowledge-search-chunks");
    for (const chunk of item.chunks) {
      const block = createElement("div", "knowledge-search-chunk");
      block.append(
        createElement(
          "span",
          "knowledge-chunk-kind",
          chunkKindLabels[chunk.kind] || chunk.kind
        ),
        createElement("strong", "", chunk.title),
        createElement("p", "", chunk.content),
        createElement("small", "knowledge-citation", chunk.citation)
      );
      chunks.append(block);
    }
    card.append(chunks);
    target.append(card);
  }
}

function localDateValue(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatPercent(rate) {
  return typeof rate === "number" ? `${Math.round(rate * 100)}%` : "--";
}

function feedbackMetric(label, value, note = "") {
  const card = createElement("div", "feedback-metric");
  card.append(
    createElement("small", "", label),
    createElement("strong", "", String(value))
  );
  if (note) card.append(createElement("span", "", note));
  return card;
}

function renderFeedbackMetrics(target, items) {
  const container = $(target);
  if (!container) return;
  container.replaceChildren(
    ...items.map((item) =>
      feedbackMetric(item.label, item.value, item.note)
    )
  );
}

function renderFeedbackPoints(target, points) {
  const container = $(target);
  if (!container) return;
  container.replaceChildren();
  const activePoints = (points || [])
    .filter((point) => point.attempts > 0 || point.hints > 0)
    .slice(0, 5);
  if (!activePoints.length) {
    container.append(
      createElement("p", "feedback-muted", "这个时间段还没有知识点记录。")
    );
    return;
  }
  for (const point of activePoints) {
    const item = createElement("div", "feedback-point-row");
    item.append(
      createElement("strong", "", point.knowledgePoint),
      createElement(
        "span",
        "",
        `作答 ${point.attempts} · 答对 ${point.correctAttempts} · 提示 ${point.hints}`
      )
    );
    container.append(item);
  }
}

function renderFeedback() {
  const daily = state.feedback?.daily;
  const weekly = state.feedback?.weekly;
  $("#feedback-loading").hidden = true;
  const hasAny = Boolean(daily || weekly);
  $("#feedback-content").hidden = !hasAny;
  $("#feedback-empty").hidden = hasAny;
  if (!hasAny) return;

  if (daily) {
    $("#daily-date-label").textContent = new Intl.DateTimeFormat("zh-CN", {
      month: "long",
      day: "numeric",
      weekday: "long"
    }).format(new Date(daily.period.from));
    $("#daily-status-pill").textContent = daily.hasData ? "有记录" : "暂无记录";
    const sentences = daily.childSummary?.sentences || [];
    $("#daily-copy").textContent = [
      daily.childSummary?.headline || "",
      ...sentences
    ]
      .filter(Boolean)
      .join(" ");
    renderFeedbackMetrics("#daily-metrics", [
      {
        label: "今日作答",
        value: daily.totals.attempts,
        note: `答对 ${daily.totals.correctAttempts} 次`
      },
      {
        label: "独立答对",
        value: daily.totals.independentCorrectAttempts,
        note: "不计提示帮助"
      },
      {
        label: "提示次数",
        value: daily.totals.hints,
        note: "来自今天"
      },
      {
        label: "到期复习",
        value: daily.dueCount,
        note: "当前队列"
      }
    ]);
    renderFeedbackPoints("#daily-points", daily.knowledgePoints);
    $("#daily-next").textContent = daily.childSummary?.nextStep || "";
  }

  if (weekly) {
    $("#weekly-period-label").textContent = `${formatDate(
      weekly.period.from
    )} - ${formatDate(weekly.period.to)}`;
    $("#weekly-status-pill").textContent = weekly.hasData
      ? "有数据"
      : "数据不足";
    $("#weekly-copy").textContent =
      weekly.parentReport?.summaryText ||
      "本周还没有作答记录，无法判断掌握变化。";
    renderFeedbackMetrics("#weekly-metrics", [
      {
        label: "本周作答",
        value: weekly.totals.attempts,
        note: `答对 ${weekly.totals.correctAttempts} 次`
      },
      {
        label: "独立答对",
        value: weekly.totals.independentCorrectAttempts,
        note: "有独立证据"
      },
      {
        label: "提示依赖率",
        value: formatPercent(weekly.rates.hintDependencyRate),
        note: weekly.dependency.rateAvailable
          ? `${weekly.dependency.knownAttempts} 次有效样本`
          : "样本不足"
      },
      {
        label: "掌握变化",
        value: `+${weekly.masteryChanges.toMastered}`,
        note: `回到巩固 ${weekly.masteryChanges.toRelearning} 道`
      }
    ]);
    renderFeedbackPoints("#weekly-points", weekly.knowledgePoints);

    const changes = $("#weekly-changes");
    changes.replaceChildren();
    const items = weekly.parentReport?.masteryChanges || [];
    if (items.length) {
      changes.append(createElement("h3", "", "本周掌握状态变化"));
      for (const item of items.slice(-6).reverse()) {
        const row = createElement("div", "feedback-change-row");
        row.append(
          createElement("span", "", item.knowledgePoint || "未分类"),
          createElement(
            "strong",
            "",
            `${statusLabels[item.previousStatus] || item.previousStatus || "新题"} → ${
              statusLabels[item.nextStatus] || item.nextStatus
            }`
          ),
          createElement("time", "", formatDate(item.createdAt))
        );
        changes.append(row);
      }
    }

    const limitations = $("#weekly-limitations");
    limitations.replaceChildren();
    const notes = weekly.parentReport?.limitations || [];
    if (notes.length) {
      limitations.append(createElement("h3", "", "数据边界"));
      const list = createElement("ul");
      for (const note of notes) list.append(createElement("li", "", note));
      limitations.append(list);
    }
  }
}

async function loadFeedback() {
  const date = localDateValue();
  const [dailyResult, weeklyResult] = await Promise.allSettled([
    api(`/api/feedback/daily?date=${date}`),
    api(`/api/feedback/weekly?end=${date}`)
  ]);
  const feedback = { ...(state.feedback || {}) };
  if (dailyResult.status === "fulfilled") {
    feedback.daily = dailyResult.value;
  }
  if (weeklyResult.status === "fulfilled") {
    feedback.weekly = weeklyResult.value;
  }
  state.feedback = feedback;
  renderFeedback();
  const failures = [
    dailyResult.status === "rejected"
      ? `日总结：${dailyResult.reason?.message || "加载失败"}`
      : null,
    weeklyResult.status === "rejected"
      ? `周报：${weeklyResult.reason?.message || "加载失败"}`
      : null
  ].filter(Boolean);
  if (failures.length) {
    throw new Error(failures.join("；"));
  }
}

async function refreshAll() {
  const targets = [
    { name: "学习概览", load: loadDashboard },
    { name: "错题列表", load: loadMistakes },
    { name: "学习反馈", load: loadFeedback },
    { name: "知识点地图", load: loadKnowledge }
  ];
  const results = await Promise.allSettled(
    targets.map((target) => target.load())
  );
  const failures = results
    .map((result, index) => ({ result, name: targets[index].name }))
    .filter(({ result }) => result.status === "rejected");
  if (failures.length) {
    console.error(
      "页面刷新失败",
      failures.map(({ name, result }) => ({
        name,
        error: result.reason
      }))
    );
  }
  return { ok: failures.length === 0, failures };
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
  editor.dataset.hint = part.hint || "";
  editor.dataset.explanation = part.explanation || "";
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
      hint: editor.dataset.hint || "",
      explanation: editor.dataset.explanation || "",
      acceptedAnswers
    };
  });
  if (!parts.length) throw new Error("请至少添加一个小问");
  return parts;
}

function displayReviewPartTitle(part, partCount) {
  const label = String(part.label || "").trim();
  const name = label || String(part.prompt || "").trim();
  if (partCount > 1) {
    if (!name) return `小问 ${part.partNo}`;
    return /^小问\s*\d+/.test(name) ? name : `小问 ${part.partNo} · ${name}`;
  }
  return name || "你的答案";
}

function renderReviewPartInputs(review) {
  const container = $("#review-parts");
  container.replaceChildren();
  for (const part of review.parts || []) {
    const wrapper = createElement("div", "review-part");
    const partName = String(part.label || part.prompt || "").trim();
    const label = createElement(
      "label",
      "",
      displayReviewPartTitle(part, review.partCount)
    );
    if (part.prompt && part.prompt !== partName) {
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
  state.reviewSessionId = review.reviewSessionId || null;
  $("#review-point").textContent = review.knowledgePoint;
  $("#review-edit-button").hidden = true;
  $("#review-attempt").textContent = review.attemptCount
    ? `第 ${review.attemptCount + 1} 次独立练习`
    : "第一次独立重做";
  $("#review-question").textContent = displayQuestion(review);
  const reviewAttachments = $("#review-attachments");
  reviewAttachments.replaceChildren();
  reviewAttachments.hidden = !(review.attachments || []).length;
  for (const attachment of review.attachments || []) {
    reviewAttachments.append(createAttachmentImage(attachment));
  }
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
  state.hintRequestKey = null;
  state.followUpRequestKey = null;
  state.attemptRequestKey = null;
  $("#follow-up-input").value = "";
  $("#follow-up-answer").hidden = true;
  $("#follow-up-answer").replaceChildren();
  $("#return-to-answer-button").hidden = true;
  $("#review-progress").style.width = `${Math.min(
    90,
    20 + state.reviewAttemptsThisSession * 18
  )}%`;
  $("#review-session-label").textContent =
    review.status === "new" ? "优先处理当前不会的题" : "逐步把思路补完整";
}

async function openReview(id, { updateHash = true } = {}) {
  try {
    const review = await api(`/api/review/${id}`);
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

async function loadHintLevel(level) {
  if (!state.review || state.busy) return;
  if (!state.hintRequestKey) state.hintRequestKey = createRequestKey();
  $("#review-pre-actions").hidden = true;
  $("#hint-panel").hidden = false;
  const nextButton = $("#next-hint-button");
  setBusy(nextButton, true, "正在给提示…");
  state.busy = true;
  try {
    const hint = await api(`/api/review/${state.review.id}/hints`, {
      method: "POST",
      headers: { "Idempotency-Key": state.hintRequestKey },
      body: JSON.stringify({ level })
    });
    state.reviewHintLevel = hint.level;
    $(".hint-number").textContent = `提示 ${hint.level}`;
    $("#review-hint-title").textContent = hint.title;
    $("#review-hint").textContent = hint.content;
    const steps = $("#review-steps");
    steps.replaceChildren();
    for (const question of hint.guidingQuestions || []) {
      steps.append(createElement("li", "", question));
    }
    nextButton.hidden = hint.level >= 4;
    state.hintRequestKey = null;
  } catch (error) {
    showToast(error.message, true);
  } finally {
    state.busy = false;
    setBusy(nextButton, false);
  }
}

function showHint() {
  loadHintLevel(Math.min(4, state.reviewHintLevel + 1));
}

function showAnswerForm() {
  $("#review-pre-actions").hidden = true;
  $("#hint-panel").hidden = true;
  $("#answer-form").hidden = false;
  $("#review-parts input")?.focus();
}

async function submitFollowUp() {
  if (!state.review || state.busy) return;
  const question = $("#follow-up-input").value.trim();
  if (!question) {
    showToast("请先写下你的疑问", true);
    return;
  }
  if (!state.followUpRequestKey) {
    state.followUpRequestKey = createRequestKey();
  }
  const button = $("#follow-up-button");
  state.busy = true;
  setBusy(button, true, "正在回答…");
  try {
    const answer = await api(
      `/api/review/${state.review.id}/follow-up`,
      {
        method: "POST",
        headers: { "Idempotency-Key": state.followUpRequestKey },
        body: JSON.stringify({
          question,
          hintLevel: Math.max(1, state.reviewHintLevel)
        })
      }
    );
    const target = $("#follow-up-answer");
    target.replaceChildren(
      createElement("strong", "", answer.title),
      createElement("p", "", answer.content),
      createElement(
        "p",
        "",
        `下一步：${answer.suggestedNextStep}`
      )
    );
    target.hidden = false;
    $("#return-to-answer-button").hidden = false;
    $("#follow-up-input").value = "";
    state.followUpRequestKey = null;
  } catch (error) {
    showToast(error.message, true);
  } finally {
    state.busy = false;
    setBusy(button, false);
  }
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
  if (!state.attemptRequestKey) state.attemptRequestKey = createRequestKey();
  state.busy = true;
  setBusy(button, true, "正在判断…");
  try {
    const result = await api(`/api/mistakes/${state.review.id}/attempts`, {
      method: "POST",
      headers: {
        "Idempotency-Key": state.attemptRequestKey,
        ...(state.reviewSessionId
          ? { "X-Review-Session": state.reviewSessionId }
          : {})
      },
      body: JSON.stringify({
        answer: answers.length === 1 ? answers[0].value : "",
        answers,
        independent: state.reviewHintLevel === 0,
        hintLevel: state.reviewHintLevel
      })
    });
    state.reviewAttemptsThisSession += 1;
    state.attemptRequestKey = null;
    renderReviewResult(result);
    const refresh = await refreshAll();
    if (!refresh.ok) {
      showToast("作答已提交，但页面刷新失败，请刷新页面查看最新数据。", true);
    }
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
  $("#review-edit-button").hidden = false;
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
        : result.nextStatus === "relearning"
          ? `已回到巩固阶段，下次复习：${formatRelativeDate(result.nextReviewAt)}`
          : `下次复习：${formatRelativeDate(result.nextReviewAt)}`
    )
  );
  heading.append(mark, headingText);
  target.append(heading);

  const firstError = readableText(result.firstError);
  const finalAnswerAssessment = readableText(result.finalAnswerAssessment);
  const stepAssessment = (Array.isArray(result.stepAssessment)
    ? result.stepAssessment
    : []
  )
    .map((step) => ({
      partNo: step.partNo,
      assessment: readableText(step.assessment)
    }))
    .filter((step) => step.assessment);

  target.append(
    createElement("p", "result-copy", readableText(result.feedback))
  );
  if (stepAssessment.length || finalAnswerAssessment || firstError) {
    const stepFeedback = createElement("div", "result-step-feedback");
    stepFeedback.append(
      createElement(
        "p",
        "result-step-label",
        "步骤分析（最终结果以系统判定为准）"
      )
    );
    if (finalAnswerAssessment) {
      stepFeedback.append(
        createElement("p", "", finalAnswerAssessment)
      );
    }
    for (const step of stepAssessment) {
      stepFeedback.append(
        createElement("p", "", `第 ${step.partNo} 个小问：${step.assessment}`)
      );
    }
    if (firstError) {
      stepFeedback.append(
        createElement("p", "", `最早出现的错误：${firstError}`)
      );
    }
    target.append(stepFeedback);
  }
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
          displayReviewPartTitle(part, result.partResults.length)
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
  closeCropEditor();
  $("#add-form").reset();
  renderPartsEditor();
  state.dialogAttachments = [];
  state.newAttachmentIds = new Set();
  state.originalPreviewIds = new Set();
  state.ocrAttachmentId = null;
  state.imageUploads = 0;
  $("#ocr-panel").hidden = true;
  $("#ocr-candidate").hidden = true;
  renderDialogAttachments();
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

async function openEditDialog(
  id,
  { context = "mistake-library" } = {}
) {
  try {
    const session = await api(`/api/mistakes/${id}/edit-session`, {
      method: "POST",
      body: JSON.stringify({
        confirmed: true,
        context,
        ...(context === "review" && state.reviewSessionId
          ? { reviewSessionId: state.reviewSessionId }
          : {})
      })
    });
    const mistake = await api(`/api/mistakes/${id}/edit`, {
      headers: {
        "X-Edit-Session": session.token
      }
    });
    const form = $("#add-form");
    form.reset();
    form.elements.question.value = mistake.question;
    form.elements.knowledgePoint.value = mistake.knowledgePoint;
    form.elements.errorType.value = mistake.errorType;
    form.elements.analysis.value = mistake.analysis || "";
    renderPartsEditor(mistake.parts || []);
    closeCropEditor();
    state.dialogAttachments = [...(mistake.attachments || [])];
    state.newAttachmentIds = new Set();
    state.originalPreviewIds = new Set();
    state.ocrAttachmentId = null;
    state.imageUploads = 0;
    $("#ocr-panel").hidden = true;
    $("#ocr-candidate").hidden = true;
    renderDialogAttachments();
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

function closeAddDialog({ discardAttachments = true } = {}) {
  closeCropEditor();
  if (discardAttachments) discardNewAttachments();
  const dialog = $("#add-dialog");
  if (dialog.open) dialog.close();
  state.dialogAttachments = [];
  state.newAttachmentIds = new Set();
  state.originalPreviewIds = new Set();
  state.ocrAttachmentId = null;
  state.imageUploads = 0;
  $("#ocr-panel").hidden = true;
  $("#ocr-candidate").hidden = true;
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
  if (!String(data.question || "").trim() && !state.dialogAttachments.length) {
    showToast("请填写题目或添加题目图片", true);
    return;
  }
  if (state.imageUploads > 0) {
    showToast("图片还在上传，请稍等再保存", true);
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
  data.question = String(data.question || "").trim();
  data.attachmentIds = state.dialogAttachments.map((attachment) => attachment.id);
  if (state.lastDiagnosis) data.diagnosis = state.lastDiagnosis;
  const button = $("#save-mistake-button");
  const isEdit = state.dialogMode === "edit" && state.editingMistakeId;
  if (isEdit && !state.editSubmissionKey) {
    state.editSubmissionKey = createRequestKey();
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
    closeAddDialog({ discardAttachments: false });
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
    const refresh = await refreshAll();
    if (!refresh.ok) {
      showToast("数据已保存，但页面刷新失败，请刷新页面查看最新数据。", true);
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
  const label = displayQuestion(item) || "图片题";
  const confirmed = window.confirm(
    `确定删除这道错题吗？\n\n${label.slice(0, 80)}${
      label.length > 80 ? "…" : ""
    }\n\n删除后无法恢复。`
  );
  if (!confirmed) return;
  try {
    await api(`/api/mistakes/${id}`, { method: "DELETE" });
    showToast("错题已删除");
    const refresh = await refreshAll();
    if (!refresh.ok) {
      showToast("错题已删除，但页面刷新失败，请刷新页面。", true);
    }
  } catch (error) {
    showToast(error.message, true);
  }
}

async function loadDemo() {
  try {
    const result = await api("/api/demo", { method: "POST" });
    if (result.added) {
      showToast(`已载入 ${result.added} 道六年级数学示例错题`);
      const refresh = await refreshAll();
      if (!refresh.ok) {
        showToast("示例数据已载入，但页面刷新失败，请刷新页面。", true);
      }
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
    const clearSearch = event.target.closest("[data-clear-search]");
    if (clearSearch) {
      clearMistakeSearch();
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
  $("#mistake-search-input").addEventListener("input", (event) => {
    state.mistakeQuery = event.target.value;
    updateMistakeSearchClear();
    window.clearTimeout(state.mistakeSearchTimer);
    state.mistakeSearchTimer = window.setTimeout(() => {
      state.mistakePage = 1;
      refreshMistakeList();
    }, 120);
  });
  $("#mistake-search-input").addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !event.target.value) return;
    event.preventDefault();
    clearMistakeSearch();
  });
  $("#mistake-search-clear").addEventListener("click", () => {
    clearMistakeSearch();
  });
  $("#take-photo-button").addEventListener("click", () => {
    $("#take-photo-input").click();
  });
  $("#choose-image-button").addEventListener("click", () => {
    $("#choose-image-input").click();
  });
  for (const input of [$("#take-photo-input"), $("#choose-image-input")]) {
    input.addEventListener("change", (event) => {
      uploadImageFiles(event.target.files);
      event.target.value = "";
    });
  }
  $("#add-dialog").addEventListener("paste", (event) => {
    if (!$("#add-dialog").open || state.cropEditor) return;
    const files = [...(event.clipboardData?.files || [])];
    if (!files.length) return;
    event.preventDefault();
    uploadImageFiles(files);
  });
  $("#attachment-list").addEventListener("click", (event) => {
    const crop = event.target.closest("[data-crop-attachment]");
    if (crop) {
      openCropEditor(Number(crop.dataset.cropAttachment));
      return;
    }
    const toggleOriginal = event.target.closest("[data-toggle-original-attachment]");
    if (toggleOriginal) {
      toggleOriginalPreview(Number(toggleOriginal.dataset.toggleOriginalAttachment));
      return;
    }
    const extract = event.target.closest("[data-extract-attachment]");
    if (extract) {
      startOcrForAttachment(Number(extract.dataset.extractAttachment));
      return;
    }
    const remove = event.target.closest("[data-remove-attachment]");
    if (remove) {
      removeDialogAttachment(Number(remove.dataset.removeAttachment));
    }
  });
  $("#rotate-crop-button").addEventListener("click", rotateCropEditor);
  $("#reset-crop-button").addEventListener("click", resetCropEditor);
  $("#restore-original-button").addEventListener("click", restoreOriginalImage);
  $("#close-crop-editor-button").addEventListener("click", closeCropEditor);
  $("#cancel-crop-button").addEventListener("click", closeCropEditor);
  $("#apply-crop-button").addEventListener("click", applyCropEditor);
  $("#crop-selection").addEventListener("pointerdown", startCropDrag);
  document.addEventListener("pointermove", moveCropDrag);
  document.addEventListener("pointerup", endCropDrag);
  document.addEventListener("pointercancel", endCropDrag);
  window.addEventListener("resize", () => {
    if (state.cropEditor?.image) renderCropEditor();
  });
  $("#run-ocr-button").addEventListener("click", runOcr);
  $("#cancel-ocr-button").addEventListener("click", () => {
    $("#ocr-panel").hidden = true;
    $("#ocr-candidate").hidden = true;
    state.ocrAttachmentId = null;
  });
  $("#use-ocr-text-button").addEventListener("click", useOcrText);
  $("#discard-ocr-button").addEventListener("click", () => {
    $("#ocr-candidate").hidden = true;
    $("#ocr-text").value = "";
  });
  $("#start-review-button").addEventListener("click", () => navigateTo("review"));
  $("#menu-button").addEventListener("click", () => {
    $(".sidebar").classList.toggle("is-open");
  });
  $("#refresh-feedback-button").addEventListener("click", async () => {
    const button = $("#refresh-feedback-button");
    setBusy(button, true, "正在刷新…");
    try {
      await loadFeedback();
      showToast("学习反馈已刷新");
    } catch (error) {
      showToast(error.message, true);
    } finally {
      setBusy(button, false);
    }
  });

  $("#knowledge-search-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = $("#knowledge-search-input");
    const query = input.value.trim();
    if (!query) {
      showToast("请输入题目或关键词", true);
      return;
    }
    const button = event.currentTarget.querySelector("button");
    setBusy(button, true, "检索中…");
    const requestId = state.knowledgeSearchRequest + 1;
    state.knowledgeSearchRequest = requestId;
    try {
      const result = await api(
        `/api/knowledge-base/search?q=${encodeURIComponent(query)}&limit=3`
      );
      if (requestId !== state.knowledgeSearchRequest) return;
      state.knowledgeSearch = result;
      renderKnowledgeSearch(result);
    } catch (error) {
      if (requestId !== state.knowledgeSearchRequest) return;
      showToast(error.message, true);
    } finally {
      setBusy(button, false);
    }
  });

  $$(".filter-chip").forEach((button) => {
    button.addEventListener("click", () => {
      window.clearTimeout(state.mistakeSearchTimer);
      state.mistakeSearchTimer = null;
      state.filter = button.dataset.filter;
      state.mistakePage = 1;
      $$(".filter-chip").forEach((chip) => {
        chip.classList.toggle("is-active", chip === button);
      });
      refreshMistakeList();
    });
  });

  $("#mistake-pagination").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-page]");
    if (!button || button.disabled) return;
    const nextPage = Number(button.dataset.page);
    if (!Number.isInteger(nextPage) || nextPage === state.mistakePage) return;
    state.mistakePage = nextPage;
    renderMistakes();
    focusFirstMistake();
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    $("#mistake-list").scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "start"
    });
  });

  ["(max-width: 560px)", "(max-width: 1100px)"].forEach((query) => {
    window.matchMedia(query).addEventListener("change", () => {
      const nextSize = getPageSize(window.innerWidth);
      if (nextSize === state.mistakePageSize) return;
      const firstIndex = (state.mistakePage - 1) * state.mistakePageSize;
      state.mistakePageSize = nextSize;
      state.mistakePage = pageForFirstItem(firstIndex, nextSize);
      renderMistakes();
    });
  });

  $("#show-hint-button").addEventListener("click", showHint);
  $("#next-hint-button").addEventListener("click", showHint);
  $("#retry-button").addEventListener("click", showAnswerForm);
  $("#retry-after-hint-button").addEventListener("click", showAnswerForm);
  $("#return-to-answer-button").addEventListener("click", showAnswerForm);
  $("#follow-up-button").addEventListener("click", submitFollowUp);
  $("#review-edit-button").addEventListener("click", () => {
    if (state.review) {
      openEditDialog(state.review.id, { context: "review" });
    }
  });
  $("#answer-form").addEventListener("submit", submitAttempt);
  $("#review-parts").addEventListener("input", () => {
    state.attemptRequestKey = null;
  });
  $("#follow-up-input").addEventListener("input", () => {
    state.followUpRequestKey = null;
  });
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
  $("#close-dialog-button").addEventListener("click", () => closeAddDialog());
  $("#cancel-dialog-button").addEventListener("click", () => closeAddDialog());
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
  $("#add-dialog").addEventListener("cancel", (event) => {
    event.preventDefault();
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
    } else if (route.view === "feedback") {
      loadFeedback().catch((error) => showToast(error.message, true));
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.cropEditor) {
      event.preventDefault();
      closeCropEditor();
      return;
    }
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
    const refresh = await refreshAll();
    if (!refresh.ok) {
      showToast("部分页面数据加载失败，请刷新重试。", true);
    }
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
