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
  useNotesStore,
} from "./notesStore";

function reset() {
  useNotesStore.setState({
    sections: [{ id: INBOX_ID, name: "收件箱" }],
    notes: [],
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
    expect(added).toBe(2);
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

  it("超限从最旧裁剪，常用 ★ 卡不清理", () => {
    useNotesStore.setState({
      settings: { ...defaultSettings(), clipHistoryLimit: 2 },
    });
    useNotesStore.getState().addClipNote("a");
    const keepId = useNotesStore.getState().notes[0].id;
    useNotesStore.getState().toggleNoteKeep(keepId);
    useNotesStore.getState().addClipNote("b");
    useNotesStore.getState().addClipNote("c");
    useNotesStore.getState().addClipNote("d");
    const texts = useNotesStore
      .getState()
      .notes.filter((n) => n.sectionId === CLIPBOARD_ID)
      .map((n) => n.text);
    // 非 keep 只留最新 2 条（d/c），keep 的 a 幸存
    expect(texts.sort()).toEqual(["a", "c", "d"]);
  });

  it("裁剪返回不再被引用的图片文件名", () => {
    useNotesStore.setState({
      settings: { ...defaultSettings(), clipHistoryLimit: 1 },
    });
    useNotesStore
      .getState()
      .addClipNote("图片 1×1", { kind: "image", imageFile: "clip-a.png" });
    const removed = useNotesStore
      .getState()
      .addClipNote("图片 2×2", { kind: "image", imageFile: "clip-b.png" });
    expect(removed).toEqual(["clip-a.png"]);
  });
});
