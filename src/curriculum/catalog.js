export const CURRICULUM_MAPPING_VERSION = "2026.11.15-v2";

export const CURRICULUM_SOURCE_KEYS = {
  renjiaoOutline: "renjiao-outline-v1",
  beishida2024Outline: "beishida-2024-outline-v1",
  beishida2024Summary: "beishida-2024-self-authored-summary-v1"
};

export const CURRICULUM_SOURCES = [
  {
    key: CURRICULUM_SOURCE_KEYS.beishida2024Outline,
    kind: "textbook_outline",
    title: "北师大版（2024）六年级数学教材单元目录（2026 秋启用，人工核对）",
    publisher: "北京师范大学出版社",
    edition: "北师大版（2024）六年级上册/下册",
    locator: "2026 年秋季学期六年级使用的 2024 版教材单元与课时顺序",
    note:
      "仅记录 2024 版教材单元结构与术语，不摘录教材正文；新版新增编排内容需由任课教师单独审核，不沿用人教版审核结论。",
    verifiedAt: "2026-11-15"
  },
  {
    key: CURRICULUM_SOURCE_KEYS.beishida2024Summary,
    kind: "self_authored_summary",
    title: "项目自编北师大版（2024）六年级数学知识摘要（待教师审核）",
    publisher: "本项目",
    edition: "2026.11（2024 版教材编排）",
    locator: "按北师大版（2024）六年级上册/下册单元与知识点编排",
    note:
      "复用项目既有数学摘要并按 2024 版北师大教材单元位置重新编排；尚未取得任课教师签字，检索结果必须显示待审核状态。",
    verifiedAt: "2026-11-15"
  }
];

const RENJIAO_SOURCE = CURRICULUM_SOURCE_KEYS.renjiaoOutline;
const BEISHIDA_OUTLINE = CURRICULUM_SOURCE_KEYS.beishida2024Outline;
const BEISHIDA_SUMMARY = CURRICULUM_SOURCE_KEYS.beishida2024Summary;

function unit(unitNo, title, points) {
  return { unitNo, title, points };
}

function point(name, sourceKnowledgeSlug, semanticKeys, aliases = [], options = {}) {
  return {
    name,
    sourceKnowledgeSlug,
    semanticKeys,
    aliases,
    newOnly: Boolean(options.newOnly)
  };
}

