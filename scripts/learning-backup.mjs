import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const FORMAT_VERSION = 1;
const MANIFEST_NAME = "manifest.json";

function sha256File(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function timestampName(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function listRelativeFiles(directory, current = "") {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(path.join(directory, current), {
    withFileTypes: true
  })) {
    const relative = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...listRelativeFiles(directory, relative));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files;
}

function assertSafeRelativePath(relativePath) {
  const resolved = path.resolve("/", relativePath);
  if (
    path.isAbsolute(relativePath) ||
    relativePath.includes("..") ||
    resolved === path.resolve("/")
  ) {
    throw new Error("备份清单包含非法附件路径");
  }
}

function assertStorageKey(storageKey) {
  if (!/^[a-f0-9-]{36}\.(?:jpg|png|webp)$/i.test(String(storageKey || ""))) {
    throw new Error("数据库包含非法的附件存储键");
  }
}

function readAttachmentRows(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const table = db
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'attachments'"
      )
      .get();
    if (!table) return [];
    return db
      .prepare(
        "SELECT storage_key, sha256, byte_size FROM attachments ORDER BY id"
      )
      .all();
  } finally {
    db.close();
  }
}

function verifyDatabase(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const quickCheck = db.prepare("PRAGMA quick_check").get().quick_check;
    if (quickCheck !== "ok") throw new Error("数据库完整性检查失败");
    const versionRow = db
      .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
      .get();
    return Number(versionRow.version || 0);
  } finally {
    db.close();
  }
}

export function createLearningBackup({
  databasePath,
  attachmentsDir,
  backupRoot,
  now = new Date()
}) {
  if (!fs.existsSync(databasePath)) {
    throw new Error(`数据库不存在：${databasePath}`);
  }
  fs.mkdirSync(backupRoot, { recursive: true });
  const outputDir = path.join(
    backupRoot,
    `learning-backup-${timestampName(now)}-${randomUUID().slice(0, 8)}`
  );
  fs.mkdirSync(outputDir, { recursive: false });
  const databaseTarget = path.join(outputDir, "learning.sqlite");
  const attachmentTarget = path.join(outputDir, "attachments");

  try {
    const db = new DatabaseSync(databasePath);
    try {
      const escaped = databaseTarget.replaceAll("'", "''");
      db.exec(`VACUUM INTO '${escaped}'`);
      const versionRow = db
        .prepare(
          "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations"
        )
        .get();
      var schemaVersion = Number(versionRow.version || 0);
    } finally {
      db.close();
    }
    if (verifyDatabase(databaseTarget) !== schemaVersion) {
      throw new Error("备份数据库版本校验失败");
    }

    const attachmentFiles = [];
    for (const row of readAttachmentRows(databaseTarget)) {
      assertStorageKey(row.storage_key);
      const source = path.join(attachmentsDir, row.storage_key);
      if (!fs.existsSync(source)) {
        throw new Error("数据库中引用的附件文件缺失，已中止备份");
      }
      const target = path.join(attachmentTarget, row.storage_key);
      let byteSize;
      let sha256;
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target);
        byteSize = fs.statSync(target).size;
        sha256 = sha256File(target);
      } catch {
        throw new Error("附件读取或复制失败，已中止备份");
      }
      if (
        sha256 !== row.sha256 ||
        byteSize !== Number(row.byte_size)
      ) {
        throw new Error("附件完整性校验失败，已中止备份");
      }
      attachmentFiles.push({
        path: row.storage_key,
        sha256,
        byteSize
      });
    }

    const manifest = {
      formatVersion: FORMAT_VERSION,
      createdAt: now.toISOString(),
      schemaVersion,
      database: {
        file: "learning.sqlite",
        sha256: sha256File(databaseTarget)
      },
      attachments: attachmentFiles
    };
    const manifestPath = path.join(outputDir, MANIFEST_NAME);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return {
      outputDir,
      manifestPath,
      databasePath: databaseTarget,
      attachmentCount: attachmentFiles.length,
      schemaVersion
    };
  } catch (error) {
    fs.rmSync(outputDir, { recursive: true, force: true });
    throw error;
  }
}

