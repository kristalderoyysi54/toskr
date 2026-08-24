import {
  recordDeliveryEvent,
  type DeliveryEvent,
} from "@/lib/deliveryActivityCore";
import { isIrreversiblePlaceholder } from "@/lib/delivery/firewall";
import { useNotesStore, type Note, type NoteProvenance } from "@/store/notesStore";

export const RESULT_ASSOCIATION_WINDOW_MS = 30 * 60 * 1_000;
const MAX_REDACTION_SESSIONS = 32;

export const RESULT_RETURN_REQUEST_EVENT = "toskr:result-return-request";
export const RESULT_LINK_CHANGED_EVENT = "toskr:result-link-changed";

export type ResultReturnRequest =
  | { kind: "linkNote"; noteId: string; returnFocus?: HTMLElement | null }
  | { kind: "linkDelivery"; delivery: DeliveryEvent; returnFocus?: HTMLElement | null }
  | { kind: "unlink"; noteId: string; returnFocus?: HTMLElement | null }
  | { kind: "preview"; noteId: string; returnFocus?: HTMLElement | null }
  | { kind: "close" };

type RedactionSession = {
  map: Readonly<Record<string, string>>;
  placeholderCounts: Readonly<Record<string, number>>;
};

const redactionSessions = new Map<string, RedactionSession>();

function request(detail: ResultReturnRequest): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<ResultReturnRequest>(RESULT_RETURN_REQUEST_EVENT, {
    detail,
  }));
}

export function requestResultLinkForNote(
  noteId: string,
  returnFocus?: HTMLElement | null
): void {
  request({ kind: "linkNote", noteId, returnFocus });
}

export function requestResultLinkForDelivery(
  delivery: DeliveryEvent,
  returnFocus?: HTMLElement | null
): void {
  request({ kind: "linkDelivery", delivery, returnFocus });
}

export function requestResultUnlink(noteId: string, returnFocus?: HTMLElement | null): void {
  request({ kind: "unlink", noteId, returnFocus });
}

export function requestPlaceholderPreview(
  noteId: string,
  returnFocus?: HTMLElement | null
): void {
  request({ kind: "preview", noteId, returnFocus });
}

export function closeResultReturnDialog(): void {
  request({ kind: "close" });
}

function successfulEvent(event: DeliveryEvent): boolean {
  return event.eventType === "sendSent" && event.status === "sent";
}

export function deliveryCandidatesForCapturedNote(
  note: Note,
  events: readonly DeliveryEvent[]
): DeliveryEvent[] {
  if (!note.sourceBundle) return [];
  const byDelivery = new Map<string, DeliveryEvent>();
  for (const event of events) {
    const elapsed = note.createdAt - event.timestampMs;
    if (
      !successfulEvent(event) ||
      event.targetBundleId !== note.sourceBundle ||
      elapsed < 0 ||
      elapsed > RESULT_ASSOCIATION_WINDOW_MS
    ) continue;
    const current = byDelivery.get(event.deliveryId);
    if (!current || event.timestampMs > current.timestampMs) {
      byDelivery.set(event.deliveryId, event);
    }
  }
  return [...byDelivery.values()].sort(
    (left, right) => right.timestampMs - left.timestampMs
  );
}

export function resultNoteCandidatesForDelivery(
  event: DeliveryEvent,
  notes: readonly Note[]
): Note[] {
  if (!successfulEvent(event) || !event.targetBundleId) return [];
  return notes
    .filter((note) => {
      const elapsed = note.createdAt - event.timestampMs;
      return note.sourceBundle === event.targetBundleId &&
        elapsed >= 0 && elapsed <= RESULT_ASSOCIATION_WINDOW_MS;
    })
    .sort((left, right) => left.createdAt - right.createdAt);
}

export type ResultAssociationState = "none" | "linked" | "unlinked" | "missing";

/** 候选变化时只保留用户亲自点选且仍然有效的项，绝不猜第一项。 */
export function retainExplicitResultSelection(
  selectedId: string | null,
  candidateIds: readonly string[]
): string | null {
  return selectedId && candidateIds.includes(selectedId) ? selectedId : null;
}

export function resultAssociationState(
  event: DeliveryEvent,
  notes: readonly Note[]
): ResultAssociationState {
  if (!event.resultNoteId) return "none";
  const note = notes.find((item) => item.id === event.resultNoteId);
  if (!note) return "missing";
  return note.provenance?.deliveryId === event.deliveryId ? "linked" : "unlinked";
}