export const TEXTBOOK_CATALOGS = [
  {
    key: "renjiao-6-all",
    editionKey: "renjiao",
    publisher: "人民教育出版社",
    edition: "人教版",
    grade: 6,
    semester: "full",
    displayName: "人教版六年级（上册/下册）",
    selectable: true,
    reviewStatus: "self_reviewed",
    sourceKey: RENJIAO_SOURCE,
    units: [
      unit(1, "六年级全册", [
        point("分数乘除法", "fraction-mul-div", ["fraction-mul-div"], [
          "分数乘法",
          "分数除法"
        ]),
        point("分数四则混合运算", "fraction-mixed-operations", [
          "fraction-mixed"
        ]),
        point("比和比例", "ratio-proportion", ["ratio", "proportion"]),
        point("比例与图形", "scale-and-figures", [
          "scale",
          "shape-transform"
        ]),
        point("圆", "circle", ["circle"]),
        point("圆柱与圆锥", "cylinder-cone", ["cylinder-cone"]),
        point("百分数", "percentage", ["percentage"]),
        point("统计与扇形统计图", "statistics-pie", ["statistics"]),
        point("数与形", "number-and-shape", ["number-shape"]),
        point("负数", "negative-numbers", ["negative"]),
        point("位置与方向", "position-direction", ["position-direction"]),
        point("综合应用", "integrated-application", ["integrated"])
      ])
    ]
  },
  {
    key: "renjiao-6-upper",
    editionKey: "renjiao",
    publisher: "人民教育出版社",
    edition: "人教版",
    grade: 6,
    semester: "upper",
    displayName: "人教版六年级上册",
    selectable: true,
    reviewStatus: "self_reviewed",
    sourceKey: RENJIAO_SOURCE,
    units: [
      unit(1, "分数乘法", [
        point("分数乘除法", "fraction-mul-div", ["fraction-mul-div"])
      ]),
      unit(2, "位置与方向（二）", [
        point("位置与方向", "position-direction", ["position-direction"])
      ]),
      unit(3, "分数除法", [
        point("分数四则混合运算", "fraction-mixed-operations", [
          "fraction-mixed"
        ])
      ]),
      unit(4, "比", [point("比和比例", "ratio-proportion", ["ratio", "proportion"])]),
      unit(5, "圆", [point("圆", "circle", ["circle"])]),
      unit(6, "百分数（一）", [point("百分数", "percentage", ["percentage"])]),
      unit(7, "扇形统计图", [
        point("统计与扇形统计图", "statistics-pie", ["statistics"])
      ]),
      unit(8, "数学广角——数与形", [
        point("数与形", "number-and-shape", ["number-shape"])
      ])
    ]
  },
  {
    key: "renjiao-6-lower",
    editionKey: "renjiao",
    publisher: "人民教育出版社",
    edition: "人教版",
    grade: 6,
    semester: "lower",
    displayName: "人教版六年级下册",
    selectable: true,
    reviewStatus: "self_reviewed",
    sourceKey: RENJIAO_SOURCE,
    units: [
      unit(1, "负数", [point("负数", "negative-numbers", ["negative"])]),
      unit(2, "百分数（二）", [point("百分数", "percentage", ["percentage"])]),
      unit(3, "圆柱与圆锥", [
        point("圆柱与圆锥", "cylinder-cone", ["cylinder-cone"])
      ]),
      unit(4, "比例", [
        point("比和比例", "ratio-proportion", ["ratio", "proportion"]),
        point("比例与图形", "scale-and-figures", ["scale", "shape-transform"])
      ]),
      unit(5, "整理和复习", [
        point("综合应用", "integrated-application", ["integrated"])
      ])
    ]
  },
  {
    key: "beishida-2024-6-upper",
    editionKey: "beishida-2024",
    publisher: "北京师范大学出版社",
    edition: "北师大版（2024）",
    grade: 6,
    semester: "upper",
    displayName: "北师大版（2024）六年级上册（2026秋）",
    selectable: true,
    reviewStatus: "unreviewed",
    sourceKey: BEISHIDA_SUMMARY,
    units: [
      unit(1, "分数除法", [
        point("分数除法", "fraction-mul-div", ["fraction-mul-div"], [
          "分数除法（一）",
          "分数除法（二）",
          "分数除法（三）"
        ])
      ]),
      unit(2, "圆", [
        point("圆", "circle", ["circle"], [
          "车轮为什么是圆的",
          "圆的认识（一）",
          "圆的认识（二）",
          "修复铜镜",
          "欣赏与设计",
          "圆的周长",
          "圆周率的历史",
          "圆的面积（一）",
          "圆的面积（二）"
        ])
      ]),
      unit(3, "综合实践：制订节水方案", [
        point("制订节水方案", null, ["practice-water"], [
          "水是生命之源",
          "调查用水情况",
          "滴水实验"
        ])
      ]),
      unit(4, "用字母表示（二）", [
        point(
          "用字母表示（二）",
          null,
          ["algebra-expression"],
          [
            "用字母表示数量关系",
            "探索规律（一）",
            "探索规律（二）",
            "日历中的数量关系",
            "花坛的周长"
          ],
          { newOnly: true }
        )
      ]),
      unit(5, "分数的应用", [
        point("分数的应用", "fraction-mixed-operations", ["fraction-mixed"], [
          "分数的应用（一）",
          "分数的应用（二）",
          "分数的应用（三）"
        ])
      ]),
      unit(6, "比的认识", [
        point("比的认识", "ratio-proportion", ["ratio"], [
          "生活中的比（一）",
          "生活中的比（二）",
          "比的化简",
          "比例的认识"
        ])
      ]),
      unit(7, "确定位置", [
        point("确定位置", "position-direction", ["position-direction"], [
          "象群北迁（一）",
          "象群北迁（二）",
          "象群北迁（三）"
        ])
      ]),
      unit(8, "数学好玩：五子棋", [
        point("数学好玩", null, ["math-fun"], ["五子棋"])
      ]),
      unit(9, "百分数的认识与应用（一）", [
        point(
          "百分数的认识与应用（一）",
          "percentage",
          ["percentage"],
          ["百分数的认识", "合格率", "餐桌上的百分数", "储蓄中的百分数"]
        )
      ]),
      unit(10, "观察物体（二）", [
        point(
          "观察物体（二）",
          null,
          ["observation"],
          ["有趣的投影", "搭积木"],
          { newOnly: true }
        )
      ]),
      unit(11, "数据的表示和分析（三）", [
        point(
          "数据的表示和分析（三）",
          "statistics-pie",
          ["statistics"],
          [
            "建设适老社会（一）",
            "建设适老社会（二）",
            "身高的情况",
            "身高的变化",
            "扇形统计图"
          ]
        )
      ]),
      unit(12, "综合实践：制订营养食谱", [
        point("制订营养食谱", null, ["practice-nutrition"], [
          "一日三餐",
          "调查营养要求",
          "分析一日三餐食谱",
          "优化设计新食谱",
          "一日食谱交流会"
        ])
      ]),
      unit(13, "总复习", [
        point("总复习", "integrated-application", ["integrated"], [
          "数与代数",
          "图形与几何",
          "统计与概率",
          "综合与实践"
        ])
      ])
    ]
  },
  {
    key: "beishida-2024-6-lower",
    editionKey: "beishida-2024",
    publisher: "北京师范大学出版社",
    edition: "北师大版（2024）",
    grade: 6,
    semester: "lower",
    displayName: "北师大版（2024）六年级下册（2027春）",
    selectable: true,
    reviewStatus: "unreviewed",
    sourceKey: BEISHIDA_SUMMARY,
    units: [
      unit(1, "圆柱和圆锥", [
        point("圆柱和圆锥", "cylinder-cone", ["cylinder-cone"], [
          "圆柱与圆锥",
          "面的旋转",
          "圆柱的表面积",
          "圆柱的体积",
          "圆锥的体积"
        ])
      ]),
      unit(2, "比例", [
        point("比例", "ratio-proportion", ["proportion"], [
          "比例的认识",
          "比例的应用"
        ]),
        point("比例尺", "scale-and-figures", ["scale"], ["比例尺的应用"]),
        point("图形的放大与缩小", "scale-and-figures", ["shape-transform"])
      ]),
      unit(3, "图形的运动", [
        point(
          "图形的运动",
          null,
          ["shape-motion"],
          ["图形的旋转（一）", "图形的旋转（二）", "欣赏与设计"],
          { newOnly: true }
        )
      ]),
      unit(4, "比例和反比例", [
        point(
          "比例和反比例",
          "ratio-proportion",
          ["proportion-function"],
          ["正比例与反比例", "变化的量", "正比例", "画一画", "反比例"],
          { newOnly: true }
        )
      ]),
      unit(5, "数学好玩", [
        point("数学好玩", null, ["math-fun"], [
          "绘制校园平面图",
          "神奇的莫比乌斯带",
          "可爱的小猫"
        ])
      ]),
      unit(6, "整理与复习", [
        point("整理与复习", "integrated-application", ["integrated-review"])
      ]),
      unit(7, "总复习", [
        point("总复习", "integrated-application", ["integrated"], [
          "数与代数",
          "图形与几何",
          "统计与概率",
          "解决问题的策略"
        ])
      ])
    ]
  }
];

