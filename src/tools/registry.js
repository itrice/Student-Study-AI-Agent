import {
  TOOL_ERROR_CODES,
  ToolError,
  normalizeToolError
} from "./errors.js";
import {
  SchemaValidationError,
  validateAndNormalize
} from "./schema.js";
import { runWithToolWriteLease } from "../database.js";

function stableStringify(value) {
  if (value === undefined) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseJson(text, fallback = {}) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function withTimeout(promise, timeoutMs, onTimeout) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(
            new ToolError(
              TOOL_ERROR_CODES.TOOL_TIMEOUT,
              `工具执行超过 ${timeoutMs}ms`,
              { status: 504 }
            )
          );
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class ToolRegistry {
  constructor(repository, definitions) {
    this.repository = repository;
    this.tools = new Map();
    for (const definition of definitions) {
      if (this.tools.has(definition.name)) {
        throw new Error(`重复的工具名称：${definition.name}`);
      }
      this.tools.set(definition.name, definition);
    }
  }

  listTools(caller = "agent") {
    return [...this.tools.values()]
      .filter((tool) => tool.allowedCallers.includes(caller))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        permission: tool.permission,
        requiresIdempotencyKey: Boolean(tool.requiresIdempotencyKey),
        timeoutMs: tool.timeoutMs || 5000,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema
      }));
  }

  getTool(name) {
    return this.tools.get(name) || null;
  }

  ensureRun(context, toolName) {
    if (context.runId) {
      const existing = this.repository.getAgentRun(context.runId);
      if (!existing) {
        throw new ToolError(
          TOOL_ERROR_CODES.NOT_FOUND,
          "Agent 运行记录不存在",
          { status: 404 }
        );
      }
      return { runId: context.runId, ownsRun: false };
    }
    const runId = this.repository.createAgentRun({
      taskType: `${context.caller}_tool`,
      goal: `调用工具 ${toolName}`
    });
    return { runId, ownsRun: true };
  }

  existingIdempotentResult(toolName, idempotencyKey, argumentsJson) {
    if (!idempotencyKey) return null;
    const existing = this.repository.findToolCallByIdempotency(
      toolName,
      idempotencyKey
    );
    if (!existing) return null;

    if (existing.arguments_json !== argumentsJson) {
      throw new ToolError(
        TOOL_ERROR_CODES.IDEMPOTENCY_CONFLICT,
        "同一幂等键不能用于不同的工具参数",
        { status: 409 }
      );
    }
    if (existing.status === "succeeded") {
      return parseJson(existing.result_json, {});
    }
    if (existing.status === "running") {
      throw new ToolError(
        TOOL_ERROR_CODES.CONFLICT,
        "相同工具调用正在执行",
        { status: 409 }
      );
    }
    throw new ToolError(
      TOOL_ERROR_CODES.CONFLICT,
      `相同工具调用此前已失败：${existing.error_message || "未知错误"}`,
      { status: 409 }
    );
  }

  async invoke(name, rawArguments = {}, context = {}) {
    const caller = context.caller || "system";
    const definition = this.tools.get(name);
    if (!definition) {
      throw new ToolError(
        TOOL_ERROR_CODES.TOOL_NOT_FOUND,
        "工具不存在",
        { status: 404 }
      );
    }
    if (!definition.allowedCallers.includes(caller)) {
      throw new ToolError(
        TOOL_ERROR_CODES.PERMISSION_DENIED,
        `${caller} 无权调用工具 ${name}`,
        { status: 403 }
      );
    }

    const idempotencyKey = context.idempotencyKey || null;
    if (definition.requiresIdempotencyKey && !idempotencyKey) {
      throw new ToolError(
        TOOL_ERROR_CODES.IDEMPOTENCY_REQUIRED,
        "写入工具必须提供幂等键",
        { status: 400 }
      );
    }
    if (
      idempotencyKey &&
      (typeof idempotencyKey !== "string" ||
        idempotencyKey.length < 1 ||
        idempotencyKey.length > 200)
    ) {
      throw new ToolError(
        TOOL_ERROR_CODES.INVALID_ARGUMENTS,
        "幂等键格式无效"
      );
    }

    const argumentsJson = stableStringify(rawArguments);
    const previous = this.existingIdempotentResult(
      name,
      idempotencyKey,
      argumentsJson
    );
    if (previous !== null) return previous;

    const run = this.ensureRun({ ...context, caller }, name);
    const startedAt = performance.now();
    const writeLease = { aborted: false };
    let callId = null;
    try {
      callId = this.repository.beginToolCall({
        runId: run.runId,
        toolName: name,
        argumentsJson,
        idempotencyKey
      });
      const args = validateAndNormalize(
        rawArguments,
        definition.inputSchema
      );
      const timeoutMs = definition.timeoutMs || 5000;
      const result = await withTimeout(
        runWithToolWriteLease(writeLease, () =>
          Promise.resolve().then(() =>
            definition.handler(args, {
              ...context,
              caller,
              runId: run.runId
            })
          )
        ),
        timeoutMs,
        () => {
          writeLease.aborted = true;
        }
      );
      const normalizedResult = validateAndNormalize(
        result,
        definition.outputSchema
      );
      const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
      this.repository.finishToolCall(callId, {
        status: "succeeded",
        resultJson: stableStringify(normalizedResult),
        latencyMs
      });
      if (run.ownsRun) {
        this.repository.finishAgentRun(run.runId, { status: "completed" });
      }
      return normalizedResult;
    } catch (error) {
      const toolError =
        error instanceof SchemaValidationError
          ? new ToolError(
              TOOL_ERROR_CODES.INVALID_ARGUMENTS,
              error.message,
              { details: { path: error.path } }
            )
          : normalizeToolError(error);
      const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
      if (callId) {
        this.repository.finishToolCall(callId, {
          status: "failed",
          latencyMs,
          errorMessage: `${toolError.code}: ${toolError.message}`
        });
      }
      if (run.ownsRun) {
        this.repository.finishAgentRun(run.runId, {
          status: "failed",
          errorMessage: `${toolError.code}: ${toolError.message}`
        });
      }
      throw toolError;
    }
  }
}

export function createToolRegistry(repository, definitions) {
  return new ToolRegistry(repository, definitions);
}
