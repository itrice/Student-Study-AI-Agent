// Standalone real-model self-check runner. Not part of node --test discovery.
import fs from "node:fs";
import path from "node:path";

const baseUrl = process.env.SELF_TEST_BASE_URL || "http://127.0.0.1:3000";
const outputDir = path.resolve("docs", "reports");
const startedAt = new Date();

const cases = [
  {
    id: "P01",
    question: "一件商品原价240元，先涨价20%，再降价20%，现价是多少元？",
    studentAnswer: "240元",
    correctAnswer: "230.4元",
    expected: ["百分数"]
  },
  {
    id: "P02",
    question: "一本书原价80元，打七五折出售，售价是多少元？",
    studentAnswer: "60元",
    correctAnswer: "60元",
    expected: ["百分数"]
  },
  {
    id: "P03",
    question: "一个数增加25%后是50，这个数原来是多少？",
    studentAnswer: "62.5",
    correctAnswer: "40",
    expected: ["百分数"]
  },
  {
    id: "F01",
    question: "计算 3/4 × 8/9。",
    studentAnswer: "24/36",
    correctAnswer: "2/3",
    expected: ["分数乘除法"]
  },
  {
    id: "F02",
    question: "计算 2/5 ÷ 4。",
    studentAnswer: "8/5",
    correctAnswer: "1/10",
    expected: ["分数乘除法"]
  },
  {
    id: "R01",
    question: "把比18:24化成最简整数比。",
    studentAnswer: "18:24",
    correctAnswer: "3:4",
    expected: ["比和比例"]
  },
  {
    id: "R02",
    question: "把240按3:5分成甲乙两部分，甲乙各是多少？",
    parts: [
      {
        label: "甲部分",
        studentAnswer: "120",
        answerType: "number",
        acceptedAnswers: ["90"]
      },
      {
        label: "乙部分",
        studentAnswer: "120",
        answerType: "number",
        acceptedAnswers: ["150"]
      }
    ],
    expected: ["比和比例"]
  },
  {
    id: "R03",
    question: "一幅地图的比例尺是1:500000，图上3厘米表示实际距离多少千米？",
    studentAnswer: "15千米",
    correctAnswer: "15千米",
    expected: ["比和比例", "比例与图形"]
  },
  {
    id: "C01",
    question: "圆的半径是4厘米，π取3.14，圆的周长是多少厘米？",
    studentAnswer: "12.56厘米",
    correctAnswer: "25.12厘米",
    expected: ["圆"]
  },
  {
    id: "C02",
    question: "圆的直径是10米，π取3.14，圆的面积是多少平方米？",
    studentAnswer: "31.4平方米",
    correctAnswer: "78.5平方米",
    expected: ["圆"]
  },
  {
    id: "C03",
    question: "环形内半径2厘米、外半径3厘米，π取3.14，环形面积是多少平方厘米？",
    studentAnswer: "15.7平方厘米",
    correctAnswer: "15.7平方厘米",
    expected: ["圆"]
  },
  {
    id: "V01",
    question: "圆柱底面半径2厘米、高5厘米，π取3.14，体积是多少立方厘米？",
    studentAnswer: "31.4立方厘米",
    correctAnswer: "62.8立方厘米",
    expected: ["圆柱与圆锥"]
  },
  {
    id: "V02",
    question: "圆锥底面半径3厘米、高6厘米，π取3.14，体积是多少立方厘米？",
    studentAnswer: "169.56立方厘米",
    correctAnswer: "56.52立方厘米",
    expected: ["圆柱与圆锥"]
  },
  {
    id: "N01",
    question: "气温为零下5摄氏度，用正负数表示应写作什么？",
    studentAnswer: "5摄氏度",
    correctAnswer: "-5摄氏度",
    expected: ["负数"]
  },
  {
    id: "N02",
    question: "比较-3和2的大小，较大的数是多少？",
    studentAnswer: "-3",
    correctAnswer: "2",
    expected: ["负数"]
  },
  {
    id: "S01",
    question: "小明四次数学成绩是80、85、90、93，平均分是多少？",
    studentAnswer: "85",
    correctAnswer: "87",
    expected: ["统计与扇形统计图"]
  },
  {
    id: "S02",
    question: "扇形统计图中某部分占30%，总数是200，该部分数量是多少？",
    studentAnswer: "30",
    correctAnswer: "60",
    expected: ["统计与扇形统计图", "百分数"]
  },
  {
    id: "S03",
    question: "袋中有3个红球、2个蓝球，随机摸出一个球，摸到红球的可能性是多少？",
    studentAnswer: "1/2",
    correctAnswer: "3/5",
    expected: ["统计与扇形统计图", "综合应用"]
  },
  {
    id: "T01",
    question: "点A在数对(2,3)处，向右平移4格后，新位置的数对是什么？",
    studentAnswer: "(6,7)",
    correctAnswer: "(6,3)",
    expected: ["比例与图形"]
  },
  {
    id: "T02",
    question: "一个图形按2:1放大，原图一条边4厘米，放大后对应边是多少厘米？",
    studentAnswer: "2厘米",
    correctAnswer: "8厘米",
    expected: ["比例与图形"]
  },
  {
    id: "R04",
    question: "甲数和乙数的比是2:3，乙数是18，甲数是多少？",
    studentAnswer: "27",
    correctAnswer: "12",
    expected: ["比和比例"]
  },
  {
    id: "P04",
    question: "一件商品涨价20%后售价是240元，原价是多少元？",
    studentAnswer: "288元",
    correctAnswer: "200元",
    expected: ["百分数"]
  },
  {
    id: "F03",
    question: "计算 5/6 ÷ 10/3。",
    studentAnswer: "5/6",
    correctAnswer: "1/4",
    expected: ["分数乘除法"]
  },
  {
    id: "F04",
    question: "计算 12 ÷ 3/4。",
    studentAnswer: "9",
    correctAnswer: "16",
    expected: ["分数乘除法"]
  },
  {
    id: "P05",
    question: "200克盐水中含盐率为15%，其中盐有多少克？",
    studentAnswer: "15克",
    correctAnswer: "30克",
    expected: ["百分数"]
  },
  {
    id: "T03",
    question: "一个长方形长8厘米、宽5厘米，按1:2缩小后，面积是多少平方厘米？",
    studentAnswer: "20平方厘米",
    correctAnswer: "10平方厘米",
    expected: ["比例与图形"]
  },
  {
    id: "V03",
    question: "一个圆柱和一个圆锥等底等高，它们体积的比是多少？",
    studentAnswer: "1:1",
    correctAnswer: "3:1",
    expected: ["圆柱与圆锥", "比和比例"]
  },
  {
    id: "N03",
    question: "数轴上位于原点左侧且距离原点3个单位长度的数是什么？",
    studentAnswer: "3",
    correctAnswer: "-3",
    expected: ["负数"]
  },
  {
    id: "P06",
    question: "一个数的60%是48，这个数是多少？",
    studentAnswer: "28.8",
    correctAnswer: "80",
    expected: ["百分数"]
  },
  {
    id: "R05",
    question: "一项工程甲单独完成需要10天，乙单独完成需要15天，求甲与乙的工作效率比和时间比。",
    parts: [
      {
        label: "工作效率比",
        studentAnswer: "3:2",
        answerType: "ratio",
        comparisonRule: "ratio",
        acceptedAnswers: ["2:3"]
      },
      {
        label: "时间比",
        studentAnswer: "2:3",
        answerType: "ratio",
        comparisonRule: "ratio",
        acceptedAnswers: ["3:2"]
      }
    ],
    expected: ["比和比例", "分数乘除法"]
  }
];

