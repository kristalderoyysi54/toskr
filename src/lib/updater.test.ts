import { beforeEach, describe, expect, it, vi } from "vitest";

const { checkMock, tipMock, relaunchMock } = vi.hoisted(() => ({
  checkMock: vi.fn(),
  tipMock: vi.fn(),
  relaunchMock: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({ check: checkMock }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: relaunchMock }));
// tip 顶层引 @/lib/tauri（Tauri runtime），单测环境整体替换
vi.mock("@/lib/tip", () => ({ tip: tipMock }));
// 单测环境没有 Tauri runtime，把持久化后端替换为内存实现
vi.mock("@/store/persistStorage", () => {
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

import { silentUpdateFlow } from "./updater";
import { defaultSettings, useNotesStore } from "@/store/notesStore";
import { useUIStore } from "@/store/uiStore";

/** 造一个最小可用的 Update 桩：silentUpdateFlow 只碰这四个成员。 */
function makeUpdate(version: string) {
  return {
    version,
    currentVersion: "0.17.0",
    body: "",
    downloadAndInstall: vi.fn(
      async (cb?: (event: { event: string }) => void) => {
        cb?.({ event: "Finished" });
      }
    ),
  };
}

// 注意：updater.ts 的 lastHandledVersion 是模块级状态，跨用例存留——
// 各用例使用互不相同的版本号，避免相互污染。
describe("silentUpdateFlow 周期检查去重", () => {
  beforeEach(() => {
    checkMock.mockReset();
    tipMock.mockClear();
    relaunchMock.mockClear();
    useNotesStore.setState({ settings: defaultSettings() });
    useUIStore.setState({ updateAvail: null });
  });

  it("同一版本多轮检查只提醒一次（30 分钟周期不重复弹泡）", async () => {
    checkMock.mockResolvedValue(makeUpdate("9.0.1"));
    await silentUpdateFlow();
    await silentUpdateFlow();
    expect(tipMock).toHaveBeenCalledTimes(1);
    expect(useUIStore.getState().updateAvail?.version).toBe("9.0.1");
  });

  it("出现更高版本号时再次提醒", async () => {
    checkMock.mockResolvedValue(makeUpdate("9.0.2"));
    await silentUpdateFlow();
    expect(tipMock).toHaveBeenCalledTimes(1);
    expect(useUIStore.getState().updateAvail?.version).toBe("9.0.2");
  });

  it("自动安装开启时，同一版本不重复下载（装完未重启二进制仍自报旧版）", async () => {
    useNotesStore.setState({
      settings: { ...defaultSettings(), autoInstallUpdate: true },
    });
    const update = makeUpdate("9.0.3");
    checkMock.mockResolvedValue(update);
    await silentUpdateFlow();
    await silentUpdateFlow();
    expect(update.downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(tipMock).toHaveBeenCalledTimes(1);
    expect(relaunchMock).not.toHaveBeenCalled();
  });

  it("自动检查关闭时不发起检查请求", async () => {
    useNotesStore.setState({
      settings: { ...defaultSettings(), autoCheckUpdate: false },
    });
    await silentUpdateFlow();
    expect(checkMock).not.toHaveBeenCalled();
  });
});
