import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import {
  jsonBody,
  projectRoot,
  startServer,
  stopServer
} from "./helpers/http-fixture.js";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2fXkAAAAASUVORK5CYII=",
  "base64"
);

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function makePng(width, height, [red, green, blue, alpha = 255]) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rowBytes = width * 4 + 1;
  const pixels = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * rowBytes;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 4;
      pixels[offset] = red;
      pixels[offset + 1] = green;
      pixels[offset + 2] = blue;
      pixels[offset + 3] = alpha;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

test(
  "HTTP 图片上传、纯图片错题、修改与删除在非安全上下文可用",
  { timeout: 30_000 },
  async () => {
    const server = await startServer({ prefix: "math-coach-m9-http-" });
    const { child, directory, attachmentsDirectory, baseUrl } = server;

    try {
      const health = await jsonBody(await fetch(`${baseUrl}/api/health`));
      assert.equal(health.ok, true);
      assert.match(health.startedAt, /^\d{4}-\d{2}-\d{2}T/);
      const packageVersion = JSON.parse(
        fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")
      ).version;
      assert.equal(health.build.version, packageVersion);
      assert.equal(health.build.versionLabel, `v${packageVersion}`);
      assert.equal(health.appVersion, packageVersion);
      for (const fingerprint of [
        health.build.server,
        health.build.appJs,
        health.build.indexHtml,
        health.build.stylesCss
      ]) {
        assert.match(fingerprint, /^[0-9a-f]{12}$/);
      }
      const homePage = await (await fetch(`${baseUrl}/`)).text();
      assert.match(
        homePage,
        new RegExp(`/app\\.js\\?v=${health.build.appJs}`)
      );
      assert.match(
        homePage,
        new RegExp(`/styles\\.css\\?v=${health.build.stylesCss}`)
      );
      assert.match(
        homePage,
        new RegExp(
          `<span class="app-version-release">${health.build.versionLabel}</span>`
        )
      );
      assert.match(
        homePage,
        new RegExp(`构建 ${health.build.appJs}`)
      );
      assert.doesNotMatch(
        homePage,
        /__APP_VERSION__|__STYLES_VERSION__|__RELEASE_VERSION__|__BUILD_ID__/
      );
      assert.equal(
        health.capabilities.mistakeUpdate.postUpdate,
        "/api/mistakes/:id/update"
      );
      assert.equal(
        health.capabilities.mistakeUpdate.patch,
        "/api/mistakes/:id"
      );

      const missingRoute = await fetch(`${baseUrl}/api/not-a-route`, {
        method: "POST"
      });
      assert.equal(missingRoute.status, 404);
      assert.equal((await jsonBody(missingRoute)).code, "ROUTE_NOT_FOUND");

      const rejected = await fetch(`${baseUrl}/api/attachments?kind=question`, {
        method: "POST",
        headers: { "Content-Type": "image/jpeg" },
        body: PNG
      });
      assert.equal(rejected.status, 400);
      assert.match((await jsonBody(rejected)).error, /格式与文件内容不一致/);

      const upload = await fetch(`${baseUrl}/api/attachments?kind=question`, {
        method: "POST",
        headers: {
          "Content-Type": "image/png",
          "X-Original-Name": encodeURIComponent("private-name.png")
        },
        body: PNG
      });
      assert.equal(upload.status, 201);
      const attachment = await jsonBody(upload);
      assert.equal(attachment.mimeType, "image/png");
      assert.equal(attachment.url, `/api/attachments/${attachment.id}`);
      assert.equal("storageKey" in attachment, false);
      assert.equal("originalName" in attachment, false);

      const image = await fetch(`${baseUrl}${attachment.url}`);
      assert.equal(image.status, 200);
      assert.equal(image.headers.get("cache-control"), "private, no-store");
      assert.equal(image.headers.get("x-content-type-options"), "nosniff");
      assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);

      const create = await fetch(`${baseUrl}/api/mistakes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: "",
          correctAnswer: "42",
          knowledgePoint: "百分数",
          errorType: "不会做",
          attachmentIds: [attachment.id]
        })
      });
      assert.equal(create.status, 201);
      const mistake = await jsonBody(create);
      assert.equal(mistake.question, "");
      assert.equal(mistake.attachments[0].id, attachment.id);

      const review = await jsonBody(
        await fetch(`${baseUrl}/api/review/${mistake.id}`)
      );
      assert.equal(review.attachments[0].id, attachment.id);
      const dashboard = await jsonBody(await fetch(`${baseUrl}/api/dashboard`));
      assert.equal(dashboard.nextReview.id, mistake.id);
      assert.equal(dashboard.nextReview.attachments[0].id, attachment.id);
      assert.equal(dashboard.recent[0].attachments[0].id, attachment.id);

      const replacementUpload = await fetch(
        `${baseUrl}/api/attachments?kind=question`,
        {
          method: "POST",
          headers: { "Content-Type": "image/png" },
          body: PNG
        }
      );
      const replacement = await jsonBody(replacementUpload);
      const update = await fetch(`${baseUrl}/api/mistakes/${mistake.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "m9-http-update-1"
        },
        body: JSON.stringify({
          question: "修改后的图片题",
          attachmentIds: [replacement.id]
        })
      });
      assert.equal(update.status, 200);
      const updated = await jsonBody(update);
      assert.equal(updated.mistake.question, "修改后的图片题");
      assert.deepEqual(
        updated.mistake.attachments.map((item) => item.id),
        [replacement.id]
      );

      const filesAfterReplace = fs.readdirSync(attachmentsDirectory);
      assert.equal(filesAfterReplace.length, 1);

      const primaryUpdate = await fetch(
        `${baseUrl}/api/mistakes/${mistake.id}/update`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "m9-http-update-post-1"
          },
          body: JSON.stringify({
            question: "通过兼容接口修改后的图片题",
            studentAnswer: "41",
            correctAnswer: "42",
            analysis: "先统一单位，再按百分数意义计算。",
            knowledgePoint: "百分数",
            errorType: "计算错误",
            attachmentIds: [replacement.id]
          })
        }
      );
      assert.equal(primaryUpdate.status, 200);
      const primaryResult = await jsonBody(primaryUpdate);
      assert.equal(primaryResult.mistake.question, "通过兼容接口修改后的图片题");
      assert.equal(primaryResult.mistake.analysis, "先统一单位，再按百分数意义计算。");
      assert.equal(primaryResult.mistake.knowledgePoint, "百分数");
      assert.equal(primaryResult.mistake.errorType, "计算错误");
      assert.deepEqual(
        primaryResult.mistake.attachments.map((item) => item.id),
        [replacement.id]
      );

      const editSession = await jsonBody(
        await fetch(`${baseUrl}/api/mistakes/${mistake.id}/edit-session`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirmed: true })
        })
      );
      const persisted = await jsonBody(
        await fetch(`${baseUrl}/api/mistakes/${mistake.id}/edit`, {
          headers: { "X-Edit-Session": editSession.token }
        })
      );
      assert.equal(persisted.question, "通过兼容接口修改后的图片题");
      assert.equal(persisted.studentAnswer, "41");
      assert.equal(persisted.correctAnswer, "42");
      assert.equal(persisted.analysis, "先统一单位，再按百分数意义计算。");
      assert.equal(persisted.knowledgePoint, "百分数");
      assert.equal(persisted.errorType, "计算错误");
      assert.deepEqual(
        persisted.attachments.map((item) => item.id),
        [replacement.id]
      );

      const unboundUpload = await fetch(
        `${baseUrl}/api/attachments?kind=question`,
        {
          method: "POST",
          headers: { "Content-Type": "image/png" },
          body: PNG
        }
      );
      const unbound = await jsonBody(unboundUpload);
      const deleteUnbound = await fetch(`${baseUrl}/api/attachments/${unbound.id}`, {
        method: "DELETE"
      });
      assert.equal(deleteUnbound.status, 200);
      assert.equal(fs.readdirSync(attachmentsDirectory).length, 1);

      const remove = await fetch(`${baseUrl}/api/mistakes/${mistake.id}`, {
        method: "DELETE"
      });
      assert.equal(remove.status, 200);
      assert.equal(fs.readdirSync(attachmentsDirectory).length, 0);

      const persistedLog = server.logs();
      assert.doesNotMatch(persistedLog, /private-name\.png/);
      assert.equal(fs.existsSync(path.join(attachmentsDirectory, filesAfterReplace[0])), false);
    } finally {
      await stopServer(child);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
);

