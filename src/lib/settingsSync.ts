import { emitTo, listen } from "@tauri-apps/api/event";

import { api } from "@/lib/tauri";
import { isDataOperationLocked } from "@/store/dataOperationStore";
import { useDataOperationStore } from "@/store/dataOperationStore";
import { DATA_ACTIVITY_EVENT } from "@/lib/dataOperations";
import { tip } from "@/lib/tip";
import { withoutLegacyAiApiKey } from "@/lib/aiKeyMigration";
import { useNotesStore, type Settings } from "@/store/notesStore";
import { useUIStore } from "@/store/uiStore";
import {
  clearTargetProfileOverride,
  useTargetStore,
} from "@/store/targetStore";

/**
 * 主面板 ↔ 设置窗口的设置同步。
 * 主面板是唯一持久化写入方（避免双 webview 写同一 store 文件的竞态）：
 * - settings 窗口启动时发 request，主面板回 state
 * - settings 窗口的每次修改发 patch，主面板应用 + 持久化 + 下发 Rust 副作用 + 回播 state
 */
export const SETTINGS_REQUEST = "toskr://settings-request";
/** 让设置窗切到指定分区；target 可附带需要编辑的发送方案。 */
export const SETTINGS_SECTION = "toskr://settings-section";
export type SettingsSectionPayload =
  | string
  | { section: string; targetProfileId?: string };
export const SETTINGS_STATE = "toskr://settings-state";
export const SETTINGS_PATCH = "toskr://settings-patch";
/** 设置窗显式保存/删除 Keychain key 后通知 main 清理当前目录的旧迁移副本。 */
export const SETTINGS_AI_KEY_CHANGED = "toskr://settings-ai-key-changed";
/** 使用概览启动或继续受控安全发送演练。 */
export const SETTINGS_START_SAFE_REHEARSAL = "toskr://start-safe-rehearsal";
export interface SafeRehearsalLaunchRequest {
  mode?: "start" | "resume";
}
export const SETTINGS_EXPORT = "toskr://do-export";
export const SETTINGS_IMPORT = "toskr://do-import";
export const SETTINGS_CLEAR_CLIP = "toskr://do-clear-clip";
export const SETTINGS_DATA_OPERATION = "toskr://do-data-operation";
export const SETTINGS_DATA_RECOVERY_OPERATION = "toskr://do-data-recovery-operation";
export const SETTINGS_DATA_HEALTH = "toskr://do-data-health";
export const SETTINGS_DATA_HEALTH_RESULT = "toskr://data-health-result";
export const SETTINGS_DATA_CONFLICT_ACTION = "toskr://data-conflict-action";
export type DataConflictAction =
  | "reload"
  | "saveRecovery"
  | "retryStorage"
  | "loadDefault";

