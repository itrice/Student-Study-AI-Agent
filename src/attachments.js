import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { LearningValidationError } from "./domain/errors.js";

export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MISTAKE = 6;
export const MAX_ATTACHMENTS_TOTAL_BYTES = 30 * 1024 * 1024;
export const UNBOUND_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
]);

const MIME_ALIASES = new Map([
  ["image/jpg", "image/jpeg"],
  ["image/pjpeg", "image/jpeg"]
]);

const EXTENSIONS = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp"
};

function normalizedMime(value) {
  const mime = String(value || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  return MIME_ALIASES.get(mime) || mime;
}

function invalidImage(message) {
  return new LearningValidationError("INVALID_IMAGE", message);
}

function readPngSize(buffer) {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return null;
  }
  return {
    mimeType: "image/png",
    extension: "png",
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

function readJpegSize(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }
  let offset = 2;
  while (offset + 3 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    let markerOffset = offset + 1;
    while (buffer[markerOffset] === 0xff) markerOffset += 1;
    const marker = buffer[markerOffset];
    offset = markerOffset + 1;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) continue;
    if (marker === 0xda) break;
    if (offset + 2 > buffer.length) break;
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) break;
    const isStartOfFrame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isStartOfFrame && segmentLength >= 7) {
      return {
        mimeType: "image/jpeg",
        extension: "jpg",
        width: buffer.readUInt16BE(offset + 5),
        height: buffer.readUInt16BE(offset + 3)
      };
    }
    offset += segmentLength;
  }
  return null;
}

function readWebpSize(buffer) {
  if (
    buffer.length < 30 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WEBP"
  ) {
    return null;
  }
  const chunk = buffer.toString("ascii", 12, 16);
  if (chunk === "VP8X") {
    return {
      mimeType: "image/webp",
      extension: "webp",
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3)
    };
  }
  if (chunk === "VP8 " && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
    return {
      mimeType: "image/webp",
      extension: "webp",
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff
    };
  }
  if (chunk === "VP8L" && buffer[20] === 0x2f) {
    const bits = buffer.readUInt32LE(21);
    return {
      mimeType: "image/webp",
      extension: "webp",
      width: 1 + (bits & 0x3fff),
      height: 1 + ((bits >>> 14) & 0x3fff)
    };
  }
  return null;
}

export function inspectImage(buffer, { declaredMime = "" } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw invalidImage("请选择一张图片");
  }
  if (buffer.length > MAX_ATTACHMENT_BYTES) {
    throw invalidImage("图片不能超过 8 MB");
  }

  const detected =
    readPngSize(buffer) || readJpegSize(buffer) || readWebpSize(buffer);
  if (!detected) {
    throw invalidImage("仅支持 JPG、PNG 或 WebP 图片");
  }
  if (!detected.width || !detected.height) {
    throw invalidImage("图片尺寸无效或文件已损坏");
  }
  if (detected.width > 12000 || detected.height > 12000) {
    throw invalidImage("图片尺寸过大");
  }

  const expectedMime = normalizedMime(declaredMime);
  if (
    expectedMime &&
    expectedMime !== "application/octet-stream" &&
    expectedMime !== detected.mimeType
  ) {
    throw invalidImage("图片格式与文件内容不一致");
  }
  return {
    ...detected,
    byteSize: buffer.length,
    sha256: createHash("sha256").update(buffer).digest("hex")
  };
}

export function sanitizeOriginalName(value) {
  return path
    .basename(String(value || "").replaceAll("\\", "/"))
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, 120);
}

export function defaultAttachmentsDirectory(databasePath) {
  if (!databasePath || databasePath === ":memory:") return null;
  return path.join(path.dirname(databasePath), "attachments");
}

export class AttachmentStore {
  constructor({ directory }) {
    if (!directory) throw new Error("附件目录不能为空");
    this.directory = path.resolve(directory);
    fs.mkdirSync(this.directory, { recursive: true });
  }

  storagePath(storageKey) {
    const key = String(storageKey || "");
    if (!/^[a-f0-9-]{36}\.(?:jpg|png|webp)$/.test(key)) {
      throw new Error("附件存储键无效");
    }
    const resolved = path.resolve(this.directory, key);
    if (!resolved.startsWith(`${this.directory}${path.sep}`)) {
      throw new Error("附件路径无效");
    }
    return resolved;
  }

  save(buffer, { declaredMime = "", originalName = "", kind = "question" } = {}) {
    const info = inspectImage(buffer, { declaredMime });
    const storageKey = `${randomUUID()}.${EXTENSIONS[info.mimeType]}`;
    const target = this.storagePath(storageKey);
    let written = false;
    try {
      fs.writeFileSync(target, buffer, { flag: "wx" });
      written = true;
    } catch (error) {
      throw new Error("图片保存失败，请稍后重试", { cause: error });
    } finally {
      if (!written) {
        try {
          fs.unlinkSync(target);
        } catch {
          // The file may not have been created yet.
        }
      }
    }
    return {
      kind,
      storageKey,
      mimeType: info.mimeType,
      byteSize: info.byteSize,
      width: info.width,
      height: info.height,
      sha256: info.sha256,
      originalName: sanitizeOriginalName(originalName)
    };
  }

  read(storageKey) {
    return fs.readFileSync(this.storagePath(storageKey));
  }

  delete(storageKey) {
    try {
      fs.unlinkSync(this.storagePath(storageKey));
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw new Error("图片删除失败，请稍后重试", { cause: error });
    }
  }

  listStorageKeys() {
    return fs
      .readdirSync(this.directory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => /^[a-f0-9-]{36}\.(?:jpg|png|webp)$/.test(name));
  }

  cleanupUnreferenced({
    referencedKeys = [],
    maxAgeMs = UNBOUND_ATTACHMENT_TTL_MS,
    now = Date.now()
  } = {}) {
    const referenced = new Set(referencedKeys);
    const deleted = [];
    for (const storageKey of this.listStorageKeys()) {
      if (referenced.has(storageKey)) continue;
      const filePath = this.storagePath(storageKey);
      let stats;
      try {
        stats = fs.statSync(filePath);
      } catch {
        continue;
      }
      if (maxAgeMs > 0 && now - stats.mtimeMs < maxAgeMs) continue;
      try {
        fs.unlinkSync(filePath);
        deleted.push(storageKey);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return deleted;
  }
}
