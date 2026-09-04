import { buildDeliveryDraft } from "./buildDraft";
import {
  executeDeliveryDraft,
  inspectDeliveryDraft,
  inspectDeliveryDraftFreshness,
  inspectDeliveryDraftNonTarget,
  nextDeliveryDraftRevision,
  rebaseDeliveryDraftForRetry,
  warnWithPanel,
} from "./executeDraft";
import type {
  DeliveryDraft,
  DeliveryDraftBuildState,
  MarkdownSendMode,
} from "./types";
import type { SendDeliveryResult, TargetSnapshot } from "@/lib/tauri";
import type { DeliveryFormat } from "@/lib/targetProfiles";
import {
  evaluateDeliveryDraftFirewall,
  scanDeliveryDraftFirewall,
  type ScanSensitiveText,
} from "./firewallController";
import { EMPTY_PRIVACY_DECISION } from "./firewall";
import {
  cleanupDeliveryDraftImages,
  evaluateDeliveryDraftImages,
  scanDeliveryDraftImages,
  type ScanImageFirewall,
} from "./imageFirewall";
import { currentTargetProfileResolution } from "@/lib/currentTargetProfile";
import {
  useDeliveryStore,
  type PreflightMode,
} from "@/store/deliveryStore";
import { useUIStore } from "@/store/uiStore";
import { useNotesStore } from "@/store/notesStore";
import {
  refreshTarget,
  sameTargetIdentity,
  useTargetStore,
} from "@/store/targetStore";
import {
  deliveryEventFromDraft,
  recordDeliveryEvent,
} from "@/lib/deliveryActivityCore";

export function shouldOpenPreflight(
  draft: DeliveryDraft,
  mode: PreflightMode,
  force = false
): boolean {
  if (force) return true;
  if (
    draft.firewallEnabled &&
    (draft.firewallStatus !== "ready" ||
      draft.findings.length > 0 ||
      draft.imageFirewall.some(
        (item) => item.status !== "ready" || item.findings.length > 0
      ))
  ) return true;
  if (mode === "always") return true;
  if (mode === "off") return false;
  // 图片隐私扫描已给每一张「ready 且零发现」的回执时，smart 不再因带图
  // 强制预检——检测无异常直接发送，省一步确认。回执缺失/数量不齐/防火墙
  // 关闭（没检测过谈不上无异常）仍照旧弹预检。
  const imagesCleared =
    draft.firewallEnabled &&
    draft.imageFirewall.length === draft.imageFiles.length &&
    draft.imageFirewall.every(
      (item) => item.status === "ready" && item.findings.length === 0
    );
  return draft.sourceItemIds.length > 1 ||
    (draft.imageFiles.length > 0 && !imagesCleared) ||
    draft.promptTemplate !== null ||
    draft.format === "code" ||
    draft.markdownMode === "strip" ||
    draft.enterPolicy === "confirm" ||
    draft.enterPolicy === "allow" ||
    draft.warnings.length > 0;
}

export type PreflightDraftChanges = {
  format?: DeliveryFormat;
  markdownMode?: MarkdownSendMode;
  promptSnippetId?: string | null;
  promptTemplate?: string | null;
};

const staleMessages: Record<
  Exclude<ReturnType<typeof inspectDeliveryDraft>, null>,
  string
> = {
  generation: "数据上下文已变化，请重新选择内容",
  source: "来源内容已变化，请重新打开预检",
  selection: "选择已变化，请重新打开预检",
  revision: "发送草稿已被更新，请使用最新预检",
  target: "发送目标已变化，请重新确认目标",
  profile: "发送方案已变化，请重新打开预检",
};

