export const SETTINGS_SUBPAGES = Object.freeze(["textbooks", "audit"]);

export function normalizeSettingsSubpage(value) {
  return SETTINGS_SUBPAGES.includes(value) ? value : null;
}

export function parseSettingsRoute(hash) {
  const raw = String(hash || "").replace(/^#/, "");
  const parts = raw.split("/");
  const view = parts[0] || "";
  if (view !== "settings") {
    return { subpage: null, unknown: false };
  }
  const segment = parts[1] || "";
  const hasExtraSegment = parts.length > 2;
  const subpage = hasExtraSegment ? null : normalizeSettingsSubpage(segment);
  return {
    subpage,
    unknown: subpage === null && (Boolean(segment) || hasExtraSegment)
  };
}
