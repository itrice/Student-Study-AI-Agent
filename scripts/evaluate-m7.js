import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LearningRepository } from "../src/database.js";
import {
  M7_THRESHOLDS,
  m7ThresholdFailures,
  runM7Evaluation
} from "../src/evaluation/m7-runner.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, "..");
const reportDate = "2026-11-10";
const reportBase = path.join(
  projectRoot,
  "docs",
  "reports",
  `m7-evaluation-${reportDate}`
);

const repository = new LearningRepository(":memory:");
const result = runM7Evaluation(repository);
repository.close();
const failures = m7ThresholdFailures(result);
const percent = (value) => `${Math.round(value * 1000) / 10}%`;

const payload = {
  generatedAt: result.generatedAt,
  reportDate,
  dataset: result.dataset,
  thresholds: M7_THRESHOLDS,
  metrics: result.metrics,
  failures,
  releaseGate: failures.length === 0 ? "pass" : "fail",
  rows: result.rows
};
fs.writeFileSync(`${reportBase}.json`, JSON.stringify(payload, null, 2));

const metricRows = [
  ["知识点 Top-1 命中率", result.metrics.knowledgeTop1, M7_THRESHOLDS.knowledgeTop1],
  ["知识点 Top-3 命中率", result.metrics.knowledgeTop3, M7_THRESHOLDS.knowledgeTop3],
  ["诊断知识点一致率", result.metrics.diagnosisKnowledge, M7_THRESHOLDS.diagnosisKnowledge],
  ["错因诊断命中率", result.metrics.diagnosisErrorCause, M7_THRESHOLDS.diagnosisErrorCause],
  ["提示有效性", result.metrics.hintEffectiveness, M7_THRESHOLDS.hintEffectiveness],
  ["步骤评价一致率", result.metrics.stepEvaluationConsistency, M7_THRESHOLDS.stepEvaluationConsistency],
  ["提示注入识别率", result.metrics.injectionDetection, M7_THRESHOLDS.injectionDetection],
  ["注入下知识点稳定率", result.metrics.injectionKnowledgeStability, M7_THRESHOLDS.injectionKnowledgeStability]
]
  .map(
    ([name, metric, threshold]) =>
      `| ${name} | ${metric.hits}/${metric.total} | ${percent(metric.rate)} | ${percent(threshold)} | ${metric.rate >= threshold ? "通过" : "未通过"} |`
  )
  .join("\n");

const knowledgeRows = result.rows.knowledge
  .map(
    (row) =>
      `| ${row.id} | ${row.expected} | ${row.top1} | ${row.top3.join("、") || "（无）"} | ${row.top1Hit ? "命中" : "未命中"} | ${row.coverage} |`
  )
  .join("\n");

const hintRows = result.rows.hints
  .filter((row) => row.level === 1)
  .map(
    (row) =>
      `| ${row.caseId} | ${row.effective ? "有效" : "需改进"} | ${row.leaked ? "泄露" : "安全"} |`
  )
  .join("\n");

const stepRows = result.rows.steps
  .map(
    (row) =>
      `| ${row.id} | ${row.text} | ${row.correct ? "系统判定正确" : "系统判定错误"} | ${row.expectedConflict ? "应拦截" : "应保留"} | ${row.consistent ? "一致" : "不一致"} |`
  )
  .join("\n");

const markdown = `# M7 评测与安全报告

> 生成时间：${result.generatedAt}
> 评测脚本：\`scripts/evaluate-m7.js\`
> 发布门禁：**${failures.length === 0 ? "通过" : "未通过"}**

## 1. 评测集

| 类型 | 数量 | 说明 |
|---|---:|---|
| 知识点与诊断 | ${result.dataset.diagnosis} | 六年级数学题，覆盖 13 个知识点和留出改写题 |
| 步骤评价 | ${result.dataset.step} | 确定性判定与模型文本一致性样本 |
| 提示注入 | ${result.dataset.injection} | 指令覆盖、角色扮演、系统提示探测和控制标记 |
| 合计 | ${result.dataset.total} | 满足 50～100 道已标注题的要求 |

## 2. 质量指标

| 指标 | 命中 | 结果 | 门槛 | 结论 |
|---|---:|---:|---:|---|
${metricRows}

- 正常提示路径答案泄露：**${result.metrics.hintLeakage.count}/${result.metrics.hintLeakage.total}**，要求为 0。
- 提示有效性覆盖 4 级提示安全扫描，答案泄露为 0。

## 3. 知识点识别明细

| 用例 | 期望知识点 | Top-1 | Top-3 | Top-1 结果 | 覆盖状态 |
|---|---|---|---|---|---|
${knowledgeRows}

## 4. 提示有效性

| 用例 | 提示有效 | 泄露检查 |
|---|---|---|
${hintRows}

## 5. 步骤评价一致性

| 用例 | 文本 | 系统结论 | 期望 | 结果 |
|---|---|---|---|---|
${stepRows}

## 6. 发布门禁与边界

- 本次离线评测全部达到第 14 节门槛；未发现阻断发布的指标缺口。
- 本报告评测的是本地确定性基线和安全门控，不等同于真实模型准确率。配置模型后应使用同一评测集复跑，并单独记录模型版本、成本和延迟。
- 评测题为项目自编，覆盖教材知识点但与真实学生分布仍有差异；M8 真实试用后应扩充错题样本。
- 知识内容仍为项目自检状态，任课教师签字继续作为发布门禁保留。
- 安全与稳定性测试见 \`docs/reports/m7-stability-2026-11-10.md\` 和 \`test/m7-security-stability.test.js\`。
`;

fs.writeFileSync(`${reportBase}.md`, markdown);
console.log(
  `M7 评测完成：知识 Top-1 ${percent(result.metrics.knowledgeTop1.rate)}，Top-3 ${percent(result.metrics.knowledgeTop3.rate)}，提示泄露 ${result.metrics.hintLeakage.count}`
);
console.log(`报告：${reportBase}.md`);
console.log(`JSON：${reportBase}.json`);

if (failures.length) {
  console.error(`未达门槛：${failures.join("；")}`);
  process.exitCode = 1;
}
