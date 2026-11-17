import { GlobalFonts } from "@napi-rs/canvas";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EINK_FONT_FAMILY = "Noto Sans SC";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
let fontsReady = false;

export function ensureEinkFonts() {
  if (fontsReady && GlobalFonts.has(EINK_FONT_FAMILY)) return;
  const regular = GlobalFonts.registerFromPath(
    path.join(currentDir, "fonts", "NotoSansSC-Regular.ttf"),
    EINK_FONT_FAMILY
  );
  const bold = GlobalFonts.registerFromPath(
    path.join(currentDir, "fonts", "NotoSansSC-Bold.ttf"),
    EINK_FONT_FAMILY
  );
  if (!regular || !bold || !GlobalFonts.has(EINK_FONT_FAMILY)) {
    throw new Error("墨水屏中文字体加载失败");
  }
  fontsReady = true;
}
