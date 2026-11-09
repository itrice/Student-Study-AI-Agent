import { createLearningToolDefinitions } from "./learning-tools.js";
import { createToolRegistry } from "./registry.js";

export { TOOL_ERROR_CODES, ToolError } from "./errors.js";

export function createLearningTools(repository) {
  return createToolRegistry(
    repository,
    createLearningToolDefinitions(repository)
  );
}
