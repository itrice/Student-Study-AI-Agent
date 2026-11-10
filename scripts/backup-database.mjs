import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "../src/environment.js";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
loadEnvFile(path.join(projectRoot, ".env"));

const databasePath =
  process.argv[2] ||
  process.env.DB_PATH ||
  path.join(process.cwd(), "data", "learning.sqlite");

if (!fs.existsSync(databasePath)) {
  console.error(`数据库不存在：${databasePath}`);
  process.exit(1);
}

const backupDirectory = path.join(path.dirname(databasePath), "backups");
fs.mkdirSync(backupDirectory, { recursive: true });

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = path.join(
  backupDirectory,
  `${path.basename(databasePath)}.manual-${timestamp}.bak`
);

const db = new DatabaseSync(databasePath);
try {
  db.exec("PRAGMA busy_timeout = 10000;");
  db.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
} finally {
  db.close();
}

const verification = new DatabaseSync(backupPath, { readOnly: true });
try {
  const result = verification.prepare("PRAGMA quick_check").get();
  if (result.quick_check !== "ok") {
    throw new Error("备份完整性检查失败");
  }
} finally {
  verification.close();
}

console.log(`备份完成：${backupPath}`);