test(
  "HTTP 裁剪默认展示派生图、保留原图、支持恢复和删除清理",
  { timeout: 30_000 },
  async () => {
    const server = await startServer({ prefix: "math-coach-crop-http-" });
    const { child, directory, attachmentsDirectory, baseUrl } = server;

    const original = makePng(8, 6, [20, 90, 140]);
    const cropped = makePng(4, 3, [200, 60, 30]);
    const cropHeaders = {
      "X-Crop-X": "1",
      "X-Crop-Y": "1",
      "X-Crop-Width": "4",
      "X-Crop-Height": "3",
      "X-Crop-Rotation": "0",
      "X-Crop-Source-Width": "8",
      "X-Crop-Source-Height": "6"
    };

    try {
      const upload = await fetch(`${baseUrl}/api/attachments?kind=question`, {
        method: "POST",
        headers: { "Content-Type": "image/png" },
        body: original
      });
      assert.equal(upload.status, 201);
      const attachment = await jsonBody(upload);
      assert.equal(attachment.hasCrop, false);
      assert.match(attachment.displayUrl, /variant=original/);

      const crop = await fetch(
        `${baseUrl}/api/attachments/${attachment.id}/crop`,
        {
          method: "POST",
          headers: { "Content-Type": "image/png", ...cropHeaders },
          body: cropped
        }
      );
      assert.equal(crop.status, 200);
      const withCrop = await jsonBody(crop);
      assert.equal(withCrop.hasCrop, true);
      assert.equal(withCrop.crop.x, 1);
      assert.equal(withCrop.crop.width, 4);
      assert.equal(fs.readdirSync(attachmentsDirectory).length, 2);

      const defaultImage = await fetch(`${baseUrl}${withCrop.url}`);
      assert.equal(defaultImage.status, 200);
      assert.equal(defaultImage.headers.get("cache-control"), "private, no-store");
      assert.deepEqual(Buffer.from(await defaultImage.arrayBuffer()), cropped);

      const originalImage = await fetch(`${baseUrl}${withCrop.originalUrl}`);
      assert.equal(originalImage.status, 200);
      assert.deepEqual(Buffer.from(await originalImage.arrayBuffer()), original);

      const invalid = await fetch(
        `${baseUrl}/api/attachments/${attachment.id}/crop`,
        {
          method: "POST",
          headers: {
            "Content-Type": "image/png",
            ...cropHeaders,
            "X-Crop-X": "7"
          },
          body: cropped
        }
      );
      assert.equal(invalid.status, 400);
      assert.match((await jsonBody(invalid)).error, /超出图片范围/);
      assert.equal(fs.readdirSync(attachmentsDirectory).length, 2);

      const reset = await fetch(
        `${baseUrl}/api/attachments/${attachment.id}/crop`,
        { method: "DELETE" }
      );
      assert.equal(reset.status, 200);
      const withoutCrop = await jsonBody(reset);
      assert.equal(withoutCrop.hasCrop, false);
      assert.equal(fs.readdirSync(attachmentsDirectory).length, 1);

      const create = await fetch(`${baseUrl}/api/mistakes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: "",
          correctAnswer: "42",
          knowledgePoint: "百分数",
          errorType: "不会做",
          attachmentIds: [attachment.id]
        })
      });
      const mistake = await jsonBody(create);
      const remove = await fetch(`${baseUrl}/api/mistakes/${mistake.id}`, {
        method: "DELETE"
      });
      assert.equal(remove.status, 200);
      assert.equal(fs.readdirSync(attachmentsDirectory).length, 0);

      const persistedLog = server.logs();
      assert.doesNotMatch(persistedLog, /storage_key|x-crop-source/i);
    } finally {
      await stopServer(child);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
);
