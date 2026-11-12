export const MAX_PAGE_BUTTONS = 5;

export function getPageSize(width) {
  if (width <= 560) return 5;
  if (width <= 1100) return 8;
  return 10;
}

export function clampPage(page, pageCount) {
  const safeCount = Math.max(1, pageCount);
  const requested = Number.isInteger(page) ? page : 1;
  return Math.min(Math.max(1, requested), safeCount);
}

export function pageForFirstItem(firstIndex, pageSize) {
  const safeSize = Math.max(1, pageSize);
  return Math.floor(Math.max(0, firstIndex) / safeSize) + 1;
}

export function paginationWindow(page, pageCount) {
  if (pageCount <= 7) {
    return Array.from({ length: pageCount }, (_, index) => index + 1);
  }
  const neighbors = Math.floor((MAX_PAGE_BUTTONS - 2) / 2);
  const values = [1];
  const from = Math.max(2, page - neighbors);
  const to = Math.min(pageCount - 1, page + neighbors);
  if (from > 2) values.push("gap");
  for (let value = from; value <= to; value += 1) values.push(value);
  if (to < pageCount - 1) values.push("gap");
  values.push(pageCount);
  return values;
}
