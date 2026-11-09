const KNOWLEDGE_PROFILES = {
  "分数乘除法": {
    patterns: [/分数/, /几分之几/, /分母/, /分子/, /约分/],
    essence: "分数运算要先判断数量关系，计算过程中及时约分，并注意单位“1”是否发生变化。",
    hint: "先圈出谁是单位“1”，再把“的”看作乘法。不要一上来就通分，先看能不能约分。",
    steps: [
      "写出题目中的数量关系，确认是求一个数的几分之几，还是已知部分求整体。",
      "把带分数化成假分数，能约分的先约分。",
      "分子乘分子、分母乘分母，最后检查结果能否继续约分。"
    ],
    commonErrors: ["乘法与除法关系混淆", "忘记约分", "没有找准单位“1”"]
  },
  "比和比例": {
    patterns: [
      /比和比例/,
      /比例尺/,
      /比值/,
      /比例/,
      /几比几/,
      /比是/,
      /按比分配/,
      /化简比/,
      /\d+\s*[:∶]\s*\d+/
    ],
    essence: "比表示两个量的倍数关系；比例表示两个比相等。列比例前要先统一前后项的顺序。",
    hint: "先写出两个对应的量，再确认前后项顺序。比例尺问题还要统一图上的长度和实际长度单位。",
    steps: [
      "找出题目中一一对应的两个量，写成“前项∶后项”。",
      "判断是化简比、求比值、按比分配，还是解比例。",
      "列比例后检查两个比是否表示同一种数量关系。"
    ],
    commonErrors: ["前后项顺序写反", "混淆化简比和求比值", "比例尺单位没有统一"]
  },
  "百分数": {
    patterns: [/百分数/, /百分率/, /百分之/, /折扣/, /利率/, /税率/, /成数/, /%/, /％/],
    essence: "百分数表示一个数是另一个数的百分之几。解决百分数问题的核心，是找准单位“1”和变化前后的对应量。",
    hint: "先把“谁比谁多或少百分之几”改写成数量关系，再判断单位“1”是原数还是变化后的数。",
    steps: [
      "圈出单位“1”，标出对应量和比较量。",
      "写出关系式：比较量 ÷ 单位“1”的量 = 百分率。",
      "根据问题选择乘法或除法，最后检查答案是否符合实际大小。"
    ],
    commonErrors: ["单位“1”找错", "增加和降低的百分率方向弄反", "小数、分数、百分数互化错误"]
  },
  "圆": {
    patterns: [/圆/, /半径/, /直径/, /周长/, /圆周率/, /π/, /pi/i],
    essence: "圆的关键量是半径和直径。已知直径要先求半径；周长和面积使用不同公式。",
    hint: "先看题目要求周长还是面积，再写出对应公式。只要题目给了直径，第一步先求半径。",
    steps: [
      "标出半径或直径，统一单位。",
      "选择公式：C=2πr 或 S=πr²。",
      "代入后先算 r²，再与 π 相乘，并检查单位。"
    ],
    commonErrors: ["混淆周长与面积公式", "直径直接当作半径", "面积单位漏写平方"]
  },
  "圆柱与圆锥": {
    patterns: [/圆柱/, /圆锥/, /侧面积/, /表面积/, /体积/, /容积/],
    essence: "圆柱和圆锥问题要先分清求的是侧面积、表面积还是体积，并统一长度单位。",
    hint: "先确认题目的目标量，再决定用哪个公式。圆锥体积别漏掉三分之一。",
    steps: [
      "判断是侧面积、表面积、体积还是容积问题。",
      "先求底面半径，再选择对应公式。",
      "检查是否带单位换算，以及圆锥是否乘了三分之一。"
    ],
    commonErrors: ["表面积和体积公式混用", "圆锥体积漏乘三分之一", "单位不统一"]
  },
  "负数": {
    patterns: [/负数/, /正数/, /数轴/, /相反意义/, /零上/, /零下/],
    essence: "正数和负数表示具有相反意义的量。数轴上越靠右的数越大，0 既不是正数也不是负数。",
    hint: "先给每个数据补上实际意义，例如“海平面以上”记为正。再借助数轴比较大小。",
    steps: [
      "确定题目规定哪一个方向为正。",
      "把生活语言改写成带正负号的数。",
      "在数轴上标出位置，再比较大小或计算变化。"
    ],
    commonErrors: ["相反意义判断反了", "忘记 0 的特殊性", "负数大小比较出错"]
  },
  "统计与扇形统计图": {
    patterns: [/统计/, /扇形/, /条形图/, /折线图/, /平均数/, /中位数/, /众数/],
    essence: "统计图回答不同问题：扇形图看部分与整体的占比，条形图比较数量，折线图看变化趋势。",
    hint: "先看题目的问题需要比较数量、看占比，还是看变化趋势，再选择对应的统计图。",
    steps: [
      "确认扇形统计图表示的是各部分占整体的百分比。",
      "用量率对应关系求整体或某一部分。",
      "对答案做合理性检查：各部分百分比之和应为 100%。"
    ],
    commonErrors: ["把具体数量当作百分比", "部分与整体对应错误", "读图时漏掉图例"]
  },
  "比例与图形": {
    patterns: [/放大/, /缩小/, /图形变换/, /位置与方向/, /数对/, /旋转/, /平移/],
    essence: "图形变换要同时关注形状、大小和位置。按比例放缩时，对应边都按相同倍数变化。",
    hint: "先找一组对应边，再写出它们的变化倍数。检查每个方向是否用了相同的比例。",
    steps: [
      "确认图形是在平移、旋转、放大还是缩小。",
      "找一组对应点或对应边。",
      "按题目给定的方向和比例逐点操作，最后检查大小和位置。"
    ],
    commonErrors: ["只改变一个方向", "对应点找错", "旋转方向看反"]
  },
  "综合应用": {
    patterns: [],
    essence: "综合题需要先把文字信息转化成数量关系，再分步骤解决。",
    hint: "先不急着计算，把已知条件和问题分别圈出来，并写出它们之间的数量关系。",
    steps: [
      "列出已知条件、未知量和最终问题。",
      "判断可以先求出哪一个中间量。",
      "分步计算并回看答案是否回答了原问题。"
    ],
    commonErrors: ["条件遗漏", "答非所问", "中间量含义不清"]
  }
};

