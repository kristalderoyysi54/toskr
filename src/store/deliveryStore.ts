import { create } from "zustand";

import { nextDeliveryDraftRevision } from "@/lib/delivery/executeDraft";
import type {
  DeliveryDraft,
  DeliveryDraftWarning,
} from "@/lib/delivery/types";
import {
  EMPTY_PRIVACY_DECISION,
  replaceFirewallFindings,
} from "@/lib/delivery/firewall";
import { findingUtf16RangeIsValid } from "@/lib/privacy";
import type { FindingCategory } from "@/lib/tauri";
import type {
  TransformRequest,
  TransformResult,
  TransformSession,
} from "@/lib/aiTransform";

export type PreflightMode = "smart" | "always" | "off";
export type PreflightSection = "summary" | "content";

interface DeliveryState {
  draft: DeliveryDraft | null;
  open: boolean;
  busy: boolean;
  activeSection: PreflightSection;
  lastError: string | null;
  retryBlocked: boolean;
  safeRetryPending: boolean;
  transform: TransformSession;
  preflightMode: PreflightMode;
  openDraft: (draft: DeliveryDraft) => void;
  replaceDraft: (draft: DeliveryDraft, preserveSafeRetry?: boolean) => void;
  closeDraft: () => void;
  setBusy: (busy: boolean) => void;
  setActiveSection: (activeSection: PreflightSection) => void;
  setLastError: (lastError: string | null) => void;
  setRetryBlocked: (retryBlocked: boolean) => void;
  setSafeRetryPending: (safeRetryPending: boolean) => void;
  setPreflightMode: (preflightMode: PreflightMode) => void;
  setFinalText: (finalText: string) => void;
  resetFinalText: () => void;
  setKeepPanel: (keepPanel: boolean) => void;
  confirmEnter: (confirmed: boolean) => void;
  replaceFirewallFinding: (findingId: string) => void;
  replaceFirewallCategory: (category: FindingCategory) => void;
  replaceAllFirewallFindings: () => void;
  excludeFirewallFinding: (findingId: string) => void;
  /** 词典化名单次豁免：把 finalText 中一处占位符还原为原文并触发隐私重扫描。 */
  revertAliasFinding: (occurrence: {
    startUtf16: number;
    endUtf16: number;
    placeholder: string;
    originalText: string;
  }) => void;
  confirmRawPrivacy: (level: "warn" | "block") => void;
  beginTransform: (request: TransformRequest) => boolean;
  finishTransform: (result: TransformResult) => void;
  failTransform: (requestId: string, error: string) => void;
  cancelTransform: (requestId: string) => void;
  settleTransformTransport: (requestId: string) => void;
  setTransformError: (error: string) => void;
  discardTransform: () => void;
  applyTransformResult: () => boolean;
  restoreTransformText: () => boolean;
}

function emptyTransform(): TransformSession {
  return {
    status: "idle",
    request: null,
    result: null,
    error: null,
    restoreText: null,
    transportPending: false,
  };
}

const initialSession = () => ({
  draft: null,
  open: false,
  busy: false,
  activeSection: "summary" as const,
  lastError: null,
  retryBlocked: false,
  safeRetryPending: false,
  preflightMode: "smart" as const,
  transform: emptyTransform(),
});

function warningsForText(draft: DeliveryDraft, finalText: string) {
  const warnings: DeliveryDraftWarning[] = draft.warnings.filter(
    (warning) => warning !== "empty-payload"
  );
  if (!finalText && draft.imageFiles.length === 0) warnings.push("empty-payload");
  return warnings;
}

function revise(
  draft: DeliveryDraft,
  patch: Partial<DeliveryDraft>,
  invalidatePrivacy = false
): DeliveryDraft {
  const finalText = patch.finalText ?? draft.finalText;
  const next: DeliveryDraft = {
    ...draft,
    ...patch,
    revision: nextDeliveryDraftRevision(draft.revision),
    warnings: warningsForText(draft, finalText),
  };
  if (next.safeRehearsal) {
    next.enterDecisionConfirmed = true;
    next.pressEnter = false;
    next.keepPanel = true;
  }
  if (!invalidatePrivacy) return next;
  return {
    ...next,
    firewallStatus: next.firewallEnabled ? "idle" : "disabled",
    findings: [],
    scanRevision: draft.scanRevision + 1,
    privacyDecision: { ...EMPTY_PRIVACY_DECISION },
  };
}

function staleTransform(
  transform: TransformSession,
  draft: DeliveryDraft
): TransformSession {
  if (
    transform.status === "applied" &&
    transform.result &&
    draft.finalText !== transform.result.text
  ) return { ...transform, status: "stale" };
  if (
    transform.status !== "ready" ||
    !transform.result ||
    (transform.result.draftId === draft.id &&
      transform.result.draftRevision === draft.revision)
  ) return transform;
  return { ...transform, status: "stale" };
}

