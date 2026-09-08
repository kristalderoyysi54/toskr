import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/store/persistStorage", () => ({
  tauriStateStorage: { getItem: vi.fn(async () => null), setItem: vi.fn(), removeItem: vi.fn() },
}));
vi.mock("@/components/SimpleMenu", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./SimpleMenu")>();
  return { ...actual, SimpleMenu: ({ children }: { children: (close: () => void) => React.ReactNode }) => children(vi.fn()) };
});
vi.mock("@/lib/settingsSync", () => ({ applySettingsPatch: vi.fn() }));

import { applySettingsPatch } from "@/lib/settingsSync";
import { api } from "@/lib/tauri";
import { useNotesStore, defaultSettings } from "@/store/notesStore";
import { useUIStore } from "@/store/uiStore";
import { PanelOptionsMenu } from "./PanelOptionsMenu";
import { applyCompanionSide, applySidebar } from "@/lib/panelPlacement";
import { handlePanelPlacementKeyDown } from "@/lib/menuKeyboard";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(api, "setPanelFreePos").mockResolvedValue(undefined);
  vi.spyOn(api, "setSidebarMode").mockResolvedValue(undefined);
  useNotesStore.setState({ settings: defaultSettings() });
  useUIStore.setState({ page: "notes", contentSubview: "notes", pinned: false });
});
afterEach(() => vi.restoreAllMocks());
function renderMenu() {
  Object.assign(useNotesStore.getInitialState(), useNotesStore.getState());
  Object.assign(useUIStore.getInitialState(), useUIStore.getState());
  return renderToStaticMarkup(<PanelOptionsMenu doneCount={4} doneTaskCount={2} onClearNotes={() => {}} onClearTasks={() => {}} />);
}

describe("面板选项按当前任务显示", () => {
  it("笔记首层只显示4项，位置细节需要展开", () => {
    const html = renderMenu();
    expect(html.match(/data-simple-menu-item/g)).toHaveLength(4);
    expect(html).toContain("紧凑列表");
    expect(html).toContain("清理已完成（4）");
    expect(html).toContain("保持面板展开");
    expect(html).toContain("位置与停靠");
    expect(html).not.toContain("屏幕右侧");
    expect(html).not.toContain("跟随当前应用");
  });
  it("消息视图不出现无效的密度或笔记清理动作", () => {
    useUIStore.setState({ contentSubview: "messages" });
    const html = renderMenu();
    expect(html.match(/data-simple-menu-item/g)).toHaveLength(2);
    expect(html).not.toContain("紧凑列表");
    expect(html).not.toContain("清理已完成");
    expect(html).not.toContain("当前列表");
  });
  it("提醒页清理数量使用任务数量，剪贴页没有清理已完成", () => {
    useUIStore.setState({ page: "tasks" });
    expect(renderMenu()).toContain("清理已完成（2）");
    useUIStore.setState({ page: "clipboard" });
    expect(renderMenu()).not.toContain("清理已完成");
  });

  it("重复选择自由移动不清除用户拖动位置，重复选择停靠不重排", async () => {
    useNotesStore.getState().setSettings({ panelFreeX: 120, panelFreeY: 240, rightSidebar: false });
    await applySidebar(false, "right");
    expect(useNotesStore.getState().settings).toMatchObject({ panelFreeX: 120, panelFreeY: 240 });
    for (const edge of ["right", "bottom"] as const) {
      useNotesStore.getState().setSettings({ rightSidebar: true, sidebarEdge: edge });
      await applySidebar(true, edge);
    }
    expect(api.setPanelFreePos).not.toHaveBeenCalled();
    expect(api.setSidebarMode).not.toHaveBeenCalled();
  });

  it("切换停靠时仍先清手动位置再重排原生窗口", async () => {
    useNotesStore.getState().setSettings({ panelFreeX: 120, panelFreeY: 240 });
    await applySidebar(true, "bottom");

    expect(useNotesStore.getState().settings).toMatchObject({
      rightSidebar: true, sidebarEdge: "bottom", panelFreeX: null, panelFreeY: null,
    });
    expect(api.setPanelFreePos).toHaveBeenCalledWith(null, null);
    expect(api.setSidebarMode).toHaveBeenCalledWith(true, "bottom");
    expect(vi.mocked(api.setPanelFreePos).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(api.setSidebarMode).mock.invocationCallOrder[0]!);
  });

  it("重复选择当前伴随方向不提交补丁，实际换边才更新", () => {
    useNotesStore.getState().setSettings({ companionEnabled: true, sidebarEdge: "left" });
    applyCompanionSide("left");
    expect(applySettingsPatch).not.toHaveBeenCalled();
    applyCompanionSide("right");
    expect(applySettingsPatch).toHaveBeenCalledExactlyOnceWith({ sidebarEdge: "right" });
  });

  it("位置入口的右键进入、左键返回由捕获阶段接管", () => {
    const setPlacementOpen = vi.fn();
    const event = (key: string, placementEntry: boolean, open = true) => ({
      key,
      target: {
        closest: (selector: string) => selector === "button"
          ? { querySelector: () => placementEntry ? {} : null }
          : open ? {} : null,
      },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    }) as unknown as React.KeyboardEvent<HTMLDivElement>;
    const right = event("ArrowRight", true);
    handlePanelPlacementKeyDown(right, false, setPlacementOpen);
    expect(setPlacementOpen).toHaveBeenLastCalledWith(true);
    expect(right.stopPropagation).toHaveBeenCalledOnce();
    const left = event("ArrowLeft", false);
    handlePanelPlacementKeyDown(left, true, setPlacementOpen);
    expect(setPlacementOpen).toHaveBeenLastCalledWith(false);
    expect(left.stopPropagation).toHaveBeenCalledOnce();
    handlePanelPlacementKeyDown(event("ArrowRight", false), false, setPlacementOpen);
    handlePanelPlacementKeyDown(event("ArrowLeft", false, false), true, setPlacementOpen);
    expect(setPlacementOpen).toHaveBeenCalledTimes(2);
  });
});