function mapping(
  targetPointName,
  status,
  { requiresConfirmation = false, confidence = 0.95, note = "" } = {}
) {
  return { targetPointName, status, requiresConfirmation, confidence, note };
}

export const CURRICULUM_MAPPING_OVERRIDES = {
  "beishida-2024-6-upper": {
    分数乘除法: [
      mapping("分数除法", "renamed", {
        note: "人教版分数乘除法对应北师大 2024 版六上“分数除法”，高置信改名映射。"
      })
    ],
    分数四则混合运算: [
      mapping("分数的应用", "renamed", {
        requiresConfirmation: true,
        confidence: 0.8,
        note: "对应北师大 2024 版六上“分数的应用”，偏应用语境，需人工确认。"
      })
    ],
    比和比例: [
      mapping("比的认识", "renamed", {
        note: "人教版“比和比例”在六上对应北师大 2024 版“比的认识”。"
      })
    ],
    比例与图形: [],
    圆: [
      mapping("圆", "exact", {
        confidence: 1,
        note: "两版教材均以“圆”为单元，名称与核心内容一致。"
      })
    ],
    圆柱与圆锥: [],
    百分数: [
      mapping("百分数的认识与应用（一）", "renamed", {
        note: "对应北师大 2024 版六上“百分数的认识与应用（一）”。"
      })
    ],
    统计与扇形统计图: [
      mapping("数据的表示和分析（三）", "renamed", {
        requiresConfirmation: true,
        confidence: 0.8,
        note: "北师大 2024 版六上以“数据的表示和分析（三）”组织统计内容，需人工确认。"
      })
    ],
    数与形: [],
    负数: [],
    位置与方向: [
      mapping("确定位置", "renamed", {
        note: "人教版“位置与方向”对应北师大 2024 版六上“确定位置”。"
      })
    ],
    综合应用: [
      mapping("总复习", "merged", {
        confidence: 0.9,
        note: "默认归入“总复习”，允许人工改选“制订节水方案”或“制订营养食谱”。"
      }),
      mapping("制订节水方案", "merged", {
        confidence: 0.9,
        note: "综合实践备选目标：制订节水方案。"
      }),
      mapping("制订营养食谱", "merged", {
        confidence: 0.9,
        note: "综合实践备选目标：制订营养食谱。"
      })
    ]
  },
  "beishida-2024-6-lower": {
    分数乘除法: [],
    分数四则混合运算: [],
    比和比例: [
      mapping("比例", "split", {
        requiresConfirmation: true,
        confidence: 0.7,
        note: "人教版“比和比例”在北师大 2024 版六下拆分到“比例”和“比例和反比例”，必须人工确认。"
      }),
      mapping("比例和反比例", "split", {
        requiresConfirmation: true,
        confidence: 0.7,
        note: "拆分目标之一：比例和反比例。"
      })
    ],
    比例与图形: [
      mapping("比例尺", "split", {
        requiresConfirmation: true,
        confidence: 0.7,
        note: "人教版“比例与图形”在北师大 2024 版六下拆分到“比例尺”和“图形的放大与缩小”，必须人工确认。"
      }),
      mapping("图形的放大与缩小", "split", {
        requiresConfirmation: true,
        confidence: 0.7,
        note: "拆分目标之一：图形的放大与缩小。"
      })
    ],
    圆: [],
    圆柱与圆锥: [
      mapping("圆柱和圆锥", "exact", {
        confidence: 1,
        note: "北师大 2024 版六下单元名为“圆柱和圆锥”，内容与人教版一致。"
      })
    ],
    百分数: [],
    统计与扇形统计图: [],
    数与形: [],
    负数: [],
    位置与方向: [],
    综合应用: [
      mapping("总复习", "merged", {
        confidence: 0.9,
        note: "默认归入“总复习”，允许人工改选“整理与复习”。"
      }),
      mapping("整理与复习", "merged", {
        confidence: 0.9,
        note: "综合复习备选目标：整理与复习。"
      })
    ]
  }
};