/** 纯重组：只更新本次正文选择，目标、选择和策略仍绑定打开预检时的快照。 */
export function rebuildPreflightDraft(
  draft: DeliveryDraft,
  changes: PreflightDraftChanges,
  state: DeliveryDraftBuildState,
  revision: number
): DeliveryDraft {
  const promptSnippetId = Object.hasOwn(changes, "promptSnippetId")
    ? changes.promptSnippetId ?? null
    : draft.promptSnippetId;
  const promptTemplate = Object.hasOwn(changes, "promptTemplate")
    ? changes.promptTemplate ?? null
    : draft.promptTemplate;
  const rebuilt = buildDeliveryDraft(
    {
      id: draft.id,
      revision,
      createdAtMs: draft.createdAtMs,
      sourceKind: draft.sourceKind,
      sourceItemIds: draft.sourceItemIds,
      format: changes.format ?? draft.format,
      markdownMode: changes.markdownMode ?? draft.markdownMode,
      promptSnippetId,
      promptTemplate: promptTemplate ?? undefined,
      sourceTextOverride: draft.sourceTextOverride ?? undefined,
      sourceContentOverride: draft.sourceContentOverride ?? undefined,
    },
    state
  );
  return {
    ...rebuilt,
    selectionItemIds: [...draft.selectionItemIds],
    targetSnapshot: draft.targetSnapshot ? { ...draft.targetSnapshot } : null,
    targetProfileId: draft.targetProfileId,
    promptGroupId: draft.promptGroupId,
    profileSource: draft.profileSource,
    profileDefaultFormat: draft.profileDefaultFormat,
    profileDefaultMarkdownMode: draft.profileDefaultMarkdownMode,
    profileKeepPanel: draft.profileKeepPanel,
    privacyPolicy: draft.privacyPolicy,
    firewallEnabled: draft.firewallEnabled,
    firewallDisabledWarnCategories: [
      ...draft.firewallDisabledWarnCategories,
    ],
    firewallStatus: draft.firewallEnabled ? "idle" : "disabled",
    findings: [],
    redactionMap: { ...draft.redactionMap },
    scanRevision: draft.scanRevision + 1,
    privacyDecision: { ...EMPTY_PRIVACY_DECISION },
    originalImageFiles: [...draft.originalImageFiles],
    imageFiles: [...draft.imageFiles],
    imageFirewall: draft.imageFirewall.map((item) => ({
      ...item,
      findings: [...item.findings],
      redactedFindingIds: [...item.redactedFindingIds],
      manualRegions: [...item.manualRegions],
      rawConfirmation: item.rawConfirmation
        ? { ...item.rawConfirmation }
        : null,
    })),
    enterPolicy: draft.enterPolicy,
    enterDecisionConfirmed: draft.enterDecisionConfirmed,
    pressEnter: draft.pressEnter,
    keepPanel: draft.keepPanel,
    safeRehearsal: draft.safeRehearsal,
    dataGeneration: draft.dataGeneration,
  };
}

export function updateOpenPreflightDraft(
  changes: PreflightDraftChanges,
  inspect: typeof inspectDeliveryDraft = inspectDeliveryDraft,
  inspectNonTarget: typeof inspectDeliveryDraftNonTarget =
    inspectDeliveryDraftNonTarget
): void {
  const delivery = useDeliveryStore.getState();
  const draft = delivery.draft;
  if (!delivery.open || !draft || delivery.busy) return;
  if (delivery.retryBlocked) {
    delivery.setLastError("目标可能已收到部分内容，请核对后关闭并重新预检");
    return;
  }
  const stale = inspect(draft);
  const hiddenStale = stale === "target" && delivery.safeRetryPending
    ? inspectNonTarget(draft)
    : null;
  const recoverableTarget = stale === "target" &&
    delivery.safeRetryPending &&
    !hiddenStale;
  if (stale && !recoverableTarget) {
    delivery.setLastError(staleMessages[hiddenStale ?? stale]);
    return;
  }
  const notes = useNotesStore.getState();
  const rebuilt = rebuildPreflightDraft(
    draft,
    changes,
    {
      notes: notes.notes,
      tasks: notes.tasks,
      promptSnippets: notes.settings.promptSnippets,
      checkedItemIds: notes.checkedIds,
      targetSnapshot: useTargetStore.getState().snapshot,
      profileResolution: currentTargetProfileResolution(),
      panelPinned: useUIStore.getState().pinned,
      dataGeneration: draft.dataGeneration,
      firewallEnabled: notes.settings.firewallEnabled,
      firewallDisabledWarnCategories:
        notes.settings.firewallDisabledWarnCategories,
      aliasEntitiesEnabled: notes.settings.aliasEntitiesEnabled,
      aliasEntities: notes.settings.aliasEntities,
    },
    nextDeliveryDraftRevision(draft.revision)
  );
  delivery.replaceDraft(rebuilt, recoverableTarget);
}

