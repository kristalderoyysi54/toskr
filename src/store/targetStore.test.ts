import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  getTargetSnapshot: vi.fn(),
  refreshTargetSnapshot: vi.fn(),
  refreshPrevApp: vi.fn(),
  appIcon: vi.fn(),
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    api: { ...actual.api, ...apiMocks },
  };
});

import type { TargetSnapshot } from "@/lib/tauri";
import {
  applyTargetEvent,
  beginTargetBlurObservation,
  observeTargetAfterBlur,
  readTarget,
  refreshTarget,
  resetTargetState,
  confirmTargetProfileOverride,
  setTargetProfileOverride,
  targetObservationPending,
  targetSendDisabled,
  useTargetStore,
} from "@/store/targetStore";
import { defaultSettings, useNotesStore } from "@/store/notesStore";
import { useUIStore } from "@/store/uiStore";

function snapshot(
  token: string,
  appName = "Codex",
  bundleId = "com.openai.codex",
  ready = true
): TargetSnapshot {
  return {
    token,
    pid: token.charCodeAt(0),
    bundleId,
    appName,
    launchedAtMs: 500,
    capturedAtMs: 900,
    revision: token.charCodeAt(0),
    ready,
    reason: ready ? null : "target_exited",
    windowId: null,
  };
}

