import { LearningValidationError } from "./domain/errors.js";

export const CROP_ROTATIONS = new Set([0, 90, 180, 270]);

function invalidCrop(message) {
  return new LearningValidationError("INVALID_CROP", message);
}

function cropInteger(value, field, { min = 0 } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min) {
    throw invalidCrop(`裁剪${field}无效`);
  }
  return number;
}

export function validateCropMetadata(attachment, crop) {
  const rotation = Number(crop.rotation);
  if (!CROP_ROTATIONS.has(rotation)) {
    throw invalidCrop("裁剪旋转角度只能是 0、90、180 或 270 度");
  }
  const sourceWidth = cropInteger(crop.sourceWidth, "原图宽度", { min: 1 });
  const sourceHeight = cropInteger(crop.sourceHeight, "原图高度", { min: 1 });
  if (
    sourceWidth !== Number(attachment.originalWidth) ||
    sourceHeight !== Number(attachment.originalHeight)
  ) {
    throw invalidCrop("原图尺寸已变化，请重新打开裁剪编辑器");
  }

  const rotatedWidth = rotation === 90 || rotation === 270
    ? sourceHeight
    : sourceWidth;
  const rotatedHeight = rotation === 90 || rotation === 270
    ? sourceWidth
    : sourceHeight;
  const x = cropInteger(crop.x, "起点 X");
  const y = cropInteger(crop.y, "起点 Y");
  const width = cropInteger(crop.width, "宽度", { min: 1 });
  const height = cropInteger(crop.height, "高度", { min: 1 });
  if (x + width > rotatedWidth || y + height > rotatedHeight) {
    throw invalidCrop("裁剪区域超出图片范围");
  }

  return {
    cropX: x,
    cropY: y,
    cropWidth: width,
    cropHeight: height,
    rotation,
    sourceWidth,
    sourceHeight
  };
}

export function saveAttachmentCrop({
  repository,
  attachmentStore,
  attachmentId,
  buffer,
  declaredMime,
  crop
}) {
  const attachment = repository.getAttachment(attachmentId, {
    includeStorageKey: true
  });
  if (!attachment) {
    throw new LearningValidationError(
      "ATTACHMENT_NOT_FOUND",
      "没有找到这张题目图片"
    );
  }
  const metadata = validateCropMetadata(attachment, crop);
  const saved = attachmentStore.save(buffer, {
    declaredMime,
    originalName: "",
    kind: attachment.kind
  });
  try {
    const result = repository.saveAttachmentCrop({
      attachmentId,
      ...saved,
      ...metadata
    });
    if (
      result.previousStorageKey &&
      result.previousStorageKey !== saved.storageKey
    ) {
      try {
        attachmentStore.delete(result.previousStorageKey);
      } catch {
        // Orphan-file GC retries a derived file that could not be removed now.
      }
    }
    return repository.getAttachment(attachmentId);
  } catch (error) {
    try {
      attachmentStore.delete(saved.storageKey);
    } catch {
      // The original image was never touched; GC handles a failed cleanup.
    }
    throw error;
  }
}

export function clearAttachmentCrop({
  repository,
  attachmentStore,
  attachmentId
}) {
  const attachment = repository.getAttachment(attachmentId);
  if (!attachment) {
    throw new LearningValidationError(
      "ATTACHMENT_NOT_FOUND",
      "没有找到这张题目图片"
    );
  }
  const result = repository.deleteAttachmentCrop(attachmentId);
  if (result.storageKey) {
    try {
      attachmentStore.delete(result.storageKey);
    } catch {
      // Metadata is already reset; orphan-file GC retries the file.
    }
  }
  return repository.getAttachment(attachmentId);
}

export function readAttachmentContent(
  attachment,
  attachmentStore,
  { variant = "crop" } = {}
) {
  const requested = String(variant || "crop").toLowerCase();
  if (!["crop", "original"].includes(requested)) {
    throw new LearningValidationError(
      "INVALID_ATTACHMENT_VARIANT",
      "图片版本参数无效"
    );
  }
  const useCrop = requested === "crop" && Boolean(attachment.cropStorageKey);
  const storageKey = useCrop
    ? attachment.cropStorageKey
    : attachment.storageKey;
  const mimeType = useCrop
    ? attachment.cropMimeType
    : attachment.originalMimeType;
  return {
    buffer: attachmentStore.read(storageKey),
    mimeType,
    usedCrop: useCrop
  };
}
