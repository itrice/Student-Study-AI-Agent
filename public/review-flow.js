export const REVIEW_AUTO_ADVANCE_DELAY_MS = 1200;

export function reviewQueueIndex(review, queue) {
  const reviewId = Number(review?.id);
  if (!Number.isInteger(reviewId) || !Array.isArray(queue)) return -1;
  return queue.findIndex((item) => Number(item?.id) === reviewId);
}

export function reviewNavigationBoundaries(review, queue) {
  const index = reviewQueueIndex(review, queue);
  return {
    previous: index > 0,
    next: index >= 0 && index < queue.length - 1
  };
}

export function reviewNavigationTarget(review, queue, direction) {
  const index = reviewQueueIndex(review, queue);
  const offset = direction === "previous" || direction === "prev" ? -1 : 1;
  const targetIndex = index + offset;
  if (index < 0 || targetIndex < 0 || targetIndex >= queue.length) {
    return null;
  }
  const item = queue[targetIndex];
  return {
    id: Number(item.id),
    index: targetIndex,
    total: queue.length
  };
}

export function reviewShouldAutoAdvance(result) {
  return Boolean(
    result &&
      result.correct === true &&
      result.outcome === "correct"
  );
}

export function reviewResultTitle(result) {
  if (result?.outcome === "correct") return "这道题全部答对";
  if (result?.outcome === "partial") {
    return "部分小问正确，整题还没做对";
  }
  return "这道题还没做对";
}

export function reviewResultStatus(result) {
  if (result?.outcome === "correct") {
    return result.mastered
      ? "整题全部正确，已达到掌握标准"
      : "整题全部正确";
  }
  if (result?.outcome === "partial") {
    return `本次 ${result.correctPartCount} / ${result.totalPartCount} 个小问正确，整题尚未完成`;
  }
  return "本次作答未通过";
}