/** 应用设置补丁并执行对应的 Rust 侧副作用（主面板调用）。 */
export function applySettingsPatch(patch: Partial<Settings>) {
  if (isDataOperationLocked()) {
    tip("warn", "数据操作进行中，设置暂时只读");
    broadcastSettings();
    return;
  }
  // 贴边隐藏已是默认能力且不再与伴随互斥；旧设置/备份中的 false 静默归一。
  if (!useNotesStore.getState().settings.autoEdgeHide || patch.autoEdgeHide === false) {
    patch = { ...patch, autoEdgeHide: true };
  }
  // 开启伴随停靠时自动退出边栏模式并恢复自动停靠——
  // 边栏在 Rust 侧一票否决磁吸，不清掉会让这个开关看似失效
  if (
    patch.companionEnabled === true &&
    useNotesStore.getState().settings.rightSidebar
  ) {
    patch = { ...patch, rightSidebar: false, panelFreeX: null, panelFreeY: null };
    tip("info", "边栏已关闭，恢复伴随磁吸");
  }
  // 伴随接管沿用“常显示”默认；默认贴边能力不强制图钉，快捷键呼出由单次
  // 会话保护控制，普通打开仍服从用户的失焦设置。
  if (patch.companionEnabled === true) {
    useUIStore.getState().setPinned(true);
  }
  useNotesStore.getState().setSettings(patch);
  const s = useNotesStore.getState().settings;
  const profileOverrideId = useTargetStore.getState().profileOverrideId;
  if (
    profileOverrideId &&
    !s.targetProfiles.some((profile) => profile.id === profileOverrideId)
  ) {
    clearTargetProfileOverride();
    tip("info", "本次发送方案已被删除，已恢复自动匹配");
  }
  if ("hotkeyModifier" in patch || "hotkeyGapMs" in patch) {
    void api.setHotkeyConfig(s.hotkeyModifier, s.hotkeyGapMs);
  }
  if ("panelToggleHotkey" in patch) {
    // 录制器已先试注册成功才发 patch；这里重复注册幂等，失败静默
    void api.setPanelHotkey(s.panelToggleHotkey).catch(() => {});
  }
  if (
    "companionEnabled" in patch ||
    "companionApps" in patch ||
    ("sidebarEdge" in patch && s.companionEnabled)
  ) {
    // 磁吸方向复用 sidebarEdge 这个共享的左右偏好；边栏没有的 top/bottom
    // 对伴随磁吸无意义，退化为右
    const side = s.sidebarEdge === "left" ? "left" : "right";
    void api.setCompanionConfig(s.companionEnabled, s.companionApps, side);
  }
  if ("companionGap" in patch) {
    void api.setCompanionGap(s.companionGap);
  }
  if ("panelFreeX" in patch || "panelFreeY" in patch) {
    // 先清拖动位再动边栏：set_sidebar_mode 关闭时会立即重排，
    // 顺序反了会按旧的手动位置摆放一帧
    void api.setPanelFreePos(s.panelFreeX, s.panelFreeY);
  }
  if ("rightSidebar" in patch || "sidebarEdge" in patch) {
    void api.setSidebarMode(s.rightSidebar, s.sidebarEdge);
  }
  if ("panelTopmost" in patch) {
    void api.setPanelTopmost(s.panelTopmost);
  }
  if ("autoEdgeHide" in patch) {
    void api.setAutoEdgeHide(true);
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
    // 缩短时长即刻更新记录；媒体实体由主窗口的引用差分统一进入延迟 GC。
    useNotesStore.getState().pruneClipHistory();
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
  void emitTo(
    "settings",
    SETTINGS_STATE,
    withoutLegacyAiApiKey(useNotesStore.getState().settings)
  ).catch(() => {});
}

/** 主面板安装同步监听（request/patch/export/import）。返回清理函数。 */
export function installSettingsSyncHost(handlers: {
  onExport: () => void;
  onImport: () => void;
  onClearClip: () => void;
  onDataOperation: (plan: import("@/lib/tauri").DataOperationPlan) => void;
  onDataRecoveryOperation: (plan: import("@/lib/tauri").DataOperationPlan) => void;
  onDataHealth: () => void;
  onDataConflictAction: (action: DataConflictAction) => void;
}) {
  const whileWritable = (action: () => void) => {
    if (isDataOperationLocked()) {
      tip("warn", "数据操作进行中，当前操作已阻止");
      return;
    }
    action();
  };
  const subs = [
    listen(SETTINGS_REQUEST, () => {
      broadcastSettings();
      const activity = useDataOperationStore.getState();
      void emitTo("settings", DATA_ACTIVITY_EVENT, {
        locked: activity.locked,
        phase: activity.phase,
        message: activity.message,
      }).catch(() => {});
    }),
    listen<Partial<Settings>>(SETTINGS_PATCH, (e) => applySettingsPatch(e.payload)),
    listen(SETTINGS_EXPORT, () => whileWritable(handlers.onExport)),
    listen(SETTINGS_IMPORT, () => whileWritable(handlers.onImport)),
    listen(SETTINGS_CLEAR_CLIP, () => whileWritable(handlers.onClearClip)),
    listen<import("@/lib/tauri").DataOperationPlan>(SETTINGS_DATA_OPERATION, (event) =>
      whileWritable(() => handlers.onDataOperation(event.payload))
    ),
    listen<import("@/lib/tauri").DataOperationPlan>(
      SETTINGS_DATA_RECOVERY_OPERATION,
      (event) => handlers.onDataRecoveryOperation(event.payload)
    ),
    listen(SETTINGS_DATA_HEALTH, () => whileWritable(handlers.onDataHealth)),
    // 冲突会把主界面锁成只读；处理冲突/启动恢复的出口必须仍可调用。
    listen<DataConflictAction>(SETTINGS_DATA_CONFLICT_ACTION, (event) =>
      handlers.onDataConflictAction(event.payload)
    ),
  ];
  return () => {
    subs.forEach((p) => p.then((fn) => fn()));
  };
}
