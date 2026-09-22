import { describe, expect, it, vi } from "vitest";
import ts from "typescript";
import viewSource from "./TextPreviewView.tsx?raw";
import type { NotePreviewPayload } from "./lib/actions";
import { looksLikeMarkdown } from "./lib/markdown";
import { hasMixedNoteContent, normalizeNoteContentBlocks, textFromContentBlocks, type NoteContentBlock } from "./lib/noteContentBlocks";
import { previewIsEditable, refreshPreviewPayload } from "./lib/previewPayload";

// 执行组件中的真实保存/自动保存/标题事件处理器，保持与现有 IME 测试相同的无 DOM 测试方式。
function editorCode() {
  const source = ts.createSourceFile("editor.tsx", viewSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = ["sameFiles", "freshTextEditHistory", "revertAutosavedDraft", "cancelEditing", "save", "tick"];
  const declarations = new Map<string, string>();
  const handlers = new Map<string, string>();
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(source))) {
      declarations.set(node.name.getText(source), `const ${node.getText(source)};`);
    }
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === "input" &&
      node.attributes.properties.some((attr) => ts.isJsxAttribute(attr) && attr.name.getText(source) === "aria-label" && attr.initializer?.getText(source) === '"笔记标题"')) {
      for (const attr of node.attributes.properties) {
        if (ts.isJsxAttribute(attr) && attr.initializer && ts.isJsxExpression(attr.initializer) && attr.initializer.expression) {
          handlers.set(attr.name.getText(source), attr.initializer.expression.getText(source));
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const name of names) {
    if (!declarations.has(name)) throw new Error(`Missing editor declaration: ${name}`);
  }
  return ts.transpileModule(`${names.map((name) => declarations.get(name)).join("\n")}
    return { save, cancelEditing, tick, ${["onChange", "onCompositionStart", "onCompositionEnd", "onKeyDown"].map((name) => `${name}: ${handlers.get(name)}`).join(",")} };`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

const code = editorCode();

function editor(rich: boolean) {
  const blocks: NoteContentBlock[] = [
    { type: "text", text: "正文" },
    { type: "image", file: "inline.png" },
    { type: "text", text: "图后" },
  ];
  const note: NotePreviewPayload = {
    id: "note-1", sessionId: "session-1", dataGeneration: 1,
    text: rich ? "正文\n图后" : "正文", title: "原标题", kind: "text", codeLang: null,
    url: null, sourceApp: null, sourceBundle: null, edit: true,
    images: rich ? ["inline.png"] : [], contentBlocks: rich ? blocks : undefined,
  };
  const runtime = {
    noteRef: { current: note },
    autosaveSessionRef: { current: {
      origin: { text: note.text, title: note.title, images: note.images, blocks: rich ? blocks : null },
      persistedTitle: note.title,
      persistedText: note.text,
      persistedImages: note.images,
      persistedBlocksJson: rich ? JSON.stringify(blocks) : null,
    } },
    draftTitleRef: { current: note.title },
    draftRef: { current: note.text },
    draftImagesRef: { current: note.images },
    draftContentBlocksRef: { current: rich ? blocks : [] },
    titleComposingRef: { current: false },
    composingRef: { current: false },
    editSessionTokenRef: { current: 1 },
    sessionPastedImagesRef: { current: new Set<string>() },
    textEditHistoryRef: { current: {} },
    textareaRef: { current: { focus: vi.fn() } },
    setDraftTitle: vi.fn(), setDraftEmpty: vi.fn(), setNote: vi.fn(), setMdView: vi.fn(),
    setDraftContentBlocks: vi.fn(), setDraftImages: vi.fn(), setTextSelection: vi.fn(), setEditing: vi.fn(),
    releaseEditorSession: vi.fn(), discardDraftImages: vi.fn(), exitEditing: vi.fn(),
    emitTo: vi.fn().mockResolvedValue(undefined), tip: vi.fn(),
    previewIsEditable, hasMixedNoteContent, normalizeNoteContentBlocks, textFromContentBlocks,
    refreshPreviewPayload, looksLikeMarkdown,
  };
  const actions = new Function(...Object.keys(runtime), code)(...Object.values(runtime)) as {
    save: () => void; tick: () => void; cancelEditing: () => void;
    onChange: (event: unknown) => void; onKeyDown: (event: unknown) => void;
    onCompositionStart: () => void; onCompositionEnd: () => void;
  };
  return { actions, runtime };
}

describe.each([false, true])("详情标题保存（图文=%s）", (rich) => {
  it.each(["新标题", ""])("仅修改标题为 %j 仍写回并保留撤销来源", (title) => {
    const { actions, runtime } = editor(rich);
    actions.onChange({ target: { value: title } });
    actions.save();
    expect(runtime.emitTo).toHaveBeenCalledExactlyOnceWith("main", "toskr://note-edit", expect.objectContaining({
      format: rich ? "blocks" : "flat", title, origin: expect.objectContaining({ title: "原标题" }),
    }));
    expect(runtime.noteRef.current.title).toBe(title || null);
    expect(runtime.setEditing).toHaveBeenCalledWith(false);
  });

  it("自动保存标题后取消，还原标题", () => {
    const { actions, runtime } = editor(rich);
    actions.onChange({ target: { value: "  临时标题  " } });
    actions.tick();
    expect(runtime.emitTo).toHaveBeenLastCalledWith("main", "toskr://note-edit", expect.objectContaining({ title: "临时标题", autosave: true }));
    actions.tick();
    expect(runtime.emitTo).toHaveBeenCalledTimes(1);
    actions.cancelEditing();
    expect(runtime.emitTo).toHaveBeenLastCalledWith("main", "toskr://note-edit", expect.objectContaining({ title: "原标题", autosave: true }));
    expect(runtime.draftTitleRef.current).toBe("原标题");
    expect(runtime.setEditing).toHaveBeenCalledWith(false);
  });

  it("标题组合输入期间不自动保存，确认上屏后再保存", () => {
    const { actions, runtime } = editor(rich);
    actions.onCompositionStart();
    actions.onChange({ target: { value: "标题拼音" } });
    actions.tick();
    expect(runtime.emitTo).not.toHaveBeenCalled();
    actions.onCompositionEnd();
    actions.tick();
    expect(runtime.emitTo).toHaveBeenCalledWith("main", "toskr://note-edit", expect.objectContaining({ title: "标题拼音", autosave: true }));
  });
});

describe("标题键盘输入", () => {
  it.each(["Enter", "Escape"])("IME 的 %s 与 WebKit 延迟 keyCode 229 不保存或退出", (key) => {
    const { actions, runtime } = editor(false);
    actions.onChange({ target: { value: "新标题" } });
    const event = { key, metaKey: true, nativeEvent: { isComposing: false }, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    actions.onCompositionStart();
    actions.onKeyDown(event);
    actions.onCompositionEnd();
    actions.onKeyDown({ ...event, keyCode: 229 });
    actions.onKeyDown({ ...event, nativeEvent: { isComposing: true } });
    expect(runtime.emitTo).not.toHaveBeenCalled();
    expect(runtime.exitEditing).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("普通回车聚焦正文，Command+Enter 保存标题", () => {
    const { actions, runtime } = editor(false);
    actions.onChange({ target: { value: "新标题" } });
    const event = { key: "Enter", metaKey: false, nativeEvent: { isComposing: false }, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    actions.onKeyDown(event);
    expect(runtime.textareaRef.current.focus).toHaveBeenCalledOnce();
    expect(runtime.emitTo).not.toHaveBeenCalled();
    actions.onKeyDown({ ...event, metaKey: true });
    expect(runtime.emitTo).toHaveBeenCalledWith("main", "toskr://note-edit", expect.objectContaining({ title: "新标题" }));
  });
});
