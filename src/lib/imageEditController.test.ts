import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  emitTo: vi.fn(async () => undefined),
  redact: vi.fn(),
  manualRedact: vi.fn(),
  release: vi.fn(),
  matchesGeneration: vi.fn(() => true),
  dataLocked: vi.fn(() => false),
  replaceNoteImage: vi.fn((
    _id: string,
    _sourceFile: string,
    _edited: { file: string; width: number; height: number },
    _options?: { snapshot?: boolean }
  ) => true),
  updateNoteContent: vi.fn((
    _id: string,
    _blocks: Array<Record<string, unknown>>
  ) => undefined),
  setDraftImages: vi.fn(),
  tip: vi.fn(),
  pendingUndo: null as (() => void) | null,
  notesState: {
    notes: [] as Array<Record<string, unknown>>,
  },
  uiState: {
    draftImages: [] as Array<Record<string, unknown>>,
  },
}));

vi.mock("@tauri-apps/api/event", () => ({ emitTo: mocks.emitTo }));
vi.mock("@/lib/dataGeneration", () => ({
  beginDataGenerationLease: () => ({ generation: 7, release: mocks.release }),
  matchesDataGeneration: mocks.matchesGeneration,
}));
vi.mock("@/lib/delivery/imageFirewall", () => ({
  manuallyRedactOpenDeliveryImage: mocks.manualRedact,
}));
vi.mock("@/lib/tauri", () => ({
  api: { redactDeliveryImage: mocks.redact },
}));
vi.mock("@/lib/tip", () => ({
  setPendingUndo: (undo: () => void) => { mocks.pendingUndo = undo; },
  tip: mocks.tip,
}));
vi.mock("@/store/dataOperationStore", () => ({
  isDataOperationLocked: mocks.dataLocked,
}));
vi.mock("@/store/notesStore", () => ({
  noteImages: (note: { images?: string[] }) => note.images ?? [],
  noteContentBlocks: (note: { blocks?: unknown[] }) => note.blocks ?? [],
  useNotesStore: {
    getState: () => ({
      notes: mocks.notesState.notes,
      replaceNoteImage: mocks.replaceNoteImage,
      updateNoteContent: mocks.updateNoteContent,
    }),
  },
}));
vi.mock("@/store/uiStore", () => ({
  useUIStore: {
    getState: () => ({
      draftImages: mocks.uiState.draftImages,
      setDraftImages: mocks.setDraftImages,
    }),
  },
}));

import {
  applyImageEditRequest,
  cancelImageEditRequest,
} from "./imageEditController";

const nativeResult = {
  originalFile: "source.png",
  redactedFile: "img-edited.png",
  originalPixelHash: "a".repeat(64),
  redactedPixelHash: "b".repeat(64),
  imageWidth: 120,
  imageHeight: 80,
};