export const LEGACY_BEISHIDA_TEXTBOOKS = new Map([
  ["beishida-6-upper", "beishida-2024-6-upper"],
  ["beishida-6-lower", "beishida-2024-6-lower"]
]);

export const TEXTBOOK_BY_KEY = new Map(
  TEXTBOOK_CATALOGS.map((textbook) => [textbook.key, textbook])
);

export const CURRICULUM_POINTS = TEXTBOOK_CATALOGS.flatMap((textbook) =>
  textbook.units.flatMap((entry) =>
    entry.points.map((catalogPoint, index) => ({
      ...catalogPoint,
      textbookKey: textbook.key,
      unitNo: entry.unitNo,
      unitTitle: entry.title,
      position: entry.unitNo * 100 + index,
      reviewStatus: textbook.reviewStatus,
      sourceKey: textbook.sourceKey,
      unitSourceKey: textbook.sourceKey
    }))
  )
);

export const CURRICULUM_NEW_POINT_NAMES = new Map(
  TEXTBOOK_CATALOGS.map((textbook) => [
    textbook.key,
    new Set(
      textbook.units.flatMap((entry) =>
        entry.points
          .filter((catalogPoint) => catalogPoint.newOnly)
          .map((catalogPoint) => catalogPoint.name)
      )
    )
  ])
);