describe("targetStore", () => {
  beforeEach(() => {
    resetTargetState();
    apiMocks.getTargetSnapshot.mockReset();
    apiMocks.refreshTargetSnapshot.mockReset();
    apiMocks.refreshPrevApp.mockReset();
    apiMocks.appIcon.mockReset().mockResolvedValue(null);
  });

  it("从 unknown 经 refreshing 映射为原生 ready snapshot", async () => {
    let resolve!: (value: TargetSnapshot) => void;
    apiMocks.refreshTargetSnapshot.mockReturnValue(
      new Promise<TargetSnapshot>((done) => {
        resolve = done;
      })
    );

    const pending = refreshTarget();
    expect(useTargetStore.getState().status).toBe("refreshing");
    expect(targetSendDisabled()).toBe(true);

    const native = snapshot("a");
    resolve(native);
    await expect(pending).resolves.toEqual(native);
    expect(useTargetStore.getState()).toMatchObject({
      snapshot: native,
      status: "ready",
      reason: null,
    });
    expect(targetSendDisabled()).toBe(false);
  });

  it("把原生失效原因稳定映射为 blocked", async () => {
    const native = snapshot("a", "Codex", "com.openai.codex", false);
    apiMocks.refreshTargetSnapshot.mockResolvedValue(native);

    await refreshTarget();

    expect(useTargetStore.getState()).toMatchObject({
      snapshot: native,
      status: "blocked",
      reason: "target_exited",
    });
  });

  it("目标事件抢占在途旧刷新，旧 A 结果不得覆盖 B", async () => {
    let resolveA!: (value: TargetSnapshot) => void;
    apiMocks.refreshTargetSnapshot.mockReturnValue(
      new Promise<TargetSnapshot>((done) => {
        resolveA = done;
      })
    );
    const pending = refreshTarget();

    const b = snapshot("b", "Terminal", "com.apple.Terminal");
    expect(applyTargetEvent(b)).toBe(true);
    resolveA(snapshot("a"));

    await expect(pending).resolves.toBeNull();
    expect(useTargetStore.getState().snapshot).toEqual(b);
  });

  it("独立窗口只读同步不轮换 token，且事件 B 作废在途 get A", async () => {
    let resolveA!: (value: TargetSnapshot) => void;
    apiMocks.getTargetSnapshot.mockReturnValue(
      new Promise<TargetSnapshot>((done) => {
        resolveA = done;
      })
    );
    const pending = readTarget();

    const b = snapshot("b", "Terminal", "com.apple.Terminal");
    applyTargetEvent(b);
    resolveA(snapshot("a"));

    await expect(pending).resolves.toBeNull();
    expect(useTargetStore.getState().snapshot).toEqual(b);
    expect(apiMocks.refreshTargetSnapshot).not.toHaveBeenCalled();
  });

  it("重复事件不触发重复 store 更新或图标请求", async () => {
    apiMocks.appIcon.mockResolvedValue({ url: "data:image/png;base64,a", color: "#000000" });
    const native = snapshot("a");
    expect(applyTargetEvent(native)).toBe(true);
    await vi.waitFor(() => expect(apiMocks.appIcon).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(useTargetStore.getState().icon?.url).toContain("data:image"));

    let updates = 0;
    const unsubscribe = useTargetStore.subscribe(() => {
      updates += 1;
    });
    expect(applyTargetEvent({ ...native, capturedAtMs: 999 })).toBe(false);
    unsubscribe();

    expect(updates).toBe(0);
    expect(apiMocks.appIcon).toHaveBeenCalledOnce();
  });

  it("显式 revision 丢弃传输层倒序的旧 A 事件", () => {
    const b = snapshot("b", "Terminal", "com.apple.Terminal");
    const a = snapshot("a");

    expect(applyTargetEvent(b)).toBe(true);
    expect(applyTargetEvent(a)).toBe(false);
    expect(useTargetStore.getState().snapshot).toEqual(b);
  });

  it("Pin 与磁吸状态不参与目标推断，切到 B 也不清选择", () => {
    useUIStore.setState({ pinned: true });
    useNotesStore.setState({
      settings: {
        ...defaultSettings(),
        companionEnabled: true,
        companionApps: ["com.example.A"],
      },
      checkedIds: ["keep-selection"],
    });

    const b = snapshot("b", "B", "com.example.B");
    applyTargetEvent(b);

    expect(useTargetStore.getState().snapshot?.bundleId).toBe("com.example.B");
    expect(useUIStore.getState().pinned).toBe(true);
    expect(useNotesStore.getState().checkedIds).toEqual(["keep-selection"]);
  });

  it("失焦立即关闸；漏采 B 时旧 A 不能靠普通 refresh 恢复 ready", async () => {
    const a = snapshot("a");
    applyTargetEvent(a);
    const pendingNative = {
      ...a,
      revision: a.revision + 1,
      ready: false,
      reason: "target_not_frontmost" as const,
    };
    apiMocks.refreshPrevApp.mockResolvedValue(pendingNative);
    apiMocks.refreshTargetSnapshot.mockResolvedValue({ ...a, token: "rotated-a" });

    const result = await observeTargetAfterBlur();

    expect(result).toEqual(pendingNative);
    expect(targetObservationPending()).toBe(true);
    expect(targetSendDisabled()).toBe(true);
    await refreshTarget();
    expect(apiMocks.refreshTargetSnapshot).not.toHaveBeenCalled();
    expect(apiMocks.refreshPrevApp).toHaveBeenCalledTimes(2);
  });

  it("pending 只由后续非自身 B observation 解除", async () => {
    const a = snapshot("a");
    applyTargetEvent(a);
    apiMocks.refreshPrevApp.mockResolvedValue({
      ...a,
      revision: a.revision + 1,
      ready: false,
      reason: "target_not_frontmost",
    });
    await observeTargetAfterBlur();

    const b = { ...snapshot("b", "Terminal", "com.apple.Terminal"), revision: 100 };
    applyTargetEvent(b);

    expect(targetObservationPending()).toBe(false);
    expect(targetSendDisabled()).toBe(false);
    expect(useTargetStore.getState().snapshot).toEqual(b);
  });

  it("已知 Toskr 辅助窗的 Native 回执保留原 A ready", async () => {
    const a = snapshot("a");
    applyTargetEvent(a);
    apiMocks.refreshPrevApp.mockResolvedValue(a);

    beginTargetBlurObservation();
    expect(targetSendDisabled()).toBe(true);
    await observeTargetAfterBlur();

    expect(targetObservationPending()).toBe(false);
    expect(targetSendDisabled()).toBe(false);
    expect(useTargetStore.getState().snapshot).toEqual(a);
  });

  it("目标变化保留本次 Profile 选择但要求显式确认", () => {
    const a = snapshot("a");
    applyTargetEvent(a);
    setTargetProfileOverride("custom-profile");

    const sameProcessNewToken = { ...a, token: "a2", revision: 90 };
    applyTargetEvent(sameProcessNewToken);
    expect(useTargetStore.getState().profileOverrideNeedsConfirmation).toBe(false);

    const b = { ...snapshot("b", "Terminal", "com.apple.Terminal"), revision: 100 };
    applyTargetEvent(b);
    expect(useTargetStore.getState()).toMatchObject({
      profileOverrideId: "custom-profile",
      profileOverrideNeedsConfirmation: true,
    });

    confirmTargetProfileOverride();
    expect(useTargetStore.getState()).toMatchObject({
      profileOverrideId: "custom-profile",
      profileOverrideNeedsConfirmation: false,
    });
  });
});
