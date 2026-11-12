import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { LearningRepository } from "../src/database.js";
import {
  AttachmentStore,
  MAX_ATTACHMENT_BYTES
} from "../src/attachments.js";
import {
  clearAttachmentCrop,
  readAttachmentContent,
  saveAttachmentCrop
} from "../src/attachment-crop.js";
import { extractAttachmentText } from "../src/attachment-service.js";
import {
  createLearningBackup,
  restoreLearningBackup
} from "../scripts/learning-backup.mjs";

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function makePng(width, height, [red, green, blue, alpha = 255]) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rowBytes = width * 4 + 1;
  const pixels = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * rowBytes;
    pixels[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 4;
      pixels[offset] = red;
      pixels[offset + 1] = green;
      pixels[offset + 2] = blue;
      pixels[offset + 3] = alpha;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

const ORIGINAL = makePng(8, 6, [30, 90, 150]);
const CROP = makePng(4, 3, [210, 70, 40]);

function withTemporaryDirectory(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "math-coach-crop-"));
  let result;
  try {
    result = callback(directory);
    if (result && typeof result.then === "function") {
      return result.finally(() => {
        fs.rmSync(directory, { recursive: true, force: true });
      });
    }
    return result;
  } finally {
    if (!result || typeof result.then !== "function") {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
}

function createFixture(directory) {
  const databasePath = path.join(directory, "learning.sqlite");
  const repository = new LearningRepository(databasePath);
  const store = new AttachmentStore({
    directory: repository.attachmentDirectory
  });
  return { databasePath, repository, store };
}

function saveOriginal(repository, store, buffer = ORIGINAL, name = "question.png") {
  const saved = store.save(buffer, {
    declaredMime: "image/png",
    originalName: name,
    kind: "question"
  });
  return {
    ...repository.insertAttachment(saved),
    sha256: saved.sha256,
    storageKey: saved.storageKey
  };
}

function applyCrop(repository, store, attachment, overrides = {}) {
  return saveAttachmentCrop({
    repository,
    attachmentStore: store,
    attachmentId: attachment.id,
    buffer: overrides.buffer || CROP,
    declaredMime: overrides.declaredMime || "image/png",
    crop: {
      x: 1,
      y: 1,
      width: 4,
      height: 3,
      rotation: 0,
      sourceWidth: 8,
      sourceHeight: 6,
      ...overrides.crop
    }
  });
}

function createImageMistake(repository, attachmentIds) {
  return repository.createMistake({
    question: "",
    correctAnswer: "42",
    knowledgePoint: "百分数",
    errorType: "不会做",
    attachmentIds
  });
}

test("裁剪保留原图，默认展示裁剪图并可恢复原图", () => {
  withTemporaryDirectory((directory) => {
    const { repository, store } = createFixture(directory);
    const attachment = saveOriginal(repository, store);
    const originalPath = path.join(store.directory, attachment.storageKey);
    const originalHash = createHash("sha256")
      .update(fs.readFileSync(originalPath))
      .digest("hex");

    const updated = applyCrop(repository, store, attachment);
    assert.equal(updated.hasCrop, true);
    assert.equal(updated.url, `/api/attachments/${attachment.id}`);
    assert.match(updated.displayUrl, /variant=crop/);
    assert.equal(updated.originalUrl, `/api/attachments/${attachment.id}?variant=original`);
    assert.deepEqual(updated.crop, {
      x: 1,
      y: 1,
      width: 4,
      height: 3,
      rotation: 0,
      sourceWidth: 8,
      sourceHeight: 6,
      updatedAt: updated.crop.updatedAt
    });
    assert.equal("storageKey" in updated, false);
    assert.equal("originalName" in updated, false);
    assert.equal(createHash("sha256").update(fs.readFileSync(originalPath)).digest("hex"), originalHash);

    const internal = repository.getAttachment(attachment.id, {
      includeStorageKey: true
    });
    assert.deepEqual(readAttachmentContent(internal, store).buffer, CROP);
    assert.deepEqual(
      readAttachmentContent(internal, store, { variant: "original" }).buffer,
      ORIGINAL
    );
    assert.equal(fs.readdirSync(store.directory).length, 2);

    const firstCropKey = internal.cropStorageKey;
    const secondCrop = makePng(4, 3, [80, 160, 90]);
    applyCrop(repository, store, attachment, { buffer: secondCrop });
    assert.equal(fs.existsSync(path.join(store.directory, firstCropKey)), false);
    assert.equal(createHash("sha256").update(fs.readFileSync(originalPath)).digest("hex"), originalHash);

    const reset = clearAttachmentCrop({
      repository,
      attachmentStore: store,
      attachmentId: attachment.id
    });
    assert.equal(reset.hasCrop, false);
    assert.equal(fs.readdirSync(store.directory).length, 1);
    assert.equal(fs.existsSync(originalPath), true);
    assert.equal(createHash("sha256").update(fs.readFileSync(originalPath)).digest("hex"), originalHash);
    repository.close();
  });
});

test("裁剪失败、越界或原图尺寸变化不会改变原图", () => {
  withTemporaryDirectory((directory) => {
    const { repository, store } = createFixture(directory);
    const attachment = saveOriginal(repository, store);
    const originalPath = path.join(store.directory, attachment.storageKey);
    const original = fs.readFileSync(originalPath);

    assert.throws(
      () => applyCrop(repository, store, attachment, { buffer: Buffer.from("bad") }),
      /仅支持/
    );
    assert.equal(repository.getAttachmentCrop(attachment.id), null);
    assert.equal(fs.readdirSync(store.directory).length, 1);

    assert.throws(
      () => applyCrop(repository, store, attachment, { crop: { rotation: 45 } }),
      /旋转角度/
    );
    assert.throws(
      () => applyCrop(repository, store, attachment, { crop: { x: 7, width: 4 } }),
      /超出图片范围/
    );
    assert.throws(
      () => applyCrop(repository, store, attachment, { crop: { sourceWidth: 9 } }),
      /原图尺寸已变化/
    );
    assert.throws(
      () =>
        applyCrop(repository, store, attachment, {
          buffer: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1)
        }),
      /不能超过 8 MB/
    );
    assert.deepEqual(fs.readFileSync(originalPath), original);
    assert.equal(repository.getAttachmentCrop(attachment.id), null);
    assert.equal(fs.readdirSync(store.directory).length, 1);
    repository.close();
  });
});

