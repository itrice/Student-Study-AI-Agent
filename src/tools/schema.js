export class SchemaValidationError extends Error {
  constructor(message, path = "$") {
    super(`${path}: ${message}`);
    this.name = "SchemaValidationError";
    this.path = path;
  }
}

function cloneDefault(value) {
  if (Array.isArray(value)) return [...value];
  if (value && typeof value === "object") return { ...value };
  return value;
}

function matchesType(value, type) {
  if (type === "array") return Array.isArray(value);
  if (type === "object")
    return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number")
    return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

export function validateAndNormalize(value, schema, path = "$") {
  if (value === undefined) {
    if (Object.hasOwn(schema, "default")) {
      value = cloneDefault(schema.default);
    } else {
      return undefined;
    }
  }

  if (schema.type && !matchesType(value, schema.type)) {
    throw new SchemaValidationError(`应为 ${schema.type} 类型`, path);
  }
  if (Object.hasOwn(schema, "const") && value !== schema.const) {
    throw new SchemaValidationError(`必须等于 ${schema.const}`, path);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    throw new SchemaValidationError(
      `必须是 ${schema.enum.join("、")} 之一`,
      path
    );
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      throw new SchemaValidationError(
        `长度不能少于 ${schema.minLength}`,
        path
      );
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      throw new SchemaValidationError(
        `长度不能超过 ${schema.maxLength}`,
        path
      );
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      throw new SchemaValidationError("格式不符合要求", path);
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      throw new SchemaValidationError(`不能小于 ${schema.minimum}`, path);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      throw new SchemaValidationError(`不能大于 ${schema.maximum}`, path);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      throw new SchemaValidationError(
        `至少需要 ${schema.minItems} 项`,
        path
      );
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      throw new SchemaValidationError(
        `最多允许 ${schema.maxItems} 项`,
        path
      );
    }
    if (schema.items) {
      return value.map((item, index) =>
        validateAndNormalize(item, schema.items, `${path}[${index}]`)
      );
    }
    return value;
  }

  if (value !== null && typeof value === "object") {
    for (const key of schema.required || []) {
      if (!Object.hasOwn(value, key)) {
        throw new SchemaValidationError(`缺少必填字段 ${key}`, path);
      }
    }

    const properties = schema.properties || {};
    const normalized = {};
    for (const [key, propertySchema] of Object.entries(properties)) {
      const propertyValue = validateAndNormalize(
        value[key],
        propertySchema,
        `${path}.${key}`
      );
      if (propertyValue !== undefined) normalized[key] = propertyValue;
    }

    if (schema.additionalProperties !== true) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) {
          throw new SchemaValidationError(`不允许字段 ${key}`, path);
        }
      }
    } else {
      for (const [key, propertyValue] of Object.entries(value)) {
        if (!Object.hasOwn(normalized, key)) normalized[key] = propertyValue;
      }
    }
    return normalized;
  }

  return value;
}
