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
    tasks: [],
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

describe("图片卡文字备注参与合并", () => {
  beforeEach(reset);

  it("真实备注并入正文，占位符不参与；图片全部聚齐", () => {
    const s = useNotesStore.getState();
    const img1 = s.addNote("现场截图说明", { kind: "image", imageFile: "a.png" });
    const img2 = useNotesStore
      .getState()
      .addNote("图片 2×2", { kind: "image", imageFile: "b.png" });
    const t1 = useNotesStore.getState().addNote("背景与目标");
    useNotesStore.getState().mergeNotes([t1.id!, img1.id!, img2.id!]);
    const notes = useNotesStore.getState().notes;
    expect(notes).toHaveLength(1);
    const m = notes[0];
    // 合并按捕获先后：先捕获的图片备注在前，后写的文字卡跟随；
    // 占位符「图片 2×2」被剔除
    expect(m.text).toBe("现场截图说明\n\n背景与目标");
    expect(m.kind).toBe("text");
    expect(noteImages(m).sort()).toEqual(["a.png", "b.png"]);
  });

  it("两张带备注的图合并：备注拼接、卡为组合文字卡", () => {
    const s = useNotesStore.getState();
    const a = s.addNote("第一张说明", { kind: "image", imageFile: "a.png" });
    const b = useNotesStore
      .getState()
      .addNote("第二张说明", { kind: "image", imageFile: "b.png" });
    useNotesStore.getState().mergeNotes([a.id!, b.id!]);
    const m = useNotesStore.getState().notes[0];
    expect(m.text).toBe("第一张说明\n\n第二张说明");
    expect(m.kind).toBe("text");
    expect(noteImages(m).sort()).toEqual(["a.png", "b.png"]);
  });
});

describe("组合卡移除单张图片", () => {
  beforeEach(reset);

  it("移除附件：剩余图顺次补位，主图不变", () => {
    const s = useNotesStore.getState();
    const a = s.addNote("第一张", { kind: "image", imageFile: "a.png" });
    const b = useNotesStore
      .getState()
      .addNote("第二张", { kind: "image", imageFile: "b.png" });
    const c = useNotesStore
      .getState()
      .addNote("第三张", { kind: "image", imageFile: "c.png" });
    useNotesStore.getState().mergeNotes([a.id!, b.id!, c.id!]);
    const merged = useNotesStore.getState().notes[0];
    const main = merged.imageFile!;
    const victim = noteImages(merged).find((f) => f !== main)!;

    const r = useNotesStore.getState().removeNoteImage(merged.id, victim);
    expect(r.noteDeleted).toBe(false);
    const after = useNotesStore.getState().notes[0];
    expect(noteImages(after)).toHaveLength(2);
    expect(noteImages(after)).not.toContain(victim);
    expect(after.imageFile).toBe(main);
  });

  it("移除主图：附件顶上成为新主图，旧宽高失效", () => {
    const s = useNotesStore.getState();
    const a = s.addNote("图片 10×10", {
      kind: "image",
      imageFile: "a.png",
      imageW: 10,
      imageH: 10,
    });
    const b = useNotesStore
      .getState()
      .addNote("图片 20×20", { kind: "image", imageFile: "b.png" });
    useNotesStore.getState().mergeNotes([a.id!, b.id!]);
    const merged = useNotesStore.getState().notes[0];
    useNotesStore.getState().removeNoteImage(merged.id, merged.imageFile!);
    const after = useNotesStore.getState().notes[0];
    expect(noteImages(after)).toHaveLength(1);
    expect(after.imageW).toBeUndefined();
    expect(after.imageH).toBeUndefined();
  });

  it("移除最后一张：有文字 → 退化为纯文本卡", () => {
    const s = useNotesStore.getState();
    const img = s.addNote("图片 1×1", { kind: "image", imageFile: "a.png" });
    const t = useNotesStore.getState().addNote("说明文字");
    useNotesStore.getState().mergeNotes([t.id!, img.id!]);
    const merged = useNotesStore.getState().notes[0];
    const r = useNotesStore.getState().removeNoteImage(merged.id, "a.png");
    expect(r.noteDeleted).toBe(false);
    const after = useNotesStore.getState().notes[0];
    expect(after.kind).toBe("text");
    expect(noteImages(after)).toEqual([]);
    expect(after.text).toBe("说明文字");
  });

  it("移除最后一张：只有占位文字 → 整张卡删除", () => {
    const s = useNotesStore.getState();
    const img = s.addNote("图片 1×1", { kind: "image", imageFile: "a.png" });
    const r = useNotesStore.getState().removeNoteImage(img.id!, "a.png");
    expect(r.noteDeleted).toBe(true);
    expect(useNotesStore.getState().notes).toHaveLength(0);
  });

  it("撤销可还原被移除的图片", () => {
    const s = useNotesStore.getState();
    const a = s.addNote("第一张", { kind: "image", imageFile: "a.png" });
    const b = useNotesStore
      .getState()
      .addNote("第二张", { kind: "image", imageFile: "b.png" });
    useNotesStore.getState().mergeNotes([a.id!, b.id!]);
    const merged = useNotesStore.getState().notes[0];
    useNotesStore.getState().removeNoteImage(merged.id, "a.png");
    expect(noteImages(useNotesStore.getState().notes[0])).toHaveLength(1);
    useNotesStore.getState().undo();
    expect(noteImages(useNotesStore.getState().notes[0]).sort()).toEqual([
      "a.png",
      "b.png",
    ]);
  });

  it("不属于该卡的文件名是安全空操作", () => {
    const s = useNotesStore.getState();
    const img = s.addNote("图片 1×1", { kind: "image", imageFile: "a.png" });
    const r = useNotesStore.getState().removeNoteImage(img.id!, "zzz.png");
    expect(r.noteDeleted).toBe(false);
    expect(useNotesStore.getState().notes).toHaveLength(1);
  });
});
