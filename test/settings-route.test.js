import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSettingsSubpage,
  parseSettingsRoute
} from "../public/settings-route.js";

test("系统配置子路由解析：索引、教材管理、审计日志", () => {
  assert.deepEqual(parseSettingsRoute("#settings"), {
    subpage: null,
    unknown: false
  });
  assert.deepEqual(parseSettingsRoute("#settings/textbooks"), {
    subpage: "textbooks",
    unknown: false
  });
  assert.deepEqual(parseSettingsRoute("#settings/audit"), {
    subpage: "audit",
    unknown: false
  });
  assert.equal(normalizeSettingsSubpage("textbooks"), "textbooks");
  assert.equal(normalizeSettingsSubpage("audit"), "audit");
  assert.equal(normalizeSettingsSubpage("unknown"), null);
  assert.equal(normalizeSettingsSubpage(undefined), null);
});

test("未知或过多层级子路径回退到系统配置索引", () => {
  assert.deepEqual(parseSettingsRoute("#settings/unknown"), {
    subpage: null,
    unknown: true
  });
  assert.deepEqual(parseSettingsRoute("#settings/textbooks/extra"), {
    subpage: null,
    unknown: true
  });
  assert.deepEqual(parseSettingsRoute("#settings/"), {
    subpage: null,
    unknown: false
  });
});

test("其他视图与空哈希不解析系统配置子路径", () => {
  assert.deepEqual(parseSettingsRoute("#knowledge/textbooks"), {
    subpage: null,
    unknown: false
  });
  assert.deepEqual(parseSettingsRoute(""), { subpage: null, unknown: false });
  assert.deepEqual(parseSettingsRoute(null), { subpage: null, unknown: false });
});