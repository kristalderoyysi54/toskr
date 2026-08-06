import { beforeEach, describe, expect, it, vi } from "vitest";

// 单测环境没有 Tauri runtime：持久化、IPC、HUD 全部替换为内存桩
vi.mock("../store/persistStorage", () => {
  const memory = new Map<string, string>();
  return {
    tauriStateStorage: {
      getItem: async (name: string) => memory.get(name) ?? null,
      setItem: async (name: string, value: string) => {
        memory.set(name, value);
      },
      removeItem: async (name: string) => {
        memory.delete(name);
      },
    },
  };
});

const mocks = vi.hoisted(() => {
  const fns = new Map<string, ReturnType<typeof vi.fn>>();
  const api = new Proxy(
    {},
    {
      get: (_t, prop) => {
        const key = String(prop);
        if (!fns.has(key)) fns.set(key, vi.fn(() => Promise.resolve()));
        return fns.get(key);
      },
    }
  );
  return { api, fns, tip: vi.fn() };
});
vi.mock("@/lib/tauri", () => ({ api: mocks.api }));
vi.mock("@/lib/tip", () => ({ tip: mocks.tip }));
vi.mock("@tauri-apps/api/event", () => ({
  emitTo: vi.fn(() => Promise.resolve()),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import { applySettingsPatch } from "./settingsSync";
import { defaultSettings, useNotesStore } from "../store/notesStore";
import { useUIStore } from "../store/uiStore";

function seed(overrides: Partial<ReturnType<typeof defaultSettings>>) {
  useNotesStore.setState({ settings: { ...defaultSettings(), ...overrides } });
}

describe("applySettingsPatch 伴随停靠 ⇄ 边栏互斥", () => {
  beforeEach(() => {
    mocks.fns.clear();
    mocks.tip.mockClear();
  });

  it("边栏开着时开启伴随停靠 → 自动退出边栏并清手动拖动位", () => {
    seed({
      companionEnabled: false,
      autoEdgeHide: false,
      rightSidebar: true,
      sidebarEdge: "right",
      panelFreeX: 100,
      panelFreeY: 200,
    });
    applySettingsPatch({ companionEnabled: true });
    const s = useNotesStore.getState().settings;
    expect(s.companionEnabled).toBe(true);
    expect(s.rightSidebar).toBe(false);
    expect(s.panelFreeX).toBeNull();
    expect(s.panelFreeY).toBeNull();
    // Rust 侧同步：边栏关闭 + 磁吸配置双双下发
    expect(mocks.fns.get("setSidebarMode")).toHaveBeenCalledWith(false, "right");
    expect(mocks.fns.get("setCompanionConfig")).toHaveBeenCalled();
    expect(mocks.tip).toHaveBeenCalledTimes(1);
  });

  it("边栏没开时开启伴随停靠 → 不碰边栏与拖动位", () => {
    seed({
      companionEnabled: false,
      autoEdgeHide: false,
      rightSidebar: false,
      panelFreeX: 100,
      panelFreeY: 200,
    });
    applySettingsPatch({ companionEnabled: true });
    const s = useNotesStore.getState().settings;
    expect(s.rightSidebar).toBe(false);
    expect(s.panelFreeX).toBe(100);
    expect(s.panelFreeY).toBe(200);
    expect(mocks.fns.get("setSidebarMode")).toBeUndefined();
    expect(mocks.tip).not.toHaveBeenCalled();
  });

  it("关闭伴随停靠 → 边栏状态原样保留", () => {
    seed({ companionEnabled: true, rightSidebar: true, sidebarEdge: "left" });
    applySettingsPatch({ companionEnabled: false });
    const s = useNotesStore.getState().settings;
    expect(s.companionEnabled).toBe(false);
    expect(s.rightSidebar).toBe(true);
    expect(s.sidebarEdge).toBe("left");
    expect(mocks.tip).not.toHaveBeenCalled();
  });

  it("互斥二选一：开贴边隐藏自动关磁吸（含 Rust 同步）", () => {
    seed({ companionEnabled: true, autoEdgeHide: false, rightSidebar: false });
    applySettingsPatch({ autoEdgeHide: true });
    const s = useNotesStore.getState().settings;
    expect(s.autoEdgeHide).toBe(true);
    expect(s.companionEnabled).toBe(false);
    expect(mocks.fns.get("setAutoEdgeHide")).toHaveBeenCalledWith(true);
    // companionEnabled 进了 patch → setCompanionConfig 以 false 下发
    expect(mocks.fns.get("setCompanionConfig")).toHaveBeenCalled();
  });

  it("互斥二选一：开磁吸自动关贴边隐藏（含 Rust 同步）", () => {
    seed({ companionEnabled: false, autoEdgeHide: true, rightSidebar: false });
    applySettingsPatch({ companionEnabled: true });
    const s = useNotesStore.getState().settings;
    expect(s.companionEnabled).toBe(true);
    expect(s.autoEdgeHide).toBe(false);
    expect(mocks.fns.get("setAutoEdgeHide")).toHaveBeenCalledWith(false);
    expect(mocks.fns.get("setCompanionConfig")).toHaveBeenCalled();
  });

  it("模式开启默认联动：贴边隐藏 → 常显示图钉 + 置顶；磁吸 → 仅常显示图钉", () => {
    useUIStore.getState().setPinned(false);
    seed({
      autoEdgeHide: false,
      companionEnabled: false,
      panelTopmost: false,
      rightSidebar: false,
    });
    applySettingsPatch({ autoEdgeHide: true });
    expect(useUIStore.getState().pinned).toBe(true);
    expect(useNotesStore.getState().settings.panelTopmost).toBe(true);
    expect(mocks.fns.get("setPanelTopmost")).toHaveBeenCalledWith(true);

    useUIStore.getState().setPinned(false);
    seed({
      autoEdgeHide: false,
      companionEnabled: false,
      panelTopmost: false,
      rightSidebar: false,
    });
    applySettingsPatch({ companionEnabled: true });
    expect(useUIStore.getState().pinned).toBe(true);
    expect(useNotesStore.getState().settings.panelTopmost).toBe(false);
  });
});
