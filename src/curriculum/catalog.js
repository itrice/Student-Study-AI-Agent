export const CURRICULUM_MAPPING_VERSION = "2026.11.15-v1";

export const CURRICULUM_SOURCE_KEYS = {
  renjiaoOutline: "renjiao-outline-v1",
  beishidaOutline: "beishida-outline-v1",
  beishidaSummary: "beishida-self-authored-summary-v1"
};

export const CURRICULUM_SOURCES = [
  {
    key: CURRICULUM_SOURCE_KEYS.beishidaOutline,
    kind: "textbook_outline",
    title: "北师大版六年级数学教材单元目录（人工核对）",
    publisher: "北京师范大学出版社",
    edition: "六年级上册/下册",
    locator: "单元名称与顺序",
    note:
      "仅记录单元结构与术语，不摘录教材正文；北师大版新增编排内容需由任课教师单独审核，不沿用人教版审核结论。",
    verifiedAt: "2026-11-15"
  },
  {
    key: CURRICULUM_SOURCE_KEYS.beishidaSummary,
    kind: "self_authored_summary",
    title: "项目自编北师大版六年级数学知识摘要（待教师审核）",
    publisher: "本项目",
    edition: "2026.11",
    locator: "按北师大版单元与知识点编排",
    note:
      "复用项目既有数学摘要并按北师大版单元位置重新编排；尚未取得任课教师签字，检索结果必须显示待审核状态。",
    verifiedAt: "2026-11-15"
  }
];

const RENJIAO_SOURCE = CURRICULUM_SOURCE_KEYS.renjiaoOutline;
const BEISHIDA_OUTLINE = CURRICULUM_SOURCE_KEYS.beishidaOutline;
const BEISHIDA_SUMMARY = CURRICULUM_SOURCE_KEYS.beishidaSummary;

function unit(unitNo, title, points) {
  return { unitNo, title, points };
}

function point(name, sourceKnowledgeSlug, semanticKeys, aliases = []) {
  return { name, sourceKnowledgeSlug, semanticKeys, aliases };
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
    key: "beishida-6-upper",
    editionKey: "beishida",
    publisher: "北京师范大学出版社",
    edition: "北师大版",
    grade: 6,
    semester: "upper",
    displayName: "北师大版六年级上册",
    selectable: true,
    reviewStatus: "unreviewed",
    sourceKey: BEISHIDA_SUMMARY,
    units: [
      unit(1, "圆", [point("圆", "circle", ["circle"], ["圆的认识", "圆的周长", "圆的面积"])]),
      unit(2, "分数混合运算", [
        point("分数混合运算", "fraction-mixed-operations", [
          "fraction-mul-div",
          "fraction-mixed"
        ], ["分数混合运算（一）", "分数混合运算（二）", "分数混合运算（三）"])
      ]),
      unit(3, "观察物体", [
        point("观察物体", null, ["observation"], [
          "搭积木比赛",
          "观察的范围",
          "天安门广场"
        ])
      ]),
      unit(4, "百分数", [
        point("百分数", "percentage", ["percentage"], ["百分数的认识"])
      ]),
      unit(5, "数据处理", [
        point("数据处理", "statistics-pie", ["statistics"], [
          "扇形统计图",
          "统计图的选择"
        ])
      ]),
      unit(6, "比的认识", [
        point("比的认识", "ratio-proportion", ["ratio"], ["比", "比的化简"])
      ]),
      unit(7, "百分数的应用", [
        point("百分数的应用", "percentage", ["percentage"], [
          "百分数应用",
          "折扣",
          "利息"
        ])
      ]),
      unit(8, "数学好玩", [
        point("数学好玩", "number-and-shape", ["number-shape"], [
          "看图找关系",
          "比赛场次",
          "反弹高度"
        ])
      ]),
      unit(9, "整理与复习", [
        point("整理与复习", "integrated-application", ["integrated"])
      ])
    ]
  },
  {
    key: "beishida-6-lower",
    editionKey: "beishida",
    publisher: "北京师范大学出版社",
    edition: "北师大版",
    grade: 6,
    semester: "lower",
    displayName: "北师大版六年级下册",
    selectable: true,
    reviewStatus: "unreviewed",
    sourceKey: BEISHIDA_SUMMARY,
    units: [
      unit(1, "圆柱与圆锥", [
        point("圆柱与圆锥", "cylinder-cone", ["cylinder-cone"], [
          "圆柱",
          "圆锥"
        ])
      ]),
      unit(2, "比例", [
        point("比例", "ratio-proportion", ["proportion"], ["比例的认识", "解比例"]),
        point("比例尺", "scale-and-figures", ["scale"], ["比例尺的应用"]),
        point("图形的放大与缩小", "scale-and-figures", ["shape-transform"])
      ]),
      unit(3, "图形的运动", [
        point("图形的运动", null, ["shape-motion"], [
          "平移",
          "旋转",
          "轴对称"
        ])
      ]),
      unit(4, "正比例与反比例", [
        point("正比例与反比例", "ratio-proportion", ["proportion", "proportion-function"], [
          "正比例",
          "反比例"
        ])
      ]),
      unit(5, "整理与复习", [
        point("整理与复习", "integrated-application", ["integrated"])
      ])
    ]
  }
];

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

