import { api } from "@/lib/tauri";
import type { Settings } from "@/store/notesStore";
import { useUIStore } from "@/store/uiStore";

function runtimeEffects(settings: Settings): Promise<unknown>[] {
  if (settings.companionEnabled) {
    useUIStore.getState().setPinned(true);
  }
  return [
    api.setHotkeyConfig(settings.hotkeyModifier, settings.hotkeyGapMs),
    api.setPanelHotkey(settings.panelToggleHotkey),
    api.setNewNoteHotkey(settings.newNoteHotkey),
    api.setCompanionConfig(
      settings.companionEnabled,
      settings.companionApps,
      settings.sidebarEdge === "left" ? "left" : "right"
    ),
    api.setCompanionGap(settings.companionGap),
    api.setSidebarMode(settings.rightSidebar, settings.sidebarEdge),
    api.setPanelTopmost(settings.panelTopmost),
    // `autoEdgeHide` 仅保留旧数据兼容；运行态始终开启，是否收起由入坞锚点裁决。
    api.setAutoEdgeHide(true),
    api.setPanelFreePos(settings.panelFreeX, settings.panelFreeY),
    api.setPanelWidth(settings.panelWidth),
    api.setStealth(settings.stealth),
    api.setSound(settings.soundEnabled),
    api.setHudDuration(settings.hudDurationMs),
    api.setDoubleTapMode(settings.doubleTapCaptureOnly),
    api.setClipWatch(settings.clipHistory),
    api.setClipPause(settings.clipPauseUntil ?? 0),
    api.setClipRules(
      settings.clipIgnoreConcealed,
      settings.clipIgnoreTransient,
      settings.clipExcludedApps
    ),
    api.setWindowTheme(settings.theme),
    api.setExcludedApps(settings.excludedApps),
    api.setVibrancy(settings.vibrancy, settings.vibrancyMaterial),
    api.setWindowAlpha(settings.windowOpacity),
  ];
}

/**
 * 数据事务专用：等待整批 Native runtime 设置全部落定。即便某项失败，也先
 * 等其余旧批次结束再抛错，避免随后回滚的设置与失败目标批次交错。
 */
export async function applyRuntimeSettingsStrict(settings: Settings): Promise<void> {
  const outcomes = await Promise.allSettled(runtimeEffects(settings));
  const failure = outcomes.find(
    (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected"
  );
  if (failure) throw failure.reason;
}

/** 启动常规下发容错；目录事务必须调用 strict 版本并等待。 */
export function applyRuntimeSettings(settings: Settings): void {
  void applyRuntimeSettingsStrict(settings).catch(() => {
    // 启动时保留持久设置，下一次启动会再次完整下发；不产生未处理 rejection。
  });
}