/**
 * 目标失效的自动恢复：用户切回同一目标（同进程/窗口身份，token 允许轮换）时，
 * 把 Draft 的目标快照重基线为最新令牌，预检无需取消重来。
 * 换成其他应用、目标重启（身份变化）或来源/方案漂移时不自动重绑，维持显式阻断；
 * 发送前 Native gate 仍会再校验一次目标。
 */
export function recoverOpenPreflightTarget(
  inspectNonTarget: typeof inspectDeliveryDraftNonTarget = inspectDeliveryDraftNonTarget
): boolean {
  const delivery = useDeliveryStore.getState();
  const draft = delivery.draft;
  if (!delivery.open || !draft || delivery.busy || delivery.retryBlocked) {
    return false;
  }
  const target = useTargetStore.getState();
  if (
    target.status !== "ready" ||
    target.profileOverrideNeedsConfirmation ||
    !target.snapshot ||
    draft.targetSnapshot?.token === target.snapshot.token ||
    !sameTargetIdentity(draft.targetSnapshot, target.snapshot) ||
    inspectNonTarget(draft)
  ) {
    return false;
  }
  delivery.replaceDraft({
    ...draft,
    revision: nextDeliveryDraftRevision(draft.revision),
    targetSnapshot: { ...target.snapshot },
  });
  return true;
}

type PreflightTargetRebindState = Pick<
  DeliveryDraftBuildState,
  | "targetSnapshot"
  | "profileResolution"
  | "firewallEnabled"
  | "firewallDisabledWarnCategories"
>;

/**
 * 显式确认新目标后的纯重绑：保留用户本次正文、模板、格式和图片遮挡，
 * 但重算目标方案与回车策略，并撤销所有绑定旧 target token 的原文放行。
 */
export function rebindPreflightDraftTarget(
  draft: DeliveryDraft,
  state: PreflightTargetRebindState,
  revision: number
): DeliveryDraft {
  const profile = state.profileResolution.profile;
  const firewallEnabled = draft.safeRehearsal || state.firewallEnabled;
  const disabledWarnCategories = draft.safeRehearsal
    ? []
    : [...state.firewallDisabledWarnCategories];
  const firewallConfigChanged =
    draft.firewallEnabled !== firewallEnabled ||
    draft.firewallDisabledWarnCategories.length !== disabledWarnCategories.length ||
    draft.firewallDisabledWarnCategories.some(
      (value, index) => value !== disabledWarnCategories[index]
    );
  // 旧文本扫描回执绑定 target token；正在扫描时回到 idle，让现有协调器重启。
  const resetTextScan = firewallConfigChanged || draft.firewallStatus === "scanning";
  const imageFirewall = draft.imageFirewall.map((item) => ({
    ...item,
    status: firewallConfigChanged
      ? (firewallEnabled ? "idle" as const : "disabled" as const)
      : item.status,
    findings: firewallConfigChanged ? [] : [...item.findings],
    rawConfirmation: null,
    failureMessage: firewallConfigChanged ? null : item.failureMessage,
  }));
  const enterPolicy = profile.enterPolicy;
  return {
    ...draft,
    revision,
    targetSnapshot: state.targetSnapshot ? { ...state.targetSnapshot } : null,
    targetProfileId: state.profileResolution.profileId,
    promptGroupId: state.profileResolution.promptGroup.id,
    profileSource: state.profileResolution.source,
    profileDefaultFormat: profile.defaultFormat,
    profileDefaultMarkdownMode: profile.defaultMarkdownMode,
    profileKeepPanel: profile.keepPanel,
    privacyPolicy: draft.safeRehearsal
      ? "requireRedaction"
      : profile.privacyPolicy,
    firewallEnabled,
    firewallDisabledWarnCategories: disabledWarnCategories,
    firewallStatus: resetTextScan
      ? (firewallEnabled ? "idle" : "disabled")
      : draft.firewallStatus,
    findings: resetTextScan ? [] : [...draft.findings],
    privacyDecision: {
      excludedFindingIds: [],
      rawConfirmation: null,
      replacedCount: draft.privacyDecision.replacedCount,
    },
    imageFirewall,
    imageFiles: imageFirewall.map((item) => item.sendFile),
    enterPolicy,
    enterDecisionConfirmed: draft.safeRehearsal || enterPolicy !== "confirm",
    pressEnter: draft.safeRehearsal ? false : enterPolicy === "allow",
    keepPanel: draft.safeRehearsal ? true : draft.keepPanel,
  };
}

