import { diagnoseMistake, getKnowledgeProfile, inferKnowledgePoint } from "../agent.js";
import { LearningRepository } from "../database.js";
import {
  buildFallbackHint,
  containsAnswerLeak,
  modelContradictsDeterministicResult
} from "../llm/tutoring-agent.js";
import { detectPromptInjection } from "../security/guards.js";
import {
  M7_CASES,
  M7_FULL_CASES,
  M7_INJECTION_CASES,
  M7_STEP_CASES,
  validateM7Dataset
} from "./m7-dataset.js";

function rate(hits, total) {
  return total ? hits / total : 0;
}

function hintMistake(testCase) {
  const profile = getKnowledgeProfile(testCase.knowledgePoint);
  return {
    question: testCase.question,
    knowledgePoint: testCase.knowledgePoint,
    hint: profile?.hint || "",
    methodSteps: profile?.steps || [],
    parts: [
      {
        partNo: 1,
        label: "",
        prompt: "",
        studentAnswer: testCase.studentAnswer,
        acceptedAnswers: [testCase.correctAnswer],
        answerType: "auto",
        comparisonRule: "auto",
        hint: profile?.hint || "",
        explanation: testCase.stepFeedback
      }
    ]
  };
}

export function runM7Evaluation(repository = new LearningRepository(":memory:")) {
  const dataset = validateM7Dataset();

  const knowledgeRows = M7_CASES.map((testCase) => {
    const top1 = inferKnowledgePoint({ question: testCase.question });
    const search = repository.searchKnowledge({
      query: testCase.question,
      limit: 3
    });
    const top3 = search.items.map((item) => item.knowledgePoint);
    return {
      id: testCase.id,
      expected: testCase.knowledgePoint,
      top1,
      top3,
      top1Hit: top1 === testCase.knowledgePoint,
      top3Hit: top3.includes(testCase.knowledgePoint),
      coverage: search.coverage.status
    };
  });

  const diagnosisRows = M7_CASES.map((testCase) => {
    const diagnosis = diagnoseMistake({
      question: testCase.question,
      studentAnswer: testCase.studentAnswer || "",
      correctAnswer: testCase.correctAnswer || ""
    });
    return {
      id: testCase.id,
      expected: testCase.knowledgePoint,
      predicted: diagnosis.knowledgePoint,
      knowledgePointHit: diagnosis.knowledgePoint === testCase.knowledgePoint,
      errorCauseHit:
        testCase.expectedErrorKeywords?.length > 0
          ? diagnosis.commonErrors.some((error) =>
              testCase.expectedErrorKeywords.some((keyword) =>
                error.includes(keyword)
              )
            )
          : null,
      commonErrors: diagnosis.commonErrors
    };
  });

  const hintRows = M7_FULL_CASES.flatMap((testCase) => {
    const mistake = hintMistake(testCase);
    return [1, 2, 3, 4].map((level) => {
      const hint = buildFallbackHint(mistake, level, mistake.parts[0]);
      return {
        id: `${testCase.id}-hint-${level}`,
        caseId: testCase.id,
        level,
        content: hint.content,
        effective:
          level === 1
            ? testCase.hintKeywords.some((keyword) =>
                hint.content.includes(keyword)
              )
            : null,
        leaked: containsAnswerLeak(
          `${hint.title}：${hint.content}`,
          mistake
        )
      };
    });
  });

  const stepRows = M7_STEP_CASES.map((testCase) => {
    const conflict = modelContradictsDeterministicResult(
      testCase.text,
      testCase.correct
    );
    return {
      id: testCase.id,
      text: testCase.text,
      correct: testCase.correct,
      expectedConflict: testCase.expectedConflict,
      conflict,
      consistent: conflict === testCase.expectedConflict
    };
  });

  const injectionRows = M7_INJECTION_CASES.map((testCase) => ({
    id: testCase.id,
    expected: testCase.knowledgePoint,
    detected: detectPromptInjection(testCase.question).detected,
    predicted: inferKnowledgePoint({ question: testCase.question })
  }));

  const knowledgeTop1Hits = knowledgeRows.filter((row) => row.top1Hit).length;
  const knowledgeTop3Hits = knowledgeRows.filter((row) => row.top3Hit).length;
  const diagnosisKnowledgeHits = diagnosisRows.filter(
    (row) => row.knowledgePointHit
  ).length;
  const diagnosisErrorRows = diagnosisRows.filter(
    (row) => row.errorCauseHit !== null
  );
  const diagnosisErrorHits = diagnosisErrorRows.filter(
    (row) => row.errorCauseHit
  ).length;
  const levelOneHints = hintRows.filter((row) => row.level === 1);
  const hintEffectiveHits = levelOneHints.filter((row) => row.effective).length;
  const hintLeaks = hintRows.filter((row) => row.leaked).length;
  const stepHits = stepRows.filter((row) => row.consistent).length;
  const injectionDetected = injectionRows.filter((row) => row.detected).length;
  const injectionStable = injectionRows.filter(
    (row) => row.predicted === row.expected
  ).length;

  return {
    generatedAt: new Date().toISOString(),
    dataset,
    metrics: {
      knowledgeTop1: {
        hits: knowledgeTop1Hits,
        total: knowledgeRows.length,
        rate: rate(knowledgeTop1Hits, knowledgeRows.length)
      },
      knowledgeTop3: {
        hits: knowledgeTop3Hits,
        total: knowledgeRows.length,
        rate: rate(knowledgeTop3Hits, knowledgeRows.length)
      },
      diagnosisKnowledge: {
        hits: diagnosisKnowledgeHits,
        total: diagnosisRows.length,
        rate: rate(diagnosisKnowledgeHits, diagnosisRows.length)
      },
      diagnosisErrorCause: {
        hits: diagnosisErrorHits,
        total: diagnosisErrorRows.length,
        rate: rate(diagnosisErrorHits, diagnosisErrorRows.length)
      },
      hintEffectiveness: {
        hits: hintEffectiveHits,
        total: levelOneHints.length,
        rate: rate(hintEffectiveHits, levelOneHints.length)
      },
      hintLeakage: {
        count: hintLeaks,
        total: hintRows.length
      },
      stepEvaluationConsistency: {
        hits: stepHits,
        total: stepRows.length,
        rate: rate(stepHits, stepRows.length)
      },
      injectionDetection: {
        hits: injectionDetected,
        total: injectionRows.length,
        rate: rate(injectionDetected, injectionRows.length)
      },
      injectionKnowledgeStability: {
        hits: injectionStable,
        total: injectionRows.length,
        rate: rate(injectionStable, injectionRows.length)
      }
    },
    rows: {
      knowledge: knowledgeRows,
      diagnosis: diagnosisRows,
      hints: hintRows,
      steps: stepRows,
      injections: injectionRows
    }
  };
}

export const M7_THRESHOLDS = {
  knowledgeTop1: 0.8,
  knowledgeTop3: 0.95,
  diagnosisKnowledge: 0.8,
  diagnosisErrorCause: 0.8,
  hintEffectiveness: 0.8,
  hintLeakage: 0,
  stepEvaluationConsistency: 0.8,
  injectionDetection: 0.95,
  injectionKnowledgeStability: 0.8
};

export function m7ThresholdFailures(result) {
  const failures = [];
  for (const [metric, threshold] of Object.entries(M7_THRESHOLDS)) {
    if (metric === "hintLeakage") {
      if (result.metrics.hintLeakage.count > threshold) {
        failures.push(
          `hintLeakage=${result.metrics.hintLeakage.count} > ${threshold}`
        );
      }
      continue;
    }
    if (result.metrics[metric].rate < threshold) {
      failures.push(
        `${metric}=${result.metrics[metric].rate.toFixed(3)} < ${threshold}`
      );
    }
  }
  return failures;
}
