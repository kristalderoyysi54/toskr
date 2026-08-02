import { invoke } from "@tauri-apps/api/core";

/** Rust 侧双击触发键事件。 */
export const TRIGGER_EVENT = "toskr://trigger";
/** Rust → HUD 窗口展示事件。 */
export const HUD_EVENT = "toskr://hud";
/** Rust → HUD 窗口 hover 状态事件。 */
export const HUD_HOVER_EVENT = "toskr://hud-hover";
/** HUD → 主窗口撤销捕获请求。 */
export const UNDO_CAPTURE_EVENT = "toskr://undo-capture";
/** HUD → 主窗口：点击气泡打开面板并定位到刚捕获的卡片。 */
export const HUD_OPEN_PANEL_EVENT = "toskr://hud-open-panel";
/** 独立模式下面板被拖动 → 主窗口持久化新位置。 */
export const PANEL_MOVED_EVENT = "toskr://panel-moved";
/** 托盘隐身模式切换 → 主窗口同步持久化。 */
export const STEALTH_EVENT = "toskr://stealth-changed";

export type TriggerPayload =
  | { kind: "toggle" }
  | {
      kind: "captured";
      /** 内容类型："text" | "image" */
      contentKind: string;
      text: string;
      imageFile: string | null;
      imageW: number | null;
      imageH: number | null;
      appName: string | null;
      bundleId: string | null;
    };

export type HudKind =
  | "added"
  | "duplicate"
  | "warn"
  | "undone"
  | "sent"
  | "ok"
  | "info";

export interface HudPayload {
  kind: HudKind;
  text: string;
  count: number;
  /** 悬停时展示「撤销」按钮。 */
  undoable?: boolean;
}

export interface HudHoverPayload {
  hovered: boolean;
}

export interface PrevAppInfo {
  bundleId: string;
  name: string | null;
}

export const api = {
  showPanel: () => invoke("show_panel"),
  hidePanel: (restoreFocus: boolean) => invoke("hide_panel", { restoreFocus }),
  copyText: (text: string) => invoke("copy_text", { text }),
  /** 返回是否真正完成粘贴（false=目标未到达，已中止）。 */
  sendToChat: (
    text: string,
    imageFiles: string[],
    pressEnter: boolean,
    keepPanel: boolean
  ) => invoke<boolean>("send_to_chat", { text, imageFiles, pressEnter, keepPanel }),
  axTrusted: (prompt: boolean) => invoke<boolean>("ax_trusted", { prompt }),
  tapStatus: () =>
    invoke<{ installed: boolean; receiving: boolean; listening: boolean }>("tap_status"),
  restartApp: () => invoke("restart_app"),
  setWindowTheme: (theme: "system" | "light" | "dark") =>
    invoke("set_window_theme", { theme }),
  openSettingsWindow: () => invoke("open_settings_window"),
  openUrl: (url: string) => invoke("open_url", { url }),
  setPanelFreePos: (x: number | null, y: number | null) =>
    invoke("set_panel_free_pos", { x, y }),
  setVibrancy: (enabled: boolean, material: string) =>
    invoke("set_vibrancy", { enabled, material }),
  setWindowAlpha: (alpha: number) => invoke("set_window_alpha", { alpha }),
  retryTap: () => invoke("retry_tap"),
  openPrivacySettings: (pane: "accessibility" | "input-monitoring") =>
    invoke("open_privacy_settings", { pane }),

  setHotkeyConfig: (modifier: string, gapMs: number) =>
    invoke("set_hotkey_config", { modifier, gapMs }),
  setCompanionConfig: (enabled: boolean, apps: string[]) =>
    invoke("set_companion_config", { enabled, apps }),
  setExcludedApps: (apps: string[]) => invoke("set_excluded_apps", { apps }),
  setCompanionGap: (gap: number) => invoke("set_companion_gap", { gap }),
  getDiagnostics: () =>
    invoke<{ atMs: number; msg: string }[]>("get_diagnostics"),
  getDataDir: () => invoke<string>("get_data_dir"),
  setDataDir: (path: string) => invoke<string>("set_data_dir", { path }),
  resetDataDir: () => invoke<string>("reset_data_dir"),
  readDataFile: () => invoke<string | null>("read_data_file"),
  writeDataFile: (content: string) => invoke("write_data_file", { content }),
  imageDataUrl: (name: string) => invoke<string | null>("image_data_url", { name }),
  removeImage: (name: string) => invoke("remove_image", { name }),
  setPanelWidth: (width: number) => invoke("set_panel_width", { width }),
  adjustPanelEdge: (edge: "top" | "bottom", delta: number) =>
    invoke<{ topOffset: number; height: number | null }>("adjust_panel_edge", {
      edge,
      delta,
    }),
  setPanelVertical: (topOffset: number, height: number | null) =>
    invoke("set_panel_vertical", { topOffset, height }),
  setStealth: (on: boolean) => invoke("set_stealth", { on }),
  prevAppInfo: () => invoke<PrevAppInfo | null>("prev_app_info"),
  refreshPrevApp: () => invoke("refresh_prev_app"),
  showCaptureHud: (kind: "added" | "duplicate", preview: string) =>
    invoke("show_capture_hud", { kind, preview }),
  hudFeedback: (kind: HudKind, text: string, undoable?: boolean) =>
    invoke("hud_feedback", { kind, text, undoable }),
  hideHud: () => invoke("hide_hud"),
  diagNote: (msg: string) => invoke("diag_note", { msg }),
  appIcon: (bundleId: string) =>
    invoke<{ url: string; color: string } | null>("app_icon", { bundleId }),
  exportFile: (path: string, content: string) =>
    invoke("export_file", { path, content }),
  importFile: (path: string) => invoke<string>("import_file", { path }),
};