type ConfirmPreflightTargetChangeOptions = {
  expectedTarget?: TargetSnapshot | null;
  inspectFreshness?: typeof inspectDeliveryDraftFreshness;
  resolveProfile?: typeof currentTargetProfileResolution;
};

/** 用户在预检内明确接受界面所示新目标；全程同步且拒绝展示后再次跳目标。 */
export function confirmOpenPreflightTargetChange(
  options: ConfirmPreflightTargetChangeOptions = {}
): boolean {
  const delivery = useDeliveryStore.getState();
  const draft = delivery.draft;
  if (!delivery.open || !draft || delivery.busy) return false;
  if (delivery.retryBlocked) {
    delivery.setLastError("目标可能已收到部分内容，请核对后关闭并重新预检");
    return false;
  }
  if (delivery.transform.status === "running") {
    delivery.setLastError("AI 转换正在生成，请等待完成后再确认新目标");
    return false;
  }

  const target = useTargetStore.getState();
  if (
    target.status !== "ready" ||
    target.profileOverrideNeedsConfirmation ||
    !target.snapshot?.ready
  ) {
    delivery.setLastError(
      target.profileOverrideNeedsConfirmation
        ? "请先确认当前目标使用的发送方案"
        : "当前新目标尚未就绪，请重新识别后再确认"
    );
    return false;
  }
  if (
    Object.hasOwn(options, "expectedTarget") &&
    (!options.expectedTarget ||
      !sameTargetIdentity(options.expectedTarget, target.snapshot))
  ) {
    delivery.setLastError("目标已再次变化，请确认当前新目标");
    return false;
  }
  if (sameTargetIdentity(draft.targetSnapshot, target.snapshot)) {
    return recoverOpenPreflightTarget();
  }

  const freshness = (options.inspectFreshness ?? inspectDeliveryDraftFreshness)(draft);
  if (freshness) {
    delivery.setLastError(staleMessages[freshness]);
    return false;
  }
  const resolution = (options.resolveProfile ?? currentTargetProfileResolution)();
  if (
    !resolution.isTargetReady ||
    resolution.targetBundleId !== target.snapshot.bundleId
  ) {
    delivery.setLastError("新目标的发送方案尚未就绪，请重新识别后再确认");
    return false;
  }

  const notes = useNotesStore.getState();
  const rebound = rebindPreflightDraftTarget(
    draft,
    {
      targetSnapshot: target.snapshot,
      profileResolution: resolution,
      firewallEnabled: notes.settings.firewallEnabled,
      firewallDisabledWarnCategories:
        notes.settings.firewallDisabledWarnCategories,
    },
    nextDeliveryDraftRevision(draft.revision)
  );
  delivery.replaceDraft(rebound);
  return true;
}

