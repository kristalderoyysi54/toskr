import { invoke } from "@tauri-apps/api/core";
import type { DeliveryEvent } from "@/lib/deliveryActivityCore";
import type { ImagePreviewEditContext } from "@/lib/imageEditor";
import type { MessageContextItem } from "@/lib/messages";
import type { ImProfile } from "@/lib/imProfile";

/** Rust 侧双击触发键事件。 */
export const TRIGGER_EVENT = "toskr://trigger";
/** Rust 前台观察器确认下一次发送目标发生语义变化。 */
export const TARGET_CHANGED_EVENT = "toskr://target-changed";
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
/** 目标 IM DevTools 只读桥 → 主窗口摘要入库；完整原始对象已先写本地账本。 */
export const MESSAGE_WATCH_EVENT = "toskr://message-watch";
/** Rust → 只读来源浮层：贴在 IM 窗口旁，不激活、不接收点击。 */
export const SOURCE_OVERLAY_EVENT = "toskr://source-overlay";
/** Rust → 主窗口：贴边隐藏运行态变化（进入/退出可介入布局、滑出/滑回）。 */
export const EDGE_HIDE_STATE_EVENT = "toskr://edge-hide-state";
/** Rust Keychain 状态变化；payload 永远不含 key。 */
export const AI_KEY_STATUS_EVENT = "toskr://ai-key-status";

export interface AiKeyStatus {
  configured: boolean;
  updatedAtMs: number | null;
}

/** 独立图片预览关联的权威来源卡；缺省表示纯文件/隐私核验预览。 */
export interface ImagePreviewSource {
  id: string;
  text: string;
  dataGeneration: number;
  edit?: boolean;
}

export function isAiKeyStatus(value: unknown): value is AiKeyStatus {
  if (!value || typeof value !== "object") return false;
  const status = value as Partial<AiKeyStatus>;
  return (
    typeof status.configured === "boolean" &&
    (status.updatedAtMs === null ||
      (typeof status.updatedAtMs === "number" &&
        Number.isFinite(status.updatedAtMs) &&
        status.updatedAtMs >= 0))
  );
}

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
  /** 同一 generation 的 HTML 表示；只交给无行为解析器，不直接渲染。 */
  html: string | null;
  /** 浏览器声明的来源 URL，仅用于解析相对图片地址。 */
  sourceUrl: string | null;
  /** watcher 观察到复制的时间，避免异步图片落盘打乱历史顺序。 */
  capturedAtMs: number;
  imageFile: string | null;
  imageW: number | null;
  imageH: number | null;
  appName: string | null;
  bundleId: string | null;
}

export interface MessageWatchStatus {
  enabled: boolean;
  bridgeReady: boolean;
  sessionStartedAtMs: number | null;
  acceptedCount: number;
  duplicateCount: number;
  lastAcceptedAtMs: number | null;
  rendererConnected: boolean;
  ledgerPath: string;
  lastError: string | null;
  transport: "cdp" | "http" | null;
}

export interface MessageWatchBridgeInfo {
  endpoint: string;
  sessionStartedAtMs: number;
}

export interface MessageWatchCapture {
  conversationId: string;
  messageId: string;
  conversationName: string | null;
  senderUid: string;
  senderName: string | null;
  occurredAtMs: number | null;
  receivedAtMs: number;
  mentionedSelf: boolean;
  followedSender: boolean;
  /** 命中的 Toskr 组合关注规则；@我/特别关注不依赖此字段。 */
  matchedRuleIds: string[];
  isGroup: boolean | null;
  messageType: string | null;
  text: string;
  /** 捕获时客户端内存中已经存在的前文，不触发拉取或切换会话。 */
  context: MessageContextItem[];
}

/** 探测到的候选 IM（供用户确认监听目标）；字段与 Rust focus::RunningApp 对应。 */
export interface ImCandidate {
  name: string;
  bundleId: string;
  binPath: string;
}

export interface MessageSourceOverlayPayload {
  sourceApp: string;
  sourceBundle: string;
  conversationName: string;
  senderName: string;
  text: string;
  reason: string;
  /** Native 定位后补充：箭头在卡片哪一侧。 */
  pointerSide?: "left" | "right";
}

