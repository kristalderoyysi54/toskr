import { describe, expect, it } from "vitest";

import { isSendDeliveryResult, type SendDeliveryResult } from "./tauri";

function result(
  overrides: Partial<SendDeliveryResult> = {}
): SendDeliveryResult {
  return {
    deliveryId: "delivery-1",
    status: "sent",
    reasonCode: "ok",
    message: "已发送到 Codex",
    target: {
      token: "token-1",
      pid: 42,
      bundleId: "com.openai.codex",
      appName: "Codex",
      launchedAtMs: 500,
      capturedAtMs: 900,
      revision: 1,
      ready: true,
      reason: null,
      windowId: null,
    },
    pasteCompleted: true,
    enterPressed: false,
    clipboardOutcome: "restored",
    startedAtMs: 1_000,
    finishedAtMs: 1_100,
    ...overrides,
  };
}

describe("SendDeliveryResult guard", () => {
  it.each([
    result(),
    result({ status: "blocked", reasonCode: "target_exited" }),
    result({ status: "failed", reasonCode: "paste_failed" }),
  ])("接受完整的 sent/blocked/failed 回执", (value) => {
    expect(isSendDeliveryResult(value)).toBe(true);
  });

  it("拒绝未知枚举与残缺目标", () => {
    expect(isSendDeliveryResult({ ...result(), status: "done" })).toBe(false);
    expect(isSendDeliveryResult({ ...result(), reasonCode: "mystery" })).toBe(false);
    expect(
      isSendDeliveryResult({ ...result(), target: { token: "token-1" } })
    ).toBe(false);
  });

  it.each([
    "restored",
    "skippedUserChanged",
    "nothingToRestore",
    "restoreFailed",
    "notOwned",
  ] as const)("接受 clipboardOutcome=%s", (clipboardOutcome) => {
    expect(isSendDeliveryResult(result({ clipboardOutcome }))).toBe(true);
  });

  it.each(["unchanged", "restore_scheduled", "payload_retained"])(
    "拒绝旧 clipboardOutcome=%s，防止旧二进制回执被误收",
    (clipboardOutcome) => {
      expect(
        isSendDeliveryResult({ ...result(), clipboardOutcome })
      ).toBe(false);
    }
  );

  it("拒绝非有限或倒序时间，避免异常 IPC 回执被当成成功", () => {
    expect(isSendDeliveryResult(result({ finishedAtMs: Number.NaN }))).toBe(false);
    expect(isSendDeliveryResult(result({ finishedAtMs: 999 }))).toBe(false);
  });

  it("拒绝自相矛盾的成功回执，避免错误修改 store", () => {
    expect(
      isSendDeliveryResult(result({ reasonCode: "target_exited" }))
    ).toBe(false);
    expect(isSendDeliveryResult(result({ pasteCompleted: false }))).toBe(false);
    expect(
      isSendDeliveryResult(
        result({ status: "blocked", reasonCode: "ok", pasteCompleted: false })
      )
    ).toBe(false);
  });
});
