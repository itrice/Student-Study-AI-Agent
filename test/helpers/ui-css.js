import fs from "node:fs";

export function readCss(fileUrl) {
  return fs.readFileSync(fileUrl, "utf8");
}

export function parseBlocks(css) {
  const blocks = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = pattern.exec(css)) !== null) {
    const selectors = match[1]
      .split(",")
      .map((selector) => selector.trim().replace(/\s+/g, " "))
      .filter(Boolean);
    blocks.push({ selectors, declarations: match[2] });
  }
  return blocks;
}

export function findDeclaration(css, selector, property) {
  for (const block of parseBlocks(css)) {
    if (!block.selectors.includes(selector)) continue;
    const match = block.declarations.match(
      new RegExp(`${property}\\s*:\\s*([^;]+)`, "i")
    );
    if (match) return match[1].trim();
  }
  return null;
}

export function cssVariables(css) {
  const variables = new Map();
  for (const block of parseBlocks(css)) {
    if (!block.selectors.includes(":root")) continue;
    for (const match of block.declarations.matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) {
      variables.set(match[1], match[2].trim());
    }
  }
  return variables;
}

export function resolvePixels(value, variables) {
  const direct = value.match(/^(\d+(?:\.\d+)?)px$/);
  if (direct) return Number(direct[1]);
  const variable = value.match(/^var\((--[\w-]+)\)$/);
  if (variable) return resolvePixels(variables.get(variable[1]), variables);
  return null;
}