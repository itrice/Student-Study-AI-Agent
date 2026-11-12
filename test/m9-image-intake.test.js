import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { LearningRepository } from "../src/database.js";
import {
  AttachmentStore,
  inspectImage,
  MAX_ATTACHMENT_BYTES
} from "../src/attachments.js";
import { extractAttachmentText } from "../src/attachment-service.js";
import { cleanupStaleAttachments } from "../src/attachment-cleanup.js";
import {
  createLearningBackup,
  restoreLearningBackup
} from "../scripts/learning-backup.mjs";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2fXkAAAAASUVORK5CYII=",
  "base64"
);

function withTemporaryDirectory(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "math-coach-m9-"));
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
  const store = new AttachmentStore({ directory: repository.attachmentDirectory });
  return { databasePath, repository, store };
}

function saveAttachment(
  repository,
  store,
  name = "question.png",
  { createdAt } = {}
) {
  const saved = store.save(PNG, {
    declaredMime: "image/png",
    originalName: name,
    kind: "question"
  });
  return {
    ...repository.insertAttachment({ ...saved, createdAt }),
    sha256: saved.sha256,
    storageKey: saved.storageKey
  };
}

function createImageMistake(repository, attachmentIds, overrides = {}) {
  return repository.createMistake({
    question: "",
    correctAnswer: "示例答案",
    knowledgePoint: "百分数",
    errorType: "不会做",
    attachmentIds,
    ...overrides
  });
}

test("纯图片错题可创建、读取并只返回安全附件字段", () => {
  withTemporaryDirectory((directory) => {
    const { repository, store } = createFixture(directory);
    const attachment = saveAttachment(repository, store, "private-name.png");
    const mistake = createImageMistake(repository, [attachment.id]);

    assert.equal(mistake.question, "");
    assert.equal(mistake.parts.length, 1);
    assert.equal(mistake.attachments.length, 1);
    assert.equal(mistake.attachments[0].url, `/api/attachments/${attachment.id}`);
    assert.equal("storageKey" in mistake.attachments[0], false);
    assert.equal("originalName" in mistake.attachments[0], false);
    assert.equal(
      repository.listMistakes()[0].attachments[0].id,
      attachment.id
    );
    const dashboard = repository.getDashboard();
    assert.equal(dashboard.recent[0].attachments[0].id, attachment.id);
    assert.equal(dashboard.nextReview.attachments[0].id, attachment.id);
    repository.close();
  });
});

test("替换原题图片会按题目内容变更重置掌握进度", () => {
  withTemporaryDirectory((directory) => {
    const { repository, store } = createFixture(directory);
    const first = saveAttachment(repository, store, "first.png");
    const second = saveAttachment(repository, store, "second.png");
    const mistake = createImageMistake(repository, [first.id]);
    const updated = repository.updateMistake(mistake.id, {
      attachmentIds: [second.id]
    });

    assert.equal(updated.learningReset, true);
    assert.ok(updated.changedFields.includes("attachments"));
    assert.equal(updated.mistake.attachments[0].id, second.id);
    repository.close();
  });
});

test("图片写入或绑定失败不会创建空壳错题", () => {
  withTemporaryDirectory((directory) => {
    const { repository, store } = createFixture(directory);
    try {
      const blockedPath = path.join(directory, "blocked");
      fs.writeFileSync(blockedPath, "not a directory");
      const failingStore = new AttachmentStore({ directory });
      failingStore.directory = blockedPath;
      assert.throws(
        () => failingStore.save(PNG, { declaredMime: "image/png" }),
        /图片保存失败/
      );
      assert.equal(repository.listMistakes().length, 0);

      assert.throws(
        () => createImageMistake(repository, [999999]),
        /图片不存在|已失效/
      );
      assert.equal(repository.listMistakes().length, 0);
      assert.equal(store.listStorageKeys().length, 0);
    } finally {
      repository.close();
    }
  });
});

test("删除错题会级联删除元数据和原图文件", () => {
  withTemporaryDirectory((directory) => {
    const { repository, store } = createFixture(directory);
    const attachment = saveAttachment(repository, store);
    const mistake = createImageMistake(repository, [attachment.id]);
    const [file] = store.listStorageKeys();

    assert.equal(repository.deleteMistake(mistake.id), true);
    assert.equal(
      repository.db.prepare("SELECT COUNT(*) AS count FROM attachments").get()
        .count,
      0
    );
    assert.equal(fs.existsSync(path.join(store.directory, file)), false);
    repository.close();
  });
});