async function runCase(item) {
  const started = performance.now();
  try {
    const response = await fetch(`${baseUrl}/api/diagnose`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: item.question,
        studentAnswer: item.studentAnswer || "",
        correctAnswer: item.correctAnswer || "",
        parts: item.parts || []
      }),
      signal: AbortSignal.timeout(90_000)
    });
    const result = await response.json();
    const failures = [];
    if (!response.ok) failures.push(`HTTP ${response.status}`);
    if (result.error) failures.push(result.error);
    if (result.source !== "llm") failures.push(`source=${result.source}`);
    if (!item.expected.includes(result.knowledgePoint)) {
      failures.push(`知识点=${result.knowledgePoint}`);
    }
    if (!(result.confidence >= 0 && result.confidence <= 1)) {
      failures.push("confidence 无效");
    }
    if (!Array.isArray(result.evidence) || !result.evidence.length) {
      failures.push("缺少 evidence");
    }
    if (!Array.isArray(result.knowledgeSources)) {
      failures.push("缺少 knowledgeSources");
    }
    if (item.parts?.length) {
      if ((result.partAnalyses || []).length !== item.parts.length) {
        failures.push("分问分析数量不匹配");
      }
      const partNos = new Set(
        (result.partAnalyses || []).map((part) => part.partNo)
      );
      if (partNos.size !== item.parts.length) {
        failures.push("分问 partNo 不完整或重复");
      }
    }
    if (!result.contextHash) failures.push("缺少 contextHash");
    return {
      id: item.id,
      pass: failures.length === 0,
      failures,
      latencyMs: Math.round(performance.now() - started),
      source: result.source,
      knowledgePoint: result.knowledgePoint,
      errorType: result.errorType,
      confidence: result.confidence,
      evidenceCount: result.evidence?.length || 0,
      sourceCount: result.knowledgeSources?.length || 0,
      partAnalysisCount: result.partAnalyses?.length || 0,
      agentRunId: result.agentRunId || null,
      fallbackReason: result.fallbackReason || null
    };
  } catch (error) {
    return {
      id: item.id,
      pass: false,
      failures: [error.message],
      latencyMs: Math.round(performance.now() - started),
      source: "error"
    };
  }
}

