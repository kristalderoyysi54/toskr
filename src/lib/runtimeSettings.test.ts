import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const fns = new Map<string, ReturnType<typeof vi.fn>>();
  const api = new Proxy(
    {},
    {
      get: (_target, property) => {
        const key = String(property);
        if (!fns.has(key)) fns.set(key, vi.fn(() => Promise.resolve()));
        return fns.get(key);
      },
    }
  );
  return { api, fns };
});
vi.mock("@/lib/tauri", () => ({ api: mocks.api }));

import {
  applyRuntimeSettings,
  applyRuntimeSettingsStrict,
} from "./runtimeSettings";
import { defaultSettings } from "../store/notesStore";
import { useUIStore } from "../store/uiStore";

describe("rehydrated runtime settings", () => {
  beforeEach(() => {
    mocks.fns.clear();
    useUIStore.setState({ pinned: false });
  });

  it("reapplies hotkey, watcher, theme and panel behavior from the new dataset", async () => {
    const settings = {
      ...defaultSettings(),
      autoEdgeHide: false,
      clipHistory: false,
      hudDurationMs: 5_000,
      theme: "dark" as const,
    };

    applyRuntimeSettings(settings);
    await vi.waitFor(() =>
      expect(mocks.fns.get("setWindowTheme")).toHaveBeenCalledWith("dark")
    );

    expect(useUIStore.getState().pinned).toBe(false);
    expect(mocks.fns.get("setHotkeyConfig")).toHaveBeenCalledWith(
      settings.hotkeyModifier,
      settings.hotkeyGapMs
    );
    expect(mocks.fns.get("setClipWatch")).toHaveBeenCalledWith(false);
    expect(mocks.fns.get("setWindowTheme")).toHaveBeenCalledWith("dark");
    expect(mocks.fns.get("setAutoEdgeHide")).toHaveBeenCalledWith(true);
    expect(mocks.fns.get("setHudDuration")).toHaveBeenCalledWith(5_000);
  });

  it("伴随模式仍默认常显示", async () => {
    applyRuntimeSettings({ ...defaultSettings(), companionEnabled: true });
    await vi.waitFor(() =>
      expect(mocks.fns.get("setCompanionConfig")).toHaveBeenCalled()
    );
    expect(useUIStore.getState().pinned).toBe(true);
  });

  it("waits for every old batch effect before surfacing one rejection", async () => {
    let finishLast!: () => void;
    mocks.fns.set(
      "setClipWatch",
      vi.fn(() => Promise.reject(new Error("watcher rejected")))
    );
    mocks.fns.set(
      "setWindowAlpha",
      vi.fn(() => new Promise<void>((resolve) => (finishLast = resolve)))
    );
    let rejected = false;
    const applying = applyRuntimeSettingsStrict(defaultSettings()).catch((error) => {
      rejected = true;
      throw error;
    });

    await Promise.resolve();
    expect(rejected).toBe(false);
    finishLast();
    await expect(applying).rejects.toThrow("watcher rejected");
  });
});
