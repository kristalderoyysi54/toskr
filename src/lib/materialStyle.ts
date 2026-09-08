import type { VibrancyMaterial } from "@/store/notesStore";

/** 旧五档设置沿用当前三档含义；不改写用户保存的透明度。 */
export function normalizeMaterialStyle(
  material: VibrancyMaterial
): "hud" | "sidebar" | "under-window" {
  if (material === "popover") return "sidebar";
  // 撤回液态样式后，仅兼容曾保存的设置值。
  if (material === "liquid") return "hud";
  if (material === "fullscreen") return "hud";
  return material;
}
