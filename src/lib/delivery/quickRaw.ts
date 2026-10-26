import { useDeliveryStore } from "@/store/deliveryStore";

import { evaluateDeliveryDraftFirewall } from "./firewallController";
import { evaluateDeliveryDraftImages } from "./imageFirewall";
import { submitPreflightDraft } from "./preflight";
import type { DeliveryDraft } from "./types";

/**
 * 「不脱敏直接发送」：把本次全部隐私命中一次性按原文保留并补齐所需确认，
 * 等价于逐项点「保留原文发送」+「再次确认」。仅作用于本次草稿；
 * 方案禁止的情形（如 requireRedaction 下图片 OCR 失败）不放行，由评估结果体现。
 */
export function keepAllPrivacyRaw(draft: DeliveryDraft): DeliveryDraft {
  const targetToken = draft.targetSnapshot?.token ?? null;
  let next: DeliveryDraft = draft;
  if (draft.firewallStatus === "ready" && draft.findings.length) {
    next = {
      ...next,
      privacyDecision: {
        ...next.privacyDecision,
        excludedFindingIds: draft.findings.map((finding) => finding.id),
        rawConfirmation: null,
      },
    };
    const level = evaluateDeliveryDraftFirewall(next).needsRawConfirmation;
    if (level) {
      next = {
        ...next,
        privacyDecision: {
          ...next.privacyDecision,
          rawConfirmation: { revision: draft.scanRevision, targetToken, level },
        },
      };
    }
  }
  if (draft.imageFirewall.length) {
    next = {
      ...next,
      imageFirewall: draft.imageFirewall.map((item) => {
        if (item.status === "ready") {
          const redacted = new Set(item.redactedFindingIds);
          return {
            ...item,
            keptFindingIds: item.findings
              .filter((finding) => !redacted.has(finding.id))
              .map((finding) => finding.id),
            rawConfirmation: null,
          };
        }
        if (item.status === "failed") {
          return {
            ...item,
            rawConfirmation: { revision: item.scanRevision, targetToken, level: "block" as const },
          };
        }
        return item;
      }),
    };
  }
  return next;
}

/** 保留后文本与图片检查是否都能放行。 */
export function canSendKeepingRaw(draft: DeliveryDraft): boolean {
  const kept = keepAllPrivacyRaw(draft);
  return evaluateDeliveryDraftFirewall(kept).canSend && evaluateDeliveryDraftImages(kept).canSend;
}

export async function submitPreflightDraftRaw(): Promise<void> {
  const { draft, open, busy } = useDeliveryStore.getState();
  if (!open || !draft || busy || !canSendKeepingRaw(draft)) return;
  useDeliveryStore.setState({ draft: keepAllPrivacyRaw(draft), lastError: null });
  await submitPreflightDraft();
}
