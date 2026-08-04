import { beforeEach, describe, expect, it, vi } from "vitest";

// 单测环境没有 Tauri runtime，把持久化后端替换为内存实现
vi.mock("./persistStorage", () => {
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

import {
  CLIPBOARD_ID,
  defaultSettings,
  doneIdsAfterSend,
  INBOX_ID,
  orderedCheckedNotes,
  TASK_INBOX_ID,
  useNotesStore,
} from "./notesStore";

function reset() {
  useNotesStore.setState({
    sections: [{ id: INBOX_ID, name: "收件箱" }],
    notes: [],
    tasks: [],
    taskSections: [{ id: TASK_INBOX_ID, name: "收集箱" }],
    checkedIds: [],
    settings: defaultSettings(),
    undoStack: [],
  });
}

describe("notesStore 基础", () => {
  beforeEach(reset);

  it("addNote 去除首尾空白并落入收件箱", () => {
    const { result } = useNotesStore.getState().addNote("  hello  ");
    expect(result).toBe("added");
    const notes = useNotesStore.getState().notes;
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toBe("hello");
    expect(notes[0].sectionId).toBe(INBOX_ID);
  });

  it("addNote 忽略纯空白", () => {
    expect(useNotesStore.getState().addNote("   \n  ").result).toBe("empty");
    expect(useNotesStore.getState().notes).toHaveLength(0);
  });

  it("addNote 对未完成同文本去重", () => {
    useNotesStore.getState().addNote("同一段话");
    const second = useNotesStore.getState().addNote("  同一段话  ");
    expect(second.result).toBe("duplicate");
    expect(useNotesStore.getState().notes).toHaveLength(1);
  });

  it("已完成的同文本同样去重（发送后再捕获不新建）", () => {
    const first = useNotesStore.getState().addNote("再来一次");
    useNotesStore.getState().setDone([first.id!], true);
    const again = useNotesStore.getState().addNote("再来一次");
    expect(again.result).toBe("duplicate");
    expect(again.id).toBe(first.id);
    expect(useNotesStore.getState().notes).toHaveLength(1);
  });

  it("新卡片置顶插入", () => {
    const s = useNotesStore.getState();
    s.addNote("旧");
    s.addNote("新");
    expect(useNotesStore.getState().notes.map((n) => n.text)).toEqual(["新", "旧"]);
  });

  it("mergeNotes 按列表顺序合并并保留首条位置", () => {
    const s = useNotesStore.getState();
    s.addNote("一");
    s.addNote("二");
    s.addNote("三");
    // 置顶插入后展示顺序为 [三, 二, 一]
    const [a, , c] = useNotesStore.getState().notes;
    useNotesStore.getState().mergeNotes([c.id, a.id]);
    const notes = useNotesStore.getState().notes;
    expect(notes).toHaveLength(2);
    expect(notes[0].text).toBe("三\n\n一");
    expect(notes[1].text).toBe("二");
  });

  it("reorderNotes 在数组内移动", () => {
    const s = useNotesStore.getState();
    s.addNote("一");
    s.addNote("二");
    s.addNote("三");
    const [a, , c] = useNotesStore.getState().notes; // [三, 二, 一]
    useNotesStore.getState().reorderNotes(a.id, c.id);
    expect(useNotesStore.getState().notes.map((n) => n.text)).toEqual(["二", "一", "三"]);
  });

  it("deleteSection 把笔记回收进收件箱且不能删除收件箱", () => {
    useNotesStore.getState().addSection("研究");
    const section = useNotesStore.getState().sections[1];
    useNotesStore.getState().addNote("x", { sectionId: section.id });
    useNotesStore.getState().deleteSection(section.id);
    let state = useNotesStore.getState();
    expect(state.sections).toHaveLength(1);
    expect(state.notes[0].sectionId).toBe(INBOX_ID);
    useNotesStore.getState().deleteSection(INBOX_ID);
    state = useNotesStore.getState();
    expect(state.sections).toHaveLength(1);
  });

  it("moveSection 上移/下移并做边界保护", () => {
    const s = useNotesStore.getState();
    s.addSection("A");
    s.addSection("B");
    const [, a, b] = useNotesStore.getState().sections;
    useNotesStore.getState().moveSection(b.id, -1);
    expect(useNotesStore.getState().sections.map((x) => x.name)).toEqual([
      "收件箱",
      "B",
      "A",
    ]);
    // 收件箱已在顶部，上移无效
    useNotesStore.getState().moveSection(INBOX_ID, -1);
    expect(useNotesStore.getState().sections[0].id).toBe(INBOX_ID);
    void a;
  });

  it("orderedCheckedNotes 按展示顺序返回", () => {
    const s = useNotesStore.getState();
    s.addNote("一");
    s.addNote("二");
    const [a, b] = useNotesStore.getState().notes; // [二, 一]
    useNotesStore.getState().setChecked([b.id, a.id]);
    expect(orderedCheckedNotes(useNotesStore.getState()).map((n) => n.text)).toEqual([
      "二",
      "一",
    ]);
  });
});

describe("撤销安全网", () => {
  beforeEach(reset);

  it("deleteNotes 可撤销恢复原位", () => {
    const s = useNotesStore.getState();
    s.addNote("一");
    s.addNote("二");
    const [a] = useNotesStore.getState().notes; // [二, 一]
    useNotesStore.getState().deleteNotes([a.id]);
    expect(useNotesStore.getState().notes).toHaveLength(1);
    const label = useNotesStore.getState().undo();
    expect(label).toContain("删除");
    expect(useNotesStore.getState().notes.map((n) => n.text)).toEqual(["二", "一"]);
  });

  it("clearDone 只清已完成且可撤销", () => {
    const s = useNotesStore.getState();
    const a = s.addNote("留下");
    const b = s.addNote("清掉");
    useNotesStore.getState().setDone([b.id!], true);
    const cleared = useNotesStore.getState().clearDone();
    expect(cleared).toBe(1);
    expect(useNotesStore.getState().notes.map((n) => n.text)).toEqual(["留下"]);
    useNotesStore.getState().undo();
    expect(useNotesStore.getState().notes).toHaveLength(2);
    void a;
  });

  it("撤销栈有深度上限且空栈返回 null", () => {
    const s = useNotesStore.getState();
    for (let i = 0; i < 8; i++) {
      s.addNote(`n${i}`);
    }
    const ids = useNotesStore.getState().notes.map((n) => n.id);
    for (const id of ids.slice(0, 7)) {
      useNotesStore.getState().deleteNotes([id]);
    }
    expect(useNotesStore.getState().undoStack.length).toBeLessThanOrEqual(5);
    let undone = 0;
    while (useNotesStore.getState().undo() !== null) undone++;
    expect(undone).toBeLessThanOrEqual(5);
    expect(useNotesStore.getState().undo()).toBeNull();
  });

  it("deleteNotes 同步清理勾选态", () => {
    const s = useNotesStore.getState();
    s.addNote("一");
    const [a] = useNotesStore.getState().notes;
    useNotesStore.getState().setChecked([a.id]);
    useNotesStore.getState().deleteNotes([a.id]);
    expect(useNotesStore.getState().checkedIds).toHaveLength(0);
  });
});

describe("导入合并", () => {
  beforeEach(reset);

  it("按 id 去重追加，孤儿分组归收件箱", () => {
    const s = useNotesStore.getState();
    const kept = s.addNote("本地已有");
    const localId = kept.id!;
    const added = useNotesStore.getState().importMerge({
      sections: [{ id: "sec-x", name: "外部组" }],
      notes: [
        {
          id: localId,
          text: "重复导入应跳过",
          sectionId: INBOX_ID,
          done: false,
          createdAt: 1,
        },
        { id: "new-1", text: "新条目", sectionId: "sec-x", done: false, createdAt: 2 },
        { id: "new-2", text: "孤儿", sectionId: "ghost", done: false, createdAt: 3 },
      ],
    });
    expect(added.notes).toBe(2);
    const state = useNotesStore.getState();
    expect(state.notes).toHaveLength(3);
    expect(state.sections.map((x) => x.name)).toEqual(["收件箱", "外部组"]);
    expect(state.notes.find((n) => n.id === "new-2")?.sectionId).toBe(INBOX_ID);
    expect(state.notes.find((n) => n.id === localId)?.text).toBe("本地已有");
  });
});

describe("链接卡片：updateNoteText 升降级与 setLinkMeta", () => {
  beforeEach(reset);

  it("捕获/输入纯 URL 自动成为链接卡", () => {
    const { id } = useNotesStore.getState().addNote("https://a.com/docs");
    const n = useNotesStore.getState().notes.find((x) => x.id === id)!;
    expect(n.kind).toBe("link");
    expect(n.url).toBe("https://a.com/docs");
  });

  it("编辑成另一个 URL：保持链接卡并清掉旧简介待重抓", () => {
    const { id } = useNotesStore.getState().addNote("https://a.com/1");
    useNotesStore.getState().setLinkMeta(id!, { title: "旧标题", icon: "https://a.com/f.ico" });
    useNotesStore.getState().updateNoteText(id!, "https://b.com/2");
    const n = useNotesStore.getState().notes.find((x) => x.id === id)!;
    expect(n.kind).toBe("link");
    expect(n.url).toBe("https://b.com/2");
    expect(n.linkTitle).toBeUndefined();
    expect(n.linkIcon).toBeUndefined();
  });

  it("链接卡编辑成普通文本：降级为文本卡", () => {
    const { id } = useNotesStore.getState().addNote("https://a.com/1");
    useNotesStore.getState().setLinkMeta(id!, { title: "标题" });
    useNotesStore.getState().updateNoteText(id!, "只是普通笔记");
    const n = useNotesStore.getState().notes.find((x) => x.id === id)!;
    expect(n.kind).toBe("text");
    expect(n.url).toBeUndefined();
    expect(n.linkTitle).toBeUndefined();
  });

  it("文本卡编辑成 URL：升级为链接卡", () => {
    const { id } = useNotesStore.getState().addNote("普通文本");
    useNotesStore.getState().updateNoteText(id!, "https://c.com/x");
    const n = useNotesStore.getState().notes.find((x) => x.id === id)!;
    expect(n.kind).toBe("link");
    expect(n.url).toBe("https://c.com/x");
  });

  it("setLinkMeta 只作用于链接卡且 URL 未变时生效", () => {
    const { id } = useNotesStore.getState().addNote("普通文本");
    useNotesStore.getState().setLinkMeta(id!, { title: "不应写入" });
    expect(
      useNotesStore.getState().notes.find((x) => x.id === id)!.linkTitle
    ).toBeUndefined();
  });
});

describe("发送后保留：doneIdsAfterSend", () => {
  beforeEach(reset);

  it("普通卡发送后进入完成列表", () => {
    const { id } = useNotesStore.getState().addNote("普通内容");
    expect(doneIdsAfterSend(useNotesStore.getState(), [id!])).toEqual([id]);
  });

  it("「常用」卡发送后不标完成", () => {
    const a = useNotesStore.getState().addNote("常用 Prompt").id!;
    const b = useNotesStore.getState().addNote("一次性内容").id!;
    useNotesStore.getState().toggleNoteKeep(a);
    expect(doneIdsAfterSend(useNotesStore.getState(), [a, b])).toEqual([b]);
    // 再次切换恢复常规行为
    useNotesStore.getState().toggleNoteKeep(a);
    expect(doneIdsAfterSend(useNotesStore.getState(), [a, b]).sort()).toEqual(
      [a, b].sort()
    );
  });

  it("「发送后保留」分组内的卡不标完成", () => {
    useNotesStore.getState().toggleSectionKeep(INBOX_ID);
    const a = useNotesStore.getState().addNote("Prompt 库内容").id!;
    expect(doneIdsAfterSend(useNotesStore.getState(), [a])).toEqual([]);
  });
});

describe("剪贴板历史 addClipNote", () => {
  beforeEach(reset);

  it("首次收集自动建「剪贴板」组并插在收件箱之后", () => {
    useNotesStore.getState().addClipNote("copied");
    const sections = useNotesStore.getState().sections;
    expect(sections.map((s) => s.id)).toEqual([INBOX_ID, CLIPBOARD_ID]);
    expect(useNotesStore.getState().notes[0].sectionId).toBe(CLIPBOARD_ID);
  });

  it("重复文本静默跳过不新建", () => {
    useNotesStore.getState().addClipNote("same");
    useNotesStore.getState().addClipNote("same");
    expect(useNotesStore.getState().notes).toHaveLength(1);
  });

  it("去重只在域内：剪贴板有同文本仍可捕获为笔记，反之亦然", () => {
    // 剪贴板先收集了某段文字 → 用户双击捕获同文本，应入库为笔记而非误报重复
    useNotesStore.getState().addClipNote("跨域文本");
    const captured = useNotesStore.getState().addNote("跨域文本");
    expect(captured.result).toBe("added");
    // 反向：笔记里已有的内容复制时，剪贴板历史照常记录
    useNotesStore.getState().addNote("先是笔记");
    useNotesStore.getState().addClipNote("先是笔记");
    const clips = useNotesStore
      .getState()
      .notes.filter((n) => n.sectionId === CLIPBOARD_ID)
      .map((n) => n.text);
    expect(clips.sort()).toEqual(["先是笔记", "跨域文本"]);
  });
});

describe("任务：CRUD / 撤销 / 转换原子性 / 导入", () => {
  beforeEach(reset);

  it("addTask 去空白、空串 empty、默认 todo/none/无到期", () => {
    expect(useNotesStore.getState().addTask("   ").result).toBe("empty");
    const { result, id } = useNotesStore.getState().addTask("  写周报  ");
    expect(result).toBe("added");
    const t = useNotesStore.getState().tasks.find((x) => x.id === id)!;
    expect(t.text).toBe("写周报");
    expect(t.status).toBe("todo");
    expect(t.priority).toBe("none");
    expect(t.dueAt).toBeNull();
    expect(t.remindedAt).toBeNull();
  });

  it("addTask 不去重（与 addNote 的刻意差异）", () => {
    useNotesStore.getState().addTask("回复邮件");
    useNotesStore.getState().addTask("回复邮件");
    expect(useNotesStore.getState().tasks).toHaveLength(2);
  });

  it("cycleTaskStatus 三态循环；toggleTaskDone 二态直切", () => {
    const id = useNotesStore.getState().addTask("任务").id!;
    const st = () => useNotesStore.getState().tasks[0].status;
    useNotesStore.getState().cycleTaskStatus(id);
    expect(st()).toBe("doing");
    useNotesStore.getState().cycleTaskStatus(id);
    expect(st()).toBe("done");
    useNotesStore.getState().cycleTaskStatus(id);
    expect(st()).toBe("todo");
    // doing 状态下 toggle 直达 done（跳过中间态），再 toggle 回 todo
    useNotesStore.getState().cycleTaskStatus(id);
    expect(st()).toBe("doing");
    useNotesStore.getState().toggleTaskDone(id);
    expect(st()).toBe("done");
    useNotesStore.getState().toggleTaskDone(id);
    expect(st()).toBe("todo");
  });

  it("setTaskDue 变更会清空 remindedAt", () => {
    const id = useNotesStore.getState().addTask("任务").id!;
    useNotesStore.getState().setTaskDue(id, 1000);
    useNotesStore.getState().markTasksReminded([id]);
    expect(useNotesStore.getState().tasks[0].remindedAt).not.toBeNull();
    useNotesStore.getState().setTaskDue(id, 2000);
    expect(useNotesStore.getState().tasks[0].remindedAt).toBeNull();
  });

  it("deleteTasks / clearDoneTasks 可撤销", () => {
    const a = useNotesStore.getState().addTask("A").id!;
    useNotesStore.getState().addTask("B");
    useNotesStore.getState().deleteTasks([a]);
    expect(useNotesStore.getState().tasks).toHaveLength(1);
    useNotesStore.getState().undo();
    expect(useNotesStore.getState().tasks).toHaveLength(2);
    useNotesStore.getState().toggleTaskDone(a);
    expect(useNotesStore.getState().clearDoneTasks()).toBe(1);
    expect(useNotesStore.getState().tasks).toHaveLength(1);
    useNotesStore.getState().undo();
    expect(useNotesStore.getState().tasks).toHaveLength(2);
  });

  it("convertNoteToTask：原子转换，一次 undo 同时恢复笔记并移除任务", () => {
    const noteId = useNotesStore.getState().addNote("变成待办的笔记").id!;
    expect(useNotesStore.getState().convertNoteToTask(noteId)).toBe(true);
    expect(useNotesStore.getState().notes).toHaveLength(0);
    expect(useNotesStore.getState().tasks).toHaveLength(1);
    expect(useNotesStore.getState().tasks[0].text).toBe("变成待办的笔记");
    useNotesStore.getState().undo();
    expect(useNotesStore.getState().notes).toHaveLength(1);
    expect(useNotesStore.getState().tasks).toHaveLength(0);
  });

  it("convertNoteToTask：图片卡拒绝且无副作用", () => {
    const imgId = useNotesStore
      .getState()
      .addNote("图片 100×100", { kind: "image", imageFile: "a.png" }).id!;
    expect(useNotesStore.getState().convertNoteToTask(imgId)).toBe(false);
    expect(useNotesStore.getState().notes).toHaveLength(1);
    expect(useNotesStore.getState().tasks).toHaveLength(0);
  });

  it("importMerge 合并 tasks：按 id 去重并计数", () => {
    const kept = useNotesStore.getState().addTask("本地任务").id!;
    const r = useNotesStore.getState().importMerge({
      tasks: [
        {
          id: kept,
          text: "重复导入应跳过",
          status: "todo",
          priority: "none",
          dueAt: null,
          createdAt: 1,
          remindedAt: null,
        },
        {
          id: "t-new",
          text: "外部任务",
          status: "doing",
          priority: "high",
          dueAt: null,
          createdAt: 2,
          remindedAt: null,
        },
      ],
    });
    expect(r).toEqual({ notes: 0, tasks: 1 });
    expect(useNotesStore.getState().tasks).toHaveLength(2);
    expect(useNotesStore.getState().tasks.find((t) => t.id === kept)?.text).toBe(
      "本地任务"
    );
  });
});

describe("任务：备注与检查列表", () => {
  beforeEach(reset);

  it("updateTaskNote 设置与清除（空串 = 清除）", () => {
    const id = useNotesStore.getState().addTask("任务").id!;
    useNotesStore.getState().updateTaskNote(id, "  一些备注  ");
    expect(useNotesStore.getState().tasks[0].note).toBe("一些备注");
    useNotesStore.getState().updateTaskNote(id, "   ");
    expect(useNotesStore.getState().tasks[0].note).toBeUndefined();
  });

  it("addChecklistItem 追加、忽略空白", () => {
    const id = useNotesStore.getState().addTask("任务").id!;
    useNotesStore.getState().addChecklistItem(id, "  子项A ");
    useNotesStore.getState().addChecklistItem(id, "   ");
    useNotesStore.getState().addChecklistItem(id, "子项B");
    const list = useNotesStore.getState().tasks[0].checklist!;
    expect(list.map((c) => c.text)).toEqual(["子项A", "子项B"]);
    expect(list.every((c) => !c.done)).toBe(true);
  });

  it("toggleChecklistItem 勾选/取消", () => {
    const id = useNotesStore.getState().addTask("任务").id!;
    useNotesStore.getState().addChecklistItem(id, "子项");
    const itemId = useNotesStore.getState().tasks[0].checklist![0].id;
    useNotesStore.getState().toggleChecklistItem(id, itemId);
    expect(useNotesStore.getState().tasks[0].checklist![0].done).toBe(true);
    useNotesStore.getState().toggleChecklistItem(id, itemId);
    expect(useNotesStore.getState().tasks[0].checklist![0].done).toBe(false);
  });

  it("updateChecklistItem 改文本；清空文本即删除该项", () => {
    const id = useNotesStore.getState().addTask("任务").id!;
    useNotesStore.getState().addChecklistItem(id, "旧文本");
    const itemId = useNotesStore.getState().tasks[0].checklist![0].id;
    useNotesStore.getState().updateChecklistItem(id, itemId, "新文本");
    expect(useNotesStore.getState().tasks[0].checklist![0].text).toBe("新文本");
    useNotesStore.getState().updateChecklistItem(id, itemId, "   ");
    expect(useNotesStore.getState().tasks[0].checklist).toHaveLength(0);
  });

  it("deleteChecklistItem 删除指定项", () => {
    const id = useNotesStore.getState().addTask("任务").id!;
    useNotesStore.getState().addChecklistItem(id, "A");
    useNotesStore.getState().addChecklistItem(id, "B");
    const first = useNotesStore.getState().tasks[0].checklist![0].id;
    useNotesStore.getState().deleteChecklistItem(id, first);
    expect(useNotesStore.getState().tasks[0].checklist!.map((c) => c.text)).toEqual([
      "B",
    ]);
  });

  it("删除任务后撤销可恢复备注与检查列表", () => {
    const id = useNotesStore.getState().addTask("任务").id!;
    useNotesStore.getState().updateTaskNote(id, "备注");
    useNotesStore.getState().addChecklistItem(id, "子项");
    useNotesStore.getState().deleteTasks([id]);
    expect(useNotesStore.getState().tasks).toHaveLength(0);
    useNotesStore.getState().undo();
    const t = useNotesStore.getState().tasks[0];
    expect(t.note).toBe("备注");
    expect(t.checklist!.map((c) => c.text)).toEqual(["子项"]);
  });
});

describe("任务：闪念与分组", () => {
  beforeEach(reset);

  it("addTask 支持 spark 类型；sparkToTask 转正式待办", () => {
    const id = useNotesStore.getState().addTask("一个灵感", { kind: "spark" }).id!;
    expect(useNotesStore.getState().tasks[0].kind).toBe("spark");
    useNotesStore.getState().sparkToTask(id);
    const t = useNotesStore.getState().tasks[0];
    expect(t.kind).toBeUndefined();
    expect(t.status).toBe("todo");
  });

  it("addTask 指定分组；未知分组回落收集箱", () => {
    useNotesStore.getState().addTaskSection("工作");
    const g = useNotesStore.getState().taskSections[1];
    const a = useNotesStore.getState().addTask("入组", { sectionId: g.id }).id!;
    const b = useNotesStore.getState().addTask("孤儿", { sectionId: "ghost" }).id!;
    expect(useNotesStore.getState().tasks.find((t) => t.id === a)?.sectionId).toBe(g.id);
    expect(
      useNotesStore.getState().tasks.find((t) => t.id === b)?.sectionId
    ).toBeUndefined();
  });

  it("moveTasksToSection 移动；移回收集箱归一为 undefined", () => {
    useNotesStore.getState().addTaskSection("工作");
    const g = useNotesStore.getState().taskSections[1];
    const id = useNotesStore.getState().addTask("任务").id!;
    useNotesStore.getState().moveTasksToSection([id], g.id);
    expect(useNotesStore.getState().tasks[0].sectionId).toBe(g.id);
    useNotesStore.getState().moveTasksToSection([id], TASK_INBOX_ID);
    expect(useNotesStore.getState().tasks[0].sectionId).toBeUndefined();
  });

  it("deleteTaskSection：组内任务归收集箱、收集箱不可删、可撤销", () => {
    useNotesStore.getState().addTaskSection("临时");
    const g = useNotesStore.getState().taskSections[1];
    const id = useNotesStore.getState().addTask("组内", { sectionId: g.id }).id!;
    useNotesStore.getState().deleteTaskSection(g.id);
    expect(useNotesStore.getState().taskSections).toHaveLength(1);
    expect(useNotesStore.getState().tasks[0].sectionId).toBeUndefined();
    useNotesStore.getState().undo();
    expect(useNotesStore.getState().taskSections).toHaveLength(2);
    expect(useNotesStore.getState().tasks.find((t) => t.id === id)?.sectionId).toBe(
      g.id
    );
    useNotesStore.getState().deleteTaskSection(TASK_INBOX_ID);
    expect(
      useNotesStore.getState().taskSections.some((s) => s.id === TASK_INBOX_ID)
    ).toBe(true);
  });

  it("importMerge：taskSections 合并、任务孤儿分组兜底收集箱", () => {
    const r = useNotesStore.getState().importMerge({
      taskSections: [{ id: "ext-g", name: "外部组" }],
      tasks: [
        {
          id: "t1",
          text: "带组",
          status: "todo",
          priority: "none",
          dueAt: null,
          createdAt: 1,
          remindedAt: null,
          sectionId: "ext-g",
        },
        {
          id: "t2",
          text: "孤儿组",
          status: "todo",
          priority: "none",
          dueAt: null,
          createdAt: 2,
          remindedAt: null,
          sectionId: "nowhere",
        },
      ],
    });
    expect(r.tasks).toBe(2);
    const st = useNotesStore.getState();
    expect(st.taskSections.map((s) => s.id)).toEqual([TASK_INBOX_ID, "ext-g"]);
    expect(st.tasks.find((t) => t.id === "t1")?.sectionId).toBe("ext-g");
    expect(st.tasks.find((t) => t.id === "t2")?.sectionId).toBeUndefined();
  });
});

describe("剪贴板 tab：发送不标完成 / 清空 / 超龄清理", () => {
  beforeEach(reset);

  function addClip(text: string, createdAt?: number) {
    const id = useNotesStore.getState().addNote(text).id!;
    useNotesStore.setState({
      notes: useNotesStore.getState().notes.map((n) =>
        n.id === id
          ? { ...n, sectionId: CLIPBOARD_ID, ...(createdAt ? { createdAt } : {}) }
          : n
      ),
    });
    return id;
  }

  it("doneIdsAfterSend 排除剪贴板卡（历史流水无完成语义）", () => {
    const clip = addClip("剪贴板内容");
    const normal = useNotesStore.getState().addNote("普通笔记").id!;
    expect(doneIdsAfterSend(useNotesStore.getState(), [clip, normal])).toEqual([
      normal,
    ]);
  });

  it("clearClipHistory 清空非固定卡且可撤销", () => {
    const a = addClip("A");
    addClip("B");
    useNotesStore.getState().toggleNoteKeep(a); // 固定 A
    const r = useNotesStore.getState().clearClipHistory();
    expect(r.removed).toBe(1);
    expect(
      useNotesStore.getState().notes.filter((n) => n.sectionId === CLIPBOARD_ID)
    ).toHaveLength(1);
    useNotesStore.getState().undo();
    expect(
      useNotesStore.getState().notes.filter((n) => n.sectionId === CLIPBOARD_ID)
    ).toHaveLength(2);
  });

  it("pruneClipHistory 按保留时长清理超龄非固定卡；永久不清", () => {
    const old = addClip("过期", Date.now() - 10 * 86_400_000);
    const fresh = addClip("新鲜");
    const pinnedOld = addClip("固定过期", Date.now() - 10 * 86_400_000);
    useNotesStore.getState().toggleNoteKeep(pinnedOld);
    // 永久：不清
    useNotesStore.getState().setSettings({ clipRetentionDays: null });
    useNotesStore.getState().pruneClipHistory();
    expect(
      useNotesStore.getState().notes.filter((n) => n.sectionId === CLIPBOARD_ID)
    ).toHaveLength(3);
    // 7 天：只清超龄且未固定的
    useNotesStore.getState().setSettings({ clipRetentionDays: 7 });
    useNotesStore.getState().pruneClipHistory();
    const rest = useNotesStore
      .getState()
      .notes.filter((n) => n.sectionId === CLIPBOARD_ID)
      .map((n) => n.id)
      .sort();
    expect(rest).toEqual([fresh, pinnedOld].sort());
    expect(rest).not.toContain(old);
  });
});
