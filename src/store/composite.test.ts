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
  defaultSettings,
  INBOX_ID,
  noteImages,
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

describe("图文组合卡片", () => {
  beforeEach(reset);

  it("不同图片各自入库（按文件名去重，不误伤）", () => {
    const s = useNotesStore.getState();
    expect(
      s.addNote("图片 1×1", { kind: "image", imageFile: "a.png" }).result
    ).toBe("added");
    expect(
      useNotesStore
        .getState()
        .addNote("图片 2×2", { kind: "image", imageFile: "b.png" }).result
    ).toBe("added");
    expect(useNotesStore.getState().notes).toHaveLength(2);
  });

  it("同一图片文件重复捕获判定为 duplicate", () => {
    useNotesStore
      .getState()
      .addNote("图片 1×1", { kind: "image", imageFile: "a.png" });
    const again = useNotesStore
      .getState()
      .addNote("图片 1×1", { kind: "image", imageFile: "a.png" });
    expect(again.result).toBe("duplicate");
  });

  it("文字+图片合并为一张组合卡：文字成正文、图片进附件", () => {
    const s = useNotesStore.getState();
    const img = s.addNote("图片 100×50", {
      kind: "image",
      imageFile: "img-aaa.png",
      imageW: 100,
      imageH: 50,
    });
    const t1 = useNotesStore.getState().addNote("背景与目标");
    useNotesStore.getState().mergeNotes([t1.id!, img.id!]);
    const notes = useNotesStore.getState().notes;
    expect(notes).toHaveLength(1);
    const m = notes[0];
    expect(m.kind).toBe("text");
    expect(m.text).toBe("背景与目标");
    expect(noteImages(m)).toEqual(["img-aaa.png"]);
  });

  it("纯图片合并保持图片类型并聚齐附件", () => {
    const s = useNotesStore.getState();
    const a = s.addNote("图片 1×1", { kind: "image", imageFile: "a.png" });
    const b = useNotesStore
      .getState()
      .addNote("图片 2×2", { kind: "image", imageFile: "b.png" });
    useNotesStore.getState().mergeNotes([b.id!, a.id!]);
    const notes = useNotesStore.getState().notes;
    expect(notes).toHaveLength(1);
    expect(notes[0].kind).toBe("image");
    expect(noteImages(notes[0]).sort()).toEqual(["a.png", "b.png"]);
  });

  it("组合卡再与新卡合并时附件不丢失", () => {
    const s = useNotesStore.getState();
    const a = s.addNote("图片 1×1", { kind: "image", imageFile: "a.png" });
    const t = useNotesStore.getState().addNote("说明文字");
    useNotesStore.getState().mergeNotes([t.id!, a.id!]);
    const combo = useNotesStore.getState().notes[0];
    const b = useNotesStore
      .getState()
      .addNote("图片 2×2", { kind: "image", imageFile: "b.png" });
    useNotesStore.getState().mergeNotes([combo.id, b.id!]);
    const final = useNotesStore.getState().notes;
    expect(final).toHaveLength(1);
    expect(noteImages(final[0]).sort()).toEqual(["a.png", "b.png"]);
    expect(final[0].text).toBe("说明文字");
  });
});
