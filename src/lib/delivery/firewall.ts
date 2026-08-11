import { findingSourceText, findingUtf16RangeIsValid } from "@/lib/privacy";
import type {
  FindingCategory,
  FirewallFinding,
  FindingSeverity,
} from "@/lib/tauri";
import type { PrivacyPolicy } from "@/lib/targetProfiles";

export type FirewallStatus =
  | "idle"
  | "scanning"
  | "ready"
  | "incomplete"
  | "failed"
  | "disabled";

export type RawPrivacyConfirmation = {
  revision: number;
  targetToken: string | null;
  level: "warn" | "block";
};

export type PrivacyDecision = {
  excludedFindingIds: string[];
  rawConfirmation: RawPrivacyConfirmation | null;
  replacedCount: number;
};

export const EMPTY_PRIVACY_DECISION: PrivacyDecision = {
  excludedFindingIds: [],
  rawConfirmation: null,
  replacedCount: 0,
};

export const FIREWALL_WARN_CATEGORIES = [
  "email",
  "phone",
  "nationalId",
  "bankCard",
  "ipAddress",
] as const satisfies readonly FindingCategory[];

export type FirewallWarnCategory = (typeof FIREWALL_WARN_CATEGORIES)[number];

export const FIREWALL_CATEGORY_LABEL: Record<FindingCategory, string> = {
  privateKey: "私钥",
  authorization: "授权凭据",
  apiKey: "API 密钥",
  databaseUrl: "数据库连接",
  email: "邮箱",
  phone: "手机号",
  nationalId: "身份证号",
  bankCard: "银行卡号",
  ipAddress: "IP 地址",
  cookie: "Cookie",
  session: "会话标识",
};

export const FIREWALL_SEVERITY_LABEL: Record<FindingSeverity, string> = {
  info: "提示",
  warn: "注意",
  block: "高风险",
};

function placeholderBase(finding: FirewallFinding): string {
  const suggested = finding.suggestedPlaceholder.trim();
  const bracketed = /^\[([A-Z0-9_]+)\]$/.exec(suggested);
  if (bracketed) return bracketed[1];
  return finding.category.replace(/[A-Z]/g, (value) => `_${value}`).toUpperCase();
}

