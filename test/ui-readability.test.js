import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const css = fs.readFileSync(
  new URL("../public/styles.css", import.meta.url),
  "utf8"
);

function parseBlocks() {
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

function findDeclaration(selector, property) {
  for (const block of parseBlocks()) {
    if (!block.selectors.includes(selector)) continue;
    const match = block.declarations.match(
      new RegExp(`${property}\\s*:\\s*([^;]+)`, "i")
    );
    if (match) return match[1].trim();
  }
  return null;
}

function cssVariables() {
  const variables = new Map();
  for (const block of parseBlocks()) {
    if (!block.selectors.includes(":root")) continue;
    for (const match of block.declarations.matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) {
      variables.set(match[1], match[2].trim());
    }
  }
  return variables;
}

function resolvePixels(value, variables) {
  const direct = value.match(/^(\d+(?:\.\d+)?)px$/);
  if (direct) return Number(direct[1]);
  const variable = value.match(/^var\((--[\w-]+)\)$/);
  if (variable) return resolvePixels(variables.get(variable[1]), variables);
  return null;
}

test("全站阅读文本字号不低于 16px", () => {
  const violations = [];
  for (const block of parseBlocks()) {
    for (const match of block.declarations.matchAll(/font-size\s*:\s*([^;]+)/gi)) {
      const size = resolvePixels(match[1].trim(), cssVariables());
      if (size !== null && size < 16) {
        violations.push(`${block.selectors.join(", ")}: ${match[1].trim()}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("正文和辅助文字使用统一可读性基线", () => {
  const variables = cssVariables();
  assert.equal(resolvePixels(variables.get("--text-body"), variables), 17);
  assert.equal(resolvePixels(variables.get("--text-label"), variables), 16);
  assert.equal(resolvePixels(variables.get("--text-meta"), variables), 16);
  assert.equal(findDeclaration("body", "font-size"), "var(--text-body)");
});

test("导航、分页和状态元信息保持 16px 可读字号", () => {
  const variables = cssVariables();
  for (const selector of [
    ".breadcrumb",
    ".today-chip",
    ".priority-footer span",
    ".session-progress span",
    ".pagination-status"
  ]) {
    const value = findDeclaration(selector, "font-size");
    assert.ok(value, `${selector} 缺少显式字号`);
    assert.ok(
      resolvePixels(value, variables) >= 16,
      `${selector} 的字号 ${value} 小于 16px`
    );
  }
});

test("按钮和输入框字号不低于 16px", () => {
  const variables = cssVariables();
  const selectors = [
    ".primary-button",
    ".secondary-button",
    ".text-button",
    ".link-button",
    ".review-edit-button",
    ".filter-chip",
    ".small-action",
    ".field input",
    ".field select",
    ".field textarea",
    ".follow-up-row textarea",
    ".review-part input",
    ".knowledge-search input"
  ];

  for (const selector of selectors) {
    const value = findDeclaration(selector, "font-size");
    assert.ok(value, `${selector} 缺少显式字号`);
    assert.ok(
      resolvePixels(value, variables) >= 16,
      `${selector} 的字号 ${value} 小于 16px`
    );
  }
});

test("放大文字后的横向布局具备换行或滚动兜底", () => {
  for (const selector of [
    ".sidebar",
    ".review-meta",
    ".review-meta-left",
    ".priority-footer",
    ".mistake-actions",
    ".knowledge-meta",
    ".knowledge-search-head",
    ".knowledge-search-head-main",
    ".knowledge-search-item-head",
    ".parts-editor-heading"
  ]) {
    const declarations = parseBlocks()
      .filter((block) => block.selectors.includes(selector))
      .map((block) => block.declarations)
      .join(";");
    assert.match(
      declarations,
      /(flex-wrap\s*:\s*wrap|overflow-y\s*:\s*auto)/,
      `${selector} 缺少换行或滚动兜底`
    );
  }
});

test("知识库检索结果提供返回默认视图的重置入口", () => {
  const app = fs.readFileSync(
    new URL("../public/app.js", import.meta.url),
    "utf8"
  );
  assert.match(app, /function resetKnowledgeSearch\(/);
  assert.match(app, /"返回默认视图"/);
  assert.match(app, /state\.knowledgeSearchRequest \+= 1/);
});

test("日总结正文只使用 sentences，不重复拼接 headline", () => {
  const app = fs.readFileSync(
    new URL("../public/app.js", import.meta.url),
    "utf8"
  );
  const start = app.indexOf("if (daily) {");
  assert.notEqual(start, -1);
  const end = app.indexOf("if (weekly) {", start);
  assert.notEqual(end, -1);
  const block = app.slice(start, end);
  assert.equal((block.match(/headline/g) || []).length, 1);
  assert.doesNotMatch(block, /\.\.\.sentences/);
  assert.match(
    block,
    /const sentences = \(daily\.childSummary\?\.sentences \|\| \[\]\)\.filter\(Boolean\);/
  );
  assert.match(block, /#daily-copy"\)\.textContent = sentences\.length/);
  assert.match(block, /sentences\.join\(" "\)/);
});
