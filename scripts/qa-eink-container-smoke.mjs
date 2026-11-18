import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const baseUrl = String(process.env.QA_BASE_URL || "http://127.0.0.1:43124")
  .replace(/\/+$/u, "");
const outputDirectory = process.env.QA_OUTPUT_DIR
  ? path.resolve(process.env.QA_OUTPUT_DIR)
  : null;

function digest(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function jsonRequest(url, options) {
  const response = await fetch(url, options);
  assert.equal(
    response.headers.get("content-encoding"),
    null,
    `${url} 不得压缩`
  );
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  return { response, body: await response.json() };
}

async function previewPixels(response) {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  const buffer = Buffer.from(await response.arrayBuffer());
  const image = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.equal(image.info.width, 800);
  assert.equal(image.info.height, 480);
  return {
    buffer,
    pixels: image.data
  };
}

function assertFrameMatchesPreview(frame, pixels) {
  assert.equal(frame.length, 48_000);
  for (let y = 0; y < 480; y += 1) {
    for (let x = 0; x < 800; x += 1) {
      const black =
        (frame[y * 100 + Math.floor(x / 8)] & (0x80 >> (x % 8))) === 0;
      const offset = (y * 800 + x) * 4;
      const expected = black ? 0 : 255;
      assert.equal(pixels[offset], expected);
      assert.equal(pixels[offset + 1], expected);
      assert.equal(pixels[offset + 2], expected);
      assert.equal(pixels[offset + 3], 255);
    }
  }
}

async function fetchPage(id, mode = "question") {
  const startedAt = performance.now();
  const response = await fetch(
    `${baseUrl}/api/eink/page?id=${id}&mode=${mode}`
  );
  const body = Buffer.from(await response.arrayBuffer());
  return { response, body, elapsedMs: performance.now() - startedAt };
}

const health = await (await fetch(`${baseUrl}/api/health`)).json();
assert.equal(health.ok, true);

const { response: queueResponse, body: queue } = await jsonRequest(
  `${baseUrl}/api/eink/queue?limit=20`
);
assert.equal(queueResponse.status, 200);
assert.equal(queue.count, queue.items.length);
assert.ok(queue.count >= 3);
for (const [index, item] of queue.items.entries()) {
  assert.equal(item.index, index + 1);
  assert.deepEqual(
    Object.keys(item).sort(),
    ["hasPhoto", "id", "index", "kp", "partCount"]
  );
}

const textItem = queue.items.find(
  (item) => !item.hasPhoto && item.partCount === 1
);
const multipartItem = queue.items.find(
  (item) => !item.hasPhoto && item.partCount > 1
);
const photoItem = queue.items.find((item) => item.hasPhoto);
assert.ok(textItem, "缺少纯文字题");
assert.ok(multipartItem, "缺少多小问");
assert.ok(photoItem, "缺少照片题");

const evidence = [];
if (outputDirectory) fs.mkdirSync(outputDirectory, { recursive: true });
for (const scenario of [
  { name: "text-question", id: textItem.id, mode: "question" },
  { name: "text-answer", id: textItem.id, mode: "answer" },
  { name: "multipart-question", id: multipartItem.id, mode: "question" },
  { name: "multipart-answer", id: multipartItem.id, mode: "answer" },
  { name: "photo-question", id: photoItem.id, mode: "question" },
  { name: "photo-answer", id: photoItem.id, mode: "answer" }
]) {
  const page = await fetchPage(scenario.id, scenario.mode);
  assert.equal(page.response.status, 200);
  assert.equal(
    page.response.headers.get("content-type"),
    "application/octet-stream"
  );
  assert.equal(page.response.headers.get("content-length"), "48000");
  assert.equal(page.response.headers.get("content-encoding"), null);
  assert.equal(page.response.headers.get("cache-control"), "no-transform");
  assert.equal(
    page.response.headers.get("x-content-type-options"),
    "nosniff"
  );
  const etag = page.response.headers.get("etag");
  assert.match(etag, /^"[0-9a-f]{64}"$/);
  assert.equal(page.response.headers.get("x-etag"), etag);

  const previewResponse = await fetch(
    `${baseUrl}/api/eink/preview?id=${scenario.id}&mode=${scenario.mode}`
  );
  assert.equal(previewResponse.headers.get("cache-control"), "no-store");
  const preview = await previewPixels(previewResponse);
  assertFrameMatchesPreview(page.body, preview.pixels);
  if (outputDirectory) {
    fs.writeFileSync(
      path.join(outputDirectory, `${scenario.name}.png`),
      preview.buffer
    );
  }
  evidence.push({
    ...scenario,
    frameBytes: page.body.length,
    frameSha256: digest(page.body),
    previewSha256: digest(preview.buffer),
    etag,
    elapsedMs: Number(page.elapsedMs.toFixed(2))
  });
}

const first = await fetchPage(textItem.id);
const notModified = await fetch(`${baseUrl}/api/eink/page?id=${textItem.id}`, {
  headers: { "If-None-Match": first.response.headers.get("etag") }
});
assert.equal(notModified.status, 304);
assert.equal(notModified.headers.get("content-length"), null);
assert.equal((await notModified.arrayBuffer()).byteLength, 0);

for (const query of [
  "id=abc",
  "id=0",
  `id=${textItem.id}&mode=hint`
]) {
  const { response, body } = await jsonRequest(
    `${baseUrl}/api/eink/page?${query}`
  );
  assert.equal(response.status, 400);
  assert.match(response.headers.get("content-type"), /^application\/json/u);
  assert.ok(body.error);
}
const missing = await fetch(`${baseUrl}/api/eink/page?id=999999999`);
assert.equal(missing.status, 404);
assert.match(missing.headers.get("content-type"), /^application\/json/u);

const serial = [];
for (let index = 0; index < 20; index += 1) {
  const page = await fetchPage(textItem.id);
  assert.equal(page.response.status, 200);
  assert.equal(page.body.length, 48_000);
  serial.push(Number(page.elapsedMs.toFixed(2)));
}

process.stdout.write(
  `${JSON.stringify(
    {
      baseUrl,
      health: {
        schemaVersion: health.schemaVersion,
        toolCount: health.toolCount
      },
      queue: {
        count: queue.count,
        itemCount: queue.items.length
      },
      evidence,
      notModified: {
        status: notModified.status,
        bodyBytes: 0
      },
      serialRequests: {
        count: serial.length,
        maxMs: Math.max(...serial),
        averageMs: Number(
          (serial.reduce((sum, value) => sum + value, 0) / serial.length).toFixed(2)
        )
      }
    },
    null,
    2
  )}\n`
);
