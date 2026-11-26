import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);

export async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export function waitForServer(child, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let output = "";
    let errors = "";
    const timer = setTimeout(() => {
      reject(new Error(`服务启动超时：${errors || output}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.includes("已启动")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on("data", (chunk) => {
      errors += chunk.toString();
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`服务提前退出（${code}）：${errors || output}`));
    });
  });
}

export async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve();
    }, 3_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function jsonBody(response) {
  return response.json();
}

export async function startServer({
  prefix = "math-coach-http-",
  directory,
  env = {},
  timeoutMs = 10_000
} = {}) {
  const fixtureDirectory =
    directory || fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const databasePath = path.join(fixtureDirectory, "learning.sqlite");
  const attachmentsDirectory = path.join(fixtureDirectory, "attachments");
  const port = await freePort();
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      DB_PATH: databasePath,
      ATTACHMENTS_DIR: attachmentsDirectory,
      ...env
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitForServer(child, timeoutMs);
  } catch (error) {
    await stopServer(child);
    throw error;
  }

  return {
    child,
    directory: fixtureDirectory,
    databasePath,
    attachmentsDirectory,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    logs() {
      return `${stdout}\n${stderr}`;
    }
  };
}