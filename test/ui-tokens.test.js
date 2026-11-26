/**
 * api-docs.css 是开发者文档的独立样式体系，豁免主站 token 色板。
 * 因此主站 §6.2 的色值允许清单不适用于它，这里按独立基线（31 非 token 字号 / 33 色）守护。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  readCss,
  parseBlocks,
  cssVariables,
  resolvePixels
} from "./helpers/ui-css.js";

const stylesCss = readCss(new URL("../public/styles.css", import.meta.url));
const apiDocsCss = readCss(new URL("../public/api-docs.css", import.meta.url));
const indexHtml = fs.readFileSync(
  new URL("../public/index.html", import.meta.url),
  "utf8"
);

// 棘轮只能改小：以下基线常量是上限，降低计数时必须在同一 PR 同步下调。
// 单测无法证明“基线未被偷偷调高”，由 R19 评审核对本文件 diff 执行。
const STYLES_NON_TOKEN_FONT_SIZE_LIMIT = 33;
const STYLES_COLOR_LIMIT = 209;
const API_DOCS_NON_TOKEN_FONT_SIZE_LIMIT = 31;
const API_DOCS_COLOR_LIMIT = 33;

const BREAKPOINT_ALLOWLIST = new Set([389, 560, 820, 900, 980, 1100]);

const STYLES_COLOR_ALLOWLIST = new Set(
  `
#102538
#132019
#142d43
#155b4a
#163248
#17324d
#173b4a
#173e4a
#1a3a52
#1b6a55
#1f7a63
#2d6a4b
#2d8267
#3d78a5
#465a4d
#4c6154
#4d5f95
#4e6256
#4f675b
#50665a
#50675a
#53685b
#53695c
#55695e
#5c417f
#5c7166
#5d7065
#5d7165
#5d7468
#5e7184
#607168
#627369
#63746a
#64786c
#65796d
#66786d
#687a6f
#68a27f
#6d7f74
#6e572a
#6f8277
#708076
#728277
#755b9c
#7a5312
#7b4f87
#7b8b81
#7b8c82
#7c5a18
#7c8b82
#7d8e84
#7d8f84
#7d9185
#7e765f
#7e8f85
#7f9086
#8292a0
#82ad98
#84938a
#84958b
#85948b
#87968d
#886222
#89988f
#8a5a00
#8a5d13
#8a998f
#8a9a92
#8b9a91
#8c9a92
#8db9a4
#8fb9a2
#90a097
#916158
#91a097
#94a097
#95a299
#96a49c
#97a29a
#97a5ae
#99c0a9
#9aa69e
#9aa69f
#9aa79f
#9aa8a0
#9ac5b5
#9b655b
#9ba79f
#9ba7a0
#9d6258
#9da8a1
#9f1239
#a13e32
#a34e42
#a44d42
#a54e43
#a8c3b5
#a8d0ba
#a9c5b8
#b5c1b9
#b7ccbf
#b8d8c9
#b9862f
#bfd1c4
#bfd9cb
#c0cbc4
#c7ddd2
#c8d8cc
#cfe2d8
#cfe3d6
#d3dbd5
#d5e0d8
#d5e6da
#d6e0d8
#d6e5db
#d8ded9
#d8e1db
#d8e2db
#d8e6dc
#d8e7de
#d8ebdf
#d9e2db
#dc6858
#dce3dd
#dce6de
#dfe9e2
#dfeae2
#dfeee6
#e0e7e1
#e11d48
#e1e8e2
#e2e8e3
#e2e9e3
#e3bb72
#e3e9e4
#e3ebe5
#e3ece6
#e3f1e8
#e3f2e9
#e4b160
#e4ebe5
#e5bd78
#e6ebe7
#e6ece7
#e78b74
#e7b96f
#e7f5ec
#e8c27d
#e8eeea
#e9efea
#e9f4ee
#e9f5ef
#ead9b4
#eadfbe
#eadfc6
#eaf3f9
#eaf5ef
#ecd8d1
#eceeeb
#edf0fb
#edf1ed
#edf1ee
#edf2ee
#edf5ef
#edf6f0
#eef2ef
#eef3ef
#efd6cc
#eff3f0
#f0d3c9
#f0d6ce
#f1f4f1
#f1f6f2
#f2e8f5
#f2eef8
#f2f5f2
#f2f5f3
#f2f6f3
#f3f6f3
#f3f7f4
#f3f8f4
#f3faf6
#f4f7f4
#f4f7f5
#f4faf7
#f5faf6
#f6fbf8
#f7f8f7
#f7faf8
#f7fbf8
#f8f9f7
#f8faf8
#f8fbf9
#f8fcf9
#f9fbf9
#f9fcfa
#fafcfa
#fbf4e4
#fbfcfb
#fbfdfb
#fdf3dd
#fdf9ee
#fff
#fff0eb
#fff5f2
#fff9f6
#fffaf7
#fffcf2
#ffffff
`.trim().split(/\s+/)
);

const API_DOCS_COLOR_ALLOWLIST = new Set(
  `
#067647
#111318
#123526
#155eef
#191c22
#1c2026
#1d2b4d
#22262e
#2d2147
#30353f
#3d1715
#3d2810
#606a78
#6941c6
#75e0a7
#84adff
#9aa4b2
#b42318
#b54708
#c3a8ff
#dfe3e9
#e7eaf0
#e7f6ee
#e8efff
#f1ebff
#f1f3f6
#f5b56d
#f6f7f9
#feeceb
#ff9c96
#fff
#fff2e0
#ffffff
`.trim().split(/\s+/)
);

function nonTokenFontSizes(css) {
  const entries = [];
  for (const block of parseBlocks(css)) {
    for (const match of block.declarations.matchAll(/font-size\s*:\s*([^;]+)/gi)) {
      const value = match[1].trim();
      if (!value.includes("var(--text")) {
        entries.push({ selectors: block.selectors, value });
      }
    }
  }
  return entries;
}

function nonTokenFontSizeLines(css) {
  const lines = [];
  for (const match of css.matchAll(/font-size\s*:\s*([^;}]+)/gi)) {
    if (match[1].includes("var(--text")) continue;
    lines.push(css.slice(0, match.index).split("\n").length);
  }
  return lines;
}

function uniqueColors(css) {
  return [
    ...new Set(
      [...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((match) =>
        match[0].toLowerCase()
      )
    )
  ].sort();
}

function widthBreakpoints(css) {
  const breakpoints = new Set();
  for (const media of css.matchAll(/@media[^{]*/g)) {
    for (const match of media[0].matchAll(
      /(?:max|min)-width\s*:\s*(\d+(?:\.\d+)?)px/g
    )) {
      breakpoints.add(Number(match[1]));
    }
  }
  return [...breakpoints].sort((left, right) => left - right);
}

