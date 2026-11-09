import { KNOWLEDGE_EVALUATION_CASES } from "./catalog.js";

const STOP_BIGRAMS = new Set([
  "一个",
  "一些",
  "多少",
  "请问",
  "计算",
  "这道",
  "题目",
  "下列",
  "下面",
  "我们",
  "他们",
  "可以",
  "需要",
  "已经",
  "的是",
  "了吗",
  "怎么",
  "什么",
  "如果",
  "因为",
  "所以",
  "这样",
  "那么",
  "其中",
  "分别",
  "不是",
  "就是",
  "这个",
  "那个",
  "表示",
  "怎样",
  "如何",
  "已知",
  "求的",
  "的是"
]);

const STOP_CHARS = new Set([
  "的",
  "了",
  "是",
  "在",
  "和",
  "与",
  "及",
  "或",
  "有",
  "为",
  "把",
  "被",
  "我",
  "你",
  "他",
  "她",
  "它",
  "这",
  "那",
  "请",
  "吗",
  "呢",
  "啊",
  "吧"
]);

const KIND_PRIORITY = {
  concept: 6,
  method: 5,
  condition: 4,
  common_error: 3,
  example: 2
};

const SIGNAL_KEYWORDS = new Set(["加", "减", "乘", "除", "折", "占"]);