export type TriggerPayload =
  | {
      kind: "toggle";
      force: boolean;
      source: "hotkey" | "doubleTap" | "tray";
    }
  | {
      kind: "captured";
      /** 内容类型："text" | "image" */
      contentKind: string;
      text: string;
      /** 与 text 来自同一 pasteboard item / generation 的富表示。 */
      html: string | null;
      /** 浏览器声明的来源 URL，仅用于解析相对图片地址。 */
      sourceUrl: string | null;
      /** 来源侧捕获时间，避免异步图片落盘改变卡片时序。 */
      capturedAtMs: number;
      imageFile: string | null;
      imageW: number | null;
      imageH: number | null;
      appName: string | null;
      bundleId: string | null;
      clipboardWarning: string | null;
    };

/** 粘贴/拖拽导入后已入媒体库的图片（文件名为像素哈希，天然去重）。 */
export type PastedImage = { file: string; width: number; height: number };

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
  /** 账单到期提醒：跳「提醒 → 订阅」并高亮该账单行。 */
  billId?: string | null;
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

export type RichClipboardWriteBlock =
  | { kind: "text"; text: string }
  | { kind: "image"; file: string; alt?: string };

export interface LocalizedRichImage {
  index: number;
  ok: boolean;
  file?: string;
  width?: number;
  height?: number;
  reason?: string;
}

export interface RichClipboardWriteResult {
  changeCount: number;
  plainBytes: number;
  htmlBytes: number;
  imageCount: number;
}

export type DataLocationKind =
  | "missing"
  | "empty"
  | "nonToskr"
  | "valid"
  | "corrupt"
  | "unsupported"
  | "encrypted";

export interface DataLocationInspection {
  path: string;
  kind: DataLocationKind;
  revision: string | null;
  readable: boolean;
  writable: boolean;
  sameAsActive: boolean;
  externalSyncLikely: boolean;
  storeVersion: number | null;
  noteCount: number;
  taskCount: number;
  mediaCount: number;
  ordinaryFileCount: number;
}

export interface DataOperationFailure {
  code: string;
  message: string;
}

export interface DataLocationStatus {
  activeDir: string;
  defaultDir: string;
  lastSuccessfulSwitchAtMs: number | null;
  lastConflictAtMs: number | null;
  conflictPending: boolean;
  pendingOperationId: string | null;
  initializationFailure: DataOperationFailure | null;
}

export type DataOperationAction =
  | "migrateCurrentToTarget"
  | "loadExistingTarget"
  | "replaceTargetWithCurrent"
  | "cancel";

export type DataOperationPhase =
  | "prepare"
  | "recoveryPoint"
  | "copy"
  | "verify"
  | "commitPointer"
  | "rehydrate"
  | "complete"
  | "rollback";

export interface DataOperationPlan {
  operationId: string;
  sourcePath: string;
  targetPath: string;
  action: DataOperationAction;
  replaceConfirmed: boolean;
  expectedTargetRevision: string;
}

export interface DataOperationResult {
  operationId: string;
  status: "awaitingRehydrate" | "completed" | "rolledBack" | "cancelled";
  phase: DataOperationPhase;
  activeDir: string;
  rolledBack: boolean;
  message: string;
}

export interface DataFileSnapshot {
  content: string | null;
  revision: string;
  size: number;
  modifiedAtMs: number | null;
}

export interface BackupCounts {
  sections: number;
  notes: number;
  taskSections: number;
  tasks: number;
  bills: number;
  messages: number;
  media: number;
}

export interface BackupInspection {
  format: "complete" | "legacyJson";
  archiveRevision: string;
  backupSchemaVersion: number | null;
  storeSchemaVersion: number | null;
  appVersion: string | null;
  createdAtMs: number | null;
  counts: BackupCounts;
  missingMedia: string[];
  warnings: string[];
}

export interface BackupImportPrepared {
  inspection: BackupInspection;
  operation: DataOperationResult;
}

export interface MediaIntegrityReport {
  referencedCount: number;
  actualCount: number;
  missing: string[];
  orphaned: string[];
  shared: { file: string; references: number }[];
  pendingUndoReferences: string[];
  tombstoned: string[];
  unsafeEntries: string[];
  suggestions: string[];
}

export interface MediaGcResult {
  deleted: string[];
  retained: string[];
}

export type TargetReason =
  | "target_missing"
  | "target_token_missing"
  | "target_token_stale"
  | "target_exited"
  | "target_bundle_mismatch"
  | "target_process_mismatch"
  | "target_identity_unavailable"
  | "target_not_frontmost";

