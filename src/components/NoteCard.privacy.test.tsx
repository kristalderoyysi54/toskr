import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ts from "typescript";
import cardSource from "./NoteCard.tsx?raw";
import { NoteCard } from "./NoteCard";
import type { Note } from "@/store/notesStore";

const note: Note = { id: "privacy-note", text: "PRIVATE-CONTENT", sectionId: "inbox", done: false, createdAt: 1, blur: true };
const source = ts.createSourceFile("NoteCard.tsx", cardSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let doubleClick = "";
function visit(node: ts.Node) {
  if (ts.isJsxAttribute(node) && node.name.getText(source) === "onDoubleClick" && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression?.getText(source).includes("sendNotesToChat")) {
    doubleClick = node.initializer.expression.getText(source);
  }
  ts.forEachChild(node, visit);
}
visit(source);
const code = ts.transpileModule(`return (${doubleClick});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function dispatchDoubleClick(interactive: boolean, selected = false) {
  const send = vi.fn();
  const run = new Function("note", "sendNotesToChat", "lastMultiSelection", code)(note, send, selected ? { ids: [note.id, "second"], at: Date.now() } : null);
  run({ target: { closest: () => interactive ? {} : null } });
  return send;
}

describe("卡片隐私遮挡", () => {
  it("拖出入口在操作前明确标注未脱敏与未知目的地", () => {
    const html = renderToStaticMarkup(<NoteCard note={{ ...note, blur: false }} />);
    expect(html).toContain("拖出原文（不脱敏，目标由拖放位置决定）");
  });
  it("启用后使用不透明且无过渡/悬停揭示的遮挡层", () => {
    const html = renderToStaticMarkup(<NoteCard note={note} />);
    const overlay = html.match(/<span[^>]*data-card-privacy="true"[^>]*>/)?.[0];
    expect(overlay).toBeDefined();
    expect(overlay).toContain("bg-surface-raised");
    expect(overlay).not.toMatch(/group-hover:|transition|bg-surface-raised\//);
  });

  it("隐私关闭时没有遮挡层", () => {
    expect(renderToStaticMarkup(<NoteCard note={{ ...note, blur: false }} />)).not.toContain('data-card-privacy="true"');
  });

  it.each([false, true])("按钮双击不发送卡片或多选内容（多选=%s）", (selected) => {
    expect(dispatchDoubleClick(true, selected)).not.toHaveBeenCalled();
  });

  it("正文双击仍发送当前卡片", () => {
    expect(dispatchDoubleClick(false)).toHaveBeenCalledExactlyOnceWith([note.id]);
  });

  it("正文双击仍保留多选发送", () => {
    expect(dispatchDoubleClick(false, true)).toHaveBeenCalledExactlyOnceWith([note.id, "second"]);
  });
});


it("历史远程图标不触发 WebView 网络加载，仅显示受限原生返回的 PNG", () => {
  const link = { ...note, blur: false, kind: "link" as const, url: "https://example.com", linkTitle: "测试链接" };
  const unsafe = renderToStaticMarkup(<NoteCard note={{ ...link, linkIcon: "https://127.0.0.1/private-icon" }} />);
  expect(unsafe).not.toContain('src="https://127.0.0.1');
  const safe = renderToStaticMarkup(<NoteCard note={{ ...link, linkIcon: "data:image/png;base64,YQ==" }} />);
  expect(safe).toContain('src="data:image/png;base64,YQ=="');
});
