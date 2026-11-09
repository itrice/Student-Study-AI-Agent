export const DIAGNOSIS_PROMPT_VERSION = "diagnosis-v1";

export const diagnosisOutputSchema = {
  type: "object",
  required: [
    "knowledgePoint",
    "errorType",
    "errorStep",
    "missingConcept",
    "initialHint",
    "confidence",
    "evidence",
    "knowledgeSources"
  ],
  additionalProperties: false,
  properties: {
    knowledgePoint: { type: "string", minLength: 1, maxLength: 100 },
    errorType: { type: "string", minLength: 1, maxLength: 100 },
    errorStep: { type: "string", maxLength: 2000, default: "" },
    missingConcept: { type: "string", maxLength: 2000, default: "" },
    initialHint: { type: "string", minLength: 1, maxLength: 2000 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    evidence: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: { type: "string", minLength: 1, maxLength: 1000 }
    },
    knowledgeSources: {
      type: "array",
      maxItems: 8,
      items: { type: "string", maxLength: 1000 }
    },
    partAnalyses: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        required: ["partNo", "label", "errorType", "initialHint"],
        additionalProperties: false,
        properties: {
          partNo: { type: "integer", minimum: 1 },
          label: { type: "string", minLength: 1, maxLength: 200 },
          errorType: { type: "string", maxLength: 100 },
          missingConcept: { type: "string", maxLength: 1000, default: "" },
          initialHint: { type: "string", maxLength: 1000 }
        }
      }
    }
  }
};
