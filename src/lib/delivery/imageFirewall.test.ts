import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/store/persistStorage", () => ({
  tauriStateStorage: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

import type {
  ImageFirewallFinding,
  ScanImageFirewallResult,
} from "@/lib/tauri";
import type { DeliveryDraft, ImageFirewallItem } from "./types";
import {
  applyImageScanResult,
  cleanupDeliveryDraftImages,
  evaluateImageFirewallPolicy,
  redactOpenDeliveryImage,
  rescanOpenDeliveryDraftPrivacy,
  replaceImageFirewallItem,
  scanDeliveryDraftImages,
} from "./imageFirewall";
import { api } from "@/lib/tauri";
import {
  nextDeliveryDraftRevision,
  resetDeliveryDraftSession,
} from "./executeDraft";
import { resetDeliveryStore, useDeliveryStore } from "@/store/deliveryStore";
import { closeOpenDraftWithTransforms } from "@/lib/aiTransform";

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
    assembledText: "",
    finalText: "",
    originalImageFiles: items.map((entry) => entry.originalFile),
    imageFiles: items.map((entry) => entry.sendFile),
    imageFirewall: items,
    format: "plain",
    promptSnippetId: null,
    transformRecipeId: null,
    promptSnippetGroupId: null,
    promptTemplate: null,
    targetSnapshot: null,
    targetProfileId: "safe",
    promptGroupId: "general",
    profileSource: "fallback",
    profileDefaultFormat: "plain",
    profileKeepPanel: false,
    privacyPolicy: "requireRedaction",
    firewallEnabled: true,
    firewallDisabledWarnCategories: [],
    firewallStatus: "ready",
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