type ExecuteDraft = (
  draft: DeliveryDraft
) => Promise<SendDeliveryResult | null>;

let draftPreparationPending = false;

export function deliveryDraftPreparationPending(): boolean {
  return draftPreparationPending;
}

const SAFE_RETRY_REASONS = new Set<SendDeliveryResult["reasonCode"]>([
  "target_not_frontmost",
  "delivery_in_progress",
  "payload_empty",
  "image_unreadable",
]);

/** 仅放行 Native 状态机保证发生在首次 paste 尝试前的失败原因。 */
export function deliveryRetryIsSafe(
  result: SendDeliveryResult | null
): boolean {
  return !!result &&
    result.status !== "sent" &&
    !result.pasteCompleted &&
    SAFE_RETRY_REASONS.has(result.reasonCode);
}

export async function dispatchDeliveryDraft(
  draft: DeliveryDraft,
  options: {
    force?: boolean;
    execute?: ExecuteDraft;
    scan?: ScanSensitiveText;
    scanImage?: ScanImageFirewall;
    activityReasonCode?: "retry-prepared";
  } = {}
): Promise<SendDeliveryResult | null> {
  if (draftPreparationPending) {
    warnWithPanel("已有发送正在准备，请稍候", "delivery-preparing");
    return null;
  }
  draftPreparationPending = true;
  try {
    void recordDeliveryEvent(
      deliveryEventFromDraft(draft, "draftCreated", {
        status: "prepared",
        reasonCode: options.activityReasonCode ?? null,
      })
    );
    const textScanned = await scanDeliveryDraftFirewall(draft, options.scan);
    const scannedDraft = await scanDeliveryDraftImages(textScanned, options.scanImage);
    const state = useDeliveryStore.getState();
    if (state.open) {
      warnWithPanel("请先完成或关闭当前发送预检", "preflight-open");
      return null;
    }
    if (shouldOpenPreflight(scannedDraft, state.preflightMode, options.force)) {
      state.openDraft(scannedDraft);
      useUIStore.getState().setOpen(true);
      void recordDeliveryEvent(
        deliveryEventFromDraft(scannedDraft, "preflightOpened", {
          status: "opened",
        })
      );
      return null;
    }
    return await (options.execute ?? executeDeliveryDraft)(scannedDraft);
  } finally {
    draftPreparationPending = false;
  }
}

export function preflightStaleMessage(
  reason: ReturnType<typeof inspectDeliveryDraft>
): string | null {
  return reason ? staleMessages[reason] : null;
}

