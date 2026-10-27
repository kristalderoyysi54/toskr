import { describe, expect, it } from "vitest";

import { useNotesStore, type Task } from "@/store/notesStore";

import { conflictTipText, desiredReminders, dueKeyLabel } from "./appleReminders";

function task(partial: Partial<Task> & { id: string }): Task {
  return {
    text: "写周报",
    status: "todo",
    priority: "none",
    dueAt: null,
    createdAt: 0,
    remindedAt: null,
    ...partial,
  };
}

describe("desiredReminders", () => {
  it("拆本地年月日时分、映射优先级与备注", () => {
    const dueAt = new Date(2026, 9, 26, 18, 30).getTime();
    const [r] = desiredReminders(
      [task({ id: "a", dueAt, priority: "high", note: "  带上数据  " })],
      new Set()
    );
    expect(r).toMatchObject({
      taskId: "a",
      due: { y: 2026, m: 10, d: 26, h: 18, mi: 30 },
      priority: 1,
      notes: "带上数据",
      completed: false,
      synced: false,
    });
  });

  it("闪念、对端删过的、从未推过的已完成任务都不下发", () => {
    const ids = desiredReminders(
      [
        task({ id: "spark", kind: "spark" }),
        task({ id: "off", appleSyncOff: true }),
        task({ id: "old-done", status: "done" }),
        task({ id: "done-synced", status: "done", appleSyncedId: "done-synced" }),
      ],
      new Set()
    ).map((r) => r.taskId);
    expect(ids).toEqual(["done-synced"]);
  });

  it("复制出的任务带着别人的同步 id，视为未同步", () => {
    const [r] = desiredReminders([task({ id: "copy", appleSyncedId: "orig" })], new Set());
    expect(r.synced).toBe(false);
  });

  it("本会话删过对端提醒的任务（撤销删除后）按未同步重建", () => {
    const [r] = desiredReminders([task({ id: "a", appleSyncedId: "a" })], new Set(["a"]));
    expect(r.synced).toBe(false);
  });

  it("对端已完成、Toskr 改回未完成 → reopened", () => {
    const [r] = desiredReminders(
      [task({ id: "a", appleSyncedId: "a", appleDone: true, status: "todo" })],
      new Set()
    );
    expect(r.reopened).toBe(true);
    const [fresh] = desiredReminders([task({ id: "b", appleSyncedId: "b" })], new Set());
    expect(fresh.reopened).toBe(false);
  });

  it("空标题给占位，避免提醒事项里出现空行", () => {
    const [r] = desiredReminders([task({ id: "a", text: "   " })], new Set());
    expect(r.title).not.toBe("");
  });
});

describe("markAppleReminderSync", () => {
  it("稳态回执不换 tasks 引用（否则每轮都会触发下一轮同步）", () => {
    useNotesStore.setState({
      tasks: [task({ id: "a", appleSyncedId: "a", status: "done", appleDone: true }), task({ id: "b", appleSyncedId: "b" })],
    });
    const before = useNotesStore.getState().tasks;
    useNotesStore.getState().markAppleReminderSync({ created: [], missing: [], done: ["a"], open: ["b"] });
    expect(useNotesStore.getState().tasks).toBe(before);
  });

  it("新建记同步 id、对端删除记不再同步、完成态随回执更新", () => {
    useNotesStore.setState({
      tasks: [task({ id: "new" }), task({ id: "gone", appleSyncedId: "gone", appleDone: true }), task({ id: "done", appleSyncedId: "done", status: "done" })],
    });
    useNotesStore.getState().markAppleReminderSync({ created: ["new"], missing: ["gone"], done: ["done"], open: ["new"] });
    const byId = Object.fromEntries(useNotesStore.getState().tasks.map((t) => [t.id, t]));
    expect(byId.new.appleSyncedId).toBe("new");
    expect(byId.gone).toMatchObject({ appleSyncOff: true, appleSyncedId: undefined, appleDone: undefined });
    expect(byId.done.appleDone).toBe(true);
  });
});

