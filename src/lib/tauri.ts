import { invoke } from "@tauri-apps/api/core";

/** Rust 侧双击触发键事件。 */
export const TRIGGER_EVENT = "toskr://trigger";
/** Rust → HUD 窗口展示事件。 */
export const HUD_EVENT = "toskr://hud";
/** Rust → HUD 窗口 hover 状态事件。 */
export const HUD_HOVER_EVENT = "toskr://hud-hover";
/** Rust → HUD 窗口：即将隐藏，先播退场动画（Rust 侧延迟 160ms 再真正 hide）。 */
export const HUD_EXIT_EVENT = "toskr://hud-exit";
/** HUD → 主窗口撤销捕获请求。 */
export const UNDO_CAPTURE_EVENT = "toskr://undo-capture";
/** HUD → 主窗口：点击气泡打开面板并定位到刚捕获的卡片。 */
export const HUD_OPEN_PANEL_EVENT = "toskr://hud-open-panel";
/** 独立模式下面板被拖动 → 主窗口持久化新位置。 */
export const PANEL_MOVED_EVENT = "toskr://panel-moved";
/** 托盘隐身模式切换 → 主窗口同步持久化。 */
export const STEALTH_EVENT = "toskr://stealth-changed";
/** 暂停剪贴板收集变化（托盘/设置 → 主窗口持久化；payload = until ms，0=恢复）。 */
export const CLIP_PAUSE_EVENT = "toskr://clip-pause-changed";
/** 剪贴板历史 watcher → 主窗口入库。 */
export const CLIP_EVENT = "toskr://clip";
/** Rust → 主窗口：贴边隐藏运行态变化（进入/退出可介入布局、滑出/滑回）。 */
export const EDGE_HIDE_STATE_EVENT = "toskr://edge-hide-state";

/** 贴边隐藏运行态载荷：active=当前是否处于可自动隐藏的布局（非钉住、
 *  非伴随磁吸的右缘停靠/右侧边栏）；hidden=面板当前是否已滑出仅露出细条。 */
export interface EdgeHideStatePayload {
  active: boolean;
  hidden: boolean;
}

/** 剪贴板历史收集载荷。 */
export interface ClipPayload {
  contentKind: string;
  text: string;
  imageFile: string | null;
  imageW: number | null;
  imageH: number | null;
  appName: string | null;
  bundleId: string | null;
}

export type TriggerPayload =
  | { kind: "toggle"; force: boolean }
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
  | "info"
  | "due";

export interface HudPayload {
  kind: HudKind;
  text: string;
  count: number;
  /** 悬停时展示「撤销」按钮。 */
  undoable?: boolean;
  /** 粘性气泡（任务到期提醒）：不自动隐藏，仅点击可关闭。 */
  sticky?: boolean;
  /** 点击气泡的跳转目标（任务 id）。 */
  targetId?: string | null;
}

/** 点击 HUD 气泡打开面板的载荷（空对象 = 定位最近捕获的笔记）。 */
export interface HudOpenPanelPayload {
  page?: "tasks";
  taskId?: string | null;
  /** 改开设置窗并切到指定分区，不开面板。 */
  settings?: string;
  /** 打开面板并唤起更新对话框（更新提醒气泡）。 */
  update?: boolean;
}

export interface HudHoverPayload {
  hovered: boolean;
}

export interface PrevAppInfo {
  bundleId: string;
  name: string | null;
}

/** 链接卡片抓取的网页元数据。 */
export interface LinkMeta {
  title: string | null;
  icon: string | null;
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
  /** 一键重置输入监控授权（tccutil 删除条目，等价系统设置里的 −）；失败 reject。 */
  resetInputMonitoring: () => invoke("reset_input_monitoring"),
  /** 把图片附件写入系统剪贴板（图片卡复制）。 */
  copyImage: (file: string) => invoke("copy_image_to_clipboard", { file }),
  /** 从系统剪贴板读图并入库（输入框粘贴图片）；无图返回 null。 */
  pasteImageFromClipboard: () =>
    invoke<{ file: string; width: number; height: number } | null>(
      "paste_image_from_clipboard"
    ),

