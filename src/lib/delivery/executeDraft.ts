import { ask } from "@tauri-apps/plugin-dialog";

import { currentTargetProfileResolution } from "@/lib/currentTargetProfile";
import { buildDeliveryDraft } from "@/lib/delivery/buildDraft";
import {
  beginDataGenerationLease,
  matchesDataGeneration,
} from "@/lib/dataGeneration";
import {
  api,
  isSendDeliveryResult,
  type SendDeliveryResult,
  type TargetSnapshot,
} from "@/lib/tauri";
import { tip } from "@/lib/tip";
import { isDataOperationLocked } from "@/store/dataOperationStore";
import { doneIdsAfterSend, useNotesStore } from "@/store/notesStore";
import {
  clearTargetProfileOverride,
  currentTargetBlockMessage,
  readTarget,
  refreshTarget,
  sameTargetIdentity,
  targetProfileIdentity,
  targetSendDisabled,
  useTargetStore,
} from "@/store/targetStore";
import { useUIStore } from "@/store/uiStore";
import {
  deliveryEventFromDraft,
  recordDeliveryEvent,
  recordDeliveryResult,
} from "@/lib/deliveryActivityCore";
import { rememberDeliveryRedactionMap } from "@/lib/resultReturn";
import { isSafeRehearsalText } from "@/lib/onboarding";

import type { DeliveryDraft } from "./types";
import { evaluateDeliveryDraftFirewall } from "./firewallController";
import { evaluateDeliveryDraftImages } from "./imageFirewall";

let latestAllocatedRevision = 0;
let activeExecutionRevision: number | null = null;
let deliveryPending = false;

/** 为每个可执行 Draft 分配唯一、单调递增的会话版本。 */
export function nextDeliveryDraftRevision(afterRevision = 0): number {
  latestAllocatedRevision = Math.max(
    latestAllocatedRevision,
    afterRevision
  ) + 1;
  return latestAllocatedRevision;
}

/** 内容、目标或数据上下文变化时作废所有旧异步回执。 */
export function invalidateDeliveryDrafts(): void {
  latestAllocatedRevision += 1;
  activeExecutionRevision = null;
}

export function deliveryDraftPending(): boolean {
  return deliveryPending;
}

/** 数据重新水合/测试隔离共用的会话重置；不持久化 revision。 */
export function resetDeliveryDraftSession(): void {
  latestAllocatedRevision = 0;
  activeExecutionRevision = null;
  deliveryPending = false;
}

export function warnWithPanel(message: string, diagCode?: string) {
  useUIStore.getState().setOpen(true);
  try {
    void Promise.resolve(api.showPanel()).catch(() => {});
    void Promise.resolve(
      api.diagNote(`前端阻断: ${diagCode ?? message}`)
    ).catch(() => {});
  } catch {
    /* Tauri 环境外 */
  }
  tip("warn", message);
}

async function restorePanelAfterDelivery(keepPanel: boolean) {
  useUIStore.getState().setOpen(true);
  if (!keepPanel) {
    try {
      await api.showPanel();
    } catch (error) {
      tip("warn", `发送已中止，但面板恢复失败：${error}`);
    }
  }
}

type DeliveryPanelPlan = {
  keepNativeWindow: boolean;
  edgeHideAfterSuccess: boolean;
};

/** 贴边模式的“收起”是沿屏缘滑出，不能退化成真实 hide。 */
function planDeliveryPanel(draftKeepPanel: boolean): DeliveryPanelPlan {
  const { pinned, edgeHideActive } = useUIStore.getState();
  const keepByPolicy = draftKeepPanel || pinned;
  const edgeHideAfterSuccess = edgeHideActive && !keepByPolicy;
  return {
    keepNativeWindow: keepByPolicy || edgeHideAfterSuccess,
    edgeHideAfterSuccess,
  };
}

