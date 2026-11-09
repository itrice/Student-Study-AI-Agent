export const TOOL_ERROR_CODES = {
  TOOL_NOT_FOUND: "TOOL_NOT_FOUND",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  INVALID_ARGUMENTS: "INVALID_ARGUMENTS",
  IDEMPOTENCY_REQUIRED: "IDEMPOTENCY_REQUIRED",
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  NOT_FOUND: "NOT_FOUND",
  DRAFT_EXPIRED: "DRAFT_EXPIRED",
  CONFLICT: "CONFLICT",
  TOOL_TIMEOUT: "TOOL_TIMEOUT",
  INTERNAL_ERROR: "INTERNAL_ERROR"
};

export class ToolError extends Error {
  constructor(
    code,
    message,
    { status = 400, details = null, cause = null } = {}
  ) {
    super(message, { cause });
    this.name = "ToolError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function normalizeToolError(error) {
  if (error instanceof ToolError) return error;
  if (error?.code && Number.isInteger(error.status)) {
    return new ToolError(error.code, error.message, {
      status: error.status,
      cause: error
    });
  }
  return new ToolError(
    TOOL_ERROR_CODES.INTERNAL_ERROR,
    "工具执行失败",
    { status: 500, cause: error }
  );
}
