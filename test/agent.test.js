import test from "node:test";
import assert from "node:assert/strict";
import {
  answersMatch,
  diagnoseMistake,
  inferKnowledgePoint
} from "../src/agent.js";

test("根据题干关键词判断六年级数学知识点", () => {
  assert.equal(
    inferKnowledgePoint({
      question: "一件商品原价 240 元，先涨价 20%，现在的价格是多少？"
    }),
    "百分数"
  );
  assert.equal(
    inferKnowledgePoint({
      question: "一个圆形花坛的半径是 3 米，求它的面积。"
    }),
    "圆"
  );
  assert.equal(
    inferKnowledgePoint({
      question: "甲数和乙数的比是 2:3，乙数是 18，求甲数。"
    }),
    "比和比例"
  );
});

test("简单分数、小数和百分数答案可以互相判定", () => {
  assert.equal(answersMatch("0.75", "3/4"), true);
  assert.equal(answersMatch("75%", "3/4"), true);
  assert.equal(answersMatch("0.8", "3/4"), false);
  assert.equal(answersMatch("3/4", "3/4或0.75"), true);
  assert.equal(answersMatch("288", "288元"), true);
  assert.equal(answersMatch("288厘米", "288米"), false);
});

test("诊断结果包含知识点、错因、提示和讲题步骤", () => {
  const result = diagnoseMistake({
    question: "把一个圆柱截成两个小圆柱后，表面积增加了多少？",
    studentAnswer: "",
    correctAnswer: "12.56 平方厘米"
  });

  assert.equal(result.knowledgePoint, "圆柱与圆锥");
  assert.equal(result.errorType, "不会做");
  assert.ok(result.hint.includes("目标量"));
  assert.equal(result.methodSteps.length, 3);
  assert.ok(result.diagnosis.includes("不会做"));
});
