import { describe, expect, it, vi } from "vitest";
import ts from "typescript";
import viewSource from "./TextPreviewView.tsx?raw";
import richSource from "./components/RichNoteContent.tsx?raw";

// 执行实际 textarea 事件处理器，重放 WebKit 的组合输入/选区事件顺序。
function handlerCode(text: string, syncName: string) {
const source = ts.createSourceFile("editor.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const handlers = new Map<string, string>();
let sync = "";
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === syncName) {
    sync = `const ${node.getText(source)};`;
  }
  if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(source) === "textarea") {
    for (const attr of node.attributes.properties) {
      if (ts.isJsxAttribute(attr) && attr.initializer && ts.isJsxExpression(attr.initializer) && attr.initializer.expression) {
        handlers.set(attr.name.getText(source), attr.initializer.expression.getText(source));
      }
    }
  }
  ts.forEachChild(node, visit);
}
visit(source);
const names = ["onCompositionStart", "onCompositionEnd", "onChange", "onSelect", "onPointerDown", "onKeyDown", "onScroll"];
return ts.transpileModule(`${sync}\nreturn {${names.filter((name) => handlers.has(name)).map((name) => `${name}: ${handlers.get(name)}`).join(",")}};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
}

function editor(rich = false) {
  const state = { selection: null as { start: number; end: number } | null };
  const textarea = { value: "消息外层miao bian", selectionStart: 4, selectionEnd: 13 };
  const runtime = {
    composingRef: { current: false },
    imeSelectionBlockedRef: { current: false },
    skipNextBeforeInputRef: { current: false },
    textEditHistoryRef: { current: { group: null } },
    draftImagesRef: { current: [] },
    draftRef: { current: textarea.value },
    setTextSelection: (selection: typeof state.selection) => { state.selection = selection; },
    onTextSelectionChange: (value: { selection: typeof state.selection } | null) => { state.selection = value?.selection ?? null; },
    onSelectionActiveChange: vi.fn(),
    setSelectedImageBlock: vi.fn(),
    onSave: vi.fn(),
    onCancel: vi.fn(),
    onChange: vi.fn(),
    replaceNoteTextBlockAt: vi.fn(),
    blocks: [],
    index: 0,
    setDraftEmpty: vi.fn(),
    checkpointTextEdit: vi.fn(),
    snapshotTextarea: vi.fn(),
    beginTextEditGroup: vi.fn(),
    window: { setTimeout: (callback: () => void) => { callback(); } },
    save: vi.fn(),
    exitEditing: vi.fn(),
  };
  const actions = new Function(...Object.keys(runtime), handlerCode(rich ? richSource : viewSource, rich ? "syncTextSelection" : "syncTextareaSelection"))(...Object.values(runtime)) as Record<string, (event?: unknown) => void>;
  const event = { currentTarget: textarea, target: textarea, nativeEvent: { isComposing: false }, key: "ArrowLeft", shiftKey: true, stopPropagation: vi.fn() };
  return { state, textarea, actions, event, runtime };
}

describe.each([false, true])("详情页输入法选区（图文=%s）", (rich) => {
  it("开始组合输入时收起已有工具栏选区", () => {
    const e = editor(rich);
    e.actions.onSelect(e.event);
    expect(e.state.selection).not.toBeNull();
    e.actions.onCompositionStart?.(e.event);
    expect(e.state.selection).toBeNull();
  });

  it("拼音组合期间的 change/select 不产生工具栏选区", () => {
    const e = editor(rich);
    e.actions.onCompositionStart?.(e.event);
    e.actions.onChange(e.event);
    expect(e.state.selection).toBeNull();
    e.actions.onSelect(e.event);
    expect(e.state.selection).toBeNull();
  });

  it("上屏后延迟到达的非折叠 select 仍不弹工具栏", () => {
    const e = editor(rich);
    e.actions.onCompositionStart?.(e.event);
    e.actions.onCompositionEnd?.(e.event);
    e.actions.onChange(e.event);
    e.actions.onSelect(e.event);
    expect(e.state.selection).toBeNull();
  });

  it("组合期间的点击、候选按键与滚动不恢复工具栏", () => {
    const e = editor(rich);
    e.actions.onCompositionStart?.(e.event);
    e.actions.onPointerDown(e.event);
    e.actions.onKeyDown({ ...e.event, key: "Escape" });
    e.actions.onSelect(e.event);
    e.actions.onScroll?.(e.event);
    expect(e.state.selection).toBeNull();
    expect(e.runtime.onCancel).not.toHaveBeenCalled();
    expect(e.runtime.exitEditing).not.toHaveBeenCalled();
    e.actions.onCompositionEnd?.(e.event);
    e.actions.onKeyDown({ ...e.event, keyCode: 229 });
    e.actions.onSelect(e.event);
    expect(e.state.selection).toBeNull();
    e.actions.onKeyDown({ ...e.event, nativeEvent: { isComposing: true } });
    e.actions.onSelect(e.event);
    expect(e.state.selection).toBeNull();
  });

  it.each(["onPointerDown", "onKeyDown"])("上屏后 %s 开始的真实选区恢复工具栏", (gesture) => {
    const e = editor(rich);
    e.actions.onCompositionStart?.(e.event);
    e.actions.onCompositionEnd?.(e.event);
    e.actions[gesture](e.event);
    e.actions.onSelect(e.event);
    expect(e.state.selection).toEqual({ start: 4, end: 13 });
    e.textarea.selectionEnd = 4;
    e.actions.onSelect(e.event);
    expect(e.state.selection).toBeNull();
  });
});
