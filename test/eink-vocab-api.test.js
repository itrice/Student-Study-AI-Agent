import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { EINK_FRAME_BYTES } from "../src/eink/render.js";
import { buildVocabFrameSvg } from "../src/eink/vocab.js";
import { toDateKey } from "../src/vocab/schedule.js";
import { startServer, stopServer } from "./helpers/http-fixture.js";

const TODAY = toDateKey(new Date());

async function withEinkVocabServer(callback) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "math-coach-eink-vocab-")
  );
  const server = await startServer({
    directory,
    prefix: "math-coach-eink-vocab-"
  });
  try {
    return await callback(server);
  } finally {
    await stopServer(server.child);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function apiJson(server, pathname, { method = "GET", body } = {}) {
  const response = await fetch(`${server.baseUrl}${pathname}`, {
    method,
    headers:
      body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, data: await response.json() };
}

async function createItems(server, body) {
  const created = await apiJson(server, "/api/vocab/items", {
    method: "POST",
    body
  });
  assert.equal(created.status, 201);
  return created.data;
}

async function fetchFrame(server, pathname, headers) {
  return fetch(`${server.baseUrl}${pathname}`, { headers });
}

async function previewPixels(response) {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  const image = await sharp(Buffer.from(await response.arrayBuffer()))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    width: image.info.width,
    height: image.info.height,
    pixels: image.data
  };
}

function assertFrameMatchesPixels(frame, width, height, pixels) {
  assert.equal(frame.length, EINK_FRAME_BYTES);
  const rowBytes = width / 8;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const black =
        (frame[y * rowBytes + Math.floor(x / 8)] & (0x80 >> (x % 8))) === 0;
      const pixel = (y * width + x) * 4;
      const expected = black ? 0 : 255;
      assert.equal(pixels[pixel], expected);
      assert.equal(pixels[pixel + 1], expected);
      assert.equal(pixels[pixel + 2], expected);
      assert.equal(pixels[pixel + 3], 255);
    }
  }
}

function hasInk(frame) {
  return frame.some((byte) => byte !== 0xff);
}

test("字词提示帧固定 48000 字节并与预览逐像素一致", async () => {
  await withEinkVocabServer(async (server) => {
    await createItems(server, {
      subject: "chinese",
      dueAt: TODAY,
      entries: [
        { term: "月亮", pinyin: "yuè liàng" },
        { term: "星星", pinyin: "xīng xing" }
      ]
    });

    const response = await fetchFrame(
      server,
      "/api/eink/vocab/page?subject=chinese"
    );
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-type"),
      "application/octet-stream"
    );
    assert.equal(response.headers.get("content-length"), "48000");
    assert.equal(response.headers.get("content-encoding"), null);
    assert.equal(response.headers.get("cache-control"), "no-transform");
    const etag = response.headers.get("etag");
    assert.match(etag, /^"[0-9a-f]{64}"$/);
    assert.equal(response.headers.get("x-etag"), etag);
    const frame = Buffer.from(await response.arrayBuffer());
    assert.equal(frame.length, EINK_FRAME_BYTES);
    assert.equal(hasInk(frame), true);

    const preview = await fetchFrame(
      server,
      "/api/eink/vocab/preview?subject=chinese"
    );
    assert.equal(preview.headers.get("cache-control"), "no-store");
    const image = await previewPixels(preview);
    assert.equal(image.width, 800);
    assert.equal(image.height, 480);
    assertFrameMatchesPixels(frame, image.width, image.height, image.pixels);

    const notModified = await fetchFrame(
      server,
      "/api/eink/vocab/page?subject=chinese",
      { "If-None-Match": etag }
    );
    assert.equal(notModified.status, 304);
    assert.equal(notModified.headers.get("etag"), etag);
    assert.equal(notModified.headers.get("content-length"), null);
    assert.equal((await notModified.arrayBuffer()).byteLength, 0);
  });
});

