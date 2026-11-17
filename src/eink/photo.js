import { createCanvas, loadImage } from "@napi-rs/canvas";

export const PHOTO_AREA = Object.freeze({
  x: 6,
  y: 56,
  width: 788,
  height: 420
});

const THUMB_WIDTH = 120;
const THUMB_HEIGHT = 90;
const PAPER_BRIGHTNESS = 195;
const PAPER_MIN_FRACTION = 0.55;
const INK_BRIGHTNESS = 160;
const EDGE_PADDING = 8;
const BLUR_WINDOW = 11;
const LOCAL_OFFSET = 10;

function grayAt(data, offset) {
  return (
    data[offset] * 0.299 +
    data[offset + 1] * 0.587 +
    data[offset + 2] * 0.114
  );
}

function boundsFor(data, width, height, predicate) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      if (!predicate(grayAt(data, offset))) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX || maxY < minY) return null;
  return { minX, minY, maxX, maxY };
}

function isEmptyOrFull(bounds, width, height) {
  if (!bounds) return true;
  return (
    bounds.minX === 0 &&
    bounds.minY === 0 &&
    bounds.maxX === width - 1 &&
    bounds.maxY === height - 1
  );
}

export function findPaperCropBounds(image) {
  const thumb = createCanvas(THUMB_WIDTH, THUMB_HEIGHT);
  const context = thumb.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, THUMB_WIDTH, THUMB_HEIGHT);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, THUMB_WIDTH, THUMB_HEIGHT);
  const pixels = context.getImageData(
    0,
    0,
    THUMB_WIDTH,
    THUMB_HEIGHT
  ).data;

  let bounds = boundsFor(
    pixels,
    THUMB_WIDTH,
    THUMB_HEIGHT,
    (gray) => gray >= PAPER_BRIGHTNESS
  );
  const paperArea = bounds
    ? (bounds.maxX - bounds.minX + 1) * (bounds.maxY - bounds.minY + 1)
    : 0;
  if (!bounds || paperArea < PAPER_MIN_FRACTION * THUMB_WIDTH * THUMB_HEIGHT) {
    bounds = boundsFor(
      pixels,
      THUMB_WIDTH,
      THUMB_HEIGHT,
      (gray) => gray < INK_BRIGHTNESS
    );
  }
  if (!bounds || isEmptyOrFull(bounds, THUMB_WIDTH, THUMB_HEIGHT)) {
    return { x: 0, y: 0, width: image.width, height: image.height };
  }

  const x = Math.max(0, Math.floor(bounds.minX * image.width / THUMB_WIDTH));
  const y = Math.max(0, Math.floor(bounds.minY * image.height / THUMB_HEIGHT));
  const right = Math.min(
    image.width,
    Math.ceil((bounds.maxX + 1) * image.width / THUMB_WIDTH)
  );
  const bottom = Math.min(
    image.height,
    Math.ceil((bounds.maxY + 1) * image.height / THUMB_HEIGHT)
  );
  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y)
  };
}

export function cropImage(image, bounds) {
  if (
    bounds.x === 0 &&
    bounds.y === 0 &&
    bounds.width === image.width &&
    bounds.height === image.height
  ) {
    return image;
  }
  const canvas = createCanvas(bounds.width, bounds.height);
  const context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, bounds.width, bounds.height);
  context.drawImage(
    image,
    bounds.x,
    bounds.y,
    bounds.width,
    bounds.height,
    0,
    0,
    bounds.width,
    bounds.height
  );
  return canvas;
}

export function padImage(image, padding = EDGE_PADDING) {
  const canvas = createCanvas(
    image.width + padding * 2,
    image.height + padding * 2
  );
  const context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, padding, padding);
  return canvas;
}

export async function prepareEinkPhoto(buffer, { skipPaperCrop = false } = {}) {
  const image = await loadImage(buffer);
  if (!image.width || !image.height) {
    throw new Error("图片尺寸无效");
  }
  let prepared = image;
  if (!skipPaperCrop) {
    // @napi-rs/canvas applies EXIF Orientation while decoding loadImage().
    prepared = cropImage(prepared, findPaperCropBounds(prepared));
  }
  return padImage(prepared);
}

export function adaptiveThreshold(pixels, width, height) {
  const gray = new Uint8ClampedArray(width * height);
  const integral = new Uint32Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = (y * width + x) * 4;
      gray[y * width + x] = Math.round(grayAt(pixels, pixel));
    }
  }
  for (let y = 1; y <= height; y += 1) {
    let rowSum = 0;
    for (let x = 1; x <= width; x += 1) {
      rowSum += gray[(y - 1) * width + x - 1];
      integral[y * (width + 1) + x] =
        integral[(y - 1) * (width + 1) + x] + rowSum;
    }
  }

  const radius = Math.floor(BLUR_WINDOW / 2);
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      const count = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum =
        integral[(y1 + 1) * (width + 1) + x1 + 1] -
        integral[y0 * (width + 1) + x1 + 1] -
        integral[(y1 + 1) * (width + 1) + x0] +
        integral[y0 * (width + 1) + x0];
      const mean = sum / count;
      const isBlack = gray[y * width + x] < mean - LOCAL_OFFSET;
      const value = isBlack ? 0 : 255;
      const offset = (y * width + x) * 4;
      pixels[offset] = value;
      pixels[offset + 1] = value;
      pixels[offset + 2] = value;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

export function drawPhoto(ctx, photo) {
  ctx.fillStyle = "white";
  ctx.fillRect(PHOTO_AREA.x, PHOTO_AREA.y, PHOTO_AREA.width, PHOTO_AREA.height);
  const scale = Math.min(
    PHOTO_AREA.width / photo.width,
    PHOTO_AREA.height / photo.height
  );
  const width = Math.max(1, Math.round(photo.width * scale));
  const height = Math.max(1, Math.round(photo.height * scale));
  const x = PHOTO_AREA.x + Math.round((PHOTO_AREA.width - width) / 2);
  const y = PHOTO_AREA.y + Math.round((PHOTO_AREA.height - height) / 2);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(photo, x, y, width, height);

  const pixels = ctx.getImageData(
    PHOTO_AREA.x,
    PHOTO_AREA.y,
    PHOTO_AREA.width,
    PHOTO_AREA.height
  );
  adaptiveThreshold(pixels.data, PHOTO_AREA.width, PHOTO_AREA.height);
  ctx.putImageData(pixels, PHOTO_AREA.x, PHOTO_AREA.y);
}
