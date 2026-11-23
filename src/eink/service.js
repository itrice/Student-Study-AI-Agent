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
  renderEinkPage
} from "./render.js";
import { prepareEinkPhoto } from "./photo.js";

const CACHE_PAGES = 32;

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
    renderer = renderEinkPage,
    dashboardRenderer = renderEinkDashboard,
    preparePhoto = prepareEinkPhoto,
    cache = new LRUCache({ max: CACHE_PAGES })
  }) {
    this.repository = repository;
    this.attachmentStore = attachmentStore;
    this.renderer = renderer;
    this.dashboardRenderer = dashboardRenderer;
    this.preparePhoto = preparePhoto;
    this.cache = cache;
  }

  getQueue(limit = 20) {
    return {
      ...this.repository.getDueReviewQueue({ limit }),
      updatedAt: new Date().toISOString()
    };
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

    const { index, total } = this.repository.getDueReviewPosition(id);
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
}