  setHotkeyConfig: (modifier: string, gapMs: number) =>
    invoke("set_hotkey_config", { modifier, gapMs }),
  /** 注册/清除面板显示隐藏快捷键；被占用等注册失败时 reject。 */
  setPanelHotkey: (shortcut: string | null) =>
    invoke("set_panel_hotkey", { shortcut }),
  /** 抓取链接的网页标题/图标（curl，6s 超时）。 */
  fetchLinkMeta: (url: string) => invoke<LinkMeta>("fetch_link_meta", { url }),
  /** `side`："right"（默认，贴目标窗口右缘）| "left"（贴左缘）。 */
  setCompanionConfig: (enabled: boolean, apps: string[], side: "left" | "right" = "right") =>
    invoke("set_companion_config", { enabled, apps, side }),
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
  imageThumbUrl: (name: string) => invoke<string | null>("image_thumb_url", { name }),
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
  setSound: (enabled: boolean) => invoke("set_sound", { enabled }),
  setDoubleTapMode: (captureOnly: boolean) =>
    invoke("set_double_tap_mode", { captureOnly }),
  setClipWatch: (enabled: boolean) => invoke("set_clip_watch", { enabled }),
  setClipRules: (
    ignoreConcealed: boolean,
    ignoreTransient: boolean,
    apps: string[]
  ) => invoke("set_clip_rules", { ignoreConcealed, ignoreTransient, apps }),
  setClipPause: (untilMs: number) => invoke("set_clip_pause", { untilMs }),
  setSidebarMode: (enabled: boolean, edge: string) =>
    invoke("set_sidebar_mode", { enabled, edge }),
  isSelfFrontmost: () => invoke<boolean>("is_self_frontmost"),
  setPanelTopmost: (enabled: boolean) =>
    invoke("set_panel_topmost", { enabled }),
  /** 自动贴边隐藏开关（类似 Dock；关闭时若正隐藏会自动滑回）。 */
  setAutoEdgeHide: (enabled: boolean) =>
    invoke("set_auto_edge_hide", { enabled }),
  /** 面板固定（图钉）状态同步：只豁免失焦收起，不影响光标驱动的贴边隐藏。 */
  setPanelPinned: (pinned: boolean) => invoke("set_panel_pinned", { pinned }),
  /** 手动拖拽落定评估：拖到屏幕左右缘 → 吸平入坞贴边隐藏。 */
  evaluateDragDock: () => invoke("evaluate_drag_dock"),
  /** 面板宽度/上下缘拖拽期间下发，贴边隐藏暂停计时。 */
  setPanelDragActive: (active: boolean) =>
    invoke("set_panel_drag_active", { active }),
  /** 立即贴边滑出（失焦时贴边隐藏模式下的「收起」，不是真实 hide；
   *  前置条件不满足时是安全的空操作）。 */
  edgeHideNow: () => invoke("edge_hide_now"),
  /** OpenAI 兼容对话补全（配置由调用方传入；返回 content 文本）。 */
  aiChat: (
    baseUrl: string,
    apiKey: string,
    model: string,
    system: string,
    user: string,
    maxTokens: number
  ) =>
    invoke<string>("ai_chat", { baseUrl, apiKey, model, system, user, maxTokens }),
  /** 拉取提供商可用模型列表（GET /v1/models）。 */
  aiListModels: (baseUrl: string, apiKey: string) =>
    invoke<string[]>("ai_list_models", { baseUrl, apiKey }),
  /** 系统 Quick Look 原尺寸预览图片附件。 */
  /** 图片原尺寸预览；`note` 传所属笔记时预览窗显示文字备注编辑条。 */
  quickLook: (files: string[], index = 0, note?: { id: string; text: string }) =>
    invoke("quick_look", {
      files,
      index,
      noteId: note?.id ?? null,
      noteText: note?.text ?? null,
    }),
  /** 文本详情窗（桌面居中；内容另行 emit 到 textpreview 窗口）。 */
  showTextPreview: () => invoke("show_text_preview"),
  ocrImage: (file: string) => invoke<string>("ocr_image", { file }),
  prevAppInfo: () => invoke<PrevAppInfo | null>("prev_app_info"),
  refreshPrevApp: () => invoke("refresh_prev_app"),
  showCaptureHud: (kind: "added" | "duplicate", preview: string) =>
    invoke("show_capture_hud", { kind, preview }),
  hudFeedback: (
    kind: HudKind,
    text: string,
    undoable?: boolean,
    sticky?: boolean,
    targetId?: string
  ) => invoke("hud_feedback", { kind, text, undoable, sticky, targetId }),
  hideHud: () => invoke("hide_hud"),
  diagNote: (msg: string) => invoke("diag_note", { msg }),
  appIcon: (bundleId: string) =>
    invoke<{ url: string; color: string } | null>("app_icon", { bundleId }),
  /** 设置里应用列表展示信息（不要求应用在运行）。 */
  appListInfo: (bundleId: string) =>
    invoke<{ name: string; iconUrl: string | null } | null>("app_list_info", {
      bundleId,
    }),
  /** 从 .app 路径读 bundle id。 */
  bundleIdOfApp: (path: string) =>
    invoke<string | null>("bundle_id_of_app", { path }),
  exportFile: (path: string, content: string) =>
    invoke("export_file", { path, content }),
  importFile: (path: string) => invoke<string>("import_file", { path }),
};