function nextPlaceholderNumber(
  redactionMap: Readonly<Record<string, string>>,
  base: string,
  text: string
): number {
  let max = 0;
  const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\[${escapedBase}_([0-9]+)\\]$`);
  for (const placeholder of Object.values(redactionMap)) {
    const match = pattern.exec(placeholder);
    if (match) max = Math.max(max, Number(match[1]));
  }
  for (const match of text.matchAll(new RegExp(`\\[${escapedBase}_([0-9]+)\\]`, "g"))) {
    max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

/** 为同一 Draft 的原值分配稳定占位符；旧映射永不重编号。 */
export function assignStablePlaceholders(
  text: string,
  findings: readonly FirewallFinding[],
  existing: Readonly<Record<string, string>>
): Record<string, string> {
  const redactionMap = Object.assign(
    Object.create(null) as Record<string, string>,
    existing
  );
  const nextByBase = new Map<string, number>();
  const ordered = [...findings].sort(
    (left, right) => left.startUtf16 - right.startUtf16 || left.endUtf16 - right.endUtf16
  );
  for (const finding of ordered) {
    const source = findingSourceText(text, finding);
    if (!source || Object.hasOwn(redactionMap, source)) continue;
    const base = placeholderBase(finding);
    const number = nextByBase.get(base) ??
      nextPlaceholderNumber(redactionMap, base, text);
    redactionMap[source] = `[${base}_${String(number).padStart(2, "0")}]`;
    nextByBase.set(base, number + 1);
  }
  return redactionMap;
}

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  info: 0,
  warn: 1,
  block: 2,
};

/** 异常/重叠 finding 也 fail-closed：高严重级、长区间优先，禁止交叉 slice。 */
function nonOverlappingFindings(
  text: string,
  findings: readonly FirewallFinding[]
): FirewallFinding[] {
  const candidates = findings
    .filter((finding) => findingUtf16RangeIsValid(text, finding))
    .sort((left, right) =>
      SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity] ||
      (right.endUtf16 - right.startUtf16) - (left.endUtf16 - left.startUtf16) ||
      left.startUtf16 - right.startUtf16 ||
      left.id.localeCompare(right.id)
    );
  const selected: FirewallFinding[] = [];
  for (const candidate of candidates) {
    if (selected.some((item) =>
      candidate.startUtf16 < item.endUtf16 && candidate.endUtf16 > item.startUtf16
    )) continue;
    selected.push(candidate);
  }
  return selected.sort((left, right) => left.startUtf16 - right.startUtf16);
}

export function replaceFirewallFindings(
  text: string,
  findings: readonly FirewallFinding[],
  existingMap: Readonly<Record<string, string>>
): {
  text: string;
  redactionMap: Record<string, string>;
  replacedFindingIds: string[];
} {
  const selected = nonOverlappingFindings(text, findings);
  const redactionMap = assignStablePlaceholders(text, selected, existingMap);
  let nextText = text;
  for (const finding of [...selected].sort(
    (left, right) => right.startUtf16 - left.startUtf16
  )) {
    const source = findingSourceText(text, finding);
    const placeholder = source ? redactionMap[source] : null;
    if (!placeholder) continue;
    nextText = `${nextText.slice(0, finding.startUtf16)}${placeholder}${nextText.slice(finding.endUtf16)}`;
  }
  return {
    text: nextText,
    redactionMap,
    replacedFindingIds: selected.map((finding) => finding.id),
  };
}

export function filterFirewallFindings(
  findings: readonly FirewallFinding[],
  disabledWarnCategories: readonly FindingCategory[]
): FirewallFinding[] {
  const disabled = new Set(disabledWarnCategories);
  return findings.filter(
    (finding) => finding.severity !== "warn" || !disabled.has(finding.category)
  );
}

export type FirewallPolicyEvaluation = {
  canSend: boolean;
  forcePressEnterOff: boolean;
  needsRawConfirmation: "warn" | "block" | null;
  unresolvedCount: number;
  reason: string | null;
};

export function rawConfirmationIsCurrent(input: {
  confirmation: RawPrivacyConfirmation | null;
  revision: number;
  targetToken: string | null;
  requiredLevel: "warn" | "block";
}): boolean {
  return !!input.confirmation &&
    input.confirmation.revision === input.revision &&
    input.confirmation.targetToken === input.targetToken &&
    input.confirmation.level === input.requiredLevel;
}

/** UI 与 Native IPC 前共用的唯一策略矩阵。 */
export function evaluateFirewallPolicy(input: {
  status: FirewallStatus;
  findings: readonly FirewallFinding[];
  excludedFindingIds: readonly string[];
  policy: PrivacyPolicy;
  rawConfirmation: RawPrivacyConfirmation | null;
  revision: number;
  targetToken: string | null;
}): FirewallPolicyEvaluation {
  if (input.status === "disabled") {
    return {
      canSend: true,
      forcePressEnterOff: false,
      needsRawConfirmation: null,
      unresolvedCount: 0,
      reason: null,
    };
  }
  if (input.status !== "ready") {
    const labels: Partial<Record<FirewallStatus, string>> = {
      idle: "隐私检查尚未开始",
      scanning: "正在执行本地隐私检查",
      incomplete: "内容过长，隐私检查未完整执行",
      failed: "隐私检查失败",
    };
    return {
      canSend: false,
      forcePressEnterOff: true,
      needsRawConfirmation: null,
      unresolvedCount: input.findings.length,
      reason: labels[input.status] ?? "隐私检查未完成",
    };
  }

  const excluded = new Set(input.excludedFindingIds);
  const actionable = input.findings.filter(
    (finding) => finding.severity === "warn" || finding.severity === "block"
  );
  const unresolved = actionable.filter((finding) => !excluded.has(finding.id));
  const rawBlocks = actionable.some((finding) => finding.severity === "block");
  if (input.policy === "requireRedaction") {
    return {
      canSend: unresolved.length === 0,
      forcePressEnterOff: rawBlocks,
      needsRawConfirmation: null,
      unresolvedCount: unresolved.length,
      reason: unresolved.length ? "请替换或明确保留全部敏感项" : null,
    };
  }

  const unresolvedBlocks = unresolved.filter((finding) => finding.severity === "block");
  if (input.policy === "confirmRaw") {
    if (unresolvedBlocks.length) {
      return {
        canSend: false,
        forcePressEnterOff: true,
        needsRawConfirmation: null,
        unresolvedCount: unresolved.length,
        reason: "高风险项必须替换或逐项明确保留",
      };
    }
    const unresolvedWarns = unresolved.filter((finding) => finding.severity === "warn");
    const confirmed = unresolvedWarns.length === 0 || rawConfirmationIsCurrent({
      confirmation: input.rawConfirmation,
      revision: input.revision,
      targetToken: input.targetToken,
      requiredLevel: "warn",
    });
    return {
      canSend: confirmed,
      forcePressEnterOff: rawBlocks,
      needsRawConfirmation: confirmed ? null : "warn",
      unresolvedCount: unresolved.length,
      reason: confirmed ? null : "请确认本次保留提示级原文",
    };
  }

  const confirmed = !rawBlocks || rawConfirmationIsCurrent({
    confirmation: input.rawConfirmation,
    revision: input.revision,
    targetToken: input.targetToken,
    requiredLevel: "block",
  });
  return {
    canSend: confirmed,
    forcePressEnterOff: rawBlocks,
    needsRawConfirmation: confirmed ? null : "block",
    unresolvedCount: unresolved.length,
    reason: confirmed ? null : "高风险原文需要再次确认",
  };
}