export async function submitPreflightDraft(options: {
  execute?: ExecuteDraft;
  inspect?: typeof inspectDeliveryDraft;
  rebase?: typeof rebaseDeliveryDraftForRetry;
  retrySafe?: typeof deliveryRetryIsSafe;
  refresh?: typeof refreshTarget;
  scan?: ScanSensitiveText;
  scanImage?: ScanImageFirewall;
} = {}): Promise<SendDeliveryResult | null> {
  const state = useDeliveryStore.getState();
  if (!state.open || !state.draft || state.busy) return null;
  if (state.retryBlocked) {
    state.setLastError("目标可能已收到部分内容，请核对后关闭并重新预检");
    return null;
  }
  if (state.transform.status === "running") {
    state.setLastError("AI 转换正在生成，请先取消或等待完成");
    return null;
  }
  let draft = state.draft;
  if (draft.firewallEnabled && draft.firewallStatus === "idle") {
    state.setBusy(true);
    const scanned = await scanDeliveryDraftFirewall(draft, options.scan);
    const current = useDeliveryStore.getState();
    if (!current.open || current.draft !== draft) return null;
    useDeliveryStore.setState({ draft: scanned, busy: false });
    draft = scanned;
  }
  if (draft.imageFirewall.some((item) => item.status === "idle")) {
    if (!useDeliveryStore.getState().busy) state.setBusy(true);
    const scanned = await scanDeliveryDraftImages(draft, options.scanImage);
    const current = useDeliveryStore.getState();
    if (!current.open || current.draft !== draft) return null;
    useDeliveryStore.setState({ draft: scanned, busy: false });
    draft = scanned;
  }
  const inspect = options.inspect ?? inspectDeliveryDraft;
  const rebase = options.rebase ?? rebaseDeliveryDraftForRetry;
  let reason = inspect(draft);
  let busyClaimed = false;
  if (reason === "target" && state.safeRetryPending) {
    state.setBusy(true);
    state.setLastError(null);
    busyClaimed = true;
    let refreshedTarget = null;
    try {
      refreshedTarget = await (options.refresh ?? refreshTarget)();
    } catch {
      // 重新识别发生在 Native 发送前，失败仍然可以再次尝试。
    }
    const current = useDeliveryStore.getState();
    if (!current.open || current.draft !== draft) return null;
    const recovered = rebase(draft, refreshedTarget);
    if (!recovered) {
      current.setBusy(false);
      current.setLastError("原目标、来源或发送方案已变化，请重新打开预检");
      return null;
    }
    current.replaceDraft(recovered);
    draft = recovered;
    reason = inspect(draft);
  }
  if (reason) {
    const current = useDeliveryStore.getState();
    if (busyClaimed) current.setBusy(false);
    current.setLastError(staleMessages[reason]);
    return null;
  }
  if (draft.enterPolicy === "confirm" && !draft.enterDecisionConfirmed) {
    state.setLastError("请先确认本次粘贴后是否按回车");
    return null;
  }
  const firewall = evaluateDeliveryDraftFirewall(draft);
  const imageFirewall = evaluateDeliveryDraftImages(draft);
  if (!firewall.canSend || !imageFirewall.canSend) {
    void recordDeliveryEvent(
      deliveryEventFromDraft(draft, "firewallBlocked", {
        status: "blocked",
        reasonCode: "privacy_gate_blocked",
      })
    );
    state.setLastError(
      firewall.reason ?? imageFirewall.reason ?? "请先完成隐私检查"
    );
    return null;
  }

  if (!busyClaimed) state.setBusy(true);
  state.setLastError(null);
  try {
    const result = await (options.execute ?? executeDeliveryDraft)(draft);
    if (result?.status === "sent") {
      useDeliveryStore.getState().closeDraft();
      cleanupDeliveryDraftImages(draft);
      return result;
    }
    const delivery = useDeliveryStore.getState();
    if (!result) {
      delivery.setSafeRetryPending(true);
      delivery.setBusy(false);
      delivery.setLastError("发送尚未开始，可以修改后重试");
      return null;
    }
    if (result.reasonCode === "image_changed" && !result.pasteCompleted) {
      delivery.setSafeRetryPending(false);
      delivery.setRetryBlocked(true);
      delivery.setBusy(false);
      delivery.setLastError("图片内容已变化，请关闭后重新预检并重新扫描");
      return result;
    }
    const retrySafe = (options.retrySafe ?? deliveryRetryIsSafe)(result);
    const retryDraft = retrySafe
      ? (options.rebase ?? rebaseDeliveryDraftForRetry)(
          draft,
          result?.target ?? null
        )
      : null;
    if (retryDraft) delivery.replaceDraft(retryDraft);
    else if (retrySafe) delivery.setSafeRetryPending(true);
    else {
      delivery.setSafeRetryPending(false);
      delivery.setRetryBlocked(true);
    }
    delivery.setBusy(false);
    delivery.setLastError(
      retrySafe
        ? "发送未完成，可以修改后重试"
        : "目标可能已收到全部或部分内容，请先核对；关闭后可重新预检"
    );
    return result;
  } catch {
    const delivery = useDeliveryStore.getState();
    delivery.setSafeRetryPending(false);
    delivery.setRetryBlocked(true);
    delivery.setBusy(false);
    delivery.setLastError(
      "发送结果不确定，请先核对目标；关闭后可重新预检"
    );
    return null;
  }
}
