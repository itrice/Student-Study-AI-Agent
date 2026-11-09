export const HINT_PROMPT_VERSION = "hint-v1";
export const ATTEMPT_EVALUATION_PROMPT_VERSION = "attempt-evaluation-v1";
export const FOLLOW_UP_PROMPT_VERSION = "follow-up-v1";

export const hintOutputSchema = {
  type: "object",
  required: [
    "level",
    "title",
    "content",
    "guidingQuestions",
    "sources"
  ],
  additionalProperties: false,
  properties: {
    level: { type: "integer", minimum: 1, maximum: 4 },
    title: { type: "string", minLength: 1, maxLength: 200 },
    content: { type: "string", minLength: 1, maxLength: 2000 },
    guidingQuestions: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: { type: "string", minLength: 1, maxLength: 500 }
    },
    sources: {
      type: "array",
      maxItems: 8,
      items: { type: "string", maxLength: 1000 }
    }
  }
};

export const followUpOutputSchema = {
  type: "object",
  required: ["title", "content", "suggestedNextStep", "sources"],
  additionalProperties: false,
  properties: {
    title: { type: "string", minLength: 1, maxLength: 200 },
    content: { type: "string", minLength: 1, maxLength: 2000 },
    suggestedNextStep: { type: "string", minLength: 1, maxLength: 1000 },
    sources: {
      type: "array",
      maxItems: 8,
      items: { type: "string", maxLength: 1000 }
    }
  }
};

export const attemptEvaluationSchema = {
  type: "object",
  required: [
    "outcome",
    "finalAnswerAssessment",
    "stepAssessment",
    "firstError",
    "feedback",
    "nextHintLevel",
    "masteryEvidence",
    "sources"
  ],
  additionalProperties: false,
  properties: {
    outcome: {
      type: "string",
      enum: ["correct", "partial", "incorrect", "ungraded"]
    },
    finalAnswerAssessment: {
      type: "string",
      minLength: 1,
      maxLength: 2000
    },
    stepAssessment: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        required: ["partNo", "assessment"],
        additionalProperties: false,
        properties: {
          partNo: { type: "integer", minimum: 1 },
          assessment: { type: "string", minLength: 1, maxLength: 2000 }
        }
      }
    },
    firstError: { type: "string", maxLength: 2000 },
    feedback: { type: "string", minLength: 1, maxLength: 3000 },
    nextHintLevel: { type: "integer", minimum: 0, maximum: 4 },
    masteryEvidence: {
      type: "array",
      maxItems: 10,
      items: { type: "string", maxLength: 1000 }
    },
    sources: {
      type: "array",
      maxItems: 8,
      items: { type: "string", maxLength: 1000 }
    }
  }
};
