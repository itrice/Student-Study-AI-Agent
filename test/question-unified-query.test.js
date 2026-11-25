import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { LearningRepository } from "../src/database.js";
import { buildOpenApiDocument } from "../src/openapi.js";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

function createQuestion(repository, suffix) {
  return repository.createMistake({
    question: `统一题库测试题 ${suffix}`,
    studentAnswer: "错误答案",
    correctAnswer: "42",
    analysis: "",
    knowledgePoint: "百分数",
    errorType: "不会做"
  });
}

function setQuestionCategories(repository, questionId, categories) {
  repository.db
    .prepare("DELETE FROM question_categories WHERE question_id = ?")
    .run(questionId);
  const insert = repository.db.prepare(
    `INSERT INTO question_categories
     (question_id, category, source, created_at)
     VALUES (?, ?, 'test', ?)`
  );
  for (const category of categories) {
    insert.run(questionId, category, "2026-11-25T20:00:00.000Z");
  }
}

function createUnifiedFixture() {
  const repository = new LearningRepository(":memory:");
  const wrong = createQuestion(repository, "错题");
  const normal = createQuestion(repository, "普通题");
  const legacy = createQuestion(repository, "无分类遗留题");
  setQuestionCategories(repository, normal.id, ["normal"]);
  setQuestionCategories(repository, legacy.id, []);
  return { repository, wrong, normal, legacy };
}

function sortedIds(items) {
  return items.map((item) => item.id).sort((left, right) => left - right);
}

test("Question 查询默认全部并支持错题分类兼容", () => {
  const { repository, wrong, normal, legacy } = createUnifiedFixture();
  try {
    const all = repository.listQuestions();
    assert.equal(all.length, 3);
    assert.deepEqual(sortedIds(all), sortedIds([wrong, normal, legacy]));

    const mistakes = repository.listQuestions({ category: "mistake" });
    assert.deepEqual(sortedIds(mistakes), sortedIds([wrong, legacy]));
    assert.ok(
      mistakes.find((item) => item.id === legacy.id).categories.includes(
        "mistake"
      )
    );

    const normalOnly = repository.listQuestions({ category: "normal" });
    assert.deepEqual(sortedIds(normalOnly), [normal.id]);
    assert.deepEqual(repository.listQuestions({ category: "missing" }), []);

    const compatible = repository.listMistakes();
    assert.deepEqual(sortedIds(compatible), sortedIds(mistakes));
    assert.equal(compatible.find((item) => item.id === wrong.id).id, wrong.id);
    assert.equal(
      Object.hasOwn(
        compatible.find((item) => item.id === wrong.id),
        "categories"
      ),
      false
    );

    const queue = repository.getDueReviewQueue({ at: "2030-01-01T00:00:00.000Z" });
    assert.equal(queue.count, 2);
    assert.deepEqual(
      queue.items.map((item) => item.id).sort((left, right) => left - right),
      [wrong.id, legacy.id].sort((left, right) => left - right)
    );
    assert.equal(
      repository.countDueReviews({ at: "2030-01-01T00:00:00.000Z" }),
      2
    );
    assert.equal(repository.getDashboard().stats.total, 3);
    assert.equal(repository.getDashboard().stats.due, 2);

    assert.equal(
      repository.db
        .prepare("SELECT COUNT(*) AS count FROM mistakes")
        .get().count,
      3
    );
    assert.equal(
      repository.db
        .prepare("SELECT COUNT(*) AS count FROM question_categories")
        .get().count,
      2
    );
  } finally {
    repository.close();
  }
});

