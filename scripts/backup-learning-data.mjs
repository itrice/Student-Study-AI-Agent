import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadEnvFile } from "../src/environment.js";
import {
  backupConfiguration,
  createLearningBackup
} from "./learning-backup.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function runBackup(environment = process.env) {
  loadEnvFile(path.join(rootDir, ".env"));
  const config = backupConfiguration(environment, rootDir);
  return createLearningBackup(config);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = runBackup(process.env);
    console.log(`备份完成：${result.outputDir}`);
    console.log(`附件数量：${result.attachmentCount}，数据库版本：${result.schemaVersion}`);
  } catch (error) {
    console.error(`备份失败：${error.message}`);
    process.exitCode = 1;
  }
}