function nextEventId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `result-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function resultCapturedEvent(
  delivery: DeliveryEvent,
  resultNoteId: string,
  timestampMs = Date.now()
): DeliveryEvent {
  return {
    eventId: nextEventId(),
    deliveryId: delivery.deliveryId,
    eventType: "resultCaptured",
    timestampMs,
    sourceKind: delivery.sourceKind,
    sourceItemIds: [...delivery.sourceItemIds],
    targetBundleId: delivery.targetBundleId,
    targetAppName: delivery.targetAppName,
    profileId: delivery.profileId,
    status: "captured",
    reasonCode: null,
    durationMs: null,
    textCharCount: delivery.textCharCount,
    imageCount: delivery.imageCount,
    firewallCounts: { ...delivery.firewallCounts },
    redactionCount: delivery.redactionCount,
    clipboardOutcome: null,
    resultNoteId,
    metricsEligible: delivery.metricsEligible !== false,
    metricsEpoch: delivery.metricsEpoch ?? 0,
    transformRecipeId: delivery.transformRecipeId ?? null,
    verificationStatus: null,
    verificationCheckCount: null,
    verificationIssueCount: null,
  };
}

export function rememberDeliveryRedactionMap(
  deliveryId: string,
  redactionMap: Readonly<Record<string, string>>,
  redactedText?: string
): void {
  const entries = Object.entries(redactionMap).filter(
    ([source, placeholder]) => !!source && !!placeholder
  );
  if (!deliveryId || !entries.length) return;
  const placeholderCounts = Object.fromEntries(
    [...new Set(entries.map(([, placeholder]) => placeholder))].map((placeholder) => {
      const count = redactedText
        ? redactedText.split(placeholder).length - 1
        : 1;
      return [placeholder, Math.max(1, count)];
    })
  );
  // 凭据 Secret 的映射在此边界不可逆丢弃：占位符仍参与计数与指纹证据，
  // 但 raw→placeholder 不驻留，恢复预览永远还原不出 Secret 原文。
  const reversibleEntries = entries.filter(
    ([, placeholder]) => !isIrreversiblePlaceholder(placeholder)
  );
  redactionSessions.delete(deliveryId);
  redactionSessions.set(deliveryId, {
    map: Object.freeze(Object.fromEntries(reversibleEntries)),
    placeholderCounts: Object.freeze(placeholderCounts),
  });
  while (redactionSessions.size > MAX_REDACTION_SESSIONS) {
    const oldest = redactionSessions.keys().next().value as string | undefined;
    if (!oldest) break;
    redactionSessions.delete(oldest);
  }
}

/** 是否存在可还原条目；Secret 已在写入口丢弃，全 Secret 的发送视为不可用。 */
export function deliveryRedactionMapAvailable(deliveryId: string): boolean {
  const map = redactionSessions.get(deliveryId)?.map;
  return !!map && Object.keys(map).length > 0;
}

/** 只暴露不可逆占位符及发送时次数，不暴露 raw→placeholder 映射。 */
export function deliveryPlaceholderCounts(
  deliveryId: string
): Readonly<Record<string, number>> | null {
  const counts = redactionSessions.get(deliveryId)?.placeholderCounts;
  return counts ? { ...counts } : null;
}

export function clearDeliveryRedactionSessions(): void {
  redactionSessions.clear();
}

/** 捕获原文是否含有该次投递发出的占位符——自动归位的指纹证据（仅会话内存可查）。 */
export function deliveryPlaceholderEvidence(
  deliveryId: string,
  text: string
): boolean {
  const counts = redactionSessions.get(deliveryId)?.placeholderCounts;
  if (!counts || !text) return false;
  return Object.keys(counts).some((placeholder) => text.includes(placeholder));
}

/**
 * 免确认自动归位：把捕获的回复卡写为某次投递的结果（provenance + resultCaptured 事件）。
 * 只对没有既有归属的卡片生效；调用方需自行保证证据充分（唯一候选 + 占位符指纹）。
 */
export async function linkCapturedNoteToDelivery(
  noteId: string,
  delivery: DeliveryEvent
): Promise<boolean> {
  const note = useNotesStore.getState().notes.find((item) => item.id === noteId);
  if (!note || note.provenance || !delivery.targetBundleId) return false;
  const provenance: NoteProvenance = {
    kind: "deliveryResult",
    deliveryId: delivery.deliveryId,
    capturedAtMs: note.createdAt,
    sourceBundle: delivery.targetBundleId,
    sourceItemIds: [...delivery.sourceItemIds],
  };
  if (!useNotesStore.getState().setNoteProvenance(noteId, provenance)) {
    return false;
  }
  const recorded = await recordDeliveryEvent(
    resultCapturedEvent(delivery, noteId)
  );
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(RESULT_LINK_CHANGED_EVENT));
  }
  return recorded;
}

export function previewRestoredPlaceholders(
  deliveryId: string,
  text: string
): { text: string; replacedCount: number } | null {
  const map = redactionSessions.get(deliveryId)?.map;
  if (!map) return null;
  let restored = text;
  let replacedCount = 0;
  const entries = Object.entries(map).sort(
    (left, right) => right[1].length - left[1].length
  );
  for (const [source, placeholder] of entries) {
    if (!placeholder) continue;
    const pieces = restored.split(placeholder);
    if (pieces.length === 1) continue;
    replacedCount += pieces.length - 1;
    restored = pieces.join(source);
  }
  return { text: restored, replacedCount };
}