test("OCR 只发送裁剪区域，恢复原图后改发原图", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { repository, store } = createFixture(directory);
    const attachment = saveOriginal(repository, store);
    applyCrop(repository, store, attachment);
    const seen = [];
    const extractor = {
      isConfigured: () => true,
      async extract({ buffer, mimeType }) {
        seen.push({ buffer, mimeType });
        return {
          rawOutput: "{\"text\":\"裁剪区域文字\"}",
          normalizedText: "裁剪区域文字",
          confidence: 0.9,
          provider: "test",
          model: "vision-test",
          promptVersion: "test"
        };
      }
    };

    const cropped = await extractAttachmentText({
      repository,
      attachmentStore: store,
      extractor,
      attachmentId: attachment.id,
      consent: true
    });
    assert.equal(cropped.available, true);
    assert.equal(cropped.usedCrop, true);
    assert.deepEqual(seen[0].buffer, CROP);
    assert.equal(seen[0].mimeType, "image/png");

    clearAttachmentCrop({
      repository,
      attachmentStore: store,
      attachmentId: attachment.id
    });
    const original = await extractAttachmentText({
      repository,
      attachmentStore: store,
      extractor,
      attachmentId: attachment.id,
      consent: true
    });
    assert.equal(original.available, true);
    assert.equal(original.usedCrop, false);
    assert.deepEqual(seen[1].buffer, ORIGINAL);
    repository.close();
  });
});

test("删除、替换和孤儿清理同时处理原图与派生裁剪图", () => {
  withTemporaryDirectory((directory) => {
    const { repository, store } = createFixture(directory);
    const first = saveOriginal(repository, store, ORIGINAL, "first.png");
    const second = saveOriginal(repository, store, makePng(8, 6, [90, 40, 170]), "second.png");
    applyCrop(repository, store, first);
    assert.equal(fs.readdirSync(store.directory).length, 3);

    const mistake = createImageMistake(repository, [first.id]);
    const updated = repository.updateMistake(mistake.id, {
      attachmentIds: [second.id]
    });
    assert.ok(updated.changedFields.includes("attachments"));
    assert.equal(fs.readdirSync(store.directory).length, 1);
    assert.equal(fs.existsSync(path.join(store.directory, first.storageKey)), false);

    applyCrop(repository, store, second);
    assert.equal(repository.getReferencedAttachmentKeys().length, 2);
    assert.equal(repository.deleteMistake(mistake.id), true);
    assert.equal(fs.readdirSync(store.directory).length, 0);

    const stale = saveOriginal(repository, store, makePng(8, 6, [12, 44, 88]), "stale.png");
    applyCrop(repository, store, stale);
    const keys = repository.deleteStaleUnboundAttachments(
      "2099-01-01T00:00:00.000Z"
    );
    assert.equal(keys.length, 2);
    assert.equal(repository.getAttachment(stale.id), null);
    repository.close();
  });
});