test("英语模式缺省跟随字词设置，显式 mode 改变提示内容与 ETag", async () => {
  await withEinkVocabServer(async (server) => {
    await createItems(server, {
      subject: "english",
      dueAt: TODAY,
      term: "apple",
      meaning: "苹果"
    });

    const defaulted = await fetchFrame(
      server,
      "/api/eink/vocab/page?subject=english"
    );
    assert.equal(defaulted.status, 200);
    const defaultEtag = defaulted.headers.get("etag");
    const defaultFrame = Buffer.from(await defaulted.arrayBuffer());

    const explicitZhToEn = await fetchFrame(
      server,
      "/api/eink/vocab/page?subject=english&index=1&mode=zh_to_en"
    );
    assert.equal(explicitZhToEn.headers.get("etag"), defaultEtag);

    const enToZh = await fetchFrame(
      server,
      "/api/eink/vocab/page?subject=english&mode=en_to_zh"
    );
    assert.equal(enToZh.status, 200);
    const enToZhEtag = enToZh.headers.get("etag");
    const enToZhFrame = Buffer.from(await enToZh.arrayBuffer());
    assert.notEqual(enToZhEtag, defaultEtag);
    assert.equal(enToZhFrame.equals(defaultFrame), false);

    const updated = await apiJson(server, "/api/vocab/settings", {
      method: "PUT",
      body: { englishMode: "en_to_zh" }
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.englishMode, "en_to_zh");

    const followed = await fetchFrame(
      server,
      "/api/eink/vocab/page?subject=english"
    );
    assert.equal(followed.headers.get("etag"), enToZhEtag);
  });
});

test("字词提示帧拒绝非法参数且不返回伪帧", async () => {
  await withEinkVocabServer(async (server) => {
    await createItems(server, {
      subject: "chinese",
      dueAt: TODAY,
      term: "山",
      pinyin: "shān"
    });

    for (const pathname of [
      "/api/eink/vocab/page",
      "/api/eink/vocab/page?subject=math",
      "/api/eink/vocab/page?subject=chinese&index=0",
      "/api/eink/vocab/page?subject=chinese&index=-1",
      "/api/eink/vocab/page?subject=chinese&index=abc",
      "/api/eink/vocab/page?subject=chinese&index=1.5",
      "/api/eink/vocab/page?subject=chinese&index=",
      "/api/eink/vocab/page?subject=chinese&index=2",
      "/api/eink/vocab/page?subject=chinese&mode=zh_to_en",
      "/api/eink/vocab/page?subject=english&mode=pinyin",
      "/api/eink/vocab/preview",
      "/api/eink/vocab/preview?subject=chinese&index=9"
    ]) {
      const response = await fetchFrame(server, pathname);
      assert.equal(response.status, 400, `${pathname} 应返回 400`);
      assert.match(
        response.headers.get("content-type") || "",
        /application\/json/
      );
      const body = await response.json();
      assert.equal(typeof body.error, "string");
      assert.equal(body.error.length > 0, true);
    }

    const outOfRange = await apiJson(
      server,
      "/api/eink/vocab/page?subject=chinese&index=2"
    );
    assert.equal(outOfRange.status, 400);
    assert.equal(outOfRange.data.code, "EINK_VOCAB_INDEX_OUT_OF_RANGE");
  });
});

test("空队列返回今天没有到期字词的提示帧", async () => {
  await withEinkVocabServer(async (server) => {
    for (const subject of ["chinese", "english"]) {
      const response = await fetchFrame(
        server,
        `/api/eink/vocab/page?subject=${subject}&index=5`
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-length"), "48000");
      const frame = Buffer.from(await response.arrayBuffer());
      assert.equal(frame.length, EINK_FRAME_BYTES);
      assert.equal(hasInk(frame), true);

      const preview = await fetchFrame(
        server,
        `/api/eink/vocab/preview?subject=${subject}`
      );
      const image = await previewPixels(preview);
      assert.equal(image.width, 800);
      assert.equal(image.height, 480);
      assertFrameMatchesPixels(
        frame,
        image.width,
        image.height,
        image.pixels
      );
    }
  });
});

test("字词帧遵守每日上限与到期顺序，不混入新词", async () => {
  await withEinkVocabServer(async (server) => {
    const limited = await apiJson(server, "/api/vocab/settings", {
      method: "PUT",
      body: { dailyLimit: 5 }
    });
    assert.equal(limited.status, 200);

    await createItems(server, {
      subject: "chinese",
      dueAt: TODAY,
      entries: Array.from({ length: 6 }, (_, index) => ({
        term: `字${index + 1}`,
        pinyin: `zi${index + 1}`
      }))
    });
    await createItems(server, {
      subject: "chinese",
      term: "新词",
      pinyin: "xin"
    });

    const today = await apiJson(server, "/api/vocab/review/today?subject=chinese");
    assert.equal(today.status, 200);
    assert.equal(today.data.items.length, 5);
    assert.deepEqual(
      today.data.items.map((item) => item.prompt),
      ["zi1", "zi2", "zi3", "zi4", "zi5"]
    );

    for (let index = 1; index <= 5; index += 1) {
      const response = await fetchFrame(
        server,
        `/api/eink/vocab/page?subject=chinese&index=${index}`
      );
      assert.equal(response.status, 200);
      assert.equal(
        (await response.arrayBuffer()).byteLength,
        EINK_FRAME_BYTES
      );
    }
    const beyond = await apiJson(
      server,
      "/api/eink/vocab/page?subject=chinese&index=6"
    );
    assert.equal(beyond.status, 400);
    assert.equal(beyond.data.code, "EINK_VOCAB_INDEX_OUT_OF_RANGE");
  });
});

test("提示帧的渲染输入只包含提示文本，不包含答案", () => {
  const chinese = buildVocabFrameSvg({
    subject: "chinese",
    mode: "pinyin_to_hanzi",
    index: 1,
    total: 2,
    prompt: "yuè liàng",
    empty: false
  });
  assert.match(chinese, /yuè liàng/);
  assert.match(chinese, /语文 · 看拼音写汉字/);
  assert.match(chinese, /1\/2/);
  assert.match(chinese, /写完后到网页或手机勾选/);
  assert.equal(chinese.includes("月亮"), false);

  const zhToEn = buildVocabFrameSvg({
    subject: "english",
    mode: "zh_to_en",
    index: 2,
    total: 3,
    prompt: "苹果",
    empty: false
  });
  assert.match(zhToEn, /英语 · 看中文写英文/);
  assert.match(zhToEn, /苹果/);
  assert.equal(zhToEn.includes("apple"), false);

  const enToZh = buildVocabFrameSvg({
    subject: "english",
    mode: "en_to_zh",
    index: 3,
    total: 3,
    prompt: "apple",
    empty: false
  });
  assert.match(enToZh, /英语 · 看英文写中文/);
  assert.match(enToZh, /apple/);
  assert.equal(enToZh.includes("苹果"), false);

  const empty = buildVocabFrameSvg({
    subject: "chinese",
    mode: "pinyin_to_hanzi",
    index: 0,
    total: 0,
    prompt: "",
    empty: true
  });
  assert.match(empty, /今天没有到期字词/);
  assert.match(empty, /0\/0/);
  assert.equal(empty.includes("看拼音写汉字"), false);
  assert.equal(empty.includes("写完后到网页或手机勾选"), false);
});