describe("图片编辑 owner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pendingUndo = null;
    mocks.notesState.notes = [];
    mocks.uiState.draftImages = [];
    mocks.matchesGeneration.mockReturnValue(true);
    mocks.dataLocked.mockReturnValue(false);
    mocks.replaceNoteImage.mockImplementation((id, sourceFile, edited) => {
      const note = mocks.notesState.notes.find((entry) => entry.id === id);
      if (!note || !(note.images as string[] | undefined)?.includes(sourceFile)) {
        return false;
      }
      note.images = (note.images as string[]).map((file) =>
        file === sourceFile ? edited.file : file
      );
      note.blocks = (note.blocks as Array<Record<string, unknown>> | undefined)?.map(
        (block) => block.type === "image" && block.file === sourceFile
          ? { ...block, ...edited }
          : block
      );
      return true;
    });
    mocks.updateNoteContent.mockImplementation((id, blocks) => {
      const note = mocks.notesState.notes.find((entry) => entry.id === id);
      if (!note) return;
      note.blocks = blocks;
      note.images = (blocks as Array<Record<string, unknown>>).flatMap((block) =>
        block.type === "image" && typeof block.file === "string" ? [block.file] : []
      );
    });
    mocks.redact.mockResolvedValue(nativeResult);
    mocks.setDraftImages.mockImplementation((images) => {
      mocks.uiState.draftImages = images;
    });
  });

  it("卡片打码持久化新文件，并在 HUD 撤销时向详情与图片窗反向同步", async () => {
    mocks.notesState.notes = [{
      id: "note-1",
      images: ["source.png"],
      blocks: [
        { type: "text", text: "提交前正文" },
        {
          type: "image",
          file: "source.png",
          width: 60,
          height: 40,
        },
      ],
    }];
    const scheduleGc = vi.fn();

    const result = await applyImageEditRequest({
      requestId: "request-note",
      target: { kind: "note", noteId: "note-1", dataGeneration: 7 },
      sourceFile: "source.png",
      regions: [{ x: 2, y: 3, width: 20, height: 10 }],
    }, scheduleGc);

    expect(result).toMatchObject({ ok: true, editedFile: "img-edited.png" });
    expect(mocks.redact).toHaveBeenCalledWith(
      "source.png",
      [{ x: 2, y: 3, width: 20, height: 10 }],
      true
    );
    expect(mocks.replaceNoteImage).toHaveBeenCalledWith("note-1", "source.png", {
      file: "img-edited.png",
      width: 120,
      height: 80,
    }, { snapshot: false });
    expect(scheduleGc).toHaveBeenCalledWith(["source.png"]);
    expect(mocks.emitTo).toHaveBeenCalledWith(
      "textpreview",
      "toskr://note-image-replaced",
      expect.objectContaining({
        operationId: "request-note",
        direction: "forward",
        sourceFile: "source.png",
        editedFile: "img-edited.png",
      })
    );

    expect(mocks.pendingUndo).toBeTypeOf("function");
    (mocks.notesState.notes[0]!.blocks as Array<Record<string, unknown>>)[0] = {
      type: "text",
      text: "提交后继续编辑的正文",
    };
    mocks.pendingUndo!();
    expect(mocks.updateNoteContent).toHaveBeenCalledWith("note-1", [
      { type: "text", text: "提交后继续编辑的正文" },
      { type: "image", file: "source.png", width: 60, height: 40 },
    ]);
    expect(mocks.emitTo).toHaveBeenCalledWith(
      "imgpreview",
      "toskr://note-image-replaced",
      expect.objectContaining({
        operationId: "request-note",
        direction: "undo",
        sourceFile: "img-edited.png",
        editedFile: "source.png",
        width: 60,
        height: 40,
      })
    );
  });

  it("草稿图片只替换当前数据代际的精确来源，并把 HUD 撤销同步给图片窗", async () => {
    mocks.uiState.draftImages = [{
      file: "source.png",
      width: 60,
      height: 40,
      dataGeneration: 7,
    }];
    const scheduleGc = vi.fn();

    const result = await applyImageEditRequest({
      requestId: "request-draft",
      target: { kind: "draft", dataGeneration: 7 },
      sourceFile: "source.png",
      regions: [{ x: 1, y: 1, width: 4, height: 4 }],
    }, scheduleGc);

    expect(result.ok).toBe(true);
    expect(mocks.uiState.draftImages).toEqual([{
      file: "img-edited.png",
      width: 120,
      height: 80,
      dataGeneration: 7,
    }]);
    expect(mocks.pendingUndo).toBeTypeOf("function");
    mocks.pendingUndo!();
    expect(mocks.uiState.draftImages).toEqual([{
      file: "source.png",
      width: 60,
      height: 40,
      dataGeneration: 7,
    }]);
    expect(mocks.emitTo).toHaveBeenCalledWith(
      "imgpreview",
      "toskr://draft-image-replaced",
      {
        operationId: "request-draft",
        direction: "undo",
        dataGeneration: 7,
        sourceFile: "img-edited.png",
        editedFile: "source.png",
        width: 60,
        height: 40,
      }
    );
  });

  it("发送预检沿用临时副本控制器，不落持久媒体", async () => {
    mocks.manualRedact.mockResolvedValue({
      file: "toskr-redacted:next.png",
      width: 120,
      height: 80,
      draftRevision: 5,
    });

    const result = await applyImageEditRequest({
      requestId: "request-delivery",
      target: {
        kind: "delivery",
        draftId: "draft-1",
        draftRevision: 4,
        originalFile: "source.png",
      },
      sourceFile: "toskr-redacted:current.png",
      regions: [{ x: 1, y: 1, width: 4, height: 4 }],
    }, vi.fn());

    expect(result).toMatchObject({
      ok: true,
      editedFile: "toskr-redacted:next.png",
      draftRevision: 5,
    });
    expect(mocks.redact).not.toHaveBeenCalled();
  });

  it("Native 处理中取消时回收结果且不替换卡片引用", async () => {
    mocks.notesState.notes = [{ id: "note-cancel", images: ["source.png"] }];
    let resolveNative!: (value: typeof nativeResult) => void;
    mocks.redact.mockReturnValue(new Promise((resolve) => {
      resolveNative = resolve;
    }));
    const scheduleGc = vi.fn();

    const pending = applyImageEditRequest({
      requestId: "request-cancel",
      target: { kind: "note", noteId: "note-cancel", dataGeneration: 7 },
      sourceFile: "source.png",
      regions: [{ x: 1, y: 1, width: 4, height: 4 }],
    }, scheduleGc);
    await vi.waitFor(() => expect(mocks.redact).toHaveBeenCalledOnce());
    cancelImageEditRequest("request-cancel");
    resolveNative(nativeResult);

    await expect(pending).resolves.toMatchObject({
      ok: false,
      message: "图片编辑已取消，结果未保存",
    });
    expect(mocks.replaceNoteImage).not.toHaveBeenCalled();
    expect(scheduleGc).toHaveBeenCalledWith(["img-edited.png"], 0);
  });

  it("畸形区域在获取写入租约前拒绝", async () => {
    const result = await applyImageEditRequest({
      requestId: "request-invalid",
      target: { kind: "draft", dataGeneration: 7 },
      sourceFile: "source.png",
      regions: [null as never],
    }, vi.fn());

    expect(result).toMatchObject({ ok: false, message: "图片编辑请求无效，请重试" });
    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.redact).not.toHaveBeenCalled();
  });
});
