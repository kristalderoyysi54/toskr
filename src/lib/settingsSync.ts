import { emitTo, listen } from "@tauri-apps/api/event";

import { api } from "@/lib/tauri";
import { useNotesStore, type Settings } from "@/store/notesStore";

/**
 * 主面板 ↔ 设置窗口的设置同步。
 * 主面板是唯一持久化写入方（避免双 webview 写同一 store 文件的竞态）：
 * - settings 窗口启动时发 request，主面板回 state
 * - settings 窗口的每次修改发 patch，主面板应用 + 持久化 + 下发 Rust 副作用 + 回播 state
 */
export const SETTINGS_REQUEST = "toskr://settings-request";
export const SETTINGS_STATE = "toskr://settings-state";
export const SETTINGS_PATCH = "toskr://settings-patch";
export const SETTINGS_EXPORT = "toskr://do-export";
export const SETTINGS_IMPORT = "toskr://do-import";
export const SETTINGS_CLEAR_CLIP = "toskr://do-clear-clip";

/** 应用设置补丁并执行对应的 Rust 侧副作用（主面板调用）。 */
export function applySettingsPatch(patch: Partial<Settings>) {
  useNotesStore.getState().setSettings(patch);
  const s = useNotesStore.getState().settings;
  if ("hotkeyModifier" in patch || "hotkeyGapMs" in patch) {
    void api.setHotkeyConfig(s.hotkeyModifier, s.hotkeyGapMs);
  }
  if ("panelToggleHotkey" in patch) {
    // 录制器已先试注册成功才发 patch；这里重复注册幂等，失败静默
    void api.setPanelHotkey(s.panelToggleHotkey).catch(() => {});
  }
  if ("companionEnabled" in patch || "companionApps" in patch) {
    void api.setCompanionConfig(s.companionEnabled, s.companionApps);
  }
  if ("companionGap" in patch) {
    void api.setCompanionGap(s.companionGap);
  }
  if ("panelFreeX" in patch || "panelFreeY" in patch) {
    void api.setPanelFreePos(s.panelFreeX, s.panelFreeY);
  }
  if ("excludedApps" in patch) {
    void api.setExcludedApps(s.excludedApps);
  }
  if ("clipHistory" in patch) {
    void api.setClipWatch(s.clipHistory);
  }
  if ("clipPauseUntil" in patch) {
    void api.setClipPause(s.clipPauseUntil ?? 0);
  }
  if ("clipRetentionDays" in patch) {
    // 缩短时长即刻生效（不等 30 分钟周期），清掉孤儿图片
    useNotesStore
      .getState()
      .pruneClipHistory()
      .forEach((f) => void api.removeImage(f).catch(() => {}));
  }
  if (
    "clipIgnoreConcealed" in patch ||
    "clipIgnoreTransient" in patch ||
    "clipExcludedApps" in patch
  ) {
    void api.setClipRules(
      s.clipIgnoreConcealed,
      s.clipIgnoreTransient,
      s.clipExcludedApps
    );
  }
  if ("stealth" in patch) {
    void api.setStealth(s.stealth);
  }
  if ("soundEnabled" in patch) {
    void api.setSound(s.soundEnabled);
  }
  if ("doubleTapCaptureOnly" in patch) {
    void api.setDoubleTapMode(s.doubleTapCaptureOnly);
  }
  if ("theme" in patch) {
    void api.setWindowTheme(s.theme);
  }
  if ("vibrancy" in patch || "vibrancyMaterial" in patch) {
    void api.setVibrancy(s.vibrancy, s.vibrancyMaterial);
  }
  if ("windowOpacity" in patch) {
    void api.setWindowAlpha(s.windowOpacity);
  }
  broadcastSettings();
}

/** 把当前设置广播给设置窗口。 */
export function broadcastSettings() {
  void emitTo("settings", SETTINGS_STATE, useNotesStore.getState().settings).catch(
    () => {}
  );
}

/** 主面板安装同步监听（request/patch/export/import）。返回清理函数。 */
export function installSettingsSyncHost(handlers: {
  onExport: () => void;
  onImport: () => void;
  onClearClip: () => void;
}) {
  const subs = [
    listen(SETTINGS_REQUEST, () => broadcastSettings()),
    listen<Partial<Settings>>(SETTINGS_PATCH, (e) => applySettingsPatch(e.payload)),
    listen(SETTINGS_EXPORT, () => handlers.onExport()),
    listen(SETTINGS_IMPORT, () => handlers.onImport()),
    listen(SETTINGS_CLEAR_CLIP, () => handlers.onClearClip()),
  ];
  return () => {
    subs.forEach((p) => p.then((fn) => fn()));
  };
}
