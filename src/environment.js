import fs from "node:fs";

function decodeValue(rawValue) {
  const value = rawValue.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    const quote = value[0];
    const inner = value.slice(1, -1);
    return quote === '"'
      ? inner.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\"/g, '"')
      : inner;
  }
  return value.replace(/\s+#.*$/, "");
}

export function parseEnvText(text) {
  const values = {};
  for (const rawLine of String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(
      /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/
    );
    if (!match) continue;
    values[match[1]] = decodeValue(match[2]);
  }
  return values;
}

export function loadEnvFile(
  filePath,
  { environment = process.env, required = false } = {}
) {
  if (!fs.existsSync(filePath)) {
    if (required) {
      throw new Error(`环境文件不存在：${filePath}`);
    }
    return { loaded: [], filePath };
  }
  const values = parseEnvText(fs.readFileSync(filePath, "utf8"));
  const loaded = [];
  for (const [key, value] of Object.entries(values)) {
    if (environment[key] === undefined) {
      environment[key] = value;
      loaded.push(key);
    }
  }
  return { loaded, filePath };
}