describe("响铃与导入", () => {
  it("开启响铃时按提醒档换算秒数；无到期或关闭时为空", () => {
    const dueAt = new Date(2026, 9, 27, 9).getTime();
    const [r] = desiredReminders([task({ id: "a", dueAt, reminderOffsets: [15, 0] })], new Set(), true);
    expect(r.alarms).toEqual([-900, 0]);
    expect(desiredReminders([task({ id: "a", dueAt })], new Set(), false)[0].alarms).toEqual([]);
    expect(desiredReminders([task({ id: "b" })], new Set(), true)[0].alarms).toEqual([]);
    expect(desiredReminders([task({ id: "c", dueAt })], new Set(), true)[0].alarms).toEqual([0]);
  });

  it("导入：只有日期按 9:00、优先级反向映射、已导入过的跳过、下发带认领 id", () => {
    useNotesStore.setState({ tasks: [task({ id: "x", appleImportItemId: "known" })] });
    const n = useNotesStore.getState().importAppleReminders([
      { itemId: "known", title: "重复", notes: null, due: null, priority: 0 },
      { itemId: "i1", title: "买牛奶", notes: " 全脂 ", due: { y: 2026, m: 10, d: 28, h: -1, mi: -1 }, priority: 1 },
    ]);
    expect(n).toBe(1);
    const imported = useNotesStore.getState().tasks.find((t) => t.appleImportItemId === "i1")!;
    expect(imported).toMatchObject({ text: "买牛奶", note: "全脂", priority: "high" });
    expect(imported.dueAt).toBe(new Date(2026, 9, 28, 9).getTime());
    expect(imported.appleSyncedId).toBe(imported.id);
    const [d] = desiredReminders([imported], new Set());
    expect(d).toMatchObject({ synced: true, adoptItemId: "i1" });
  });

  it("认领成功后清掉待认领标记", () => {
    useNotesStore.setState({ tasks: [task({ id: "a", appleSyncedId: "a", appleImportItemId: "i1" })] });
    useNotesStore.getState().markAppleReminderSync({ created: [], missing: [], done: [], open: ["a"], adopted: ["a"] });
    expect(useNotesStore.getState().tasks[0].appleImportItemId).toBeUndefined();
  });
});

describe("标题回流与导入分组", () => {
  it("只有已同步的任务带标题基准", () => {
    const [synced, fresh] = desiredReminders(
      [task({ id: "a", appleSyncedId: "a", appleTitle: "旧" }), task({ id: "b", appleTitle: "旧" })],
      new Set()
    );
    expect(synced.baseTitle).toBe("旧");
    expect(fresh.baseTitle).toBeNull();
  });

  it("回执：对端改名回写任务文字，基准随之更新；无变化不换引用", () => {
    useNotesStore.setState({ tasks: [task({ id: "a", appleSyncedId: "a", appleTitle: "写周报" })] });
    useNotesStore.getState().markAppleReminderSync({
      created: [], missing: [], done: [], open: ["a"],
      titles: [["a", "写月报"]], renamed: [["a", "写月报"]],
    });
    const after = useNotesStore.getState().tasks;
    expect(after[0]).toMatchObject({ text: "写月报", appleTitle: "写月报" });
    useNotesStore.getState().markAppleReminderSync({
      created: [], missing: [], done: [], open: ["a"], titles: [["a", "写月报"]],
    });
    expect(useNotesStore.getState().tasks).toBe(after);
  });

  it("导入进设置里选的分组；分组不存在时回收集箱", () => {
    const store = useNotesStore.getState();
    const sectionId = "work";
    useNotesStore.setState({
      tasks: [],
      taskSections: [...store.taskSections, { id: sectionId, name: "工作" }],
      settings: { ...store.settings, appleRemindersImportSectionId: sectionId },
    });
    useNotesStore.getState().importAppleReminders([{ itemId: "i", title: "A", notes: null, due: null, priority: 0 }]);
    expect(useNotesStore.getState().tasks[0].sectionId).toBe(sectionId);
    expect(useNotesStore.getState().tasks[0].appleTitle).toBe("A");
    useNotesStore.setState((s) => ({ tasks: [], settings: { ...s.settings, appleRemindersImportSectionId: "nope" } }));
    useNotesStore.getState().importAppleReminders([{ itemId: "j", title: "B", notes: null, due: null, priority: 0 }]);
    expect(useNotesStore.getState().tasks[0].sectionId).toBeUndefined();
  });
});