test("备份恢复同时保留原图、裁剪图和裁剪元数据", () => {
  withTemporaryDirectory((directory) => {
    const { databasePath, repository, store } = createFixture(directory);
    const attachment = saveOriginal(repository, store);
    applyCrop(repository, store, attachment);
    createImageMistake(repository, [attachment.id]);
    const internal = repository.getAttachment(attachment.id, {
      includeStorageKey: true
    });
    const originalKey = internal.storageKey;
    const cropKey = internal.cropStorageKey;
    const originalHash = createHash("sha256").update(ORIGINAL).digest("hex");
    const cropHash = createHash("sha256").update(CROP).digest("hex");
    repository.close();

    const backup = createLearningBackup({
      databasePath,
      attachmentsDir: store.directory,
      backupRoot: path.join(directory, "backups"),
      now: new Date("2026-11-12T00:00:00.000Z")
    });
    const manifest = JSON.parse(fs.readFileSync(backup.manifestPath, "utf8"));
    assert.equal(manifest.attachments.length, 2);
    assert.deepEqual(
      manifest.attachments.map((item) => item.path).sort(),
      [cropKey, originalKey].sort()
    );

    const restoredDatabase = path.join(directory, "restored", "learning.sqlite");
    const restoredAttachments = path.join(directory, "restored", "attachments");
    const restored = restoreLearningBackup({
      backupDir: backup.outputDir,
      databasePath: restoredDatabase,
      attachmentsDir: restoredAttachments
    });
    assert.equal(restored.schemaVersion, 11);
    assert.equal(restored.attachmentCount, 2);

    const db = new DatabaseSync(restoredDatabase, { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM attachments").get().count, 1);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM attachment_crops").get().count, 1);
    } finally {
      db.close();
    }
    assert.equal(
      createHash("sha256").update(fs.readFileSync(path.join(restoredAttachments, originalKey))).digest("hex"),
      originalHash
    );
    assert.equal(
      createHash("sha256").update(fs.readFileSync(path.join(restoredAttachments, cropKey))).digest("hex"),
      cropHash
    );

    const restoredRepository = new LearningRepository(restoredDatabase, {
      attachmentDirectory: restoredAttachments
    });
    try {
      const image = restoredRepository.listMistakes()[0].attachments[0];
      assert.equal(image.hasCrop, true);
      assert.equal(image.crop.width, 4);
      assert.equal(image.crop.height, 3);
    } finally {
      restoredRepository.close();
    }
  });
});

test("每张图片独立裁剪，修改错题会保留裁剪状态", () => {
  withTemporaryDirectory((directory) => {
    const { repository, store } = createFixture(directory);
    const cropped = saveOriginal(repository, store, ORIGINAL, "cropped.png");
    const plain = saveOriginal(repository, store, makePng(8, 6, [60, 120, 30]), "plain.png");
    applyCrop(repository, store, cropped);
    const mistake = createImageMistake(repository, [cropped.id, plain.id]);
    const before = repository.getMistake(mistake.id);
    assert.equal(before.attachments[0].hasCrop, true);
    assert.equal(before.attachments[1].hasCrop, false);

    const updated = repository.updateMistake(mistake.id, {
      question: "修改题目文字",
      attachmentIds: [cropped.id, plain.id]
    });
    assert.equal(updated.mistake.attachments[0].hasCrop, true);
    assert.equal(updated.mistake.attachments[1].hasCrop, false);
    assert.equal(updated.mistake.attachments[0].crop.rotation, 0);
    repository.close();
  });
});

test("图片录入 UI 提供鼠标/触摸裁剪、旋转、重置、取消和查看原图入口", () => {
  const html = fs.readFileSync(
    new URL("../public/index.html", import.meta.url),
    "utf8"
  );
  const app = fs.readFileSync(
    new URL("../public/app.js", import.meta.url),
    "utf8"
  );

  assert.match(html, /id="crop-editor"[\s\S]*id="crop-selection"/);
  assert.match(html, /id="rotate-crop-button"/);
  assert.match(html, /id="reset-crop-button"/);
  assert.match(html, /id="restore-original-button"/);
  assert.match(html, /id="cancel-crop-button"/);
  assert.match(html, /id="apply-crop-button"/);
  assert.match(app, /addEventListener\("pointerdown"/);
  assert.match(app, /addEventListener\("pointermove"/);
  assert.match(app, /canvas\.toBlob/);
  assert.match(app, /X-Crop-Rotation/);
  assert.match(app, /data-toggle-original-attachment/);
  assert.doesNotMatch(app, /storageKey|storage_key|originalName/);
});
