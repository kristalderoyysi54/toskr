import { findingUtf16RangeIsValid } from "@/lib/privacy";
import { api, type ScanSensitiveResult } from "@/lib/tauri";
import { useDeliveryStore } from "@/store/deliveryStore";

import {
  assignStablePlaceholders,
  evaluateFirewallPolicy,
  filterFirewallFindings,
} from "./firewall";
import type { DeliveryDraft } from "./types";

export type ScanSensitiveText = (
  text: string
) => Promise<ScanSensitiveResult>;

export function evaluateDeliveryDraftFirewall(draft: DeliveryDraft) {
  return evaluateFirewallPolicy({
    status: draft.firewallStatus,
    findings: draft.findings,
    excludedFindingIds: draft.privacyDecision.excludedFindingIds,
    policy: draft.privacyPolicy,
    rawConfirmation: draft.privacyDecision.rawConfirmation,
    revision: draft.scanRevision,
    targetToken: draft.targetSnapshot?.token ?? null,
  });
}

function beginFirewallScan(draft: DeliveryDraft): DeliveryDraft {
  if (!draft.firewallEnabled) {
    return {
      ...draft,
      firewallStatus: "disabled",
      findings: [],
    };
  }
  return {
    ...draft,
    firewallStatus: "scanning",
    findings: [],
    scanRevision: draft.scanRevision + 1,
  };
}

function failedScan(draft: DeliveryDraft, status: "failed" | "incomplete") {
  return {
    ...draft,
    firewallStatus: status,
    findings: [],
    pressEnter: false,
  } satisfies DeliveryDraft;
}

function applyScanResult(
  draft: DeliveryDraft,
  result: ScanSensitiveResult
): DeliveryDraft {
  if (
    result.inputUtf16 !== draft.finalText.length ||
    (result.complete && result.scannedUtf16 !== draft.finalText.length) ||
    result.findings.some(
      (finding) => !findingUtf16RangeIsValid(draft.finalText, finding)
    )
  ) {
    return failedScan(draft, "failed");
  }
  if (!result.complete) return failedScan(draft, "incomplete");
  const findings = filterFirewallFindings(
    result.findings,
    draft.firewallDisabledWarnCategories
  );
  const redactionMap = assignStablePlaceholders(
    draft.finalText,
    findings,
    draft.redactionMap
  );
  return {
    ...draft,
    firewallStatus: "ready",
    findings,
    redactionMap,
    // 扫描命中 block 后，无论 Profile 如何配置都禁止自动回车。
    pressEnter: findings.some((finding) => finding.severity === "block")
      ? false
      : draft.pressEnter,
  };
}

export async function scanDeliveryDraftFirewall(
  draft: DeliveryDraft,
  scan: ScanSensitiveText = api.scanSensitiveText
): Promise<DeliveryDraft> {
  if (!draft.firewallEnabled) return beginFirewallScan(draft);
  if (draft.firewallStatus === "ready") return draft;
  const scanning = beginFirewallScan(draft);
  try {
    return applyScanResult(scanning, await scan(scanning.finalText));
  } catch {
    return failedScan(scanning, "failed");
  }
}

/**
 * 编辑态扫描协调器。回执必须仍匹配 Draft id、正文、目标和 scanRevision；
 * 任一变化都静默丢弃旧结果，绝不让旧扫描覆盖新草稿。
 */
export async function scanOpenDeliveryDraft(
  scan: ScanSensitiveText = api.scanSensitiveText
): Promise<void> {
  const state = useDeliveryStore.getState();
  const draft = state.draft;
  if (!state.open || !draft || draft.firewallStatus !== "idle") return;
  const scanning = beginFirewallScan(draft);
  useDeliveryStore.setState({ draft: scanning, lastError: null });
  let completed: DeliveryDraft;
  try {
    completed = applyScanResult(scanning, await scan(scanning.finalText));
  } catch {
    completed = failedScan(scanning, "failed");
  }
  const current = useDeliveryStore.getState();
  const live = current.draft;
  if (
    !current.open ||
    !live ||
    live.id !== scanning.id ||
    live.scanRevision !== scanning.scanRevision ||
    live.finalText !== scanning.finalText ||
    live.targetSnapshot?.token !== scanning.targetSnapshot?.token ||
    live.firewallStatus !== "scanning"
  ) {
    return;
  }
  useDeliveryStore.setState({ draft: completed, lastError: null });
}

/**
 * 用户主动重检当前正文。先同步清空旧 finding/确认，再进入现有扫描协调器；
 * 因此按钮连点、正文变化或 Draft 关闭都只能让同一 revision 的回执落地。
 */
export async function rescanOpenDeliveryDraft(
  scan: ScanSensitiveText = api.scanSensitiveText
): Promise<boolean> {
  const current = useDeliveryStore.getState();
  const draft = current.draft;
  if (
    !current.open || current.busy || !draft || !draft.firewallEnabled ||
    draft.firewallStatus === "scanning"
  ) return false;
  const expected = {
    id: draft.id,
    revision: draft.revision,
    finalText: draft.finalText,
    targetToken: draft.targetSnapshot?.token ?? null,
  };
  useDeliveryStore.setState({
    draft: {
      ...draft,
      firewallStatus: "idle",
      findings: [],
      privacyDecision: {
        ...draft.privacyDecision,
        excludedFindingIds: [],
        rawConfirmation: null,
      },
    },
    lastError: null,
  });
  await scanOpenDeliveryDraft(scan);
  const settled = useDeliveryStore.getState();
  const live = settled.draft;
  return Boolean(
    settled.open && live &&
    live.id === expected.id &&
    live.revision === expected.revision &&
    live.finalText === expected.finalText &&
    (live.targetSnapshot?.token ?? null) === expected.targetToken &&
    live.firewallStatus !== "idle" &&
    live.firewallStatus !== "scanning"
  );
}
