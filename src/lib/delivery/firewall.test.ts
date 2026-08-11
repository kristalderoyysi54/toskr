import { describe, expect, it } from "vitest";

import type { FirewallFinding } from "@/lib/tauri";

import {
  assignStablePlaceholders,
  evaluateFirewallPolicy,
  filterFirewallFindings,
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