function withTemporaryDirectory(callback) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "math-coach-unified-query-")
  );
  let result;
  try {
    result = callback(directory);
    if (result && typeof result.then === "function") {
      return result.finally(() => {
        try {
          fs.rmSync(directory, {
            recursive: true,
            force: true,
            maxRetries: 20,
            retryDelay: 100
          });
        } catch {
          // Windows may release SQLite handles after this process exits.
        }
      });
    }
    return result;
  } finally {
    if (!result || typeof result.then !== "function") {
      try {
        fs.rmSync(directory, {
          recursive: true,
          force: true,
          maxRetries: 20,
          retryDelay: 100
        });
      } catch {
        // Best-effort cleanup for a transient Windows file lock.
      }
    }
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    let errors = "";
    const timer = setTimeout(() => {
      reject(new Error(`服务启动超时：${errors || output}`));
    }, 10_000);
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

async function stopServer(child) {
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

test("统一题库 HTTP 查询与旧错题接口返回同一份题目", async () => {
  await withTemporaryDirectory(async (directory) => {
    const databasePath = path.join(directory, "learning.sqlite");
    const setup = new LearningRepository(databasePath);
    const wrong = createQuestion(setup, "HTTP 错题");
    const normal = createQuestion(setup, "HTTP 普通题");
    const legacy = createQuestion(setup, "HTTP 遗留题");
    setQuestionCategories(setup, normal.id, ["normal"]);
    setQuestionCategories(setup, legacy.id, []);
    setup.close();

    const port = await freePort();
    const child = spawn(process.execPath, ["src/server.js"], {
      cwd: projectRoot,
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(port),
        DB_PATH: databasePath,
        ATTACHMENTS_DIR: path.join(directory, "attachments"),
        OCR_BASE_URL: ""
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    try {
      await waitForServer(child);
      const baseUrl = `http://127.0.0.1:${port}`;
      const all = await fetch(`${baseUrl}/api/questions`).then((response) =>
        response.json()
      );
      assert.equal(all.total, 3);
      assert.deepEqual(sortedIds(all.questions), sortedIds([wrong, normal, legacy]));

      const mistakes = await fetch(
        `${baseUrl}/api/questions?category=mistake`
      ).then((response) => response.json());
      assert.equal(mistakes.total, 2);
      assert.deepEqual(sortedIds(mistakes.questions), sortedIds([wrong, legacy]));

      const normalOnly = await fetch(
        `${baseUrl}/api/questions?category=normal`
      ).then((response) => response.json());
      assert.equal(normalOnly.total, 1);
      assert.deepEqual(sortedIds(normalOnly.questions), [normal.id]);

      const compatible = await fetch(`${baseUrl}/api/mistakes`).then(
        (response) => response.json()
      );
      assert.ok(Array.isArray(compatible));
      assert.deepEqual(sortedIds(compatible), sortedIds(mistakes.questions));
      const same = compatible.find((item) => item.id === wrong.id);
      assert.equal(same.id, wrong.id);
      assert.equal(same.question, wrong.question);
      assert.equal(Object.hasOwn(same, "categories"), false);

      const queue = await fetch(
        `${baseUrl}/api/review/queue?limit=20`
      ).then((response) => response.json());
      assert.equal(queue.count, 2);
      assert.deepEqual(
        queue.items.map((item) => item.id).sort((left, right) => left - right),
        [wrong.id, legacy.id].sort((left, right) => left - right)
      );
      const next = await fetch(`${baseUrl}/api/review/next`).then((response) =>
        response.json()
      );
      assert.ok([wrong.id, legacy.id].includes(next.id));
    } finally {
      await stopServer(child);
    }

    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM mistakes").get().count,
        3
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM question_categories").get()
          .count,
        2
      );
      assert.equal(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'questions'"
          )
          .get(),
        undefined
      );
    } finally {
      db.close();
    }
  });
});

test("OpenAPI 和题库页面公开全部题目与错题快捷筛选", () => {
  const app = fs.readFileSync(
    new URL("../public/app.js", import.meta.url),
    "utf8"
  );
  const html = fs.readFileSync(
    new URL("../public/index.html", import.meta.url),
    "utf8"
  );
  const document = buildOpenApiDocument();
  const questionList = document.paths["/api/questions"].get;
  const category = questionList.parameters.find(
    (parameter) => parameter.name === "category"
  );
  assert.ok(category);
  assert.equal(category.schema.default, "all");
  assert.match(questionList.description, /默认.*全部/);
  assert.match(
    document.paths["/api/mistakes"].get.description,
    /兼容|category=mistake/
  );

  assert.match(html, /data-view="mistakes"[\s\S]*<span>题库<\/span>/);
  assert.match(html, /<h1>题库<\/h1>/);
  assert.ok(
    html.indexOf('data-question-category="all"') <
      html.indexOf('data-question-category="mistake"')
  );
  assert.match(app, /state\.questionCategory = category === "mistake"/);
  assert.match(app, /\?category=mistake/);
  assert.match(app, /api\(`\/api\/questions\$\{query\}`\)/);
  assert.match(app, /state\.mistakes = result\.questions \|\| \[\]/);
});
