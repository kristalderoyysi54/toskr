import { currentTargetProfileResolution } from "@/lib/currentTargetProfile";
import {
  beginDataGenerationLease,
  currentDataGeneration,
  matchesDataGeneration,
} from "@/lib/dataGeneration";
import { buildDeliveryDraft } from "@/lib/delivery/buildDraft";
import {
  deliveryDraftPending,
  nextDeliveryDraftRevision,
} from "@/lib/delivery/executeDraft";
import type { ScanSensitiveText } from "@/lib/delivery/firewallController";
import {
  deliveryDraftPreparationPending,
  dispatchDeliveryDraft,
} from "@/lib/delivery/preflight";
import {
  deliveryEventOutputMode,
  type DeliveryEvent,
} from "@/lib/deliveryActivityCore";
import type { TargetSnapshot } from "@/lib/tauri";
import { isDataOperationLocked } from "@/store/dataOperationStore";
import { useDeliveryStore } from "@/store/deliveryStore";
import { useNotesStore } from "@/store/notesStore";
import { refreshTarget, useTargetStore } from "@/store/targetStore";
import { useUIStore } from "@/store/uiStore";

export type DeliveryRecoveryFailure =
  | "unsupported"
  | "sourceMissing"
  | "busy"
  | "dataChanged"
  | "targetUnavailable";

export type DeliveryRecoveryResult =
  | { ok: true }
  | { ok: false; reason: DeliveryRecoveryFailure };

type RecoveryOptions = {
  refresh?: () => Promise<TargetSnapshot | null>;
  scan?: ScanSensitiveText;
};

function sourcesExist(event: DeliveryEvent): boolean {
  if (!event.sourceItemIds.length) return false;
  const state = useNotesStore.getState();
  const ids = new Set(
    event.sourceKind === "task"
      ? state.tasks.map((item) => item.id)
      : state.notes.map((item) => item.id)
  );
  return event.sourceItemIds.every((id) => ids.has(id));
}

function recoveryBusy(): boolean {
  return isDataOperationLocked() ||
    useDeliveryStore.getState().open ||
    deliveryDraftPending() ||
    deliveryDraftPreparationPending();
}

/**
 * 历史事件只提供来源 id 与可选输出方式；恢复永远重读当前 Store、刷新目标
 * 并强制打开预检。这里没有 execute 注入点，结构上杜绝“历史记录一键自动重发”。
 */
export async function reprepareDeliveryEvent(
  event: DeliveryEvent,
  options: RecoveryOptions = {}
): Promise<DeliveryRecoveryResult> {
  const recordedOutputMode = deliveryEventOutputMode(event);
  const failedAttempt =
    ["firewallBlocked", "sendBlocked", "sendFailed"].includes(event.eventType) &&
    ["blocked", "failed"].includes(event.status);
  const completedSend =
    event.eventType === "sendSent" &&
    event.status === "sent" &&
    recordedOutputMode !== null;
  if (!failedAttempt && !completedSend) {
    return { ok: false, reason: "unsupported" };
  }
  if (!sourcesExist(event)) return { ok: false, reason: "sourceMissing" };
  if (recoveryBusy()) return { ok: false, reason: "busy" };

  const lease = beginDataGenerationLease();
  const generation = lease.generation;
  try {
    let target: TargetSnapshot | null;
    try {
      target = await (options.refresh ?? refreshTarget)();
    } catch {
      return { ok: false, reason: "targetUnavailable" };
    }
    if (
      !matchesDataGeneration(generation) ||
      isDataOperationLocked()
    ) {
      return { ok: false, reason: "dataChanged" };
    }
    if (!target?.ready || useTargetStore.getState().status !== "ready") {
      return { ok: false, reason: "targetUnavailable" };
    }
    // refresh 是异步边界，必须重读来源；历史正文和首次检查结果都不能复用。
    if (!sourcesExist(event)) return { ok: false, reason: "sourceMissing" };
    if (recoveryBusy()) return { ok: false, reason: "busy" };

    const notes = useNotesStore.getState();
    const draft = buildDeliveryDraft(
      {
        id: `delivery-${crypto.randomUUID()}`,
        revision: nextDeliveryDraftRevision(),
        createdAtMs: Date.now(),
        sourceKind: event.sourceKind,
        sourceItemIds: [...event.sourceItemIds],
        ...(recordedOutputMode
          ? {
              format: event.format,
              markdownMode: event.markdownMode,
            }
          : {}),
      },
      {
        notes: notes.notes,
        tasks: notes.tasks,
        promptSnippets: notes.settings.promptSnippets,
        checkedItemIds: notes.checkedIds,
        targetSnapshot: target,
        profileResolution: currentTargetProfileResolution(),
        panelPinned: useUIStore.getState().pinned,
        dataGeneration: currentDataGeneration(),
        firewallEnabled: notes.settings.firewallEnabled,
        firewallDisabledWarnCategories:
          notes.settings.firewallDisabledWarnCategories,
        aliasEntitiesEnabled: notes.settings.aliasEntitiesEnabled,
        aliasEntities: notes.settings.aliasEntities,
      }
    );
    await dispatchDeliveryDraft(draft, {
      force: true,
      scan: options.scan,
      activityReasonCode: "retry-prepared",
    });
    return useDeliveryStore.getState().open
      ? { ok: true }
      : { ok: false, reason: "busy" };
  } finally {
    lease.release();
  }
}