test("删除全部学习数据会清理附件与识别记录", () => {
  withTemporaryDirectory((directory) => {
    const { repository, store } = createFixture(directory);
    const attachment = saveAttachment(repository, store);
    const mistake = createImageMistake(repository, [attachment.id]);
    repository.saveAttachmentExtraction({
      attachmentId: attachment.id,
      rawOutput: "raw",
      normalizedText: "识别文字",
      provider: "test",
      model: "test-model",
      promptVersion: "test"
    });
    const result = repository.deleteAllLearningData();

    assert.ok(result.deleted.attachments >= 1);
    assert.ok(result.deleted.attachment_extractions >= 1);
    assert.equal(repository.listMistakes().length, 0);
    assert.equal(store.listStorageKeys().length, 0);
    assert.equal(repository.deleteMistake(mistake.id), false);
    repository.close();
  });
});

test("未引用文件 GC 不删除仍被错题引用的图片", () => {
  withTemporaryDirectory((directory) => {
    const { repository, store } = createFixture(directory);
    try {
      const referenced = saveAttachment(repository, store, "used.png");
      const orphan = store.save(PNG, {
        declaredMime: "image/png",
        originalName: "orphan.png"
      });
      createImageMistake(repository, [referenced.id]);

      const deleted = store.cleanupUnreferenced({
        referencedKeys: repository.getReferencedAttachmentKeys(),
        maxAgeMs: 0
      });
      assert.ok(deleted.includes(orphan.storageKey));
      assert.equal(
        fs.existsSync(path.join(store.directory, orphan.storageKey)),
        false
      );
      assert.equal(store.listStorageKeys().length, 1);
    } finally {
      repository.close();
    }
  });
});

test("过期未绑定附件会清理元数据和文件，新上传与已引用图片保留", () => {
  withTemporaryDirectory((directory) => {
    const { repository, store } = createFixture(directory);
    try {
      const now = Date.parse("2026-11-12T00:00:00.000Z");
      const old = saveAttachment(repository, store, "old.png", {
        createdAt: "2026-11-10T00:00:00.000Z"
      });
      const recent = saveAttachment(repository, store, "recent.png", {
        createdAt: "2026-11-11T23:30:00.000Z"
      });
      const referenced = saveAttachment(repository, store, "used.png", {
        createdAt: "2026-11-10T00:00:00.000Z"
      });
      createImageMistake(repository, [referenced.id]);

      const result = cleanupStaleAttachments({
        repository,
        attachmentStore: store,
        now,
        ttlMs: 24 * 60 * 60 * 1000
      });

      assert.deepEqual(result.deletedFiles, [old.storageKey]);
      assert.equal(repository.getAttachment(old.id), null);
      assert.equal(fs.existsSync(path.join(store.directory, old.storageKey)), false);
      assert.ok(repository.getAttachment(recent.id));
      assert.ok(repository.getAttachment(referenced.id));
      assert.equal(fs.existsSync(path.join(store.directory, recent.storageKey)), true);
      assert.equal(fs.existsSync(path.join(store.directory, referenced.storageKey)), true);
    } finally {
      repository.close();
    }
  });
});

test("备份恢复同时保留数据库、附件元数据和原图哈希", () => {
  withTemporaryDirectory((directory) => {
    const { databasePath, repository, store } = createFixture(directory);
    const attachment = saveAttachment(repository, store);
    createImageMistake(repository, [attachment.id]);
    const originalFile = path.join(store.directory, store.listStorageKeys()[0]);
    const originalHash = createHash("sha256")
      .update(fs.readFileSync(originalFile))
      .digest("hex");
    repository.close();

    const backup = createLearningBackup({
      databasePath,
      attachmentsDir: store.directory,
      backupRoot: path.join(directory, "backups"),
      now: new Date("2026-11-11T00:00:00.000Z")
    });
    const restoredDatabase = path.join(directory, "restored", "learning.sqlite");
    const restoredAttachments = path.join(directory, "restored", "attachments");
    const restored = restoreLearningBackup({
      backupDir: backup.outputDir,
      databasePath: restoredDatabase,
      attachmentsDir: restoredAttachments
    });

    assert.equal(restored.schemaVersion, 11);
    const db = new DatabaseSync(restoredDatabase, { readOnly: true });
    try {
      assert.equal(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM attachments").get().count,
        1
      );
    } finally {
      db.close();
    }
    const restoredRepository = new LearningRepository(restoredDatabase, {
      attachmentDirectory: restoredAttachments
    });
    try {
      const mistake = restoredRepository.listMistakes()[0];
      assert.equal(mistake.attachments.length, 1);
      const [restoredFile] = fs.readdirSync(restoredAttachments);
      assert.equal(
        createHash("sha256")
          .update(fs.readFileSync(path.join(restoredAttachments, restoredFile)))
          .digest("hex"),
        originalHash
      );
    } finally {
      restoredRepository.close();
    }
  });
});

