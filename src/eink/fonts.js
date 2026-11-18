import path from "node:path";
import { fileURLToPath } from "node:url";

export const EINK_FONT_FAMILY = "Noto Sans SC";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

export const EINK_FONT_DIRECTORY = path.join(currentDir, "fonts");

// The Docker image installs these files into fontconfig. The no-op keeps the
// renderer contract stable for callers that used the previous native backend.
export function ensureEinkFonts() {}
