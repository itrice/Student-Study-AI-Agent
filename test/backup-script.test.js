import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createRepository } from "../src/database.js";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

test("备份脚本生成可校验的一致性快照", () => {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "math-coach-backup-")
  );
  const databasePath = path.join(temporaryDirectory, "learning.sqlite");

  try {
    const repository = createRepository(databasePath);
    repository.addDemoData();
    repository.close();

    const output = execFileSync(
      process.execPath,
      ["scripts/backup-database.mjs", databasePath],
      { cwd: projectRoot, encoding: "utf8" }
    );
    assert.match(output, /备份完成/);

    const backupDirectory = path.join(temporaryDirectory, "backups");
    const backupName = fs
      .readdirSync(backupDirectory)
      .find((name) => name.endsWith(".bak"));
    assert.ok(backupName, "应生成 .bak 备份文件");

    const backup = new DatabaseSync(
      path.join(backupDirectory, backupName),
      { readOnly: true }
    );
    try {
      assert.equal(
        backup.prepare("PRAGMA quick_check").get().quick_check,
        "ok"
      );
      assert.equal(
        backup.prepare("SELECT COUNT(*) AS total FROM mistakes").get().total,
        5
      );
    } finally {
      backup.close();
    }
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
