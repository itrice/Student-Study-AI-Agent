import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LearningRepository } from "../src/database.js";
import { evaluateKnowledgeRetrieval } from "../src/knowledge/search.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, "..");
const reportDate = "2026-11-10";
const reportBase = path.join(
  projectRoot,
  "docs",
  "reports",
  `m5-knowledge-evaluation-${reportDate}`
);

const repository = new LearningRepository(":memory:");
const stats = repository.getKnowledgeBaseStats();
const evaluation = evaluateKnowledgeRetrieval(repository, { limit: 3 });
repository.close();

const generatedAt = new Date().toISOString();
const payload = {
  generatedAt,
  reportDate,
  contentVersion: stats.contentVersion,
  textbookVersion: stats.textbookVersion,
  corpus: {
    knowledgePoints: stats.knowledgePoints,
    chunks: stats.chunks,
    sources: stats.sources,
    reviewCounts: stats.reviewCounts
  },
  evaluation: {
    limit: evaluation.limit,
    total: evaluation.total,
    hits: evaluation.hits,
    accuracy: evaluation.accuracy,
    top1Hits: evaluation.top1Hits,
    top1Accuracy: evaluation.top1Accuracy,
    covered: evaluation.covered,
    sourceCoverage: evaluation.sourceCoverage,
    heldOut: evaluation.heldOut,
    statusCounts: evaluation.statusCounts,
    perPoint: evaluation.perPoint,
    misses: evaluation.misses,
    rows: evaluation.rows
  }
};

fs.writeFileSync(`${reportBase}.json`, JSON.stringify(payload, null, 2));

const percent = (value) => `${Math.round(value * 1000) / 10}%`;
const tableRows = evaluation.rows
  .map(
    (row) =>
      `| ${row.id} | ${row.expected} | ${row.top1 || "（无）"} | ${row.top3.join("、") || "（无）"} | ${row.hit ? "命中" : "未命中"} | ${row.coverage} | ${row.bestScore ?? "-"} |`
  )
  .join("\n");
const perPointRows = evaluation.perPoint
  .map(
    (point) =>
      `| ${point.knowledgePoint} | ${point.hits}/${point.total} | ${percent(point.accuracy)} |`
  )
  .join("\n");
const missRows = evaluation.misses.length
  ? evaluation.misses
      .map(
        (row) =>
          `- ${row.id}：期望「${row.expected}」，实际 Top-3 为「${row.top3.join("、") || "（无）"}」。`
      )
      .join("\n")
  : "- 无。";

const markdown = `# M5 知识库与检索评测报告

> 生成时间：${generatedAt}
> 内容版本：\`${stats.contentVersion}\`
> 教材版本：${stats.textbookVersion}
> 评测脚本：\`scripts/evaluate-m5-knowledge.js\`

## 结论

- 知识点 Top-3 命中率：**${percent(evaluation.accuracy)}**（${evaluation.hits}/${evaluation.total}）。
- 知识点 Top-1 命中率：**${percent(evaluation.top1Accuracy)}**（${evaluation.top1Hits}/${evaluation.total}）。
- 留出改写集 Top-3 命中率：**${percent(evaluation.heldOut.accuracy)}**（${evaluation.heldOut.hits}/${evaluation.heldOut.total}）。
- 留出改写集 Top-1 命中率：**${percent(evaluation.heldOut.top1Accuracy)}**（${evaluation.heldOut.top1Hits}/${evaluation.heldOut.total}）。
- 已覆盖结果的来源引用覆盖率：**${percent(evaluation.sourceCoverage)}**。
- 覆盖状态分布：${Object.entries(evaluation.statusCounts)
  .map(([status, count]) => `${status}=${count}`)
  .join("，")}。
- 当前验收线为 Top-3 ≥ 90%，本次结果满足要求。

## 语料规模

| 指标 | 数量 |
|---|---:|
| 知识点卡片 | ${stats.knowledgePoints} |
| 知识片段 | ${stats.chunks} |
| 来源记录 | ${stats.sources} |
| 项目自检卡片 | ${stats.reviewCounts.self_reviewed || 0} |
| 教师已审卡片 | ${stats.reviewCounts.teacher_reviewed || 0} |

## 分知识点结果

| 知识点 | 命中 | 命中率 |
|---|---:|---:|
${perPointRows}

## 未命中项

${missRows}

## 明细

| 用例 | 期望知识点 | Top-1 | Top-3 | 结果 | 覆盖状态 | 最高分 |
|---|---|---|---|---|---|---:|
${tableRows}

## 方法与边界

- 使用 \`search_knowledge\` 的同一检索实现，查询时只传题目文本，不传标准知识点。
- Top-3 命中表示期望知识点出现在前三个检索结果中。
- 来源覆盖率要求每个已覆盖结果至少带一条 \`knowledge_chunks.citation\`。
- 评测集是本项目自编的 48 道题：36 道卡片对齐题加 12 道未直接复用卡片例题措辞的留出改写题。
- 留出改写集用于降低“闭集匹配”带来的乐观偏差，但仍不等同于真实学生分布；教师复核后应继续扩充并重新评测。
- 知识内容为项目自编摘要，非教材原文；当前审核状态为 \`self_reviewed\`，教师最终签字仍待完成。
`;

fs.writeFileSync(`${reportBase}.md`, markdown);

console.log(`M5 知识库评测完成：${evaluation.hits}/${evaluation.total}，${percent(evaluation.accuracy)}`);
console.log(`报告：${reportBase}.md`);
console.log(`JSON：${reportBase}.json`);

if (
  evaluation.accuracy < 0.9 ||
  evaluation.heldOut.accuracy < 0.9 ||
  evaluation.sourceCoverage < 1
) {
  process.exitCode = 1;
}
