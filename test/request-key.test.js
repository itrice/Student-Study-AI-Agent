import test from "node:test";
import assert from "node:assert/strict";

import { createRequestKey } from "../public/request-key.js";

test("请求键优先使用 crypto.randomUUID", () => {
  assert.equal(
    createRequestKey({ randomUUID: () => "native-uuid" }),
    "native-uuid"
  );
});

test("非安全上下文使用 getRandomValues 生成 UUID v4", () => {
  const key = createRequestKey({
    getRandomValues(bytes) {
      bytes.set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
      return bytes;
    }
  });

  assert.equal(key, "00010203-0405-4607-8809-0a0b0c0d0e0f");
});

test("randomUUID 抛错时回退到 getRandomValues", () => {
  const key = createRequestKey({
    randomUUID() {
      throw new TypeError("randomUUID is not a function");
    },
    getRandomValues(bytes) {
      bytes.fill(0);
      return bytes;
    }
  });

  assert.equal(key, "00000000-0000-4000-8000-000000000000");
});

test("完全不支持 Web Crypto 时仍生成唯一请求键", () => {
  const keys = new Set(
    Array.from({ length: 100 }, () => createRequestKey({}))
  );

  assert.equal(keys.size, 100);
  for (const key of keys) {
    assert.match(key, /^req-[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/);
    assert.ok(key.length <= 200);
  }
});
