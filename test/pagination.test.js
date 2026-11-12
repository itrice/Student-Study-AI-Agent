import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_PAGE_BUTTONS,
  clampPage,
  getPageSize,
  pageForFirstItem,
  paginationWindow
} from "../public/pagination.js";

test("错题列表按设备宽度选择每页条数", () => {
  assert.equal(getPageSize(390), 5);
  assert.equal(getPageSize(560), 5);
  assert.equal(getPageSize(561), 8);
  assert.equal(getPageSize(834), 8);
  assert.equal(getPageSize(1100), 8);
  assert.equal(getPageSize(1101), 10);
});

test("页码窗口最多显示五个页码并保留首尾页", () => {
  for (let page = 1; page <= 100; page += 1) {
    const values = paginationWindow(page, 100);
    const numbers = values.filter((value) => typeof value === "number");
    assert.ok(numbers.length <= MAX_PAGE_BUTTONS);
    assert.equal(numbers[0], 1);
    assert.equal(numbers.at(-1), 100);
    assert.ok(numbers.includes(page));
  }
  assert.ok(paginationWindow(50, 100).includes("gap"));
  assert.deepEqual(paginationWindow(2, 5), [1, 2, 3, 4, 5]);
});

test("尺寸变化时按当前首条错题换算页码", () => {
  assert.equal(pageForFirstItem(10, 5), 3);
  assert.equal(pageForFirstItem(10, 8), 2);
  assert.equal(pageForFirstItem(0, 8), 1);
});

test("删除末页最后一条后回退到有效页", () => {
  assert.equal(clampPage(2, 1), 1);
  assert.equal(clampPage(3, 2), 2);
  assert.equal(clampPage(5, 0), 1);
  assert.equal(clampPage(0, 4), 1);
  assert.equal(clampPage(Number.NaN, 4), 1);
});
