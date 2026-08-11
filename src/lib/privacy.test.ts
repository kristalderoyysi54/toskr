import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { findingSourceText, findingUtf16RangeIsValid } from "./privacy";
import {
  api,
  type FirewallFinding,
  type ScanSensitiveResult,
} from "./tauri";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const finding = (
  startUtf16: number,
  endUtf16: number
): FirewallFinding => ({
  id: `email:${startUtf16}:${endUtf16}`,
  category: "email",
  severity: "warn",
  startUtf16,
  endUtf16,
  maskedPreview: "a•••m",
  suggestedPlaceholder: "[EMAIL]",
  ruleId: "contact.email",
});

describe("privacy UTF-16 contract", () => {
  it("uses JavaScript UTF-16 offsets around CJK, emoji and combining text", () => {
    const prefix = "中文😀e\u0301 前缀 ";
    const email = "alice@example.com";
    const text = `${prefix}${email} 后缀`;
    const match = finding(prefix.length, prefix.length + email.length);

    expect(findingUtf16RangeIsValid(text, match)).toBe(true);
    expect(findingSourceText(text, match)).toBe(email);
  });

  it("rejects negative, inverted, surrogate-splitting and out-of-range offsets", () => {
    const text = "A😀B";
    expect(findingUtf16RangeIsValid(text, finding(-1, 1))).toBe(false);
    expect(findingUtf16RangeIsValid(text, finding(3, 2))).toBe(false);
    expect(findingUtf16RangeIsValid(text, finding(1, 2))).toBe(false);
    expect(findingUtf16RangeIsValid(text, finding(0, 99))).toBe(false);
    expect(findingSourceText(text, finding(1, 2))).toBeNull();
  });
});

describe("scanSensitiveText IPC", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("sends one strongly typed camelCase request to the local command", async () => {
    const response: ScanSensitiveResult = {
      findings: [finding(0, 17)],
      warnings: [],
      inputUtf16: 17,
      scannedUtf16: 17,
      complete: true,
    };
    vi.mocked(invoke).mockResolvedValue(response);

    await expect(api.scanSensitiveText("alice@example.com")).resolves.toEqual(
      response
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("scan_sensitive_text", {
      request: { text: "alice@example.com" },
    });
  });
});
