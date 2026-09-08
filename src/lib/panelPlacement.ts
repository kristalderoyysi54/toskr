import { applySettingsPatch } from "@/lib/settingsSync";
import { api } from "@/lib/tauri";
import { useNotesStore, type Settings } from "@/store/notesStore";

/** 改变屏幕停靠后由 Native 重排，避免重复 showPanel 建立收起锚点。 */
export async function applySidebar(on: boolean, edge: Settings["sidebarEdge"]) {
  const current = useNotesStore.getState().settings;
  if (current.rightSidebar === on && (!on || current.sidebarEdge === edge)) return;
  useNotesStore.getState().setSettings({
    rightSidebar: on,
    sidebarEdge: edge,
    panelFreeX: null,
    panelFreeY: null,
  });
  await api.setPanelFreePos(null, null).catch(() => {});
  await api.setSidebarMode(on, edge).catch(() => {});
}

export function applyCompanionSide(edge: "left" | "right") {
  const current = useNotesStore.getState().settings.sidebarEdge === "left" ? "left" : "right";
  if (current !== edge) applySettingsPatch({ sidebarEdge: edge });
}