function settlePanelAfterSuccessfulDelivery(plan: DeliveryPanelPlan) {
  if (!plan.edgeHideAfterSuccess) return;
  const ui = useUIStore.getState();
  // 发送期间若用户改为固定，实时图钉比 Draft 快照优先。
  if (ui.pinned) return;
  ui.setShortcutHoldOpen(false);
  if (!ui.edgeHideActive) {
    ui.setOpen(false);
    return;
  }
  // 这里是发送方案的显式“成功后收起”：解除快捷键保护，
  // 但保留窗口和屏缘锚点，以便触边立即唤回。
  if (!ui.edgeHidden) void api.edgeHideNow(true).catch(() => {});
}

function sameDraftTarget(
  draftTarget: TargetSnapshot | null,
  currentTarget: TargetSnapshot | null
): boolean {
  return !!draftTarget &&
    !!currentTarget &&
    draftTarget.token === currentTarget.token &&
    sameTargetIdentity(draftTarget, currentTarget);
}

function sameDraftProfile(draft: DeliveryDraft): boolean {
  const current = currentTargetProfileResolution();
  const settings = useNotesStore.getState().settings;
  const privacyCurrent = draft.safeRehearsal
    ? draft.privacyPolicy === "requireRedaction" &&
      draft.firewallEnabled &&
      draft.firewallDisabledWarnCategories.length === 0
    : current.profile.privacyPolicy === draft.privacyPolicy &&
      settings.firewallEnabled === draft.firewallEnabled &&
      sameStrings(
        settings.firewallDisabledWarnCategories,
        draft.firewallDisabledWarnCategories
      );
  return current.source === draft.profileSource &&
    current.profileId === draft.targetProfileId &&
    current.promptGroup.id === draft.promptGroupId &&
    current.profile.defaultFormat === draft.profileDefaultFormat &&
    current.profile.enterPolicy === draft.enterPolicy &&
    current.profile.keepPanel === draft.profileKeepPanel &&
    privacyCurrent;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

/**
 * 发送前复核交错顺序仍与 Draft 现状对齐：预检改过正文（finalText 漂离
 * rawText）或图片清单数量变化都退回默认顺序，宁可不交错也不发错内容。
 */
function draftSegmentsForSend(draft: DeliveryDraft) {
  const segments = draft.segments;
  if (!segments || draft.finalText !== draft.rawText) return undefined;
  const referenced = segments.flatMap((segment) =>
    segment.kind === "image" ? [segment.fileIndex] : []
  );
  const valid =
    referenced.length === draft.imageFiles.length &&
    new Set(referenced).size === referenced.length &&
    referenced.every((index) => index >= 0 && index < draft.imageFiles.length);
  return valid ? segments : undefined;
}

/** 原文保留决定绑定当前 target token；发送前复核不能再轮换这枚 token。 */
function draftHasTargetBoundPrivacyDecision(draft: DeliveryDraft): boolean {
  return draft.privacyDecision.excludedFindingIds.length > 0 ||
    draft.privacyDecision.rawConfirmation !== null ||
    draft.imageFirewall.some((item) => item.rawConfirmation !== null);
}

function draftSourceIsCurrent(draft: DeliveryDraft): boolean {
  const state = useNotesStore.getState();
  if (draft.promptSnippetId) {
    const snippet = state.settings.promptSnippets.find(
      (item) => item.id === draft.promptSnippetId
    );
    if (
      !snippet ||
      snippet.text !== draft.promptTemplate ||
      snippet.groupId !== draft.promptSnippetGroupId
    ) {
      return false;
    }
  }
  const rebuilt = buildDeliveryDraft(
    {
      id: draft.id,
      revision: draft.revision,
      createdAtMs: draft.createdAtMs,
      sourceKind: draft.sourceKind,
      sourceItemIds: draft.sourceItemIds,
      format: draft.format,
      promptSnippetId: draft.promptSnippetId,
      promptTemplate: draft.promptTemplate ?? undefined,
      sourceTextOverride: draft.sourceTextOverride ?? undefined,
    },
    {
      notes: state.notes,
      tasks: state.tasks,
      promptSnippets: state.settings.promptSnippets,
      checkedItemIds: state.checkedIds,
      targetSnapshot: useTargetStore.getState().snapshot,
      profileResolution: currentTargetProfileResolution(),
      panelPinned: useUIStore.getState().pinned,
      dataGeneration: draft.dataGeneration,
      firewallEnabled: state.settings.firewallEnabled,
      firewallDisabledWarnCategories:
        state.settings.firewallDisabledWarnCategories,
      aliasEntitiesEnabled: state.settings.aliasEntitiesEnabled,
      aliasEntities: state.settings.aliasEntities,
    }
  );
  return rebuilt.rawText === draft.rawText &&
    rebuilt.finalText === draft.assembledText &&
    sameStrings(rebuilt.sourceItemIds, draft.sourceItemIds) &&
    sameStrings(rebuilt.imageFiles, draft.originalImageFiles);
}

export type DeliveryDraftFreshnessIssue =
  | "generation"
  | "source"
  | "selection"
  | "revision";

export type DeliveryDraftStaleReason =
  | DeliveryDraftFreshnessIssue
  | "target"
  | "profile";

export type DeliveryDraftNonTargetStaleReason = Exclude<
  DeliveryDraftStaleReason,
  "target"
>;

export function inspectDeliveryDraftFreshness(
  draft: DeliveryDraft
): DeliveryDraftFreshnessIssue | null {
  if (!matchesDataGeneration(draft.dataGeneration)) return "generation";
  if (!draftSourceIsCurrent(draft)) return "source";
  if (
    draft.sourceKind !== "task" &&
    !sameStrings(draft.selectionItemIds, useNotesStore.getState().checkedIds)
  ) {
    return "selection";
  }
  const expectedRevision = deliveryPending
    ? activeExecutionRevision
    : latestAllocatedRevision;
  return draft.revision === expectedRevision ? null : "revision";
}

/** Preflight 只读检查：不弹 HUD、不修改 revision，也不记录正文。 */
export function inspectDeliveryDraft(
  draft: DeliveryDraft
): DeliveryDraftStaleReason | null {
  const target = useTargetStore.getState();
  if (
    target.status !== "ready" ||
    target.profileOverrideNeedsConfirmation ||
    !sameDraftTarget(draft.targetSnapshot, target.snapshot)
  ) {
    return "target";
  }
  return inspectDeliveryDraftNonTarget(draft);
}

/** 目标失效会遮住其他 stale；安全重试编辑前用它独立证明来源与策略仍新鲜。 */
export function inspectDeliveryDraftNonTarget(
  draft: DeliveryDraft
): DeliveryDraftNonTargetStaleReason | null {
  if (!sameDraftProfile(draft)) return "profile";
  return inspectDeliveryDraftFreshness(draft);
}

/**
 * Native 刷新会为同一目标轮换 token。失败重试只更新这枚能力令牌；
 * 目标身份、来源、选择或方案任一变化都拒绝重基线。
 */
export function rebaseDeliveryDraftForRetry(
  draft: DeliveryDraft,
  verifiedTarget: TargetSnapshot | null
): DeliveryDraft | null {
  const target = useTargetStore.getState();
  if (
    target.status !== "ready" ||
    target.profileOverrideNeedsConfirmation ||
    !target.snapshot ||
    !verifiedTarget ||
    !sameDraftTarget(verifiedTarget, target.snapshot) ||
    !sameTargetIdentity(draft.targetSnapshot, target.snapshot) ||
    !sameDraftProfile(draft) ||
    inspectDeliveryDraftFreshness(draft)
  ) {
    return null;
  }
  return {
    ...draft,
    revision: nextDeliveryDraftRevision(draft.revision),
    targetSnapshot: { ...verifiedTarget },
  };
}

function rejectStaleDraft(draft: DeliveryDraft): boolean {
  const issue = inspectDeliveryDraftFreshness(draft);
  if (!issue) return false;
  if (issue === "source" || issue === "selection") invalidateDeliveryDrafts();
  const messages: Record<DeliveryDraftFreshnessIssue, [string, string]> = {
    generation: [
      "发送已取消：数据上下文已变化，请重新选择内容",
      "send-generation-changed",
    ],
    source: ["发送已取消：来源内容已变化，请重试", "draft-source-changed"],
    selection: ["发送已取消：选择已变化，请重试", "draft-selection-changed"],
    revision: ["发送已取消：发送内容已更新，请重试", "draft-stale"],
  };
  void recordDeliveryEvent(
    deliveryEventFromDraft(draft, "sendBlocked", {
      status: "blocked",
      reasonCode: messages[issue][1],
    })
  );
  warnWithPanel(...messages[issue]);
  return true;
}

function blockDelivery(
  draft: DeliveryDraft,
  message: string,
  reasonCode: string
): null {
  warnWithPanel(message, reasonCode);
  void recordDeliveryEvent(
    deliveryEventFromDraft(draft, "sendBlocked", {
      status: "blocked",
      reasonCode,
    })
  );
  return null;
}

async function discardStaleResult(
  draft: DeliveryDraft,
  result: SendDeliveryResult
): Promise<boolean> {
  const issue = inspectDeliveryDraftFreshness(draft);
  if (!issue) return false;
  if (issue === "source" || issue === "selection") invalidateDeliveryDrafts();
  if (result.status !== "sent") {
    await restorePanelAfterDelivery(draft.keepPanel);
    return true;
  }
  const messages: Record<DeliveryDraftFreshnessIssue, string> = {
    generation: "发送已完成，但数据上下文已变化，未修改卡片状态",
    source: "发送已完成，但来源内容已变化，未修改卡片状态",
    selection: "发送已完成，但选择已变化，未修改卡片状态",
    revision: "发送已完成，但发送内容版本已变化，未修改卡片状态",
  };
  tip("warn", messages[issue]);
  return true;
}

function applySuccessfulDelivery(draft: DeliveryDraft) {
  if (draft.sourceKind === "task") return;
  const state = useNotesStore.getState();
  const liveIds = new Set(state.notes.map((note) => note.id));
  if (draft.sourceItemIds.some((id) => !liveIds.has(id))) {
    tip("warn", "发送已完成，但来源卡片已变化，未修改卡片状态");
    return;
  }
  const doneIds = doneIdsAfterSend(state, draft.sourceItemIds);
  if (doneIds.length) state.setDone(doneIds, true);
  state.clearChecked();
  if (draft.safeRehearsal) {
    const onboarding = useNotesStore.getState().settings.onboarding;
    const rehearsalNote = state.notes.find(
      (note) => note.id === draft.sourceItemIds[0]
    );
    if (
      draft.sourceItemIds.length === 1 &&
      onboarding.rehearsalActive &&
      onboarding.rehearsalNoteId === draft.sourceItemIds[0] &&
      rehearsalNote &&
      isSafeRehearsalText(rehearsalNote.text)
    ) {
      state.transitionOnboarding({ type: "deliverySent" });
    } else {
      tip("warn", "演练发送已完成，但演练会话已变化，未改写上手进度");
    }
    return;
  }
  state.markOnboarding({ sent: true });
}

/** 所有外部发送唯一执行器；只消费不可变 Draft，不再自行拼装正文。 */
export async function executeDeliveryDraft(
  draft: DeliveryDraft
): Promise<SendDeliveryResult | null> {
  if (deliveryPending) {
    return blockDelivery(draft, "已有发送正在进行，请稍候", "delivery-pending");
  }
  if (draft.revision !== latestAllocatedRevision) {
    return blockDelivery(draft, "发送已取消：发送内容已更新，请重试", "draft-stale");
  }
  if (isDataOperationLocked()) {
    return blockDelivery(draft, "数据只读期间不能发送", "data-locked");
  }
  if (draft.warnings.includes("source-missing")) {
    return blockDelivery(draft, "发送已取消：所选内容已变化", "draft-source-missing");
  }
  if (draft.warnings.includes("empty-payload")) {
    return blockDelivery(draft, "发送已取消：没有可发送的内容", "draft-empty");
  }
  if (useTargetStore.getState().profileOverrideNeedsConfirmation) {
    return blockDelivery(
      draft,
      "原临时发送方案已暂停，请确认或恢复自动匹配",
      "override-needs-confirmation"
    );
  }
  if (targetSendDisabled()) {
    return blockDelivery(draft, currentTargetBlockMessage(), "target-not-ready");
  }
  // 只比目标身份，不比 token：Native 刷新会为同一目标轮换 token（见 targetStore
  // 的 sameTargetIdentity 注释），详情窗「发送选中」关窗那一下必然触发一次刷新，
  // 若把轮换当成换了目标，同一个目标也会被误判成「发送目标已变化」。
  // token 的安全边界在后面：refreshedTarget 与 draft 的身份仍要一致，隐私绑定
  // 场景另有 token 严格校验，真正下发也用刷新后的 refreshedTarget.token
  const currentTarget = useTargetStore.getState().snapshot;
  if (!currentTarget || !sameTargetIdentity(draft.targetSnapshot, currentTarget)) {
    return blockDelivery(draft, "发送目标已变化，请确认后重试发送", "draft-target-changed");
  }
  if (!sameDraftProfile(draft)) {
    return blockDelivery(draft, "发送方案设置已变化，请确认后重试发送", "profile-policy-changed");
  }
  if (rejectStaleDraft(draft)) return null;
  const firewall = evaluateDeliveryDraftFirewall(draft);
  const imageFirewall = evaluateDeliveryDraftImages(draft);
  if (!firewall.canSend || !imageFirewall.canSend) {
    warnWithPanel(
      `发送已取消：${firewall.reason ?? imageFirewall.reason ?? "隐私检查未完成"}`,
      "privacy_gate_blocked"
    );
    void recordDeliveryEvent(
      deliveryEventFromDraft(draft, "firewallBlocked", {
        status: "blocked",
        reasonCode: "privacy_gate_blocked",
      })
    );
    return null;
  }

  const lease = beginDataGenerationLease();
  activeExecutionRevision = draft.revision;
  deliveryPending = true;
  let nativeDispatchTarget: TargetSnapshot | null = null;
  try {
    let pressEnter = draft.safeRehearsal ||
      firewall.forcePressEnterOff || imageFirewall.forcePressEnterOff
      ? false
      : draft.pressEnter;
    if (
      !draft.safeRehearsal &&
      draft.enterPolicy === "confirm" &&
      !draft.enterDecisionConfirmed
    ) {
      const confirmed = await ask(
        "当前发送方案的“粘贴后动作”需要确认：粘贴后立即按回车吗？",
        { title: "确认粘贴后动作", kind: "warning" }
      );
      if (rejectStaleDraft(draft)) return null;
      if (!confirmed) {
        tip("info", "已取消发送，内容和选择保持不变");
        return null;
      }
      pressEnter = true;
    }

    const preserveConfirmedToken = draftHasTargetBoundPrivacyDecision(draft);
    const refreshedTarget = await (
      preserveConfirmedToken ? readTarget() : refreshTarget()
    );
    if (!refreshedTarget?.ready || targetSendDisabled()) {
      const message = refreshedTarget
        ? currentTargetBlockMessage()
        : useTargetStore.getState().status === "ready"
          ? "发送目标刚刚发生变化，请重试发送"
          : currentTargetBlockMessage();
      return blockDelivery(draft, message, "target-refresh-blocked");
    }
    if (!sameTargetIdentity(draft.targetSnapshot, refreshedTarget)) {
      return blockDelivery(draft, "发送目标已变化，请确认后重试发送", "target-identity-changed");
    }
    if (
      preserveConfirmedToken &&
      refreshedTarget.token !== draft.targetSnapshot?.token
    ) {
      return blockDelivery(
        draft,
        "发送目标凭据已变化，请重新确认原文发送",
        "privacy-confirmation-stale"
      );
    }
    if (useTargetStore.getState().profileOverrideNeedsConfirmation) {
      return blockDelivery(
        draft,
        "原临时发送方案已暂停，请确认或恢复自动匹配",
        "override-needs-confirmation"
      );
    }
    if (!sameDraftProfile(draft)) {
      return blockDelivery(draft, "发送方案设置已变化，请确认后重试发送", "profile-policy-changed");
    }
    if (rejectStaleDraft(draft)) return null;

    const panelPlan = planDeliveryPanel(draft.keepPanel);
    if (!panelPlan.keepNativeWindow) useUIStore.getState().setOpen(false);
    nativeDispatchTarget = refreshedTarget;
    void recordDeliveryEvent(
      deliveryEventFromDraft(draft, "sendStarted", { status: "started" })
    );
    const result = await api.sendDelivery({
      targetToken: refreshedTarget.token,
      text: draft.finalText,
      imageFiles: draft.imageFiles,
      expectedImagePixelHashes: draft.imageFirewall.map((item) =>
        item.sendFile === item.originalFile
          ? item.pixelHash
          : item.redactedPixelHash
      ),
      segments: draftSegmentsForSend(draft),
      pressEnter,
      keepPanel: panelPlan.keepNativeWindow,
      deliveryId: draft.id,
    });
    if (!isSendDeliveryResult(result) || result.deliveryId !== draft.id) {
      throw new Error("原生发送回执无效");
    }
    recordDeliveryResult(draft, result);
    if (result.status === "sent") {
      rememberDeliveryRedactionMap(draft.id, draft.redactionMap, draft.finalText);
      settlePanelAfterSuccessfulDelivery(panelPlan);
    }
    if (await discardStaleResult(draft, result)) return result;
    const targetState = useTargetStore.getState();
    if (
      result.status === "sent" &&
      draft.profileSource === "temporary" &&
      targetState.profileOverrideId === draft.targetProfileId &&
      !targetState.profileOverrideNeedsConfirmation &&
      !!result.target &&
      targetState.profileOverrideTargetIdentity ===
        targetProfileIdentity(result.target) &&
      sameTargetIdentity(draft.targetSnapshot, result.target)
    ) {
      clearTargetProfileOverride();
    }
    if (result.status === "sent") {
      applySuccessfulDelivery(draft);
    } else {
      await restorePanelAfterDelivery(draft.keepPanel);
    }
    return result;
  } catch (error) {
    await restorePanelAfterDelivery(draft.keepPanel);
    tip("warn", `发送失败：${error}`);
    // 只有进入 Native IPC 后的异常才属于“结果不确定”。调用前的失败没有
    // 粘贴副作用，仍返回 null，让预检保留可编辑、可重试状态。
    if (!nativeDispatchTarget) {
      void recordDeliveryEvent(
        deliveryEventFromDraft(draft, "sendBlocked", {
          status: "blocked",
          reasonCode: "target-refresh-failed",
        })
      );
      return null;
    }
    const finishedAtMs = Date.now();
    const result: SendDeliveryResult = {
      deliveryId: draft.id,
      status: "failed",
      reasonCode: "internal_error",
      message: "发送结果不确定，请先核对目标内容",
      target: nativeDispatchTarget,
      pasteCompleted: false,
      enterPressed: false,
      clipboardOutcome: "notOwned",
      startedAtMs: finishedAtMs,
      finishedAtMs,
    };
    recordDeliveryResult(draft, result);
    return result;
  } finally {
    activeExecutionRevision = null;
    deliveryPending = false;
    lease.release();
  }
}