function applyFirewallReplacement(
  draft: DeliveryDraft,
  findingIds: ReadonlySet<string>
): DeliveryDraft | null {
  const result = replaceFirewallFindings(
    draft.finalText,
    draft.findings.filter((finding) => findingIds.has(finding.id)),
    draft.redactionMap
  );
  if (!result.replacedFindingIds.length || result.text === draft.finalText) return null;
  const next = revise(
    draft,
    {
      finalText: result.text,
      redactionMap: result.redactionMap,
    },
    true
  );
  return {
    ...next,
    redactionMap: result.redactionMap,
    privacyDecision: {
      ...EMPTY_PRIVACY_DECISION,
      replacedCount:
        draft.privacyDecision.replacedCount + result.replacedFindingIds.length,
    },
  };
}

export const useDeliveryStore = create<DeliveryState>()((set, get) => ({
  ...initialSession(),
  openDraft: (draft) =>
    set({
      draft: draft.safeRehearsal
        ? {
            ...draft,
            enterDecisionConfirmed: true,
            pressEnter: false,
            keepPanel: true,
          }
        : draft,
      open: true,
      busy: false,
      activeSection: "summary",
      lastError: null,
      retryBlocked: false,
      safeRetryPending: false,
      transform: emptyTransform(),
    }),
  replaceDraft: (draft, preserveSafeRetry = false) =>
    set((state) => ({
      draft: draft.safeRehearsal
        ? {
            ...draft,
            enterDecisionConfirmed: true,
            pressEnter: false,
            keepPanel: true,
          }
        : draft,
      lastError: null,
      retryBlocked: false,
      safeRetryPending: preserveSafeRetry,
      transform: staleTransform(state.transform, draft),
    })),
  closeDraft: () =>
    set({
      ...initialSession(),
      preflightMode: get().preflightMode,
    }),
  setBusy: (busy) => set({ busy }),
  setActiveSection: (activeSection) => set({ activeSection }),
  setLastError: (lastError) => set({ lastError }),
  setRetryBlocked: (retryBlocked) => set({ retryBlocked }),
  setSafeRetryPending: (safeRetryPending) => set({ safeRetryPending }),
  setPreflightMode: (preflightMode) => set({ preflightMode }),
  setFinalText: (finalText) => {
    const draft = get().draft;
    if (!draft || draft.finalText === finalText) return;
    const next = revise(draft, { finalText, transformRecipeId: null }, true);
    set({
      draft: next,
      lastError: null,
      transform: staleTransform(get().transform, next),
    });
  },
  resetFinalText: () => {
    const draft = get().draft;
    if (!draft || draft.finalText === draft.assembledText) return;
    const next = revise(
      draft,
      { finalText: draft.assembledText, transformRecipeId: null },
      true
    );
    set({
      draft: next,
      lastError: null,
      transform: staleTransform(get().transform, next),
    });
  },
  setKeepPanel: (keepPanel) => {
    const draft = get().draft;
    if (!draft || draft.keepPanel === keepPanel) return;
    const next = revise(draft, { keepPanel });
    set({
      draft: next,
      lastError: null,
      transform: staleTransform(get().transform, next),
    });
  },
  confirmEnter: (pressEnter) => {
    const draft = get().draft;
    if (!draft || draft.enterPolicy !== "confirm") return;
    if (draft.safeRehearsal) {
      if (
        draft.enterDecisionConfirmed &&
        !draft.pressEnter &&
        draft.keepPanel
      ) return;
      const next = revise(draft, {
        enterDecisionConfirmed: true,
        pressEnter: false,
        keepPanel: true,
      });
      set({ draft: next, lastError: null });
      return;
    }
    if (
      draft.enterDecisionConfirmed &&
      draft.pressEnter === pressEnter
    ) {
      return;
    }
    const rawBlockPresent = draft.findings.some(
      (finding) => finding.severity === "block"
    );
    const safePressEnter = rawBlockPresent ? false : pressEnter;
    const next = revise(draft, {
        enterDecisionConfirmed: true,
        pressEnter: safePressEnter,
      });
    set({
      draft: next,
      lastError: null,
      transform: staleTransform(get().transform, next),
    });
  },
  replaceFirewallFinding: (findingId) => {
    const draft = get().draft;
    if (!draft) return;
    const next = applyFirewallReplacement(draft, new Set([findingId]));
    if (next) set({
      draft: next,
      lastError: null,
      transform: staleTransform(get().transform, next),
    });
  },
  replaceFirewallCategory: (category) => {
    const draft = get().draft;
    if (!draft) return;
    const ids = new Set(
      draft.findings
        .filter((finding) => finding.category === category)
        .map((finding) => finding.id)
    );
    const next = applyFirewallReplacement(draft, ids);
    if (next) set({
      draft: next,
      lastError: null,
      transform: staleTransform(get().transform, next),
    });
  },
  replaceAllFirewallFindings: () => {
    const draft = get().draft;
    if (!draft) return;
    const next = applyFirewallReplacement(
      draft,
      new Set(draft.findings.map((finding) => finding.id))
    );
    if (next) set({
      draft: next,
      lastError: null,
      transform: staleTransform(get().transform, next),
    });
  },
  revertAliasFinding: (occurrence) => {
    const draft = get().draft;
    if (!draft) return;
    // 偏移量必须对当前 finalText 仍然鲜活；文本已被编辑则静默忽略（UI 会随重算刷新）
    if (
      !findingUtf16RangeIsValid(draft.finalText, occurrence) ||
      draft.finalText.slice(occurrence.startUtf16, occurrence.endUtf16) !==
        occurrence.placeholder
    ) return;
    const finalText =
      draft.finalText.slice(0, occurrence.startUtf16) +
      occurrence.originalText +
      draft.finalText.slice(occurrence.endUtf16);
    const next = revise(
      draft,
      {
        finalText,
        aliasReplacedCount: Math.max(0, draft.aliasReplacedCount - 1),
      },
      true
    );
    set({
      draft: next,
      lastError: null,
      transform: staleTransform(get().transform, next),
    });
  },
  excludeFirewallFinding: (findingId) => {
    const draft = get().draft;
    if (
      !draft ||
      !draft.findings.some((finding) => finding.id === findingId) ||
      draft.privacyDecision.excludedFindingIds.includes(findingId)
    ) return;
    set({
      draft: {
        ...draft,
        privacyDecision: {
          ...draft.privacyDecision,
          excludedFindingIds: [
            ...draft.privacyDecision.excludedFindingIds,
            findingId,
          ],
          rawConfirmation: null,
        },
      },
      lastError: null,
    });
  },
  confirmRawPrivacy: (level) => {
    const draft = get().draft;
    if (!draft) return;
    set({
      draft: {
        ...draft,
        privacyDecision: {
          ...draft.privacyDecision,
          rawConfirmation: {
            revision: draft.scanRevision,
            targetToken: draft.targetSnapshot?.token ?? null,
            level,
          },
        },
      },
      lastError: null,
    });
  },
  beginTransform: (request) => {
    const state = get();
    if (
      !state.open ||
      !state.draft ||
      state.transform.status === "running" ||
      state.transform.transportPending ||
      state.draft.id !== request.draftId ||
      state.draft.revision !== request.draftRevision
    ) return false;
    set({
      transform: {
        status: "running",
        request,
        result: null,
        error: null,
        restoreText: state.transform.restoreText,
        transportPending: true,
      },
    });
    return true;
  },
  finishTransform: (result) => {
    const state = get();
    if (state.transform.request?.requestId !== result.requestId) return;
    const current = state.draft;
    const ready = !!current &&
      current.id === result.draftId &&
      current.revision === result.draftRevision;
    set({
      transform: {
        ...state.transform,
        status: ready ? "ready" : "stale",
        result,
        error: null,
      },
    });
  },
  failTransform: (requestId, error) => {
    const transform = get().transform;
    if (transform.request?.requestId !== requestId) return;
    set({
      transform: { ...transform, status: "error", result: null, error },
    });
  },
  cancelTransform: (requestId) => {
    const transform = get().transform;
    if (transform.request?.requestId !== requestId) return;
    set({
      transform: {
        ...transform,
        status: "cancelled",
        result: null,
        error: null,
      },
    });
  },
  settleTransformTransport: (requestId) => {
    const transform = get().transform;
    if (transform.request?.requestId !== requestId) return;
    set({ transform: { ...transform, transportPending: false } });
  },
  setTransformError: (error) => set({
    transform: { ...emptyTransform(), status: "error", error },
  }),
  discardTransform: () => {
    const transform = get().transform;
    if (transform.status === "running" || transform.transportPending) return;
    set({ transform: emptyTransform() });
  },
  applyTransformResult: () => {
    const state = get();
    const draft = state.draft;
    const result = state.transform.result;
    if (
      !draft ||
      !result ||
      state.transform.status !== "ready" ||
      result.draftId !== draft.id ||
      result.draftRevision !== draft.revision
    ) return false;
    const next = revise(draft, {
      finalText: result.text,
      transformRecipeId: result.recipeId,
      enterDecisionConfirmed:
        draft.enterPolicy === "confirm" ? false : draft.enterDecisionConfirmed,
      pressEnter: draft.enterPolicy === "confirm" ? false : draft.pressEnter,
    }, true);
    set({
      draft: next,
      lastError: null,
      transform: {
        ...state.transform,
        status: "applied",
        error: null,
        restoreText: draft.finalText,
      },
    });
    return true;
  },
  restoreTransformText: () => {
    const state = get();
    const draft = state.draft;
    const restoreText = state.transform.restoreText;
    if (!draft || restoreText === null || draft.finalText === restoreText) {
      return false;
    }
    const next = revise(draft, {
      finalText: restoreText,
      transformRecipeId: null,
      enterDecisionConfirmed:
        draft.enterPolicy === "confirm" ? false : draft.enterDecisionConfirmed,
      pressEnter: draft.enterPolicy === "confirm" ? false : draft.pressEnter,
    }, true);
    set({
      draft: next,
      lastError: null,
      transform: {
        ...state.transform,
        status: state.transform.result ? "stale" : "idle",
        restoreText: null,
      },
    });
    return true;
  },
}));

export function resetDeliveryStore(): void {
  useDeliveryStore.setState(initialSession());
}
