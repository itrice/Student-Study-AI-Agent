let fallbackSequence = 0;

function formatUuid(bytes) {
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
    12,
    16
  )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createRequestKey(cryptoApi = globalThis.crypto) {
  if (typeof cryptoApi?.randomUUID === "function") {
    try {
      return cryptoApi.randomUUID();
    } catch {
      // randomUUID can be exposed but unavailable outside a secure context.
    }
  }

  if (typeof cryptoApi?.getRandomValues === "function") {
    try {
      const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      return formatUuid(bytes);
    } catch {
      // Fall through to the final request-key fallback.
    }
  }

  fallbackSequence = (fallbackSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `req-${Date.now().toString(36)}-${fallbackSequence.toString(
    36
  )}-${Math.random().toString(36).slice(2, 12)}`;
}
