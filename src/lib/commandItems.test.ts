import { describe, expect, it, vi } from "vitest";

import { buildCommandItems, keyHintsFor, type CommandContext } from "./commandItems";

function ctx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    page: "notes",
    contentSubview: "notes",
    checkedCount: 0,
    focusedNoteId: null,
    notes: [
      { id: "n1", text: "把这段错误日志发给 Claude", sectionId: "inbox" },
      { id: "n2", text: "clipboard entry about cargo clean", sectionId: "clip" },
    ] as never,
    tasks: [{ id: "t1", text: "核对首页文案", status: "todo" }] as never,
    clipboardSectionId: "clip",
    actions: {
      sendChecked: vi.fn(),
      sendNote: vi.fn(),
      setPage: vi.fn(),
      addSection: vi.fn(),
      openSettings: vi.fn(),
      openRecentDelivery: vi.fn(),
      openSearch: vi.fn(),
      focusNote: vi.fn(),
      focusTask: vi.fn(),
    },
    ...overrides,
  };
}

describe("命令面板条目", () => {
  it("无查询词只列动作；勾选时发送动作针对勾选，否则针对焦点卡", () => {
    const none = buildCommandItems(ctx(), "");
    expect(none.every((item) => item.group === "动作")).toBe(true);
    expect(none.find((item) => item.id === "send-checked")).toBeUndefined();
    const checked = buildCommandItems(ctx({ checkedCount: 2 }), "");
    expect(checked[0]!.label).toContain("2 张");
    const c = ctx({ focusedNoteId: "n1" });
    buildCommandItems(c, "")[0]!.run();
    expect(c.actions.sendNote).toHaveBeenCalledWith("n1");
  });

  it("查询词过滤动作并附卡片/任务命中，剪贴卡定位到剪贴页", () => {
    const c = ctx();
    const items = buildCommandItems(c, "cargo");
    const hit = items.find((item) => item.id === "note:n2")!;
    expect(hit.hint).toBe("剪贴");
    hit.run();
    expect(c.actions.focusNote).toHaveBeenCalledWith("n2", "clipboard");
    const task = buildCommandItems(c, "首页").find((item) => item.id === "task:t1")!;
    task.run();
    expect(c.actions.focusTask).toHaveBeenCalledWith("t1");
    expect(buildCommandItems(c, "设置").map((item) => item.id)).toEqual(["settings"]);
  });

  it("提示行随上下文变化", () => {
    const base = { page: "notes" as const, contentSubview: "notes" as const, editing: false, searchOpen: false, focusedNote: false, checkedCount: 0 };
    expect(keyHintsFor(base).map(([k]) => k)).toContain("⌘K");
    expect(keyHintsFor({ ...base, checkedCount: 3 })[0]![1]).toBe("发送 3 张");
    expect(keyHintsFor({ ...base, editing: true })[0]![0]).toBe("⌘⏎");
    expect(keyHintsFor({ ...base, focusedNote: true }).map(([k]) => k)).toContain("Space");
  });
});