export interface TargetSnapshot {
  token: string | null;
  pid: number | null;
  bundleId: string | null;
  appName: string | null;
  launchedAtMs: number | null;
  capturedAtMs: number;
  /** 原生目标状态的进程内单调版本；用于拒绝并发倒序事件。 */
  revision: number;
  ready: boolean;
  reason: TargetReason | null;
  /** 当前无法可靠取得编辑窗口身份，原生侧固定返回 null。 */
  windowId: number | null;
}

export type DeliveryStatus = "sent" | "blocked" | "failed";

export type DeliveryReasonCode =
  | "ok"
  | TargetReason
  | "target_focus_drift"
  | "delivery_in_progress"
  | "payload_empty"
  | "image_unreadable"
  | "image_changed"
  | "privacy_incomplete"
  | "privacy_native_blocked"
  | "paste_failed"
  | "enter_failed"
  | "internal_error";

export type ClipboardOutcome =
  | "restored"
  | "restoredPartial"
  | "skippedUserChanged"
  | "nothingToRestore"
  | "restoreFailed"
  | "notOwned";

/** 图文交错粘贴顺序中的一段；image 按下标引用 imageFiles。 */
export type DeliverySegment =
  | { kind: "text"; text: string }
  | { kind: "image"; fileIndex: number };

export interface SendDeliveryRequest {
  targetToken: string | null;
  text: string;
  imageFiles: string[];
  /** 与 imageFiles 同序；已扫描/遮挡图片在 Native 副作用前复核像素 hash。 */
  expectedImagePixelHashes: Array<string | null>;
  /**
   * 可选交错顺序：text 段必须是 text 字段的切片、每张图恰好引用一次，
   * Native 校验失败会整单拒发。缺省保持文字整段在前、图片在后。
   */
  segments?: DeliverySegment[];
  /**
   * 预检授权保留的高风险文本 finding id（ruleId:start:end）。Native 发送前
   * 复扫 text，名单外的 Block finding 一律拒发；正文改动会使 id 失配自动作废。
   */
  allowedTextFindingIds: string[];
  /** 文本防火墙总开关快照；false 时 Native 跳过复扫（缺省按开启 fail-closed）。 */
  firewallTextEnabled: boolean;
  pressEnter: boolean;
  keepPanel: boolean;
  deliveryId: string;
}

export interface SendDeliveryResult {
  deliveryId: string;
  status: DeliveryStatus;
  reasonCode: DeliveryReasonCode;
  message: string;
  target: TargetSnapshot | null;
  pasteCompleted: boolean;
  enterPressed: boolean;
  clipboardOutcome: ClipboardOutcome;
  startedAtMs: number;
  finishedAtMs: number;
}

export type FindingCategory =
  | "privateKey"
  | "authorization"
  | "apiKey"
  | "databaseUrl"
  | "email"
  | "phone"
  | "nationalId"
  | "bankCard"
  | "ipAddress"
  | "cookie"
  | "session";

export type FindingSeverity = "info" | "warn" | "block";

export interface FirewallFinding {
  id: string;
  category: FindingCategory;
  severity: FindingSeverity;
  startUtf16: number;
  endUtf16: number;
  maskedPreview: string;
  suggestedPlaceholder: string;
  ruleId: string;
}

export interface ScanSensitiveRequest {
  text: string;
}

export interface ScanWarning {
  code: "inputTooLong";
  message: string;
  maxBytes: number;
  actualBytes: number;
}

export interface ScanSensitiveResult {
  findings: FirewallFinding[];
  warnings: ScanWarning[];
  inputUtf16: number;
  scannedUtf16: number;
  complete: boolean;
}

/** Vision 框已统一转换为左上原点、0..1 归一化坐标。 */
export interface ImageNormalizedBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImagePixelBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImageOcrObservation {
  text: string;
  confidence: number;
  boundingBox: ImageNormalizedBox;
  imageWidth: number;
  imageHeight: number;
}

export interface ImageFirewallFinding {
  id: string;
  observationIndex: number;
  category: FindingCategory;
  severity: FindingSeverity;
  boundingBox: ImageNormalizedBox;
  pixelBox: ImagePixelBox;
  maskedPreview: string;
  ruleId: string;
}

