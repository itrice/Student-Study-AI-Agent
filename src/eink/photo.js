import sharp from "sharp";

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
const CROP_INSET = 1;
const INK_BRIGHTNESS = 160;
const EDGE_PADDING = 8;
const BLUR_WINDOW = 11;
const LOCAL_OFFSET = 10;

function grayAt(data, offset, channels) {
  return (
    data[offset] * 0.299 +
    data[offset + channels] * 0.587 +
    data[offset + channels * 2] * 0.114
  );
}

function boundsFor(image, predicate) {
  const { data, width, height, channels } = image;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * channels;
      if (!predicate(grayAt(data, offset, channels))) continue;
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
  const { width, height } = image;
  let bounds = boundsFor(
    image,
    (gray) => gray >= PAPER_BRIGHTNESS
  );
  const paperArea = bounds
    ? (bounds.maxX - bounds.minX + 1) * (bounds.maxY - bounds.minY + 1)
    : 0;
  if (!bounds || paperArea < PAPER_MIN_FRACTION * width * height) {
    bounds = boundsFor(
      image,
      (gray) => gray < INK_BRIGHTNESS
    );
  }
  if (!bounds || isEmptyOrFull(bounds, width, height)) {
    return { x: 0, y: 0, width, height };
  }

  const insetX = bounds.maxX - bounds.minX + 1 > CROP_INSET * 2
    ? CROP_INSET
    : 0;
  const insetY = bounds.maxY - bounds.minY + 1 > CROP_INSET * 2
    ? CROP_INSET
    : 0;
  const x = Math.max(0, bounds.minX + insetX);
  const y = Math.max(0, bounds.minY + insetY);
  const right = Math.min(width, bounds.maxX + 1 - insetX);
  const bottom = Math.min(height, bounds.maxY + 1 - insetY);
  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y)
  };
}

export async function prepareEinkPhoto(
  buffer,
  { skipPaperCrop = false } = {}
) {
  const oriented = await sharp(buffer, { failOn: "none" })
    .rotate()
    .flatten({ background: "white" })
    .png()
    .toBuffer({ resolveWithObject: true });
  if (!oriented.info.width || !oriented.info.height) {
    throw new Error("图片尺寸无效");
  }

  let cropped = oriented;
  if (!skipPaperCrop) {
    const thumbnail = await sharp(oriented.data)
      .resize(THUMB_WIDTH, THUMB_HEIGHT, { fit: "fill" })
      .flatten({ background: "white" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const thumbBounds = findPaperCropBounds({
      data: thumbnail.data,
      width: thumbnail.info.width,
      height: thumbnail.info.height,
      channels: thumbnail.info.channels
    });
    const x = Math.max(
      0,
      Math.floor(thumbBounds.x * oriented.info.width / THUMB_WIDTH)
    );
    const y = Math.max(
      0,
      Math.floor(thumbBounds.y * oriented.info.height / THUMB_HEIGHT)
    );
    const width = Math.min(
      oriented.info.width - x,
      Math.ceil(thumbBounds.width * oriented.info.width / THUMB_WIDTH)
    );
    const height = Math.min(
      oriented.info.height - y,
      Math.ceil(thumbBounds.height * oriented.info.height / THUMB_HEIGHT)
    );
    if (
      x !== 0 ||
      y !== 0 ||
      width !== oriented.info.width ||
      height !== oriented.info.height
    ) {
      cropped = await sharp(oriented.data)
        .extract({ left: x, top: y, width, height })
        .png()
        .toBuffer({ resolveWithObject: true });
    }
  }

  const padded = await sharp(cropped.data)
    .extend({
      top: EDGE_PADDING,
      bottom: EDGE_PADDING,
      left: EDGE_PADDING,
      right: EDGE_PADDING,
      background: "white"
    })
    .png()
    .toBuffer({ resolveWithObject: true });
  return {
    buffer: padded.data,
    width: padded.info.width,
    height: padded.info.height
  };
}

export function adaptiveThreshold(pixels, width, height) {
  const gray = new Uint8ClampedArray(width * height);
  const integral = new Uint32Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = (y * width + x) * 4;
      gray[y * width + x] = Math.round(grayAt(pixels, pixel, 4));
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