export function normalizeKnowledgeText(value) {
  return String(value || "")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function cjkRuns(text) {
  return String(text || "").match(/[\u3400-\u9fff]+/g) || [];
}

function latinTokens(text) {
  return String(text || "").match(/[a-z0-9]+(?:\.[0-9]+)?/gi) || [];
}

function symbolTokens(text) {
  return String(text || "").match(/[\u0370-\u03ff]+/g) || [];
}

function bigramSet(text, { keepSingle = false } = {}) {
  const result = new Set();
  const normalized = normalizeKnowledgeText(text);
  for (const run of cjkRuns(normalized)) {
    if (run.length === 1 && keepSingle) {
      result.add(run);
      continue;
    }
    for (let index = 0; index < run.length - 1; index += 1) {
      const gram = run.slice(index, index + 2);
      if (STOP_BIGRAMS.has(gram)) continue;
      if (STOP_CHARS.has(gram[0]) && STOP_CHARS.has(gram[1])) continue;
      result.add(gram);
    }
  }
  for (const token of latinTokens(normalized)) {
    if (token.length >= 2) result.add(token);
  }
  for (const token of symbolTokens(normalized)) {
    result.add(token);
  }
  return result;
}

export function segmentKnowledgeText(text) {
  const tokens = [];
  const source = String(text || "");
  for (const run of cjkRuns(source)) {
    for (const char of run) tokens.push(char);
    for (let index = 0; index < run.length - 1; index += 1) {
      tokens.push(run.slice(index, index + 2));
    }
  }
  for (const token of latinTokens(source)) tokens.push(token);
  for (const token of symbolTokens(source)) tokens.push(token);
  return tokens.join(" ");
}

export function buildKnowledgeFtsQuery(query) {
  const terms = [];
  const normalized = normalizeKnowledgeText(query);
  for (const run of cjkRuns(normalized)) {
    if (run.length === 1) {
      terms.push(`"${run}"`);
      continue;
    }
    for (let index = 0; index < run.length - 1; index += 1) {
      const gram = run.slice(index, index + 2);
      if (STOP_BIGRAMS.has(gram)) continue;
      terms.push(`"${gram[0]} ${gram[1]}"`);
    }
  }
  for (const token of latinTokens(normalized)) {
    if (token.length >= 2) terms.push(`"${token}"`);
  }
  for (const token of symbolTokens(normalized)) {
    terms.push(`"${token}"`);
  }
  return [...new Set(terms)].slice(0, 40).join(" OR ");
}

function overlapRatio(queryGrams, text) {
  if (!queryGrams.size) return 0;
  const textGrams = bigramSet(text);
  let matches = 0;
  for (const gram of queryGrams) {
    if (textGrams.has(gram)) matches += 1;
  }
  return matches / queryGrams.size;
}

function scoreCard(card, query, queryNormalized, queryGrams, ftsHits) {
  const nameNormalized = normalizeKnowledgeText(card.name);
  let score = 0;
  const matchedBy = new Set();

  if (queryNormalized === nameNormalized) {
    score += 400;
    matchedBy.add("name");
  } else if (
    nameNormalized.length >= 2 &&
    queryNormalized.includes(nameNormalized)
  ) {
    score += 120 + nameNormalized.length * 8;
    matchedBy.add("name");
  } else if (
    nameNormalized.length >= 2 &&
    queryNormalized.length >= 2 &&
    nameNormalized.includes(queryNormalized)
  ) {
    score += 90 + queryNormalized.length * 6 + nameNormalized.length * 2;
    matchedBy.add("name");
  } else if (
    nameNormalized.length === 1 &&
    queryNormalized.length <= 6 &&
    queryNormalized.includes(nameNormalized)
  ) {
    score += 45;
    matchedBy.add("name");
  }

  for (const alias of card.aliases || []) {
    const aliasNormalized = normalizeKnowledgeText(alias);
    if (!aliasNormalized) continue;
    if (queryNormalized === aliasNormalized) {
      score += 240;
      matchedBy.add("alias");
    } else if (aliasNormalized.length < 2) {
      continue;
    } else if (queryNormalized.includes(aliasNormalized)) {
      score += 35 + Math.min(100, aliasNormalized.length * 9);
      matchedBy.add("alias");
    } else if (
      aliasNormalized.includes(queryNormalized) &&
      queryNormalized.length >= 2
    ) {
      score += 18;
      matchedBy.add("alias");
    }
  }

  for (const keyword of card.keywords || []) {
    const keywordNormalized = normalizeKnowledgeText(keyword);
    if (
      keywordNormalized.length < 2 &&
      !SIGNAL_KEYWORDS.has(keywordNormalized)
    ) {
      continue;
    }
    if (queryNormalized.includes(keywordNormalized)) {
      score += 8 + Math.min(30, keywordNormalized.length * 3);
      matchedBy.add("keyword");
    }
  }

  const searchable = [
    card.name,
    ...(card.aliases || []),
    ...(card.keywords || []),
    card.summary,
    card.unit,
    ...(card.prerequisites || []),
    ...(card.chunks || []).map((chunk) => chunk.title)
  ].join(" ");
  const overlap = overlapRatio(queryGrams, searchable);
  if (overlap > 0) {
    score += overlap * 70;
    matchedBy.add("full_text");
  }

  if (ftsHits > 0) {
    score += Math.min(25, ftsHits * 3);
    matchedBy.add("fts");
  }

  if (
    card.name === "综合应用" &&
    queryNormalized.length >= 6 &&
    /[\d一二三四五六七八九十]/.test(queryNormalized)
  ) {
    score += 6;
  }

  return { score, matchedBy: [...matchedBy] };
}

function scoreChunk(chunk, queryGrams, queryNormalized) {
  const text = `${chunk.title} ${chunk.content}`;
  const overlap = overlapRatio(queryGrams, text);
  const normalized = normalizeKnowledgeText(text);
  let score = (KIND_PRIORITY[chunk.kind] || 1) * 6 + overlap * 80;
  if (queryNormalized.length >= 2 && normalized.includes(queryNormalized)) {
    score += 30;
  }
  return score;
}

function selectChunks(card, queryGrams, queryNormalized, { includeCard }) {
  const chunks = [...(card.chunks || [])];
  if (includeCard) return chunks;

  const selected = [];
  for (const kind of ["concept", "method"]) {
    const found = chunks.find(
      (chunk) => chunk.kind === kind && !selected.includes(chunk)
    );
    if (found) selected.push(found);
  }

  const remaining = chunks
    .filter((chunk) => !selected.includes(chunk))
    .sort(
      (left, right) =>
        scoreChunk(right, queryGrams, queryNormalized) -
        scoreChunk(left, queryGrams, queryNormalized)
    );

  while (selected.length < 3 && remaining.length) {
    selected.push(remaining.shift());
  }
  return selected;
}

function toSearchItem(card, chunks, score, matchedBy) {
  const citations = [
    ...new Set(chunks.map((chunk) => chunk.citation).filter(Boolean))
  ];
  return {
    id: card.id,
    knowledgePoint: card.name,
    slug: card.slug,
    unit: card.unit,
    textbookVersion: card.textbookVersion,
    aliases: card.aliases,
    prerequisites: card.prerequisites,
    summary: card.summary,
    essence: card.summary,
    hint: card.hint,
    steps: card.steps,
    commonErrors: card.commonErrors,
    contentVersion: card.contentVersion,
    reviewStatus: card.reviewStatus,
    chunks: chunks.map((chunk) => ({
      id: chunk.id,
      key: chunk.chunkKey,
      kind: chunk.kind,
      title: chunk.title,
      content: chunk.content,
      citation: chunk.citation,
      sourceKey: chunk.source?.key || ""
    })),
    citations,
    sources: card.sources || [],
    score: Math.round(score),
    matchedBy
  };
}

export function searchKnowledgeCards(
  cards,
  { query, knowledgePoint = null, limit = 3, includeCard = false, ftsHits = null } = {}
) {
  const text = String(query || "").trim();
  const queryNormalized = normalizeKnowledgeText(text);
  const queryGrams = bigramSet(text);
  const requested = String(knowledgePoint || "").trim();

  if (!queryNormalized) {
    return {
      query: text,
      items: [],
      count: 0,
      coverage: {
        status: "not_covered",
        note: "检索词为空，无法匹配知识库。",
        matchedKnowledgePoints: []
      }
    };
  }

  let requestedCard = null;
  if (requested) {
    requestedCard =
      cards.find(
        (card) =>
          card.name === requested ||
          (card.aliases || []).some((alias) => alias === requested)
      ) || null;
  }

  const scored = cards.map((card) => {
    const hits = ftsHits?.get?.(card.id) || 0;
    const result = scoreCard(
      card,
      text,
      queryNormalized,
      queryGrams,
      hits
    );
    return { card, ...result };
  });

  const strongMatches = scored.filter(
    ({ score, matchedBy }) =>
      score >= 45 &&
      matchedBy.some((item) => item === "name" || item === "alias")
  );
  if (strongMatches.length >= 2) {
    const integrated = scored.find(
      ({ card }) => card.name === "综合应用"
    );
    if (integrated) integrated.score += 30;
  }

  let candidates = scored;
  if (requestedCard) {
    candidates = scored
      .map((entry) => ({
        ...entry,
        score: entry.card.id === requestedCard.id ? 1000 : entry.score
      }))
      .filter((entry) => entry.card.id === requestedCard.id);
  } else {
    candidates = scored
      .filter((entry) => entry.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.card.position - right.card.position
      );
  }

  const bestScore = candidates[0]?.score || 0;
  let status = "covered";
  if (!requestedCard && bestScore < 18) status = "not_covered";
  else if (!requestedCard && bestScore < 45) status = "insufficient";

  if (status === "not_covered") {
    return {
      query: text,
      items: [],
      count: 0,
      coverage: {
        status,
        note:
          "知识库暂未覆盖这个问题。请改用综合应用，或请教师补充知识卡片，不要编造教材来源。",
        bestScore: Math.round(bestScore),
        matchedKnowledgePoints: [],
        suggestions: cards.map((card) => card.name)
      }
    };
  }

  const maxItems = Math.max(1, Math.min(5, Number(limit) || 3));
  const selected = candidates.slice(0, requestedCard ? 1 : maxItems);
  const items = selected.map((entry) => {
    const chunks = selectChunks(
      entry.card,
      queryGrams,
      queryNormalized,
      { includeCard }
    );
    return toSearchItem(
      entry.card,
      chunks,
      entry.score,
      entry.matchedBy
    );
  });

  const sources = items.flatMap((item) => item.sources || []);
  return {
    query: text,
    items,
    count: items.length,
    coverage: {
      status,
      note:
        status === "covered"
          ? "已匹配到可追溯的知识片段。"
          : "匹配度较低，请确认知识点；引用来源前不要扩大解释。",
      bestScore: Math.round(bestScore),
      matchedKnowledgePoints: items.map((item) => item.knowledgePoint),
      sourceCount: new Set(sources.map((source) => source.key)).size,
      citationCount: new Set(items.flatMap((item) => item.citations)).size
    }
  };
}

export function evaluateKnowledgeRetrieval(
  repository,
  { cases = KNOWLEDGE_EVALUATION_CASES, limit = 3 } = {}
) {
  const rows = cases.map((testCase) => {
    const result = repository.searchKnowledge({
      query: testCase.query,
      limit
    });
    const names = result.items.map((item) => item.knowledgePoint);
    const hit = names.includes(testCase.knowledgePoint);
    const top1 = names[0] || null;
    const top1Hit = top1 === testCase.knowledgePoint;
    const sourced = result.items.every(
      (item) => item.sources?.length && item.citations?.length
    );
    return {
      id: testCase.id,
      set: testCase.set || "card_aligned",
      expected: testCase.knowledgePoint,
      query: testCase.query,
      top3: names,
      top1,
      hit,
      top1Hit,
      sourced,
      coverage: result.coverage.status,
      bestScore: result.coverage.bestScore ?? null
    };
  });

  const hits = rows.filter((row) => row.hit).length;
  const top1Hits = rows.filter((row) => row.top1Hit).length;
  const coveredRows = rows.filter((row) => row.coverage !== "not_covered");
  const sourcedRows = coveredRows.filter((row) => row.sourced).length;
  const heldOutRows = rows.filter((row) => row.set === "held_out");
  const heldOutHits = heldOutRows.filter((row) => row.hit).length;
  const heldOutTop1Hits = heldOutRows.filter((row) => row.top1Hit).length;
  const byPoint = new Map();
  for (const row of rows) {
    if (!byPoint.has(row.expected)) {
      byPoint.set(row.expected, { total: 0, hits: 0 });
    }
    const entry = byPoint.get(row.expected);
    entry.total += 1;
    if (row.hit) entry.hits += 1;
  }

  return {
    limit,
    total: rows.length,
    hits,
    accuracy: rows.length ? hits / rows.length : 0,
    top1Hits,
    top1Accuracy: rows.length ? top1Hits / rows.length : 0,
    covered: coveredRows.length,
    sourceCoverage: coveredRows.length ? sourcedRows / coveredRows.length : 0,
    heldOut: {
      total: heldOutRows.length,
      hits: heldOutHits,
      accuracy: heldOutRows.length ? heldOutHits / heldOutRows.length : 0,
      top1Hits: heldOutTop1Hits,
      top1Accuracy: heldOutRows.length
        ? heldOutTop1Hits / heldOutRows.length
        : 0,
      misses: heldOutRows.filter((row) => !row.hit)
    },
    statusCounts: rows.reduce((counts, row) => {
      counts[row.coverage] = (counts[row.coverage] || 0) + 1;
      return counts;
    }, {}),
    perPoint: [...byPoint.entries()].map(([knowledgePoint, value]) => ({
      knowledgePoint,
      ...value,
      accuracy: value.total ? value.hits / value.total : 0
    })),
    misses: rows.filter((row) => !row.hit),
    unsourced: coveredRows.filter((row) => !row.sourced),
    rows
  };
}