export interface ScanImageFirewallResult {
  file: string;
  pixelHash: string;
  ruleVersion: number;
  imageWidth: number;
  imageHeight: number;
  cacheHit: boolean;
  /** 只存在于 IPC 扫描回执；控制器不得写入 DeliveryDraft 或日志。 */
  observations: ImageOcrObservation[];
  findings: ImageFirewallFinding[];
}

export interface RedactDeliveryImageResult {
  originalFile: string;
  redactedFile: string;
  originalPixelHash: string;
  redactedPixelHash: string;
  imageWidth: number;
  imageHeight: number;
}

const DELIVERY_STATUSES = new Set<DeliveryStatus>(["sent", "blocked", "failed"]);
const TARGET_REASONS = new Set<TargetReason>([
  "target_missing",
  "target_token_missing",
  "target_token_stale",
  "target_exited",
  "target_bundle_mismatch",
  "target_process_mismatch",
  "target_identity_unavailable",
  "target_not_frontmost",
]);
const DELIVERY_REASONS = new Set<DeliveryReasonCode>([
  "ok",
  ...TARGET_REASONS,
  "target_focus_drift",
  "delivery_in_progress",
  "payload_empty",
  "image_unreadable",
  "image_changed",
  "privacy_incomplete",
  "privacy_native_blocked",
  "paste_failed",
  "enter_failed",
  "internal_error",
]);
const CLIPBOARD_OUTCOMES = new Set<ClipboardOutcome>([
  "restored",
  "restoredPartial",
  "skippedUserChanged",
  "nothingToRestore",
  "restoreFailed",
  "notOwned",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isTargetSnapshot(value: unknown): value is TargetSnapshot {
  if (!isRecord(value)) return false;
  return (
    (typeof value.token === "string" || value.token === null) &&
    isNullableFiniteNumber(value.pid) &&
    (typeof value.bundleId === "string" || value.bundleId === null) &&
    (typeof value.appName === "string" || value.appName === null) &&
    isNullableFiniteNumber(value.launchedAtMs) &&
    typeof value.capturedAtMs === "number" &&
    Number.isFinite(value.capturedAtMs) &&
    typeof value.revision === "number" &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0 &&
    typeof value.ready === "boolean" &&
    (value.reason === null || TARGET_REASONS.has(value.reason as TargetReason)) &&
    isNullableFiniteNumber(value.windowId)
  );
}

/** IPC 边界守卫，防止旧二进制或异常 payload 被误判为成功。 */
export function isSendDeliveryResult(value: unknown): value is SendDeliveryResult {
  if (!isRecord(value)) return false;
  const structurallyValid =
    typeof value.deliveryId === "string" &&
    DELIVERY_STATUSES.has(value.status as DeliveryStatus) &&
    DELIVERY_REASONS.has(value.reasonCode as DeliveryReasonCode) &&
    typeof value.message === "string" &&
    (value.target === null || isTargetSnapshot(value.target)) &&
    typeof value.pasteCompleted === "boolean" &&
    typeof value.enterPressed === "boolean" &&
    CLIPBOARD_OUTCOMES.has(value.clipboardOutcome as ClipboardOutcome) &&
    typeof value.startedAtMs === "number" &&
    Number.isFinite(value.startedAtMs) &&
    typeof value.finishedAtMs === "number" &&
    Number.isFinite(value.finishedAtMs) &&
    value.finishedAtMs >= value.startedAtMs;
  if (!structurallyValid) return false;
  if (value.status === "sent") {
    return (
      value.reasonCode === "ok" &&
      value.pasteCompleted === true &&
      isTargetSnapshot(value.target) &&
      value.target.ready
    );
  }
  return value.reasonCode !== "ok" && value.enterPressed === false;
}

export const api = {
  showPanel: (shortcutHold = false) => invoke("show_panel", { shortcutHold }),
  hidePanel: (restoreFocus: boolean) => invoke("hide_panel", { restoreFocus }),
  copyText: (text: string) => invoke("copy_text", { text }),
  copyRichClipboard: (blocks: RichClipboardWriteBlock[]) =>
    invoke<RichClipboardWriteResult>("copy_rich_clipboard", { blocks }),
  localizeRichClipboardImages: (sources: string[], sourceUrl?: string | null) =>
    invoke<LocalizedRichImage[]>("localize_rich_clipboard_images", {
      sources,
      sourceUrl: sourceUrl ?? null,
    }),
  getTargetSnapshot: () => invoke<TargetSnapshot>("get_target_snapshot"),
  refreshTargetSnapshot: () => invoke<TargetSnapshot>("refresh_target_snapshot"),
  validateTargetSnapshot: (targetToken: string | null) =>
    invoke<TargetSnapshot>("validate_target_snapshot", { targetToken }),
  sendDelivery: (request: SendDeliveryRequest) =>
    invoke<SendDeliveryResult>("send_delivery", { request }),
  scanSensitiveText: (text: string) =>
    invoke<ScanSensitiveResult>("scan_sensitive_text", {
      request: { text } satisfies ScanSensitiveRequest,
    }),
  scanImageFirewall: (file: string, force = false) =>
    invoke<ScanImageFirewallResult>("scan_image_firewall", { file, force }),
  redactDeliveryImage: (
    originalFile: string,
    regions: ImagePixelBox[],
    persist = false
  ) =>
    invoke<RedactDeliveryImageResult>("redact_delivery_image", {
      request: { originalFile, regions, persist },
    }),
  cleanupRedactedImages: (files: string[]) =>
    invoke<void>("cleanup_redacted_images", { files }),
  clearRedactedImages: () => invoke<void>("clear_redacted_images"),
  deliveryImageDataUrl: (file: string, fullSize = false) =>
    invoke<string | null>("delivery_image_data_url", { file, fullSize }),
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
  /** 从系统剪贴板读图并入库（粘贴图片）：位图单张；Finder 复制的本地图片
   *  文件可多张；无图返回空数组。 */
  pasteImagesFromClipboard: () =>
    invoke<PastedImage[]>("paste_images_from_clipboard"),
  /** 拖入的本地图片文件入库（详情窗拖拽添加）；非图片/坏文件被跳过。 */
  importImageFiles: (paths: string[]) =>
    invoke<PastedImage[]>("import_image_files", { paths }),

  setHotkeyConfig: (modifier: string, gapMs: number) =>
    invoke("set_hotkey_config", { modifier, gapMs }),
  /** 注册/清除面板显示隐藏快捷键；被占用等注册失败时 reject。 */
  setPanelHotkey: (shortcut: string | null) =>
    invoke("set_panel_hotkey", { shortcut }),
  /** 抓取链接的网页标题/图标（curl，6s 超时）。 */
  fetchLinkMeta: (url: string) => invoke<LinkMeta>("fetch_link_meta", { url }),
  /** 按域名抓 favicon 缓存进媒体库，返回文件名；失败 reject（前端回退首字色块）。 */
  fetchFavicon: (domain: string) => invoke<string>("fetch_favicon", { domain }),
  /** 抓当日汇率（USD 基准 code→rate）；前端按日缓存，失败 reject。 */
  fetchExchangeRates: () => invoke<Record<string, number>>("fetch_exchange_rates"),
  /** `side`："right"（默认，贴目标窗口右缘）| "left"（贴左缘）。 */
  setCompanionConfig: (enabled: boolean, apps: string[], side: "left" | "right" = "right") =>
    invoke("set_companion_config", { enabled, apps, side }),
  setExcludedApps: (apps: string[]) => invoke("set_excluded_apps", { apps }),
  setCompanionGap: (gap: number) => invoke("set_companion_gap", { gap }),
  getDiagnostics: () =>
    invoke<{ atMs: number; msg: string }[]>("get_diagnostics"),
  appendDeliveryEvent: (event: DeliveryEvent, retentionDays = 30) =>
    invoke<void>("append_delivery_event", { event, retentionDays }),
  getRecentDeliveryEvents: (limit = 100, retentionDays = 30) =>
    invoke<DeliveryEvent[]>("get_recent_delivery_events", { limit, retentionDays }),
  clearDeliveryEvents: () => invoke<void>("clear_delivery_events"),
  getDataDir: () => invoke<string>("get_data_dir"),
  getDataLocationStatus: () =>
    invoke<DataLocationStatus>("get_data_location_status"),
  retryStorageInitialization: () =>
    invoke<DataLocationStatus>("retry_storage_initialization"),
  loadDefaultFromRecovery: () =>
    invoke<DataLocationStatus>("load_default_from_recovery"),
  clearDataConflict: () => invoke<void>("clear_data_conflict"),
  markDataConflict: () => invoke<void>("mark_data_conflict"),
  inspectDataLocation: (path: string) =>
    invoke<DataLocationInspection>("inspect_data_location", { path }),
  beginDataOperation: (plan: DataOperationPlan) =>
    invoke<DataOperationResult>("begin_data_operation", { plan }),
  beginRecoveryDataOperation: (plan: DataOperationPlan) =>
    invoke<DataOperationResult>("begin_recovery_data_operation", { plan }),
  finalizeDataOperation: (operationId: string) =>
    invoke<DataOperationResult>("finalize_data_operation", { operationId }),
  rollbackDataOperation: (operationId: string) =>
    invoke<DataOperationResult>("rollback_data_operation", { operationId }),
  readDataSnapshot: () => invoke<DataFileSnapshot>("read_data_snapshot"),
  writeDataIfCurrent: (content: string, expectedRevision: string) =>
    invoke<DataFileSnapshot>("write_data_if_current", {
      content,
      expectedRevision,
    }),
  imageDataUrl: (name: string) => invoke<string | null>("image_data_url", { name }),
  imageThumbUrl: (name: string) => invoke<string | null>("image_thumb_url", { name }),
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
  setHudDuration: (durationMs: number) =>
    invoke("set_hud_duration", { durationMs }),
  setDoubleTapMode: (captureOnly: boolean) =>
    invoke("set_double_tap_mode", { captureOnly }),
  setClipWatch: (enabled: boolean) => invoke("set_clip_watch", { enabled }),
  setMessageWatch: (enabled: boolean) =>
    invoke<MessageWatchStatus>("set_message_watch", { enabled }),
  getMessageWatchStatus: () =>
    invoke<MessageWatchStatus>("get_message_watch_status"),
  getMessageWatchBridgeInfo: () =>
    invoke<MessageWatchBridgeInfo>("get_message_watch_bridge_info"),
  getMessageWatchCaptures: (limit = 1_000) =>
    invoke<MessageWatchCapture[]>("get_message_watch_captures", { limit }),
  /** 在目标 IM中定位会话：滚动会话列表到该群并高亮；不打开会话、不改已读。 */
  locateMessageSource: (payload: MessageSourceOverlayPayload) =>
    invoke<void>("locate_message_source", { payload }),
  /** 指定 bundle 的目标 IM 是否已安装（设置页前置检查）。 */
  messageWatchAppInstalled: (bundleId: string) =>
    invoke<boolean>("message_watch_app_installed", { bundleId }),
  /** 探测当前运行的候选 IM，供用户确认监听目标（代码不预置任何具体应用）。 */
  detectRunningImCandidates: () =>
    invoke<ImCandidate[]>("detect_running_im_candidates"),
  setMessageWatchAuto: (enabled: boolean, script?: string, profile?: ImProfile) =>
    invoke<MessageWatchStatus>("set_message_watch_auto", { enabled, script, profile }),
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
  /** 兼容旧设置字段；当前产品始终下发 true，贴边隐藏是默认能力。 */
  setAutoEdgeHide: (enabled: boolean) =>
    invoke("set_auto_edge_hide", { enabled }),
  /** 面板固定（图钉）状态同步：只豁免失焦收起，不影响光标驱动的贴边隐藏。 */
  setPanelPinned: (pinned: boolean) => invoke("set_panel_pinned", { pinned }),
  /** 手动拖拽落定评估：拖到屏幕左右缘 → 吸平入坞贴边隐藏。 */
  evaluateDragDock: () => invoke("evaluate_drag_dock"),
  /** 面板宽度/上下缘拖拽期间下发，贴边隐藏暂停计时。 */
  setPanelDragActive: (active: boolean) =>
    invoke("set_panel_drag_active", { active }),
  /** 立即贴边滑出；explicit=true 用于 Esc，可越过快捷键保护与图钉。 */
  edgeHideNow: (explicit = false) =>
    invoke<boolean>("edge_hide_now", { explicit }),
  /** Keychain 仅回传配置状态；密钥正文永不返回 WebView。 */
  setAiApiKey: (apiKey: string, overwriteExisting: boolean) =>
    invoke<AiKeyStatus>("set_ai_api_key", { apiKey, overwriteExisting }),
  getAiKeyStatus: () => invoke<AiKeyStatus>("get_ai_key_status"),
  deleteAiApiKey: () => invoke<AiKeyStatus>("delete_ai_api_key"),
  /** OpenAI 兼容对话补全；Rust 从 Keychain 读取 key。 */
  aiChat: (
    baseUrl: string,
    model: string,
    system: string,
    user: string,
    maxTokens: number
  ) =>
    invoke<string>("ai_chat", { baseUrl, model, system, user, maxTokens }),
  /** 拉取提供商可用模型列表（GET /v1/models）。 */
  aiListModels: (baseUrl: string) =>
    invoke<string[]>("ai_list_models", { baseUrl }),
  /** 系统 Quick Look 原尺寸预览图片附件。 */
  /** 图片原尺寸预览；`note` 传所属笔记时预览窗显示文字备注编辑条。 */
  quickLook: (
    files: string[],
    index = 0,
    note?: ImagePreviewSource,
    editContext?: ImagePreviewEditContext
  ) =>
    invoke("quick_look", {
      files,
      index,
      noteId: note?.id ?? null,
      noteText: note?.text ?? null,
      dataGeneration: note?.dataGeneration ?? null,
      edit: note?.edit ?? false,
      editContext: editContext ?? null,
    }),
  /** 悬停窥视：原尺寸预览窗的瞬态形态（不抢焦点、鼠标穿透），移开由 hidePeekImage 收起。 */
  peekImage: (files: string[]) =>
    invoke("quick_look", {
      files,
      index: 0,
      noteId: null,
      noteText: null,
      dataGeneration: null,
      edit: false,
      editContext: null,
      transient: true,
    }),
  /** 收起悬停窥视的瞬态预览窗（常规预览窗不受影响）。 */
  hidePeekImage: () => invoke("hide_transient_image_preview"),
  /** 文本详情窗（桌面居中；内容另行 emit 到 textpreview 窗口）。 */
  showTextPreview: () => invoke("show_text_preview"),
  ocrImage: (file: string) => invoke<string>("ocr_image", { file }),
  prevAppInfo: () => invoke<PrevAppInfo | null>("prev_app_info"),
  refreshPrevApp: () => invoke<TargetSnapshot>("refresh_prev_app"),
  showCaptureHud: (
    kind: "added" | "duplicate",
    preview: string,
    warning?: string | null,
    associationSuggested = false,
    aliasRestoredCount: number | null = null,
    autoLinked = false
  ) => invoke("show_capture_hud", {
    kind,
    preview,
    warning: warning ?? null,
    associationSuggested,
    aliasRestoredCount,
    autoLinked,
  }),
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
  exportCompleteBackup: (
    path: string,
    stateJson: string,
    expectedRevision: string
  ) =>
    invoke<BackupInspection>("export_complete_backup", {
      path,
      stateJson,
      expectedRevision,
    }),
  exportNotesBundle: (path: string, markdown: string, mediaFiles: string[]) =>
    invoke<void>("export_notes_bundle", {
      path,
      markdown,
      mediaFiles,
    }),
  exportConflictRecoveryBackup: (path: string, stateJson: string) =>
    invoke<BackupInspection>("export_conflict_recovery_backup", {
      path,
      stateJson,
    }),
  inspectBackup: (path: string) =>
    invoke<BackupInspection>("inspect_backup", { path }),
  createDataRecoveryBackup: (
    stateJson: string,
    operationId: string,
    expectedRevision: string
  ) =>
    invoke<string>("create_data_recovery_backup", {
      stateJson,
      operationId,
      expectedRevision,
    }),
  beginCompleteBackupImport: (
    path: string,
    operationId: string,
    expectedRevision: string,
    expectedActiveRevision: string
  ) =>
    invoke<BackupImportPrepared>("begin_complete_backup_import", {
      path,
      operationId,
      expectedRevision,
      expectedActiveRevision,
    }),
  readLegacyBackup: (path: string, expectedRevision: string) =>
    invoke<string>("read_legacy_backup", { path, expectedRevision }),
  inspectMediaIntegrity: (stateJson: string) =>
    invoke<MediaIntegrityReport>("inspect_media_integrity", { stateJson }),
  scheduleMediaGc: (files: string[], notBeforeMs: number) =>
    invoke<void>("schedule_media_gc", { files, notBeforeMs }),
  runMediaGc: (stateJson: string, nowMs: number, expectedRevision: string) =>
    invoke<MediaGcResult>("run_media_gc", {
      stateJson,
      nowMs,
      expectedRevision,
    }),
};