describe("备注回流", () => {
  it("只有已同步的任务带备注基准；导入的任务以导入备注为基准", () => {
    const [synced, fresh] = desiredReminders(
      [task({ id: "a", appleSyncedId: "a", appleNotes: "" }), task({ id: "b", appleNotes: "x" })],
      new Set()
    );
    expect(synced.baseNotes).toBe("");
    expect(fresh.baseNotes).toBeNull();
    useNotesStore.setState({ tasks: [] });
    useNotesStore.getState().importAppleReminders([{ itemId: "i", title: "A", notes: " 全脂 ", due: null, priority: 0 }]);
    expect(useNotesStore.getState().tasks[0].appleNotes).toBe("全脂");
  });

  it("回执：对端清空备注回写为无备注，基准随之更新；无变化不换引用", () => {
    useNotesStore.setState({ tasks: [task({ id: "a", appleSyncedId: "a", note: "旧", appleNotes: "旧" })] });
    useNotesStore.getState().markAppleReminderSync({
      created: [], missing: [], done: [], open: ["a"], notes: [["a", ""]], renoted: [["a", ""]],
    });
    const after = useNotesStore.getState().tasks;
    expect(after[0].note).toBeUndefined();
    expect(after[0].appleNotes).toBe("");
    useNotesStore.getState().markAppleReminderSync({ created: [], missing: [], done: [], open: ["a"], notes: [["a", ""]] });
    expect(useNotesStore.getState().tasks).toBe(after);
  });
});

describe("到期回流与冲突撤销", () => {
  it("到期键与 Rust due_key 同格式，可往返", async () => {
    const { appleDueKey, appleDueFromKey } = await import("@/store/notesStore");
    const due = { y: 2026, m: 10, d: 26, h: 18, mi: 0 };
    expect(appleDueKey(due)).toBe("2026-10-26 18:0");
    expect(appleDueKey(null)).toBe("");
    expect(appleDueFromKey("2026-1-2 -1:-1")).toEqual({ y: 2026, m: 1, d: 2, h: -1, mi: -1 });
    expect(appleDueFromKey("")).toBeNull();
    expect(dueKeyLabel("")).not.toBe("");
  });

  it("已同步任务带到期基准；回执回写到期并清掉已提醒标记，无变化不换引用", () => {
    const dueAt = new Date(2026, 9, 26, 18).getTime();
    const [d] = desiredReminders([task({ id: "a", appleSyncedId: "a", dueAt, appleDue: "2026-10-26 18:0" })], new Set());
    expect(d.baseDue).toBe("2026-10-26 18:0");
    useNotesStore.setState({ tasks: [task({ id: "a", appleSyncedId: "a", dueAt, remindedAt: dueAt })] });
    const moved = { y: 2026, m: 10, d: 28, h: 9, mi: 30 };
    useNotesStore.getState().markAppleReminderSync({
      created: [], missing: [], done: [], open: ["a"], dues: [["a", "2026-10-28 9:30"]], redued: [["a", moved]],
    });
    const after = useNotesStore.getState().tasks;
    expect(after[0]).toMatchObject({ dueAt: new Date(2026, 9, 28, 9, 30).getTime(), remindedAt: null, appleDue: "2026-10-28 9:30" });
    useNotesStore.getState().markAppleReminderSync({ created: [], missing: [], done: [], open: ["a"], dues: [["a", "2026-10-28 9:30"]] });
    expect(useNotesStore.getState().tasks).toBe(after);
  });

  it("撤销冲突：标题 / 备注 / 到期写回对端版本", () => {
    useNotesStore.setState({ tasks: [task({ id: "a", text: "我的", note: "我的备注", dueAt: 0 })] });
    useNotesStore.getState().applyAppleReminderTheirs([
      { taskId: "a", field: "title", theirs: "对端" },
      { taskId: "a", field: "notes", theirs: "" },
      { taskId: "a", field: "due", theirs: "2026-10-30 -1:-1" },
    ]);
    expect(useNotesStore.getState().tasks[0]).toMatchObject({
      text: "对端",
      note: undefined,
      dueAt: new Date(2026, 9, 30, 9).getTime(),
    });
  });

  it("冲突提示：单处写出对端内容，多处给数量", () => {
    expect(conflictTipText([{ taskId: "a", field: "title", theirs: "对端" }])).toContain("对端");
    expect(conflictTipText([{ taskId: "a", field: "title", theirs: "x" }, { taskId: "b", field: "due", theirs: "" }])).toContain("2");
  });
});