export function restoreLearningBackup({
  backupDir,
  databasePath,
  attachmentsDir,
  force = false
}) {
  const manifestPath = path.join(backupDir, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) {
    throw new Error("备份目录缺少 manifest.json");
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.formatVersion !== FORMAT_VERSION) {
    throw new Error("备份格式版本不受支持");
  }
  if (!manifest.database || typeof manifest.database.file !== "string") {
    throw new Error("备份清单缺少数据库文件");
  }
  if (!Array.isArray(manifest.attachments)) {
    throw new Error("备份清单缺少附件列表");
  }
  assertSafeRelativePath(manifest.database.file);
  const backupDatabasePath = path.join(backupDir, manifest.database.file);
  if (!fs.existsSync(backupDatabasePath)) {
    throw new Error("备份中缺少数据库文件");
  }
  if (sha256File(backupDatabasePath) !== manifest.database.sha256) {
    throw new Error("备份数据库校验失败");
  }
  verifyDatabase(backupDatabasePath);

  const manifestAttachments = new Map();
  for (const item of manifest.attachments) {
    if (!item || typeof item.path !== "string") {
      throw new Error("备份清单包含非法附件记录");
    }
    assertSafeRelativePath(item.path);
    assertStorageKey(item.path);
    if (manifestAttachments.has(item.path)) {
      throw new Error("备份清单包含重复附件");
    }
    const source = path.join(backupDir, "attachments", item.path);
    if (!fs.existsSync(source)) {
      throw new Error("备份中缺少附件文件");
    }
    let sourceHash;
    try {
      sourceHash = sha256File(source);
    } catch {
      throw new Error("附件读取失败");
    }
    if (sourceHash !== item.sha256) {
      throw new Error("附件校验失败");
    }
    manifestAttachments.set(item.path, item);
  }

  for (const row of readAttachmentRows(backupDatabasePath)) {
    assertStorageKey(row.storage_key);
    const item = manifestAttachments.get(row.storage_key);
    if (
      !item ||
      item.sha256 !== row.sha256 ||
      Number(item.byteSize) !== Number(row.byte_size)
    ) {
      throw new Error("备份数据库与附件清单不一致");
    }
  }

  const existingAttachments = listRelativeFiles(attachmentsDir);
  if (!force && (fs.existsSync(databasePath) || existingAttachments.length)) {
    throw new Error("目标数据已存在；确认覆盖时请使用 --force");
  }

  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  fs.mkdirSync(attachmentsDir, { recursive: true });
  const tempDatabase = `${databasePath}.restore-${randomUUID()}.tmp`;
  fs.copyFileSync(backupDatabasePath, tempDatabase);
  try {
    if (verifyDatabase(tempDatabase) !== manifest.schemaVersion) {
      throw new Error("恢复数据库版本校验失败");
    }
    for (const suffix of ["-wal", "-shm"]) {
      fs.rmSync(`${databasePath}${suffix}`, { force: true });
    }
    fs.rmSync(databasePath, { force: true });
    fs.renameSync(tempDatabase, databasePath);
  } finally {
    fs.rmSync(tempDatabase, { force: true });
  }

  fs.rmSync(attachmentsDir, { recursive: true, force: true });
  fs.mkdirSync(attachmentsDir, { recursive: true });
  for (const item of manifest.attachments) {
    const source = path.join(backupDir, "attachments", item.path);
    const target = path.join(attachmentsDir, item.path);
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      if (sha256File(target) !== item.sha256) {
        throw new Error("hash mismatch");
      }
    } catch {
      throw new Error("附件恢复复制失败");
    }
  }

  return {
    databasePath,
    attachmentsDir,
    attachmentCount: manifest.attachments.length,
    schemaVersion: manifest.schemaVersion
  };
}

export function backupConfiguration(environment = process.env, rootDir) {
  const databasePath = path.resolve(
    environment.DB_PATH || path.join(rootDir, "data", "learning.sqlite")
  );
  return {
    databasePath,
    attachmentsDir: path.resolve(
      environment.ATTACHMENTS_DIR ||
        path.join(path.dirname(databasePath), "attachments")
    ),
    backupRoot: path.resolve(
      environment.BACKUP_DIR || path.join(path.dirname(databasePath), "backups")
    )
  };
}
