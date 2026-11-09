import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const port = 3127;
const baseUrl = `http://127.0.0.1:${port}`;
const databasePath = path.join(
  projectRoot,
  "docs",
  "reports",
  "m4-evidence.sqlite"
);
const tempRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), "learning-agent-m4-api-")
);
const resolvedTempRoot = path.resolve(os.tmpdir());
if (
  !tempRoot.startsWith(`${resolvedTempRoot}${path.sep}`) ||
  !tempRoot.includes("learning-agent-m4-api-")
) {
  throw new Error(`拒绝使用意外的临时目录：${tempRoot}`);
}
const verificationDatabase = path.join(tempRoot, "m4-evidence-copy.sqlite");
const originalHashBefore = createHash("sha256")
  .update(await fs.readFile(databasePath))
  .digest("hex");
await fs.copyFile(databasePath, verificationDatabase);

const child = spawn(process.execPath, ["src/server.js"], {
  cwd: projectRoot,
  env: {
    ...process.env,
    DB_PATH: verificationDatabase,
    PORT: String(port),
    HOST: "127.0.0.1"
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});
let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
  stdout += chunk;
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`M4 API 服务提前退出：${stderr || stdout}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        signal: AbortSignal.timeout(1000)
      });
      if (response.ok) return response.json();
    } catch {
      // 服务仍在启动。
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`M4 API 服务启动超时：${stderr || stdout}`);
}

function findForbiddenProperties(value, forbiddenNames) {
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) =>
      findForbiddenProperties(item, forbiddenNames)
    );
  }
  const found = [];
  for (const [key, childValue] of Object.entries(value)) {
    if (forbiddenNames.includes(key)) found.push(key);
    found.push(...findForbiddenProperties(childValue, forbiddenNames));
  }
  return found;
}

async function requestJson(
  pathname,
  { method = "GET", body, headers = {}, expectedStatus = 200 } = {}
) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000)
  });
  const value = await response.json();
  if (response.status !== expectedStatus) {
    throw new Error(
      `${pathname} 预期 HTTP ${expectedStatus}，实际 ${response.status}：${JSON.stringify(value)}`
    );
  }
  return value;
}

try {
  const health = await waitForServer();
  const review = await requestJson("/api/review/1");
  const detail = await requestJson("/api/mistakes/1");
  const list = await requestJson("/api/mistakes");
  const forbidden = ["correctAnswer", "analysis", "acceptedAnswers"];
  const reviewLeaks = findForbiddenProperties(review, forbidden);
  const detailLeaks = findForbiddenProperties(detail, forbidden);
  const listLeaks = findForbiddenProperties(list, forbidden);
  if (reviewLeaks.length || detailLeaks.length || listLeaks.length) {
    throw new Error(
      `安全接口发生答案泄露：${JSON.stringify({
        reviewLeaks,
        detailLeaks,
        listLeaks
      })}`
    );
  }

  const unauthorizedEditError = await requestJson(
    "/api/mistakes/1/edit",
    { expectedStatus: 403 }
  );
  const historicalReviewStageError = await requestJson(
    "/api/mistakes/1/edit-session",
    {
      method: "POST",
      expectedStatus: 409,
      body: {
        confirmed: true,
        context: "review",
        reviewSessionId: review.reviewSessionId
      }
    }
  );
  const created = await requestJson("/api/mistakes", {
    method: "POST",
    expectedStatus: 201,
    body: {
      question: "用于验证编辑门控的临时题目",
      studentAnswer: "",
      correctAnswer: "2",
      parts: [
        {
          label: "答案",
          answerType: "auto",
          comparisonRule: "auto",
          acceptedAnswers: ["2"]
        }
      ]
    }
  });
  const createdReview = await requestJson(`/api/review/${created.id}`);
  const reviewStageError = await requestJson(
    `/api/mistakes/${created.id}/edit-session`,
    {
      method: "POST",
      expectedStatus: 409,
      body: {
        confirmed: true,
        context: "review",
        reviewSessionId: createdReview.reviewSessionId
      }
    }
  );
  const librarySession = await requestJson(
    `/api/mistakes/${created.id}/edit-session`,
    {
      method: "POST",
      body: { confirmed: true, context: "mistake-library" }
    }
  );
  const edit = await requestJson(`/api/mistakes/${created.id}/edit`, {
    headers: { "X-Edit-Session": librarySession.token }
  });
  if (
    edit.correctAnswer !== "2" ||
    edit.parts?.[0]?.acceptedAnswers?.[0] !== "2"
  ) {
    throw new Error("授权后的编辑接口没有返回答案数据");
  }
  await requestJson(`/api/mistakes/${created.id}/edit`, {
    headers: { "X-Edit-Session": librarySession.token },
    expectedStatus: 403
  });

  const originalHashAfter = createHash("sha256")
    .update(await fs.readFile(databasePath))
    .digest("hex");
  if (originalHashBefore !== originalHashAfter) {
    throw new Error(
      `验证过程修改了证据库：${originalHashBefore} -> ${originalHashAfter}`
    );
  }
  console.log(
    JSON.stringify(
      {
        baseUrl,
        databasePath,
        verificationDatabase,
        originalHashBefore,
        originalHashAfter,
        originalHashUnchanged: true,
        healthSchemaVersion: health.schemaVersion,
        reviewMistakeId: review.id,
        reviewLeakFields: reviewLeaks,
        detailLeakFields: detailLeaks,
        listLeakFields: listLeaks,
        editWithoutSession: {
          status: 403,
          error: unauthorizedEditError.error
        },
        reviewBeforeAttemptEdit: {
          status: 409,
          error: reviewStageError.error
        },
        historicalAttemptDoesNotUnlockCurrentReview: {
          status: 409,
          error: historicalReviewStageError.error
        },
        authorizedEditHasCorrectAnswer: true,
        editSessionIsSingleUse: true
      },
      null,
      2
    )
  );
} finally {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 3000))
    ]);
  }
  if (child.exitCode === null) child.kill("SIGKILL");
  await fs.rm(tempRoot, { recursive: true, force: true });
}
