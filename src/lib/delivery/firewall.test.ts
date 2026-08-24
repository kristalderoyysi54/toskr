import { describe, expect, it } from "vitest";

import type { FirewallFinding } from "@/lib/tauri";

import {
  allowedBlockFindingIds,
  assignStablePlaceholders,
  evaluateFirewallPolicy,
  filterFirewallFindings,
  isIrreversiblePlaceholder,
  replaceFirewallFindings,
} from "./firewall";

function finding(
  id: string,
  category: FirewallFinding["category"],
  severity: FirewallFinding["severity"],
  startUtf16: number,
  endUtf16: number
): FirewallFinding {
  return {
    id,
    category,
    severity,
    startUtf16,
    endUtf16,
    maskedPreview: "已遮罩",
    suggestedPlaceholder: `[${category.toUpperCase()}]`,
    ruleId: `test.${category}`,
  };
}

describe("Firewall redaction", () => {
  it("同值多处使用同一稳定编号，新增值延续首次出现顺序", () => {
    const text = "alice@example.com / bob@example.com / alice@example.com";
    const findings = [
      finding("a1", "email", "warn", 0, 17),
      finding("b", "email", "warn", 20, 35),
      finding("a2", "email", "warn", 38, 55),
    ];

    const first = assignStablePlaceholders(text, findings, {});
    expect(first).toEqual({
      "alice@example.com": "[EMAIL_01]",
      "bob@example.com": "[EMAIL_02]",
    });

    const nextText = `carol@example.com ${text}`;
    const next = assignStablePlaceholders(
      nextText,
      [finding("c", "email", "warn", 0, 17), ...findings.map((item) => ({
        ...item,
        startUtf16: item.startUtf16 + 18,
        endUtf16: item.endUtf16 + 18,
      }))],
      first
    );
    expect(next["alice@example.com"]).toBe("[EMAIL_01]");
    expect(next["carol@example.com"]).toBe("[EMAIL_03]");
  });

  it("不会与正文中已存在的占位符编号冲突", () => {
    const text = "保留 [EMAIL_01]，替换 alice@example.com";
    const start = text.indexOf("alice@example.com");
    expect(assignStablePlaceholders(
      text,
      [finding("email", "email", "warn", start, start + 17)],
      {}
    )["alice@example.com"]).toBe("[EMAIL_02]");
  });

  it("倒序替换 Unicode 区间，并让高严重级 overlap 获胜", () => {
    const text = "😀 alice@example.com 尾";
    const emailStart = "😀 ".length;
    const result = replaceFirewallFindings(
      text,
      [
        finding("wide", "email", "warn", emailStart, emailStart + 17),
        finding("block", "apiKey", "block", emailStart + 6, emailStart + 17),
      ],
      {}
    );

    expect(result.text).toBe("😀 alice@[APIKEY_01] 尾");
    expect(result.replacedFindingIds).toEqual(["block"]);
  });
});

describe("Secret 不可逆语义", () => {
  it("凭据类占位符判定为不可逆，PII 与词典类保持可逆", () => {
    for (const irreversible of [
      "[PRIVATE_KEY_01]",
      "[AUTHORIZATION_02]",
      "[API_KEY_10]",
      "[DATABASE_URL_01]",
      "[COOKIE_03]",
      "[SESSION_01]",
    ]) {
      expect(isIrreversiblePlaceholder(irreversible)).toBe(true);
    }
    for (const reversible of [
      "[EMAIL_01]",
      "[PHONE_02]",
      "[NATIONAL_ID_01]",
      "[BANK_CARD_01]",
      "[IP_ADDRESS_01]",
      "[USER_01]",
      "[ORDER_07]",
      "[API_KEY]",
      "普通文本",
    ]) {
      expect(isIrreversiblePlaceholder(reversible)).toBe(false);
    }
  });
});

describe("Native 门禁白名单组装", () => {
  const warnFinding = finding("warn-1", "email", "warn", 0, 3);
  const blockA = finding("block-a", "apiKey", "block", 4, 7);
  const blockB = finding("block-b", "cookie", "block", 8, 12);

  it("仅收逐项保留的 block；warn 与未保留 block 不进名单", () => {
    expect(allowedBlockFindingIds({
      findings: [warnFinding, blockA, blockB],
      excludedFindingIds: ["block-a", "warn-1"],
      rawConfirmation: null,
      revision: 1,
      targetToken: "t1",
    })).toEqual(["block-a"]);
  });

  it("当前有效的 block 级全局确认覆盖全部 block", () => {
    expect(allowedBlockFindingIds({
      findings: [warnFinding, blockA, blockB],
      excludedFindingIds: [],
      rawConfirmation: { revision: 1, targetToken: "t1", level: "block" },
      revision: 1,
      targetToken: "t1",
    })).toEqual(["block-a", "block-b"]);
  });

  it("revision 或 target token 漂移后全局确认失效", () => {
    expect(allowedBlockFindingIds({
      findings: [blockA],
      excludedFindingIds: [],
      rawConfirmation: { revision: 1, targetToken: "t1", level: "block" },
      revision: 2,
      targetToken: "t1",
    })).toEqual([]);
    expect(allowedBlockFindingIds({
      findings: [blockA],
      excludedFindingIds: [],
      rawConfirmation: { revision: 1, targetToken: "t1", level: "block" },
      revision: 1,
      targetToken: "t2",
    })).toEqual([]);
  });
});

describe("Firewall policy", () => {
  const warn = finding("warn", "email", "warn", 0, 3);
  const block = finding("block", "apiKey", "block", 4, 7);

  it("warn 类别可关闭，但 block 永不被类别开关过滤", () => {
    expect(filterFirewallFindings([warn, block], ["email", "apiKey"]))
      .toEqual([block]);
  });

  it("实现 requireRedaction / confirmRaw / allowRaw 三种门禁", () => {
    expect(evaluateFirewallPolicy({
      status: "ready",
      findings: [warn, block],
      excludedFindingIds: [],
      policy: "requireRedaction",
      rawConfirmation: null,
      revision: 1,
      targetToken: "t1",
    }).canSend).toBe(false);
    expect(evaluateFirewallPolicy({
      status: "ready",
      findings: [warn, block],
      excludedFindingIds: ["block"],
      policy: "confirmRaw",
      rawConfirmation: { revision: 1, targetToken: "t1", level: "warn" },
      revision: 1,
      targetToken: "t1",
    }).canSend).toBe(true);
    const allow = evaluateFirewallPolicy({
      status: "ready",
      findings: [block],
      excludedFindingIds: [],
      policy: "allowRaw",
      rawConfirmation: { revision: 1, targetToken: "t1", level: "block" },
      revision: 1,
      targetToken: "t1",
    });
    expect(allow).toMatchObject({ canSend: true, forcePressEnterOff: true });
  });

  it("正文 revision 或目标 token 改变后原文确认立即失效", () => {
    for (const [revision, targetToken] of [[2, "t1"], [1, "t2"]] as const) {
      expect(evaluateFirewallPolicy({
        status: "ready",
        findings: [warn],
        excludedFindingIds: [],
        policy: "confirmRaw",
        rawConfirmation: { revision: 1, targetToken: "t1", level: "warn" },
        revision,
        targetToken,
      }).canSend).toBe(false);
    }
  });
});
