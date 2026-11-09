export class LearningValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LearningValidationError";
    this.code = code;
    this.status = 400;
  }
}
