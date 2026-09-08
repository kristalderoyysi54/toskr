import { beforeEach, describe, expect, it, vi } from "vitest";

// 单测环境没有 Tauri runtime：持久化、IPC、HUD 全部替换为内存桩
vi.mock("../store/persistStorage", () => {
  const memory = new Map<string, string>();
  return {
    flushPendingWrites: (...args: unknown[]) => mocks.flush(...args),
    isPersistencePaused: () => mocks.paused,
    hasLoadedPersistenceAuthority: () => mocks.authority,
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
  return { api, fns, tip: vi.fn(), flush: vi.fn<(...args: unknown[]) => Promise<void>>(() => Promise.resolve()), paused: false, authority: true };
});
vi.mock("@/lib/tauri", () => ({ api: mocks.api }));
vi.mock("@/lib/tip", () => ({ tip: mocks.tip }));
vi.mock("@tauri-apps/api/event", () => ({
  emitTo: vi.fn(() => Promise.resolve()),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import { emitTo } from "@tauri-apps/api/event";
import { applySettingsPatch, broadcastSettings, SETTINGS_STATE } from "./settingsSync";
import { defaultSettings, useNotesStore } from "../store/notesStore";
import { useDataOperationStore } from "../store/dataOperationStore";
import { useUIStore } from "../store/uiStore";
import {
  applyTargetEvent,
  resetTargetState,
  setTargetProfileOverride,
  useTargetStore,
} from "../store/targetStore";
import { useDeliveryStore, resetDeliveryStore } from "../store/deliveryStore";
import type { DeliveryDraft } from "./delivery/types";
import { registerPrivacySettingsSave, waitForPrivacySettingsSave } from "./delivery/privacySettingsBarrier";
import type { TargetSnapshot } from "./tauri";

function seed(overrides: Partial<ReturnType<typeof defaultSettings>>) {
  useNotesStore.setState({ settings: { ...defaultSettings(), ...overrides } });
}

describe("applySettingsPatch 面板布局策略", () => {
  beforeEach(() => {
    mocks.fns.clear();
    mocks.flush.mockReset().mockResolvedValue();
    mocks.paused = false;
    mocks.authority = true;
    resetDeliveryStore();
    registerPrivacySettingsSave(Promise.resolve());
    mocks.tip.mockClear();
    vi.mocked(emitTo).mockClear();
    useDataOperationStore.setState({ locked: false, phase: "idle", message: "" });
    resetTargetState();
  });

  it("敏感字段保存期间冻结旧预检并失效扫描回执，落盘后才提示成功且保留手工打码", async () => {
    seed({});
    let resolveSave!: () => void;
    mocks.flush.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveSave = resolve; }));
    const images = [{ status: "scanning", scanRevision: 3, originalFile: "original.png", sendFile: "redacted.png", redactedFindingIds: ["masked"], manualRegions: [{ x: 1, y: 2, width: 3, height: 4 }], keptFindingIds: ["kept"], rawConfirmation: { revision: 3 } }, { status: "disabled", scanRevision: 1 }];
    useDeliveryStore.setState({ open: true, draft: {
      id: "existing", scanRevision: 7, firewallStatus: "ready", findings: [{ id: "old" }],
      imageFirewall: images, privacyDecision: { excludedFindingIds: ["old"], rawConfirmation: {}, replacedCount: 2 },
    } as unknown as DeliveryDraft });

    applySettingsPatch({ firewallCustomSensitiveFields: ["internal_key"] });
    expect(mocks.flush).toHaveBeenCalledOnce();
    expect(useDeliveryStore.getState().busy).toBe(true);
    expect(useDeliveryStore.getState().draft).toMatchObject({ scanRevision: 8, firewallStatus: "failed", findings: [], privacyDecision: { excludedFindingIds: [], rawConfirmation: null } });
    const updatedImages = useDeliveryStore.getState().draft!.imageFirewall;
    expect(updatedImages[0]).toMatchObject({
      status: "failed", scanRevision: 4, keptFindingIds: [], rawConfirmation: null,
      failureMessage: "敏感字段已更新，请重新检查图片",
      originalFile: "original.png", sendFile: "redacted.png", redactedFindingIds: ["masked"],
    });
    // 图片扫描协调器要求scanRevision相等；已发出的旧OCR回执无法匹配新版本。
    expect(updatedImages[0].scanRevision).not.toBe(images[0].scanRevision);
    expect(updatedImages[0].manualRegions).toBe(images[0].manualRegions);
    expect(updatedImages[1]).toBe(images[1]);
    expect(mocks.tip).not.toHaveBeenCalledWith("ok", expect.anything());
    resolveSave();
    await waitForPrivacySettingsSave();
    expect(useDeliveryStore.getState().busy).toBe(false);
    expect(useDeliveryStore.getState().draft?.firewallStatus).toBe("failed");
    expect(mocks.tip).toHaveBeenCalledWith("ok", "敏感字段已保存，请重新检查当前发送内容");
  });

  it("保存失败持续阻止扫描，重新保存成功后才解除", async () => {
    seed({});
    mocks.flush.mockRejectedValueOnce(new Error("disk failure"));
    applySettingsPatch({ firewallCustomSensitiveFields: ["internal_key"] });
    await expect(waitForPrivacySettingsSave()).rejects.toThrow("disk failure");
    await expect(waitForPrivacySettingsSave()).rejects.toThrow("disk failure");
    expect(mocks.tip).not.toHaveBeenCalledWith("ok", expect.anything());
    expect(mocks.tip).toHaveBeenCalledWith("warn", expect.stringContaining("保存失败"));
    applySettingsPatch({ firewallCustomSensitiveFields: ["internal_key"] });
    await waitForPrivacySettingsSave();
    expect(mocks.tip).toHaveBeenCalledWith("ok", "敏感字段已保存");
  });

  it("发送忙碌、打码中、无权威存储或字段无效时拒绝并回播原设置", () => {
    seed({});
    useDeliveryStore.setState({ busy: true });
    applySettingsPatch({ firewallCustomSensitiveFields: ["internal_key"] });
    useDeliveryStore.setState({ busy: false, draft: { imageFirewall: [{ status: "redacting" }] } as DeliveryDraft });
    applySettingsPatch({ firewallCustomSensitiveFields: ["internal_key"] });
    resetDeliveryStore();
    mocks.authority = false;
    applySettingsPatch({ firewallCustomSensitiveFields: ["internal_key"] });
    mocks.authority = true;
    applySettingsPatch({ firewallCustomSensitiveFields: ["bad field"] });
    expect(useNotesStore.getState().settings.firewallCustomSensitiveFields).toEqual([]);
    expect(mocks.flush).not.toHaveBeenCalled();
    expect(emitTo).toHaveBeenCalledTimes(4);
  });

  it("旧保存回执不解除新草稿的busy", async () => {
    seed({});
    let resolveSave!: () => void;
    mocks.flush.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveSave = resolve; }));
    useDeliveryStore.setState({ open: true, draft: { id: "old", scanRevision: 0, imageFirewall: [], privacyDecision: {} } as unknown as DeliveryDraft });
    applySettingsPatch({ firewallCustomSensitiveFields: ["key"] });
    useDeliveryStore.setState({ busy: true, draft: { id: "new", scanRevision: 1 } as DeliveryDraft });
    resolveSave();
    await waitForPrivacySettingsSave();
    expect(useDeliveryStore.getState().busy).toBe(true);
  });

  it("并发保存时只由最新回执提示成功，其他设置不强制flush", async () => {
    seed({});
    let resolveFirst!: () => void;
    let resolveSecond!: () => void;
    mocks.flush.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise<void>((resolve) => { resolveSecond = resolve; }));
    applySettingsPatch({ firewallCustomSensitiveFields: ["first"] });
    applySettingsPatch({ firewallCustomSensitiveFields: ["second"] });
    applySettingsPatch({ detailFontSize: 16 });
    expect(mocks.flush).toHaveBeenCalledTimes(2);
    resolveFirst();
    await Promise.resolve();
    expect(mocks.tip).not.toHaveBeenCalledWith("ok", expect.anything());
    resolveSecond();
    await waitForPrivacySettingsSave();
    expect(mocks.tip).toHaveBeenCalledTimes(1);
    expect(useNotesStore.getState().settings.firewallCustomSensitiveFields).toEqual(["second"]);
  });

  it("广播到设置 WebView 前剥离旧 JSON 密钥恢复副本", () => {
    seed({});
    useNotesStore.setState({
      settings: {
        ...useNotesStore.getState().settings,
        aiApiKey: "sk-never-broadcast",
      } as ReturnType<typeof defaultSettings>,
    });

    broadcastSettings();

    expect(vi.mocked(emitTo)).toHaveBeenCalledWith(
      "settings",
      SETTINGS_STATE,
      expect.not.objectContaining({ aiApiKey: expect.anything() })
    );
  });

  it("数据事务锁定期间拒绝设置写入和 Rust 副作用", () => {
    seed({ panelTopmost: false });
    useDataOperationStore.setState({
      locked: true,
      phase: "rehydrate",
      message: "正在重新水合",
    });

    applySettingsPatch({ panelTopmost: true });

    expect(useNotesStore.getState().settings.panelTopmost).toBe(false);
    expect(mocks.fns.get("setPanelTopmost")).toBeUndefined();
    expect(mocks.tip).toHaveBeenCalledWith(
      "warn",
      "数据操作进行中，设置暂时只读"
    );
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

  it("伴随磁吸与默认贴边能力可同时开启", () => {
    seed({ companionEnabled: false, autoEdgeHide: true, rightSidebar: false });
    applySettingsPatch({ companionEnabled: true });
    const s = useNotesStore.getState().settings;
    expect(s.autoEdgeHide).toBe(true);
    expect(s.companionEnabled).toBe(true);
    expect(mocks.fns.get("setCompanionConfig")).toHaveBeenCalled();
    expect(mocks.tip).not.toHaveBeenCalledWith("info", "已关闭贴边隐藏");
  });

  it("旧设置尝试关闭贴边能力时静默归一为开启且不强制图钉/置顶", () => {
    useUIStore.getState().setPinned(false);
    seed({ autoEdgeHide: true, companionEnabled: false, panelTopmost: false });
    applySettingsPatch({ autoEdgeHide: false });
    const s = useNotesStore.getState().settings;
    expect(s.autoEdgeHide).toBe(true);
    expect(s.panelTopmost).toBe(false);
    expect(useUIStore.getState().pinned).toBe(false);
    expect(mocks.fns.get("setAutoEdgeHide")).toHaveBeenCalledWith(true);
  });

  it("默认设置开启贴边能力、磁吸按需关闭", () => {
    const d = defaultSettings();
    expect(d.autoEdgeHide).toBe(true);
    expect(d.companionEnabled).toBe(false);
  });

  it("首装默认：剪贴板历史开、保留 1 个月（30 天）", () => {
    const d = defaultSettings();
    expect(d.clipHistory).toBe(true);
    expect(d.clipRetentionDays).toBe(30);
  });

  it("提示时长修改后立即持久化并下发 Native", () => {
    seed({ hudDurationMs: 3_000 });

    applySettingsPatch({ hudDurationMs: 5_000 });

    expect(useNotesStore.getState().settings.hudDurationMs).toBe(5_000);
    expect(mocks.fns.get("setHudDuration")).toHaveBeenCalledWith(5_000);
  });

  it("发送方案/提示词组 patch 走主窗口持久化，并修复已删除的临时方案", () => {
    const settings = defaultSettings();
    seed({
      targetProfiles: [
        ...settings.targetProfiles,
        {
          id: "temporary",
          name: "临时",
          bundleIds: ["com.openai.codex"],
          promptGroupId: settings.promptGroups[0].id,
          defaultFormat: "plain",
          defaultMarkdownMode: "preserve",
          enterPolicy: "never",
          privacyPolicy: "requireRedaction",
          keepPanel: false,
        },
      ],
    });
    applyTargetEvent({
      token: "target",
      pid: 42,
      bundleId: "com.openai.codex",
      appName: "Codex",
      launchedAtMs: 1,
      capturedAtMs: 2,
      revision: 1,
      ready: true,
      reason: null,
      windowId: null,
    } satisfies TargetSnapshot);
    setTargetProfileOverride("temporary");

    applySettingsPatch({
      targetProfiles: settings.targetProfiles,
      promptGroups: settings.promptGroups,
    });

    expect(useNotesStore.getState().settings.targetProfiles).toEqual(
      settings.targetProfiles
    );
    expect(useTargetStore.getState().profileOverrideId).toBeNull();
    expect(mocks.tip).toHaveBeenCalledWith(
      "info",
      "本次发送方案已被删除，已恢复自动匹配"
    );
  });

  it("只有伴随模式默认联动常显示；默认贴边能力不改图钉或置顶", () => {
    useUIStore.getState().setPinned(false);
    seed({
      autoEdgeHide: false,
      companionEnabled: false,
      panelTopmost: false,
      rightSidebar: false,
    });
    applySettingsPatch({ autoEdgeHide: true });
    expect(useUIStore.getState().pinned).toBe(false);
    expect(useNotesStore.getState().settings.panelTopmost).toBe(false);
    expect(mocks.fns.get("setPanelTopmost")).toBeUndefined();

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
