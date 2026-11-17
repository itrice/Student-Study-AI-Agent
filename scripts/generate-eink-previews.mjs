import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import { LearningRepository } from "../src/database.js";
import { AttachmentStore } from "../src/attachments.js";
import { EinkPageService } from "../src/eink/service.js";
import { ensureEinkFonts } from "../src/eink/fonts.js";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const outputDirectory = path.join(
  projectRoot,
  "docs",
  "reports",
  "eink-previews"
);
const temporaryDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "math-coach-eink-previews-")
);
fs.mkdirSync(outputDirectory, { recursive: true });
ensureEinkFonts();

const repository = new LearningRepository(
  path.join(temporaryDirectory, "learning.sqlite")
);
const attachmentStore = new AttachmentStore({
  directory: path.join(temporaryDirectory, "attachments")
});

function makeHomeworkPhoto() {
  const canvas = createCanvas(960, 540);
  const context = canvas.getContext("2d");
  context.fillStyle = "#666";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#f2f2f2";
  context.fillRect(38, 28, canvas.width - 76, canvas.height - 56);
  context.fillStyle = "#111";
  context.font = '36px "Noto Sans SC"';
  context.fillText("圆的半径是 3 厘米，求它的面积。", 88, 126);
  context.fillText("要求：写出公式，计算时 π 取 3.14。", 88, 196);
  context.strokeStyle = "#111";
  context.lineWidth = 3;
  context.beginPath();
  context.arc(300, 382, 116, 0, Math.PI * 2);
  context.stroke();
  context.beginPath();
  context.moveTo(300, 382);
  context.lineTo(416, 382);
  context.stroke();
  context.font = '28px "Noto Sans SC"';
  context.fillText("r = 3 cm", 352, 362);
  return canvas.toBuffer("image/png");
}

function addPhotoMistake(question, parts = []) {
  const saved = attachmentStore.save(makeHomeworkPhoto(), {
    declaredMime: "image/png",
    originalName: "eink-homework.png"
  });
  const attachment = repository.insertAttachment(
    {
      ...saved,
      createdAt: new Date().toISOString()
    },
    { unbound: true }
  );
  return {
    mistake: repository.createMistake({
      question,
      studentAnswer: "18.84 平方厘米",
      correctAnswer: "28.26 平方厘米",
      analysis: "圆的面积 S = πr²。",
      knowledgePoint: "圆",
      errorType: "忘记平方",
      attachmentIds: [attachment.id],
      parts
    }),
    attachment,
    storageKey: saved.storageKey
  };
}

const text = repository.createMistake({
  question: "一个圆的半径是 3 厘米，求它的面积。",
  studentAnswer: "18.84 平方厘米",
  correctAnswer: "28.26 平方厘米",
  analysis: "使用圆面积公式 S = πr²，π 取 3.14。",
  knowledgePoint: "圆",
  errorType: "忘记平方"
});

const longText = repository.createMistake({
  question:
    "学校组织六年级同学参加实践活动。第一组采集了 120 个样本，第二组采集的数量是第一组的四分之三，第三组比第二组多采集百分之二十。请分别求出第二组和第三组采集的样本数量，并说明每一步使用的数量关系。完成后检查单位是否一致，再把三个小组的数据整理成完整的数量关系表。",
  studentAnswer: "90，108",
  correctAnswer: "90 个，108 个",
  analysis: "先求第二组，再求第三组。",
  knowledgePoint: "分数乘除法",
  errorType: "百分数增加量理解错误"
});

const multipart = repository.createMistake({
  question: "一项工程，甲队的工作效率是 1/5，乙队的工作效率是 1/6。",
  studentAnswer: "6:1；1:6",
  correctAnswer: "1:6；6:1",
  analysis: "先分别写出效率比和时间比。",
  knowledgePoint: "比和比例",
  errorType: "前后项对应反了",
  parts: [
    {
      label: "工作效率比",
      prompt: "甲队和乙队的工作效率比",
      studentAnswer: "6:1",
      answerType: "ratio",
      acceptedAnswers: ["1:6"],
      explanation: "甲乙效率分别为 1/5 和 1/6。"
    },
    {
      label: "时间比",
      prompt: "完成同一项工程所需时间比",
      studentAnswer: "1:6",
      answerType: "ratio",
      acceptedAnswers: ["6:1"],
      explanation: "时间与效率成反比。"
    }
  ]
});

const photo = addPhotoMistake("");
const multiPhoto = addPhotoMistake("观察图形并完成两个小问。", [
  {
    label: "第1问",
    prompt: "图中圆的半径是多少？",
    studentAnswer: "6 cm",
    acceptedAnswers: ["3 cm"],
    explanation: "线段从圆心画到圆上一点。"
  },
  {
    label: "第2问",
    prompt: "圆的面积是多少？",
    studentAnswer: "18.84 cm²",
    acceptedAnswers: ["28.26 cm²"],
    explanation: "S = πr²。"
  }
]);

const missing = addPhotoMistake("附件缺失时仍应回退到文字页。");
fs.unlinkSync(
  attachmentStore.storagePath(missing.storageKey)
);

const service = new EinkPageService({
  repository,
  attachmentStore
});

const scenarios = [
  { name: "text-question", id: text.id, mode: "question" },
  { name: "text-answer", id: text.id, mode: "answer" },
  { name: "long-text-question", id: longText.id, mode: "question" },
  { name: "multipart-question", id: multipart.id, mode: "question" },
  { name: "multipart-answer", id: multipart.id, mode: "answer" },
  { name: "photo-question", id: photo.mistake.id, mode: "question" },
  {
    name: "photo-multipart-question",
    id: multiPhoto.mistake.id,
    mode: "question"
  },
  {
    name: "missing-attachment-fallback",
    id: missing.mistake.id,
    mode: "question"
  }
];

const evidence = [];
for (const scenario of scenarios) {
  const coldStarted = performance.now();
  const first = await service.getPage(scenario);
  const coldMs = performance.now() - coldStarted;
  const hotStarted = performance.now();
  const hot = await service.getPage(scenario);
  const hotMs = performance.now() - hotStarted;
  const filename = `${scenario.name}.png`;
  fs.writeFileSync(path.join(outputDirectory, filename), first.png);
  evidence.push({
    ...scenario,
    filename,
    frameBytes: first.frame.length,
    pngBytes: first.png.length,
    etag: first.etag,
    layoutVersion: first.layoutVersion,
    warning: first.warning,
    coldMs: Number(coldMs.toFixed(1)),
    hotMs: Number(hotMs.toFixed(1)),
    hotCacheHit: hot.cacheHit
  });
}

const emptyRepository = new LearningRepository();
const emptyQueue = new EinkPageService({
  repository: emptyRepository,
  attachmentStore: new AttachmentStore({
    directory: path.join(temporaryDirectory, "empty-attachments")
  })
}).getQueue();
emptyRepository.close();

fs.writeFileSync(
  path.join(outputDirectory, "evidence.json"),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), emptyQueue, evidence }, null, 2)}\n`
);

console.log(`已生成 ${evidence.length} 张墨水屏预览：${outputDirectory}`);
repository.close();
fs.rmSync(temporaryDirectory, { recursive: true, force: true });
