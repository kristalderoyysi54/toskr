import { describe, expect, it, vi } from "vitest";

vi.mock("@/store/persistStorage", () => ({
  tauriStateStorage: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

import type { FirewallFinding, ImageFirewallFinding } from "@/lib/tauri";
import type { DeliveryDraft, ImageFirewallItem } from "./types";
import { nextDeliveryDraftRevision } from "./executeDraft";
import { evaluateDeliveryDraftFirewall } from "./firewallController";
import { evaluateDeliveryDraftImages } from "./imageFirewall";
import { canSendKeepingRaw, keepAllPrivacyRaw } from "./quickRaw";

const blockFinding: ImageFirewallFinding = {
  id: "image-0-api-key",
  observationIndex: 0,
  category: "apiKey",
  severity: "block",
  boundingBox: { x: 0.1, y: 0.2, width: 0.5, height: 0.1 },
  pixelBox: { x: 20, y: 40, width: 100, height: 20 },
  maskedPreview: "sk••••89",
  ruleId: "credential.api-key",
};

function item(patch: Partial<ImageFirewallItem> = {}): ImageFirewallItem {
  return {
    originalFile: "img-original.png",
    sendFile: "img-original.png",
    status: "ready",
    pixelHash: "a".repeat(64),
    redactedPixelHash: null,
    width: 200,
    height: 200,
    scanRevision: 1,
    findings: [blockFinding],
    redactedFindingIds: [],
    keptFindingIds: [],
    manualRegions: [],
    rawConfirmation: null,
    failureMessage: null,
    ...patch,
  };
}

function draft(items: ImageFirewallItem[]): DeliveryDraft {
  return {
    id: "image-firewall-draft",
    revision: nextDeliveryDraftRevision(),
    createdAtMs: 1,
    sourceKind: "note",
    sourceItemIds: ["note-1"],
    selectionItemIds: ["note-1"],
    rawText: "",
    sourceTextOverride: null,
    assembledText: "",
    finalText: "",
    originalImageFiles: items.map((entry) => entry.originalFile),
    segments: null,
    imageFiles: items.map((entry) => entry.sendFile),
    imageFirewall: items,
    format: "plain",
    markdownMode: "preserve",
    promptSnippetId: null,
    transformRecipeId: null,
    promptSnippetGroupId: null,
    promptTemplate: null,
    targetSnapshot: null,
    targetProfileId: "safe",
    promptGroupId: "general",
    profileSource: "fallback",
    profileDefaultFormat: "plain",
    profileDefaultMarkdownMode: "preserve",
    profileKeepPanel: false,
    privacyPolicy: "requireRedaction",
    firewallEnabled: true,
    firewallDisabledWarnCategories: [],
    firewallStatus: "ready",
    aliasReplacedCount: 0,
    findings: [],
    redactionMap: {},
    scanRevision: 1,
    privacyDecision: {
      excludedFindingIds: [],
      rawConfirmation: null,
      replacedCount: 0,
    },
    enterPolicy: "never",
    enterDecisionConfirmed: true,
    pressEnter: false,
    keepPanel: true,
    warnings: [],
    dataGeneration: 1,
  };
}

function textFinding(id: string, severity: FirewallFinding["severity"]): FirewallFinding {
  return {
    id,
    category: severity === "block" ? "apiKey" : "email",
    severity,
    startUtf16: 0,
    endUtf16: 4,
    maskedPreview: "已遮罩",
    suggestedPlaceholder: "[X]",
    ruleId: "test.rule",
  };
}

function textDraft(policy: DeliveryDraft["privacyPolicy"]): DeliveryDraft {
  return {
    ...draft([]),
    finalText: "secret text",
    privacyPolicy: policy,
    findings: [textFinding("t-block", "block"), textFinding("t-warn", "warn")],
  };
}

describe("不脱敏直接发送", () => {
  it.each(["requireRedaction", "confirmRaw", "allowRaw"] as const)(
    "%s：文本命中全部保留后放行，不改动原草稿",
    (policy) => {
      const original = textDraft(policy);
      expect(evaluateDeliveryDraftFirewall(original).canSend).toBe(false);
      const kept = keepAllPrivacyRaw(original);
      expect(evaluateDeliveryDraftFirewall(kept).canSend).toBe(true);
      expect(kept.privacyDecision.excludedFindingIds).toEqual(["t-block", "t-warn"]);
      expect(original.privacyDecision.excludedFindingIds).toEqual([]);
      expect(canSendKeepingRaw(original)).toBe(true);
    }
  );

  it("allowRaw 含高风险时补齐 block 级确认", () => {
    const kept = keepAllPrivacyRaw(textDraft("allowRaw"));
    expect(kept.privacyDecision.rawConfirmation).toMatchObject({ level: "block", revision: 1 });
  });

  it("图片：未遮挡区域全部保留，已遮挡的不重复记入", () => {
    const other = { ...blockFinding, id: "image-0-other" };
    const source = {
      ...draft([item({ findings: [blockFinding, other], redactedFindingIds: [other.id] })]),
      privacyPolicy: "confirmRaw" as const,
    };
    expect(evaluateDeliveryDraftImages(source).canSend).toBe(false);
    const kept = keepAllPrivacyRaw(source);
    expect(kept.imageFirewall[0].keptFindingIds).toEqual([blockFinding.id]);
    expect(evaluateDeliveryDraftImages(kept).canSend).toBe(true);
  });

  it("OCR 失败：allowRaw 可确认原图放行，requireRedaction 仍禁止", () => {
    const failed = item({ status: "failed", findings: [] });
    expect(canSendKeepingRaw({ ...draft([failed]), privacyPolicy: "allowRaw" })).toBe(true);
    expect(canSendKeepingRaw({ ...draft([failed]), privacyPolicy: "requireRedaction" })).toBe(false);
  });
});
