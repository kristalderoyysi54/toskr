import { describe, expect, it, vi } from "vitest";

const eventMocks = vi.hoisted(() => ({
  listener: null as null | ((event: { payload: unknown }) => void),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, listener: typeof eventMocks.listener) => {
    eventMocks.listener = listener;
    return () => {};
  }),
}));

import { subscribeAiKeyStatus } from "./aiKeyStatus";
import { listen } from "@tauri-apps/api/event";

describe("AI key status multi-webview sync", () => {
  it("监听建立后到达的新事件不会被较慢的初始查询覆盖", async () => {
    let resolveInitial!: (value: {
      configured: boolean;
      updatedAtMs: number | null;
    }) => void;
    const getStatus = vi.fn(
      () =>
        new Promise<{ configured: boolean; updatedAtMs: number | null }>(
          (resolve) => {
            resolveInitial = resolve;
          }
        )
    );
    const received: boolean[] = [];
    const pending = subscribeAiKeyStatus(
      (status) => received.push(status.configured),
      getStatus
    );

    await vi.waitFor(() => expect(eventMocks.listener).not.toBeNull());
    eventMocks.listener?.({
      payload: { configured: true, updatedAtMs: 456 },
    });
    resolveInitial({ configured: false, updatedAtMs: null });
    await pending;

    expect(received).toEqual([true]);
  });

  it("监听建立失败时返回安全空清理函数并报告错误", async () => {
    vi.mocked(listen).mockRejectedValueOnce(new Error("window closed"));
    const onError = vi.fn();
    const stop = await subscribeAiKeyStatus(
      vi.fn(),
      vi.fn(),
      onError
    );
    expect(onError).toHaveBeenCalledTimes(1);
    expect(() => stop()).not.toThrow();
  });
});
