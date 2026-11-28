import { createHash } from "node:crypto";
import { LRUCache } from "lru-cache";
import { readAttachmentContent } from "../attachment-crop.js";
import { LearningValidationError } from "../domain/errors.js";
import {
  shanghaiDateKey,
  shanghaiMonthKey
} from "../feedback-calendar.js";
import {
  EINK_DASHBOARD_LAYOUT_VERSION,
  EINK_QUOTE_VERSION,
  renderEinkDashboard,
  selectDailyQuote
} from "./dashboard.js";
import {
  EINK_LAYOUT_VERSION,
  renderEinkPage,
  renderEinkUnfitNotice
} from "./render.js";
import {
  EINK_VOCAB_LAYOUT_VERSION,
  renderEinkVocabFrame
} from "./vocab.js";
import { evaluateEinkFit } from "./fit.js";
import { prepareEinkPhoto } from "./photo.js";
import { toDateKey } from "../vocab/schedule.js";

const CACHE_PAGES = 32;
const FIT_CACHE_ENTRIES = 256;

function cacheDigest(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function dashboardEtag(model, frame) {
  return `"${cacheDigest(
    Buffer.concat([
      Buffer.from(JSON.stringify(model)),
      Buffer.from(frame)
    ])
  )}"`;
}

function renderSource(mistake, mode, index, total, photoAttachment) {
  return {
    layoutVersion: EINK_LAYOUT_VERSION,
    mode,
    index,
    total,
    mistake: {
      id: mistake.id,
      revision: mistake.revision,
      updatedAt: mistake.updatedAt,
      question: mistake.question,
      studentAnswer: mistake.studentAnswer,
      correctAnswer: mistake.correctAnswer,
      analysis: mistake.analysis,
      knowledgePoint: mistake.knowledgePoint,
      errorType: mistake.errorType,
      parts: (mistake.parts || []).map((part) => ({
        id: part.id,
        partNo: part.partNo,
        label: part.label,
        prompt: part.prompt,
        studentAnswer: part.studentAnswer,
        knowledgePoint: part.knowledgePoint,
        hint: part.hint,
        explanation: part.explanation,
        acceptedAnswers: part.acceptedAnswers || []
      }))
    },
    photoAttachmentId: photoAttachment?.id || null,
    attachments: (mistake.attachments || []).map((attachment) => ({
      id: attachment.id,
      createdAt: attachment.createdAt,
      mimeType: attachment.mimeType,
      width: attachment.width,
      height: attachment.height,
      hasCrop: attachment.hasCrop,
      cropUpdatedAt: attachment.crop?.updatedAt || null
    }))
  };
}

function notFound() {
  const error = new LearningValidationError(
    "MISTAKE_NOT_FOUND",
    "没有找到这道错题"
  );
  error.status = 404;
  return error;
}

function vocabIndexOutOfRange(total) {
  const error = new Error(`index 超出今日到期字词数量（共 ${total} 条）`);
  error.status = 400;
  error.code = "EINK_VOCAB_INDEX_OUT_OF_RANGE";
  return error;
}

export function etagMatches(header, etag) {
  const value = String(header || "").trim();
  if (!value) return false;
  return value
    .split(",")
    .map((item) => item.trim())
    .some((item) => item === "*" || item === etag);
}

export class EinkPageService {
  constructor({
    repository,
    attachmentStore,
    vocabStore = null,
    renderer = renderEinkPage,
    dashboardRenderer = renderEinkDashboard,
    vocabRenderer = renderEinkVocabFrame,
    preparePhoto = prepareEinkPhoto,
    unfitRenderer = renderEinkUnfitNotice,
    cache = new LRUCache({ max: CACHE_PAGES }),
    fitCache = new LRUCache({ max: FIT_CACHE_ENTRIES })
  }) {
    this.repository = repository;
    this.attachmentStore = attachmentStore;
    this.vocabStore = vocabStore;
    this.renderer = renderer;
    this.dashboardRenderer = dashboardRenderer;
    this.vocabRenderer = vocabRenderer;
    this.preparePhoto = preparePhoto;
    this.unfitRenderer = unfitRenderer;
    this.cache = cache;
    this.fitCache = fitCache;
  }

  resolveFit(mistake) {
    const stored = mistake.einkFitStatus;
    if (stored === "fit") return { status: "fit", reasons: [] };
    const key = `${mistake.id}:${mistake.revision}:${
      stored === "unfit" ? "pinned-unfit" : "auto"
    }`;
    const cached = this.fitCache.get(key);
    if (cached) return cached;
    const computed = evaluateEinkFit(mistake);
    const result = stored === "unfit"
      ? { status: "unfit", reasons: computed.reasons }
      : computed;
    this.fitCache.set(key, result);
    return result;
  }

  getVisibleQueue() {
    const visible = [];
    for (const row of this.repository.getDueReviewCandidates()) {
      if (row.einkFitStatus === "unfit") continue;
      if (row.einkFitStatus !== "fit") {
        let fit = this.fitCache.get(`${row.id}:${row.revision}:auto`);
        if (!fit) {
          const mistake = this.repository.getMistake(row.id, {
            includeSolution: true
          });
          if (!mistake) continue;
          fit = this.resolveFit(mistake);
        }
        if (fit.status === "unfit") continue;
      }
      visible.push(row);
    }
    return visible;
  }

  getQueue(limit = 20) {
    const visible = this.getVisibleQueue();
    return {
      count: visible.length,
      items: visible.slice(0, limit).map((row, index) => ({
        id: row.id,
        index: index + 1,
        hasPhoto: Boolean(row.hasPhoto),
        partCount: row.partCount,
        ...(row.kp ? { kp: row.kp } : {})
      })),
      updatedAt: new Date().toISOString()
    };
  }

  getVisiblePosition(id) {
    const visible = this.getVisibleQueue();
    const index = visible.findIndex((row) => row.id === id);
    if (index < 0) return { index: 1, total: 1 };
    return { index: index + 1, total: visible.length };
  }

  async getDashboard({ now = new Date() } = {}) {
    const current = now instanceof Date ? now : new Date(now);
    if (Number.isNaN(current.getTime())) {
      throw new TypeError("无效看板时间");
    }
    const dateKey = shanghaiDateKey(current);
    const monthKey = shanghaiMonthKey(current);
    let student = null;
    try {
      student = this.repository.getStudent();
    } catch {
      // Count and calendar reads below degrade independently.
    }
    let dueCount = 0;
    let dueAvailable = true;
    try {
      dueCount = this.repository.countDueReviews({
        at: current.toISOString(),
        studentId: student?.id || null
      });
    } catch {
      dueAvailable = false;
    }

    let calendarDays = [];
    let calendarAvailable = true;
    try {
      const calendar = this.repository.buildFeedbackCalendar({
        month: monthKey,
        studentId: student?.id || null
      });
      if (!Array.isArray(calendar.days)) throw new TypeError("日历数据无效");
      calendarDays = calendar.days.map((day) => ({
        date: day.date,
        hasActivity: day.hasActivity === true
      }));
    } catch {
      calendarAvailable = false;
    }

    const quote = selectDailyQuote(dateKey);
    const model = {
      dateKey,
      monthKey,
      dueCount,
      dueAvailable,
      calendarAvailable,
      calendarDays,
      quote,
      layoutVersion: EINK_DASHBOARD_LAYOUT_VERSION,
      quoteVersion: EINK_QUOTE_VERSION
    };
    const key = cacheDigest(JSON.stringify(model));
    const cached = this.cache.get(key);
    if (cached) return { ...cached, cacheHit: true };

    const rendered = await this.dashboardRenderer(model);
    const etag = dashboardEtag(model, rendered.frame);
    const result = {
      ...rendered,
      model,
      etag,
      layoutVersion: EINK_DASHBOARD_LAYOUT_VERSION
    };
    this.cache.set(key, result);
    return { ...result, cacheHit: false };
  }

  async getPage({ id, mode }) {
    const mistake = this.repository.getMistake(id, {
      includeSolution: true
    });
    if (!mistake) throw notFound();

    const fit = this.resolveFit(mistake);
    if (fit.status === "unfit") {
      return this.getUnfitResult({ mistake, mode, reasons: fit.reasons });
    }

    const { index, total } = this.getVisiblePosition(id);
    const attachment =
      mode === "question" && mistake.attachments.length
        ? mistake.attachments[0]
        : null;
    const source = renderSource(mistake, mode, index, total, attachment);
    const key = cacheDigest(JSON.stringify(source));
    const cached = this.cache.get(key);
    if (cached) return { ...cached, cacheHit: true };

    let photo = null;
    let warning = null;
    if (attachment) {
      try {
        const content = readAttachmentContent(
          this.repository.getAttachment(attachment.id, {
            includeStorageKey: true
          }),
          this.attachmentStore
        );
        photo = await this.preparePhoto(content.buffer, {
          skipPaperCrop: content.usedCrop
        });
      } catch {
        warning = "EINK_PHOTO_FALLBACK";
      }
    }

    let rendered;
    try {
      rendered = await this.renderer({
        mistake,
        mode,
        index,
        total,
        photo
      });
    } catch (error) {
      if (!photo) throw error;
      warning = "EINK_PHOTO_FALLBACK";
      rendered = await this.renderer({
        mistake,
        mode,
        index,
        total,
        photo: null
      });
    }
    if (rendered.unfit) {
      return this.getUnfitResult({
        mistake,
        mode,
        reasons: rendered.reasons
      });
    }

    const etag = `"${cacheDigest(rendered.frame)}"`;
    const result = {
      ...rendered,
      etag,
      layoutVersion: EINK_LAYOUT_VERSION,
      warning
    };
    this.cache.set(key, result);
    return { ...result, cacheHit: false };
  }

  async getVocabFrame({ studentId, subject, index, mode = null }) {
    if (!this.vocabStore) throw new Error("字词帧服务未配置字词数据源");
    const dictation = this.vocabStore.dictation({
      studentId,
      subject,
      mode: mode || undefined,
      todayKey: toDateKey(new Date())
    });
    const total = dictation.items.length;
    const empty = total === 0;
    if (!empty && index > total) throw vocabIndexOutOfRange(total);

    const model = {
      layoutVersion: EINK_VOCAB_LAYOUT_VERSION,
      subject,
      mode: dictation.mode,
      index: empty ? 0 : index,
      total,
      prompt: empty ? "" : dictation.items[index - 1].prompt,
      empty
    };
    const key = cacheDigest(JSON.stringify(model));
    const cached = this.cache.get(key);
    if (cached) return { ...cached, cacheHit: true };

    const rendered = await this.vocabRenderer(model);
    const etag = `"${cacheDigest(rendered.frame)}"`;
    const result = {
      ...rendered,
      model,
      etag,
      layoutVersion: EINK_VOCAB_LAYOUT_VERSION
    };
    this.cache.set(key, result);
    return { ...result, cacheHit: false };
  }

  async getUnfitResult({ mistake, mode, reasons = [] }) {
    const key = cacheDigest(
      `unfit:${mistake.id}:${mistake.revision}:${mode}:${reasons.join(",")}`
    );
    const cached = this.cache.get(key);
    if (cached) return { ...cached, cacheHit: true };
    const png = await this.unfitRenderer({ mistake, mode, reasons });
    const result = {
      unfit: true,
      code: "EINK_UNFIT",
      reasons,
      png,
      layoutVersion: EINK_LAYOUT_VERSION
    };
    this.cache.set(key, result);
    return { ...result, cacheHit: false };
  }
}