test("附件缺失或清单被篡改时备份恢复会拒绝不一致数据", () => {
  withTemporaryDirectory((directory) => {
    const { databasePath, repository, store } = createFixture(directory);
    const attachment = saveAttachment(repository, store);
    createImageMistake(repository, [attachment.id]);
    const attachmentPath = path.join(store.directory, attachment.storageKey);
    const original = fs.readFileSync(attachmentPath);
    repository.close();
    const backupRoot = path.join(directory, "backups");

    fs.rmSync(attachmentPath);
    assert.throws(
      () =>
        createLearningBackup({
          databasePath,
          attachmentsDir: store.directory,
          backupRoot
        }),
      /附件文件缺失/
    );
    assert.equal(
      fs.existsSync(backupRoot) ? fs.readdirSync(backupRoot).length : 0,
      0
    );

    fs.writeFileSync(attachmentPath, original);
    const backup = createLearningBackup({
      databasePath,
      attachmentsDir: store.directory,
      backupRoot
    });
    const backupAttachment = path.join(
      backup.outputDir,
      "attachments",
      attachment.storageKey
    );
    fs.writeFileSync(backupAttachment, Buffer.from("tampered"));
    assert.throws(
      () =>
        restoreLearningBackup({
          backupDir: backup.outputDir,
          databasePath: path.join(directory, "restored", "learning.sqlite"),
          attachmentsDir: path.join(directory, "restored", "attachments")
        }),
      /附件校验失败/
    );
  });
});

test("拒绝超限、伪造格式、损坏图片和超过数量的附件", () => {
  assert.throws(
    () => inspectImage(Buffer.alloc(MAX_ATTACHMENT_BYTES + 1)),
    /不能超过 8 MB/
  );
  assert.throws(() => inspectImage(Buffer.from("not an image")), /仅支持/);
  assert.throws(
    () => inspectImage(PNG, { declaredMime: "image/jpeg" }),
    /格式与文件内容不一致/
  );
  assert.throws(
    () => inspectImage(PNG.subarray(0, 8)),
    /仅支持|尺寸无效/
  );

  withTemporaryDirectory((directory) => {
    const { repository, store } = createFixture(directory);
    const ids = Array.from({ length: 7 }, () => {
      return saveAttachment(repository, store).id;
    });
    assert.throws(
      () => createImageMistake(repository, ids),
      /最多添加 6 张/
    );
    assert.equal(repository.listMistakes().length, 0);
    repository.close();
  });
});

test("视觉识别必须显式同意，失败时可退回图片加文字保存", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { repository, store } = createFixture(directory);
    const attachment = saveAttachment(repository, store);
    let calls = 0;
    const extractor = {
      isConfigured: () => true,
      async extract() {
        calls += 1;
        throw new Error("provider down");
      }
    };

    await assert.rejects(
      extractAttachmentText({
        repository,
        attachmentStore: store,
        extractor,
        attachmentId: attachment.id,
        consent: false
      }),
      /明确同意/
    );
    assert.equal(calls, 0);

    const failed = await extractAttachmentText({
      repository,
      attachmentStore: store,
      extractor,
      attachmentId: attachment.id,
      consent: true
    });
    assert.equal(failed.available, false);
    assert.match(failed.message, /可直接填写/);
    assert.equal(calls, 1);

    const success = await extractAttachmentText({
      repository,
      attachmentStore: store,
      extractor: {
        isConfigured: () => true,
        async extract() {
          return {
            rawOutput: "{\"text\":\"识别出的题目\"}",
            normalizedText: "识别出的题目",
            confidence: 0.9,
            provider: "test",
            model: "vision-test",
            promptVersion: "test"
          };
        }
      },
      attachmentId: attachment.id,
      consent: true
    });
    assert.equal(success.available, true);
    assert.equal(success.text, "识别出的题目");
    assert.equal(
      repository.getLatestAttachmentExtraction(attachment.id).normalized_text,
      "识别出的题目"
    );
    const mistake = createImageMistake(repository, [attachment.id], {
      question: success.text
    });
    assert.equal(mistake.question, "识别出的题目");
    repository.close();
  });
});

test("图片录入 UI 提供拍照、相册、粘贴和隐私确认入口", () => {
  const html = fs.readFileSync(
    new URL("../public/index.html", import.meta.url),
    "utf8"
  );
  const app = fs.readFileSync(
    new URL("../public/app.js", import.meta.url),
    "utf8"
  );

  assert.match(html, /id="take-photo-input"[\s\S]*capture="environment"/);
  assert.match(html, /id="choose-image-input"[\s\S]*multiple/);
  assert.match(html, /外部视觉模型/);
  assert.match(app, /addEventListener\("paste"/);
  assert.match(app, /clipboardData\?\.files/);
  assert.doesNotMatch(app, /crypto\.randomUUID\s*\(/);
  assert.doesNotMatch(app, /storageKey|storage_key|originalName/);
});
