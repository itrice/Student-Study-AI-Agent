import test from "node:test";
import assert from "node:assert/strict";

import {
  filterMistakes,
  mistakeMatchesQuery,
  normalizeSearchTerms
} from "../public/mistake-search.js";

const mistakes = [
  {
    id: 1,
    question: "一个圆形花坛的半径是 4 米，面积是多少？",
    knowledgePoint: "圆",
    errorType: "半径变化漏算",
    status: "new",
    parts: [{ label: "第一问", prompt: "先求半径" }]
  },
  {
    id: 2,
    question: "把 3/4 升果汁平均倒入 3 个杯子，每杯多少升？",
    knowledgePoint: "分数乘除法",
    errorType: "计算错误",
    status: "practicing",
    parts: []
  },
  {
    id: 3,
    question: "Circle area practice",
    knowledgePoint: "圆",
    errorType: "单位没有统一",
    status: "mastered",
    parts: []
  }
];

test("搜索词按空白拆分、去空格并忽略大小写", () => {
  assert.deepEqual(normalizeSearchTerms("  圆   面积 "), ["圆", "面积"]);
  assert.deepEqual(normalizeSearchTerms("Circle AREA"), ["circle", "area"]);
  assert.deepEqual(normalizeSearchTerms("   "), []);
});

test("可以按题目、知识点、错因和小问搜索", () => {
  assert.deepEqual(
    filterMistakes(mistakes, { query: "花坛" }).map((item) => item.id),
    [1]
  );
  assert.deepEqual(
    filterMistakes(mistakes, { query: "分数乘除" }).map((item) => item.id),
    [2]
  );
  assert.deepEqual(
    filterMistakes(mistakes, { query: "半径变化" }).map((item) => item.id),
    [1]
  );
  assert.deepEqual(
    filterMistakes(mistakes, { query: "先求半径" }).map((item) => item.id),
    [1]
  );
});

test("多个搜索词需要同时命中", () => {
  assert.deepEqual(
    filterMistakes(mistakes, { query: "圆 面积" }).map((item) => item.id),
    [1]
  );
  assert.deepEqual(filterMistakes(mistakes, { query: "圆 不存在" }), []);
});

test("搜索忽略英文大小写", () => {
  assert.deepEqual(
    filterMistakes(mistakes, { query: "circle area" }).map((item) => item.id),
    [3]
  );
});

test("搜索与状态筛选、分页数据源共同工作", () => {
  assert.deepEqual(
    filterMistakes(mistakes, { query: "圆", status: "mastered" }).map(
      (item) => item.id
    ),
    [3]
  );
  assert.deepEqual(
    filterMistakes(mistakes, { status: "new" }).map((item) => item.id),
    [1]
  );
  assert.equal(filterMistakes(mistakes, { query: "" }).length, 3);
});

test("空搜索返回全部，无法命中时返回空数组", () => {
  assert.equal(filterMistakes(mistakes).length, 3);
  assert.deepEqual(filterMistakes(mistakes, { query: "不存在的题目" }), []);
  assert.equal(mistakeMatchesQuery(mistakes[0], []), true);
  assert.equal(mistakeMatchesQuery(mistakes[0], ["圆"]), true);
  assert.equal(mistakeMatchesQuery(mistakes[0], ["  圆  "]), true);
});

test("纯图片错题可以用“图片”搜索到", () => {
  const imageOnly = [
    {
      id: 4,
      question: "",
      knowledgePoint: "圆",
      errorType: "计算错误",
      status: "new",
      parts: [],
      attachments: [{ id: 9 }]
    }
  ];
  assert.deepEqual(
    filterMistakes(imageOnly, { query: "图片" }).map((item) => item.id),
    [4]
  );
});
