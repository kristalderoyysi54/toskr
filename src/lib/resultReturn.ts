import type { DeliveryEvent } from "@/lib/deliveryActivityCore";
import type { Note } from "@/store/notesStore";

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
  redactionSessions.delete(deliveryId);
  redactionSessions.set(deliveryId, {
    map: Object.freeze(Object.fromEntries(entries)),
    placeholderCounts: Object.freeze(placeholderCounts),
  });
  while (redactionSessions.size > MAX_REDACTION_SESSIONS) {
    const oldest = redactionSessions.keys().next().value as string | undefined;
    if (!oldest) break;
    redactionSessions.delete(oldest);
  }
}

export function deliveryRedactionMapAvailable(deliveryId: string): boolean {
  return redactionSessions.has(deliveryId);
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