test("styles.css 非 token 字号不超过 33 个", () => {
  const entries = nonTokenFontSizes(stylesCss);
  assert.ok(
    entries.length <= STYLES_NON_TOKEN_FONT_SIZE_LIMIT,
    `styles.css 非 token font-size ${entries.length} 个，超过上限 ${STYLES_NON_TOKEN_FONT_SIZE_LIMIT}；行号：${nonTokenFontSizeLines(stylesCss).join(", ")}`
  );
});

test("styles.css 去重颜色字面量不超过 209 个且不引入新色值", () => {
  const colors = uniqueColors(stylesCss);
  const unexpected = colors.filter(
    (color) => !STYLES_COLOR_ALLOWLIST.has(color)
  );
  assert.deepEqual(
    unexpected,
    [],
    `styles.css 出现允许清单之外的新颜色：${unexpected.join(", ")}`
  );
  assert.ok(
    colors.length <= STYLES_COLOR_LIMIT,
    `styles.css 去重颜色字面量 ${colors.length} 个，超过上限 ${STYLES_COLOR_LIMIT}`
  );
});

test("styles.css 宽度断点不超出既定集合", () => {
  const unexpected = widthBreakpoints(stylesCss).filter(
    (breakpoint) => !BREAKPOINT_ALLOWLIST.has(breakpoint)
  );
  assert.deepEqual(
    unexpected,
    [],
    `styles.css 出现新宽度断点：${unexpected.join(", ")}px`
  );
});

test("index.html 不包含内联 style 属性", () => {
  const violations = [...indexHtml.matchAll(/<[a-zA-Z][^>]*\sstyle\s*=/gi)].map(
    (match) => `index.html:${indexHtml.slice(0, match.index).split("\n").length}`
  );
  assert.deepEqual(violations, [], `发现内联 style：${violations.join(", ")}`);
});

test("--text-* 字号 token 不低于 16px", () => {
  const variables = cssVariables(stylesCss);
  const tokens = [...variables.entries()].filter(([name]) =>
    name.startsWith("--text-")
  );
  assert.ok(tokens.length > 0, "styles.css 缺少 --text-* 字号 token");

  const violations = [];
  for (const [name, value] of tokens) {
    const pixels = resolvePixels(value, variables);
    if (pixels === null || pixels < 16) {
      violations.push(`${name}: ${value}`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    `--text-* token 低于 16px 或无法解析：${violations.join(", ")}`
  );
});

test("api-docs.css 独立体系维持非 token 字号与色值基线", () => {
  const entries = nonTokenFontSizes(apiDocsCss);
  assert.ok(
    entries.length <= API_DOCS_NON_TOKEN_FONT_SIZE_LIMIT,
    `api-docs.css 非 token font-size ${entries.length} 个，超过上限 ${API_DOCS_NON_TOKEN_FONT_SIZE_LIMIT}；行号：${nonTokenFontSizeLines(apiDocsCss).join(", ")}`
  );

  const colors = uniqueColors(apiDocsCss);
  const unexpected = colors.filter(
    (color) => !API_DOCS_COLOR_ALLOWLIST.has(color)
  );
  assert.deepEqual(
    unexpected,
    [],
    `api-docs.css 出现允许清单之外的新颜色：${unexpected.join(", ")}`
  );
  assert.ok(
    colors.length <= API_DOCS_COLOR_LIMIT,
    `api-docs.css 去重颜色字面量 ${colors.length} 个，超过上限 ${API_DOCS_COLOR_LIMIT}`
  );
});