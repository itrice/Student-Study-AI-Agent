import test from "node:test";
import assert from "node:assert/strict";
import { LearningRepository } from "../src/database.js";

function createMistake(repository, overrides = {}) {
  return repository.createMistake({
    question: "一件商品原价 240 元，先涨价 20%，现在的价格是多少元？",
    studentAnswer: "240元",
    correctAnswer: "288元",
    analysis: "先求涨了多少钱，再用原价加涨价部分。",
    knowledgePoint: "百分数",
    errorType: "单位“1”找错",
    ...overrides
  });
}

test("新错题进入优先复习队列，并计入知识点统计", () => {
  const repository = new LearningRepository();
  const first = createMistake(repository);
  const second = createMistake(repository, {
    question: "一个圆形花坛的半径是 3 米，面积是多少？",
    knowledgePoint: "圆",
    correctAnswer: "28.26平方米"
  });

  const dashboard = repository.getDashboard();
  assert.equal(dashboard.stats.total, 2);
  assert.equal(dashboard.stats.new, 2);
  assert.equal(dashboard.stats.due, 2);
  assert.equal(dashboard.nextReview.id, first.id);

  const summary = repository.getKnowledgeSummary();
  const percent = summary.find((item) => item.name === "百分数");
  const circle = summary.find((item) => item.name === "圆");
  assert.equal(percent.total, 1);
  assert.equal(circle.new, 1);
  assert.equal(percent.relearning, 0);
  assert.equal(circle.relearning, 0);
  assert.ok(percent.mastery < 50);

  const next = repository.getNextReview();
  assert.equal(next.id, first.id);
  assert.equal(next.correctAnswer, "288元");
  repository.close();
});

test("答错后延后复习，连续两次答对后标记掌握", () => {
  const repository = new LearningRepository();
  const mistake = createMistake(repository);

  const wrong = repository.recordAttempt(mistake.id, "240元");
  assert.equal(wrong.correct, false);
  assert.equal(wrong.mistake.status, "practicing");
  assert.equal(wrong.mistake.consecutiveCorrect, 0);
  assert.equal(wrong.mistake.attemptCount, 1);
  assert.equal(repository.getNextReview(), null);
  const storedWrongAttempt = repository.db
    .prepare(
      "SELECT outcome, independent, evaluation_source FROM attempts WHERE mistake_id = ?"
    )
    .get(mistake.id);
  assert.equal(storedWrongAttempt.outcome, "incorrect");
  assert.equal(storedWrongAttempt.independent, null);
  assert.equal(storedWrongAttempt.evaluation_source, "rule");

  const firstCorrect = repository.recordAttempt(mistake.id, "288元", {
    independent: true
  });
  assert.equal(firstCorrect.correct, true);
  assert.equal(firstCorrect.mastered, false);
  assert.equal(firstCorrect.mistake.status, "practicing");
  assert.equal(firstCorrect.mistake.consecutiveCorrect, 1);
  assert.equal(
    repository.db
      .prepare(
        "SELECT outcome FROM attempts WHERE mistake_id = ? ORDER BY id DESC LIMIT 1"
      )
      .get(mistake.id).outcome,
    "correct"
  );

  const secondCorrect = repository.recordAttempt(mistake.id, "288", {
    independent: true
  });
  assert.equal(secondCorrect.correct, true);
  assert.equal(secondCorrect.mastered, true);
  assert.equal(secondCorrect.mistake.status, "mastered");
  assert.equal(secondCorrect.mistake.consecutiveCorrect, 2);
  assert.ok(new Date(secondCorrect.nextReviewAt) > new Date());

  const dashboard = repository.getDashboard();
  assert.equal(dashboard.stats.mastered, 1);
  assert.equal(dashboard.stats.due, 0);
  repository.close();
});

test("示例数据只会在空错题库中载入一次", () => {
  const repository = new LearningRepository();

  assert.deepEqual(repository.addDemoData(), { added: 5 });
  assert.deepEqual(repository.addDemoData(), { added: 0 });
  assert.equal(repository.listMistakes().length, 5);

  const first = repository.listMistakes()[0];
  assert.equal(repository.deleteMistake(first.id), true);
  assert.equal(repository.deleteMistake(first.id), false);
  repository.close();
});