export const KNOWLEDGE_POINT_NAMES = Object.keys(KNOWLEDGE_PROFILES);

export function getKnowledgeProfile(name) {
  const profile = KNOWLEDGE_PROFILES[name];
  if (!profile) return null;
  return {
    name,
    essence: profile.essence,
    hint: profile.hint,
    steps: [...profile.steps],
    commonErrors: [...profile.commonErrors]
  };
}

export function inferKnowledgePoint({ question = "", analysis = "" }) {
  const text = `${question} ${analysis}`;
  let best = { name: "综合应用", score: 0 };

  for (const [name, profile] of Object.entries(KNOWLEDGE_PROFILES)) {
    const score = profile.patterns.reduce((total, pattern) => {
      return total + (pattern.test(text) ? 1 : 0);
    }, 0);
    if (score > best.score) {
      best = { name, score };
    }
  }

  return best.name;
}

function inferErrorType({ studentAnswer = "", correctAnswer = "" }) {
  if (!studentAnswer.trim()) {
    return "不会做";
  }
  if (studentAnswer.trim() === correctAnswer.trim()) {
    return "步骤或表达不完整";
  }
  return "计算或关系判断错误";
}

export function normalizeAnswer(value = "") {
  const text = String(value)
    .trim()
    .replace(/\s+/g, "")
    .replace(/[，,]/g, "")
    .replace(/[％%]/g, "%")
    .replace(/[：]/g, ":")
    .toLowerCase();

  const percentMatch = text.match(/^(-?\d+(?:\.\d+)?)%$/);
  if (percentMatch) {
    return String(Number(percentMatch[1]) / 100);
  }

  const fractionMatch = text.match(/^(-?\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
  if (fractionMatch && Number(fractionMatch[2]) !== 0) {
    return String(Number(fractionMatch[1]) / Number(fractionMatch[2]));
  }

  return text;
}

export function parseAnswerValue(value = "") {
  const text = normalizeAnswer(value).replace(/[（）()]/g, "");
  const match = text.match(
    /^(-?\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?([^\d.]*)$/
  );
  if (!match) return null;

  const numerator = Number(match[1]);
  const denominator = match[2] ? Number(match[2]) : 1;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return null;
  }

  let number = numerator / denominator;
  let unit = match[3] || "";
  if (unit === "%") {
    number /= 100;
    unit = "";
  }

  return { number, unit };
}

export function answersMatch(studentAnswer, correctAnswer) {
  const expectedParts = String(correctAnswer || "")
    .split(/[或;；]/)
    .map((part) => part.replace(/[（）()]/g, "").trim())
    .filter(Boolean);
  const student = normalizeAnswer(studentAnswer);

  if (student === normalizeAnswer(correctAnswer)) {
    return true;
  }

  return expectedParts.some((part) => {
    const expected = normalizeAnswer(part);
    if (student === expected) {
      return true;
    }

    const studentValue = parseAnswerValue(studentAnswer);
    const expectedValue = parseAnswerValue(part);
    return (
      studentValue &&
      expectedValue &&
      (!studentValue.unit ||
        !expectedValue.unit ||
        studentValue.unit === expectedValue.unit) &&
      Math.abs(studentValue.number - expectedValue.number) < 1e-9
    );
  });
}

export function diagnoseMistake(input) {
  const question = String(input.question || "").trim();
  const analysis = String(input.analysis || "").trim();
  const inferredPoint = inferKnowledgePoint({ question, analysis });
  const requestedPoint = String(input.knowledgePoint || "").trim();
  const knowledgePoint = KNOWLEDGE_PROFILES[requestedPoint]
    ? requestedPoint
    : inferredPoint;
  const profile = KNOWLEDGE_PROFILES[knowledgePoint];
  const errorType =
    String(input.errorType || "").trim() ||
    inferErrorType({
      studentAnswer: input.studentAnswer,
      correctAnswer: input.correctAnswer
    });

  return {
    knowledgePoint,
    errorType,
    hint: profile.hint,
    methodSteps: profile.steps,
    commonErrors: profile.commonErrors,
    diagnosis: [
      `初步归因：${errorType}。`,
      `知识点核心：${profile.essence}`,
      analysis
        ? `订正时优先对照你的记录：“${analysis}”`
        : "订正时补写一句：我具体错在哪一步，下一步应该先做什么。"
    ].join("\n"),
    confidence: input.knowledgePoint ? "已确认" : "关键词初判"
  };
}
