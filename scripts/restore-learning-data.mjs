import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadEnvFile } from "../src/environment.js";
import {
  backupConfiguration,
  restoreLearningBackup
} from "./learning-backup.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function runRestore(backupDir, { environment = process.env, force = false } = {}) {
  loadEnvFile(path.join(rootDir, ".env"));
  const config = backupConfiguration(environment, rootDir);
  return restoreLearningBackup({
    backupDir,
    databasePath: config.databasePath,
    attachmentsDir: config.attachmentsDir,
    force
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  const force = process.argv.includes("--force");
  if (!args[0]) {
    console.error("用法：node scripts/restore-learning-data.mjs <备份目录> [--force]");
    process.exit(1);
  }
  try {
    const result = runRestore(path.resolve(args[0]), { force });
    console.log(`恢复完成：${result.databasePath}`);
    console.log(`附件数量：${result.attachmentCount}，数据库版本：${result.schemaVersion}`);
  } catch (error) {
    console.error(`恢复失败：${error.message}`);
    process.exitCode = 1;
  }
}
