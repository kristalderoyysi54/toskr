import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  getTargetSnapshot: vi.fn(),
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
import { installTargetSnapshotSync } from "@/lib/targetSnapshotSync";
import {
  resetTargetState,
  targetSendDisabled,
  useTargetStore,
} from "@/store/targetStore";

const target: TargetSnapshot = {
  token: "native-target",
  pid: 42,
  bundleId: "com.openai.codex",
  appName: "Codex",
  launchedAtMs: 100,
  capturedAtMs: 200,
  revision: 3,
  ready: true,
  reason: null,
  windowId: null,
};

describe("前端目标快照生命周期同步", () => {
  beforeEach(() => {
    resetTargetState();
    apiMocks.getTargetSnapshot.mockReset().mockResolvedValue(target);
    apiMocks.appIcon.mockReset().mockResolvedValue(null);
  });

  it("WebView 重载后先订阅变化，再主动恢复 Native 已有目标", async () => {
    const order: string[] = [];
    const stop = vi.fn();
    apiMocks.getTargetSnapshot.mockImplementation(async () => {
      order.push("read");
      return target;
    });

    const sync = installTargetSnapshotSync({
      listen: async () => {
        order.push("listen");
        return stop;
      },
    });

    expect(targetSendDisabled()).toBe(true);
    await sync.ready;

    expect(order).toEqual(["listen", "read"]);
    expect(useTargetStore.getState().snapshot).toEqual(target);
    expect(targetSendDisabled()).toBe(false);

    sync.dispose();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("补读旧快照期间收到新目标事件时保留新目标", async () => {
    let onTarget!: (snapshot: TargetSnapshot) => void;
    let resolveRead!: (snapshot: TargetSnapshot) => void;
    apiMocks.getTargetSnapshot.mockReturnValue(
      new Promise<TargetSnapshot>((resolve) => {
        resolveRead = resolve;
      })
    );
    const sync = installTargetSnapshotSync({
      listen: async (handler) => {
        onTarget = handler;
        return vi.fn<() => void>();
      },
    });
    await vi.waitFor(() => expect(apiMocks.getTargetSnapshot).toHaveBeenCalledOnce());

    const newer = {
      ...target,
      token: "new-target",
      pid: 84,
      bundleId: "com.apple.Terminal",
      appName: "Terminal",
      revision: target.revision + 1,
    };
    onTarget(newer);
    resolveRead(target);
    await sync.ready;

    expect(useTargetStore.getState().snapshot).toEqual(newer);
    sync.dispose();
  });
});
