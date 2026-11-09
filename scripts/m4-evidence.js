import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRepository } from "../src/database.js";
import { loadEnvFile } from "../src/environment.js";
import {
  createGatewayFromEnvironment,
  createTutoringAgent
} from "../src/llm/index.js";
import { createLearningTools } from "../src/tools/index.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const evidencePath = path.join(
  projectRoot,
  "docs",
  "reports",
  "m4-evidence.sqlite"
);

loadEnvFile(path.join(projectRoot, ".env"));

try {
  await fs.access(evidencePath);
  throw new Error(
    `M4 证据库已存在，拒绝覆盖：${evidencePath}。如确需重建，请先人工核对并移走旧证据库。`
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const repository = createRepository(evidencePath);
const tools = createLearningTools(repository);
const gateway = createGatewayFromEnvironment(process.env);
if (!gateway.isConfigured()) {
  repository.close();
  throw new Error(
    "LLM 未配置，无法生成真实模型 M4 证据。请确认 .env 中的 LLM_* 配置。"
  );
}

const agent = createTutoringAgent({ repository, tools, gateway });

try {
  const mistake = repository.createMistake({
    question:
      "一项工程，甲队的工作效率是 1/5，乙队的工作效率是 1/6，甲队和乙队的工作效率比是（），时间比是（）。",
    studentAnswer: "5:6；6:5",
    knowledgePoint: "比和比例",
    errorType: "前后项顺序写反",
    analysis: "需要先分别求时间，再按题目要求的甲队与乙队顺序写比。",
    parts: [
      {
        label: "工作效率比",
        prompt: "甲队和乙队的工作效率比",
        answerType: "ratio",
        comparisonRule: "ratio",
        acceptedAnswers: ["6:5"]
      },
      {
        label: "时间比",
        prompt: "甲队和乙队完成整项工程所需时间的比",
        answerType: "ratio",
        comparisonRule: "ratio",
        acceptedAnswers: ["5:6"]
      }
    ]
  });

  const hints = [];
  for (let level = 1; level <= 4; level += 1) {
    hints.push(
      await agent.getHint({
        mistakeId: mistake.id,
        level,
        idempotencyKey: `m4-evidence-hint-${level}`
      })
    );
  }

  const followUp = await agent.followUp({
    mistakeId: mistake.id,
    question: "为什么效率比和时间比的前后项顺序相反？",
    idempotencyKey: "m4-evidence-follow-up"
  });

  const attempt = await agent.submitAttempt({
    mistakeId: mistake.id,
    answers: [
      { partId: mistake.parts[0].id, value: "5:6" },
      { partId: mistake.parts[1].id, value: "6:5" }
    ],
    independent: true,
    hintLevel: 0
  });

  const hintRows = repository.db
    .prepare(
      `SELECT id, mistake_id, attempt_id, hint_level, source, part_id,
              created_at
       FROM hint_events
       WHERE mistake_id = ?
       ORDER BY id`
    )
    .all(mistake.id);
  const attemptRow = repository.db
    .prepare(
      `SELECT id, mistake_id, outcome, hint_level, independent,
              evaluation_source, agent_run_id, created_at
       FROM attempts
       WHERE id = ?`
    )
    .get(attempt.attemptId);
  const evaluationRow = repository.getLatestAttemptEvaluation(mistake.id);
  const llmCalls = repository.db
    .prepare(
      `SELECT id, run_id, provider, model, prompt_version, status,
              input_tokens, output_tokens, latency_ms, created_at
       FROM llm_calls
       ORDER BY id`
    )
    .all();

  console.log(
    JSON.stringify(
      {
        databasePath: evidencePath,
        syntheticData: true,
        mistakeId: mistake.id,
        hintEventIds: hintRows.map((row) => row.id),
        hintRows,
        followUp: {
          source: followUp.source,
          provider: followUp.provider,
          model: followUp.model,
          promptVersion: followUp.promptVersion
        },
        attemptRow,
        attemptEvaluationId: evaluationRow.id,
        evaluationRow,
        llmCalls
      },
      null,
      2
    )
  );
} finally {
  repository.close();
}