const results = [];
for (const item of cases) {
  const result = await runCase(item);
  results.push(result);
  console.log(
    `${result.pass ? "PASS" : "FAIL"} ${item.id} ${result.source} ${result.latencyMs}ms${
      result.failures?.length ? ` ${result.failures.join("; ")}` : ""
    }`
  );
  await new Promise((resolve) => setTimeout(resolve, 600));
}

const finishedAt = new Date();
const passed = results.filter((result) => result.pass).length;
const summary = {
  startedAt: startedAt.toISOString(),
  finishedAt: finishedAt.toISOString(),
  baseUrl,
  total: results.length,
  passed,
  failed: results.length - passed,
  passRate: Number(((passed / results.length) * 100).toFixed(1)),
  averageLatencyMs: Math.round(
    results.reduce((sum, result) => sum + result.latencyMs, 0) / results.length
  ),
  results
};

fs.mkdirSync(outputDir, { recursive: true });
const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
const jsonPath = path.join(outputDir, `llm-self-test-${stamp}.json`);
const markdownPath = path.join(outputDir, `llm-self-test-${stamp}.md`);
fs.writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`);

const markdown = [
  "# LLM 自我测试报告",
  "",
  `- 开始时间：${summary.startedAt}`,
  `- 结束时间：${summary.finishedAt}`,
  `- 题目数量：${summary.total}`,
  `- 通过：${summary.passed}`,
  `- 失败：${summary.failed}`,
  `- 通过率：${summary.passRate}%`,
  `- 平均耗时：${summary.averageLatencyMs}ms`,
  "",
  "| 编号 | 结果 | 来源 | 知识点 | 置信度 | 分问数 | 耗时 | 失败原因 |",
  "|---|---|---|---|---|---|---|---|",
  ...results.map(
    (result) =>
      `| ${result.id} | ${result.pass ? "通过" : "失败"} | ${result.source || ""} | ${
        result.knowledgePoint || ""
      } | ${result.confidence ?? ""} | ${result.partAnalysisCount ?? ""} | ${
        result.latencyMs
      }ms | ${(result.failures || []).join("；")} |`
  ),
  ""
].join("\n");
fs.writeFileSync(markdownPath, markdown);

console.log(`REPORT_JSON=${jsonPath}`);
console.log(`REPORT_MARKDOWN=${markdownPath}`);
console.log(
  `SUMMARY passed=${summary.passed}/${summary.total} passRate=${summary.passRate}% avg=${summary.averageLatencyMs}ms`
);
process.exitCode = summary.failed === 0 ? 0 : 1;