describe("image Firewall", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetDeliveryDraftSession();
    resetDeliveryStore();
  });
  it("requireRedaction 在高风险区域未遮挡时阻断，遮挡后放行", () => {
    expect(evaluateImageFirewallPolicy({
      enabled: true,
      items: [item()],
      policy: "requireRedaction",
      targetToken: "target-a",
    })).toMatchObject({ canSend: false, unresolvedCount: 1 });

    expect(evaluateImageFirewallPolicy({
      enabled: true,
      items: [item({ redactedFindingIds: [blockFinding.id] })],
      policy: "requireRedaction",
      targetToken: "target-a",
    })).toMatchObject({ canSend: true, unresolvedCount: 0 });

    expect(evaluateImageFirewallPolicy({
      enabled: true,
      items: [item({
        rawConfirmation: {
          revision: 1,
          targetToken: "target-a",
          level: "block",
        },
      })],
      policy: "allowRaw",
      targetToken: "target-a",
    })).toMatchObject({
      canSend: false,
      needsRawConfirmation: null,
      reason: "图片高风险区域必须遮挡",
    });
  });

  it("OCR 失败不会静默当安全：严格方案阻断，其他方案也必须显式确认", () => {
    const failed = item({
      status: "failed",
      findings: [],
      failureMessage: "本地 OCR 失败",
    });
    expect(evaluateImageFirewallPolicy({
      enabled: true,
      items: [failed],
      policy: "requireRedaction",
      targetToken: "target-a",
    }).canSend).toBe(false);
    expect(evaluateImageFirewallPolicy({
      enabled: true,
      items: [failed],
      policy: "confirmRaw",
      targetToken: "target-a",
    })).toMatchObject({ canSend: false, needsRawConfirmation: "block" });

    const confirmed = item({
      ...failed,
      rawConfirmation: {
        revision: 1,
        targetToken: "target-a",
        level: "block",
      },
    });
    expect(evaluateImageFirewallPolicy({
      enabled: true,
      items: [confirmed],
      policy: "confirmRaw",
      targetToken: "target-a",
    }).canSend).toBe(true);
    expect(evaluateImageFirewallPolicy({
      enabled: true,
      items: [confirmed],
      policy: "confirmRaw",
      targetToken: "target-b",
    }).canSend).toBe(false);
  });

  it("扫描结果进入 Draft 时丢弃 OCR 原文，只保留遮罩 UI 所需元数据", () => {
    const result: ScanImageFirewallResult = {
      file: "img-original.png",
      pixelHash: "a".repeat(64),
      ruleVersion: 1,
      imageWidth: 200,
      imageHeight: 200,
      cacheHit: false,
      observations: [{
        text: "secret-value-that-must-not-live-in-draft",
        confidence: 0.99,
        boundingBox: blockFinding.boundingBox,
        imageWidth: 200,
        imageHeight: 200,
      }],
      findings: [blockFinding],
    };
    const next = applyImageScanResult(item({ status: "scanning", findings: [] }), result, []);

    expect(next.status).toBe("ready");
    expect(next.findings).toEqual([blockFinding]);
    expect(JSON.stringify(next)).not.toContain("secret-value-that-must-not-live-in-draft");
  });

  it("多图更新严格按 originalFile 定位，不串改其他图片或发送顺序", () => {
    const first = item();
    const second = item({
      originalFile: "img-second.png",
      sendFile: "img-second.png",
      findings: [],
    });
    const replaced = replaceImageFirewallItem(
      [first, second],
      "img-original.png",
      item({
        sendFile: "toskr-redacted:redacted.png",
        redactedFindingIds: [blockFinding.id],
      })
    );

    expect(replaced.map((entry) => entry.sendFile)).toEqual([
      "toskr-redacted:redacted.png",
      "img-second.png",
    ]);
    expect(replaced[1]).toBe(second);
  });

  it("多图 OCR 独立结算：一张失败不会覆盖另一张的成功状态", async () => {
    const first = item({
      status: "idle",
      pixelHash: null,
      findings: [],
      width: null,
      height: null,
    });
    const second = item({
      originalFile: "img-second.png",
      sendFile: "img-second.png",
      status: "idle",
      pixelHash: null,
      findings: [],
      width: null,
      height: null,
    });
    const scanned = await scanDeliveryDraftImages(
      draft([first, second]),
      async (file) => {
        if (file === second.originalFile) throw new Error("synthetic OCR failure");
        return {
          file,
          pixelHash: "b".repeat(64),
          ruleVersion: 1,
          imageWidth: 200,
          imageHeight: 200,
          cacheHit: false,
          observations: [{
            text: "api_key=abcdefghijklmnop",
            confidence: 0.98,
            boundingBox: blockFinding.boundingBox,
            imageWidth: 200,
            imageHeight: 200,
          }],
          findings: [blockFinding],
        };
      }
    );

    expect(scanned.imageFirewall.map((entry) => entry.status)).toEqual([
      "ready",
      "failed",
    ]);
    expect(scanned.imageFirewall[0].findings).toHaveLength(1);
    expect(scanned.imageFirewall[1].failureMessage).toContain("未将图片标记为安全");
  });

  it("手动重新检测清空旧授权与遮挡，并强制绕过图片 OCR 缓存", async () => {
    const redacted = item({
      sendFile: "toskr-redacted:old-rescan.png",
      redactedPixelHash: "c".repeat(64),
      redactedFindingIds: [blockFinding.id],
      rawConfirmation: {
        revision: 1,
        targetToken: null,
        level: "block",
      },
    });
    const opened = draft([redacted]);
    opened.privacyDecision = {
      excludedFindingIds: ["old-text-finding"],
      rawConfirmation: {
        revision: 1,
        targetToken: null,
        level: "warn",
      },
      replacedCount: 2,
    };
    useDeliveryStore.getState().openDraft(opened);
    const textScan = vi.spyOn(api, "scanSensitiveText").mockResolvedValue({
      findings: [],
      warnings: [],
      inputUtf16: 0,
      scannedUtf16: 0,
      complete: true,
    });
    const imageScan = vi.spyOn(api, "scanImageFirewall").mockResolvedValue({
      file: "img-original.png",
      pixelHash: "a".repeat(64),
      ruleVersion: 1,
      imageWidth: 200,
      imageHeight: 200,
      cacheHit: false,
      observations: [],
      findings: [],
    });
    const cleanup = vi.spyOn(api, "cleanupRedactedImages").mockResolvedValue();

    expect(await rescanOpenDeliveryDraftPrivacy()).toBe(true);

    expect(textScan).toHaveBeenCalledWith("");
    expect(imageScan).toHaveBeenCalledWith("img-original.png", true);
    expect(cleanup).toHaveBeenCalledWith(["toskr-redacted:old-rescan.png"]);
    expect(useDeliveryStore.getState().draft).toMatchObject({
      firewallStatus: "ready",
      findings: [],
      privacyDecision: {
        excludedFindingIds: [],
        rawConfirmation: null,
        replacedCount: 2,
      },
      imageFiles: ["img-original.png"],
      imageFirewall: [{
        status: "ready",
        sendFile: "img-original.png",
        redactedFindingIds: [],
        rawConfirmation: null,
        findings: [],
      }],
    });
  });

  it("重新检测连点只启动一个扫描，旧正文回执也不会触发图片重检", async () => {
    let resolveText!: (result: Awaited<ReturnType<typeof api.scanSensitiveText>>) => void;
    const pendingText = new Promise<Awaited<ReturnType<typeof api.scanSensitiveText>>>(
      (resolve) => { resolveText = resolve; }
    );
    const textScan = vi.fn(() => pendingText);
    const imageScan = vi.fn(async () => ({
      file: "img-original.png",
      pixelHash: "a".repeat(64),
      ruleVersion: 1,
      imageWidth: 200,
      imageHeight: 200,
      cacheHit: false,
      observations: [],
      findings: [],
    }));
    useDeliveryStore.getState().openDraft(draft([item({ findings: [] })]));

    const first = rescanOpenDeliveryDraftPrivacy(textScan, imageScan);
    expect(useDeliveryStore.getState().draft?.firewallStatus).toBe("scanning");
    expect(await rescanOpenDeliveryDraftPrivacy(textScan, imageScan)).toBe(false);
    useDeliveryStore.getState().setFinalText("正文已变化");
    resolveText({
      findings: [],
      warnings: [],
      inputUtf16: 0,
      scannedUtf16: 0,
      complete: true,
    });

    expect(await first).toBe(false);
    expect(textScan).toHaveBeenCalledTimes(1);
    expect(imageScan).not.toHaveBeenCalled();
    expect(useDeliveryStore.getState().draft).toMatchObject({
      finalText: "正文已变化",
      firewallStatus: "idle",
    });
  });

  it("确认遮挡后 Draft 仅改用独立副本，关闭时只清理副本 token", async () => {
    const redact = vi.spyOn(api, "redactDeliveryImage").mockResolvedValue({
      originalFile: "img-original.png",
      redactedFile: "toskr-redacted:redacted-owned.png",
      originalPixelHash: "a".repeat(64),
      redactedPixelHash: "c".repeat(64),
      imageWidth: 200,
      imageHeight: 200,
    });
    const cleanup = vi.spyOn(api, "cleanupRedactedImages").mockResolvedValue();
    const built = draft([item()]);
    useDeliveryStore.getState().openDraft(built);

    expect(await redactOpenDeliveryImage("img-original.png", blockFinding.id)).toBe(true);
    const current = useDeliveryStore.getState().draft!;
    expect(redact).toHaveBeenCalledWith("img-original.png", [blockFinding.pixelBox]);
    expect(current.originalImageFiles).toEqual(["img-original.png"]);
    expect(current.imageFiles).toEqual(["toskr-redacted:redacted-owned.png"]);
    expect(current.imageFirewall[0].redactedPixelHash).toBe("c".repeat(64));

    cleanupDeliveryDraftImages(current);
    expect(cleanup).toHaveBeenCalledWith(["toskr-redacted:redacted-owned.png"]);
    expect(cleanup.mock.calls.flat()).not.toContain("img-original.png");
  });

  it("遮挡 IPC 迟到时不写入已关闭 Draft，并回收迟到副本", async () => {
    let resolve!: (value: Awaited<ReturnType<typeof api.redactDeliveryImage>>) => void;
    const pending = new Promise<Awaited<ReturnType<typeof api.redactDeliveryImage>>>((done) => {
      resolve = done;
    });
    vi.spyOn(api, "redactDeliveryImage").mockReturnValue(pending);
    const cleanup = vi.spyOn(api, "cleanupRedactedImages").mockResolvedValue();
    useDeliveryStore.getState().openDraft(draft([item()]));

    const operation = redactOpenDeliveryImage("img-original.png", blockFinding.id);
    useDeliveryStore.getState().closeDraft();
    resolve({
      originalFile: "img-original.png",
      redactedFile: "toskr-redacted:late.png",
      originalPixelHash: "a".repeat(64),
      redactedPixelHash: "d".repeat(64),
      imageWidth: 200,
      imageHeight: 200,
    });

    expect(await operation).toBe(false);
    expect(useDeliveryStore.getState().draft).toBeNull();
    expect(cleanup).toHaveBeenCalledWith(["toskr-redacted:late.png"]);
  });

  it("旧 Draft 的遮挡回执不能写入重开的同图新会话", async () => {
    const resolvers: Array<(
      value: Awaited<ReturnType<typeof api.redactDeliveryImage>>
    ) => void> = [];
    vi.spyOn(api, "redactDeliveryImage").mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve))
    );
    const cleanup = vi.spyOn(api, "cleanupRedactedImages").mockResolvedValue();
    useDeliveryStore.getState().openDraft({
      ...draft([item()]),
      id: "old-draft",
    });
    const oldOperation = redactOpenDeliveryImage(
      "img-original.png",
      blockFinding.id
    );

    useDeliveryStore.getState().closeDraft();
    useDeliveryStore.getState().openDraft({
      ...draft([item()]),
      id: "reopened-draft",
    });
    const newOperation = redactOpenDeliveryImage(
      "img-original.png",
      blockFinding.id
    );
    resolvers[0]({
      originalFile: "img-original.png",
      redactedFile: "toskr-redacted:old-late.png",
      originalPixelHash: "a".repeat(64),
      redactedPixelHash: "d".repeat(64),
      imageWidth: 200,
      imageHeight: 200,
    });

    expect(await oldOperation).toBe(false);
    expect(useDeliveryStore.getState().draft).toMatchObject({
      id: "reopened-draft",
      imageFiles: ["img-original.png"],
      imageFirewall: [{ status: "redacting" }],
    });
    expect(cleanup).toHaveBeenCalledWith(["toskr-redacted:old-late.png"]);

    resolvers[1]({
      originalFile: "img-original.png",
      redactedFile: "toskr-redacted:new-current.png",
      originalPixelHash: "a".repeat(64),
      redactedPixelHash: "e".repeat(64),
      imageWidth: 200,
      imageHeight: 200,
    });
    expect(await newOperation).toBe(true);
    expect(useDeliveryStore.getState().draft?.imageFiles).toEqual([
      "toskr-redacted:new-current.png",
    ]);
  });

  it("取消后清理旧副本，重开 Preflight 从原图的独立状态开始", () => {
    const cleanup = vi.spyOn(api, "cleanupRedactedImages").mockResolvedValue();
    const old = item({
      sendFile: "toskr-redacted:old-session.png",
      redactedPixelHash: "e".repeat(64),
      redactedFindingIds: [blockFinding.id],
    });
    useDeliveryStore.getState().openDraft(draft([old]));

    closeOpenDraftWithTransforms();

    expect(useDeliveryStore.getState().draft).toBeNull();
    expect(cleanup).toHaveBeenCalledWith(["toskr-redacted:old-session.png"]);
    const fresh = item({
      status: "idle",
      pixelHash: null,
      width: null,
      height: null,
      findings: [],
    });
    useDeliveryStore.getState().openDraft(draft([fresh]));
    expect(useDeliveryStore.getState().draft).toMatchObject({
      imageFiles: ["img-original.png"],
      imageFirewall: [{
        originalFile: "img-original.png",
        sendFile: "img-original.png",
        status: "idle",
      }],
    });
  });
});
