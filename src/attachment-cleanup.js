import { UNBOUND_ATTACHMENT_TTL_MS } from "./attachments.js";

export const ATTACHMENT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export function cleanupStaleAttachments({
  repository,
  attachmentStore,
  now = Date.now(),
  ttlMs = UNBOUND_ATTACHMENT_TTL_MS
}) {
  const cutoffIso = new Date(now - ttlMs).toISOString();
  const staleStorageKeys = repository.deleteStaleUnboundAttachments(cutoffIso);
  const deletedFiles = new Set();

  for (const storageKey of staleStorageKeys) {
    try {
      if (attachmentStore.delete(storageKey)) deletedFiles.add(storageKey);
    } catch {
      // The orphan-file sweep below retries files that could not be deleted.
    }
  }

  const orphanFiles = attachmentStore.cleanupUnreferenced({
    referencedKeys: repository.getReferencedAttachmentKeys(),
    maxAgeMs: ttlMs,
    now
  });
  for (const storageKey of orphanFiles) deletedFiles.add(storageKey);

  return {
    staleRecords: staleStorageKeys.length,
    deletedFiles: [...deletedFiles]
  };
}

export function scheduleAttachmentCleanup(
  options,
  {
    intervalMs = ATTACHMENT_CLEANUP_INTERVAL_MS,
    onError = () => {}
  } = {}
) {
  const run = () => {
    try {
      cleanupStaleAttachments(options);
    } catch (error) {
      onError(error);
    }
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return timer;
}
