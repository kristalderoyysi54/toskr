import { describe, expect, it } from "vitest";

import type { NotePreviewPayload } from "./actions";
import {
  appendPreviewContent,
  editorInsertRejectionReason,
  hasRecentEditorInsertOperation,
  refreshPreviewPayload,
  rememberEditorInsertOperation,
} from "./previewPayload";

const note = (overrides: Partial<NotePreviewPayload> = {}): NotePreviewPayload => ({
  dataGeneration: 0,
  sessionId: "session-1",
  id: "note-1",
  text: "plain text",
  kind: "text",
  codeLang: null,
  url: null,
  title: null,
  sourceApp: null,
  sourceBundle: null,
  images: [],
  edit: true,
  ...overrides,
});

describe("refreshPreviewPayload", () => {
  it("reclassifies text to a link in the current detail window", () => {
    const result = refreshPreviewPayload(note(), "  https://example.com  ");

    expect(result.payload).toMatchObject({
      text: "https://example.com",
      kind: "link",
      url: "https://example.com",
      codeLang: null,
    });
    expect(result.markdownView).toBe(false);
  });

  it("reclassifies a link back to text", () => {
    const result = refreshPreviewPayload(
      note({ kind: "link", url: "https://example.com" }),
      "ordinary sentence"
    );

    expect(result.payload).toMatchObject({
      text: "ordinary sentence",
      kind: "text",
      url: null,
      codeLang: null,
    });
  });

  it("enables the default rendered view after editing to Markdown", () => {
    const result = refreshPreviewPayload(note(), "# QA Markdown");

    expect(result.payload.kind).toBe("text");
    expect(result.markdownView).toBe(true);
  });

  it("keeps code classification on the shared content decision path", () => {
    const result = refreshPreviewPayload(
      note(),
      "const add = (a, b) => { return a + b; };"
    );

    expect(result.payload.kind).toBe("text");
    expect(result.payload.codeLang).not.toBeNull();
    expect(result.payload.url).toBeNull();
  });

  it("带粘贴图片时 URL 正文保持图文卡，不升级为链接卡", () => {
    const result = refreshPreviewPayload(
      note({ images: ["paste.png"] }),
      "https://example.com"
    );

    expect(result.payload.kind).toBe("text");
    expect(result.payload.url).toBeNull();
    expect(result.payload.images).toEqual(["paste.png"]);
  });

  it("只保留粘贴图片时转为图片卡", () => {
    const result = refreshPreviewPayload(note({ images: ["paste.png"] }), "   ");

    expect(result.payload.kind).toBe("image");
    expect(result.payload.text).toBe("");
  });
});

describe("appendPreviewContent", () => {
  it("把剪贴板正文以段落追加，并对附件稳定去重", () => {
    const result = appendPreviewContent(
      "原卡内容",
      ["original.png"],
      "剪贴板内容",
      ["original.png", "clip.png"]
    );

    expect(result).toEqual({
      text: "原卡内容\n\n剪贴板内容",
      images: ["original.png", "clip.png"],
      selection: { start: 11, end: 11 },
    });
  });

  it("纯图片剪贴板内容不改正文，只追加附件", () => {
    expect(appendPreviewContent("原卡内容", [], "", ["clip.png"])).toEqual({
      text: "原卡内容",
      images: ["clip.png"],
      selection: { start: 4, end: 4 },
    });
  });
});

describe("编辑器追加幂等窗口", () => {
  it("ACK 丢失后的短时重试命中同一操作，过期后允许用户再次追加", () => {
    const operations = new Map<string, number>();
    rememberEditorInsertOperation(operations, "same-operation", 1000);

    expect(
      hasRecentEditorInsertOperation(operations, "same-operation", 5999)
    ).toBe(true);
    expect(
      hasRecentEditorInsertOperation(operations, "same-operation", 6000)
    ).toBe(false);
  });

  it("缓存有界，避免详情窗长期复用时无限增长", () => {
    const operations = new Map<string, number>();
    for (let index = 0; index < 40; index += 1) {
      rememberEditorInsertOperation(operations, `operation-${index}`, 1000);
    }

    expect(operations.size).toBe(32);
    expect(operations.has("operation-0")).toBe(false);
    expect(operations.has("operation-39")).toBe(true);
  });
});

describe("编辑器追加请求边界", () => {
  const payload = {
    requestId: "request-1",
    operationKey: "operation-1",
    expiresAt: 2500,
    targetId: "note-1",
    targetSessionId: "session-1",
    text: "追加内容",
    images: [],
    dataGeneration: 0,
  };

  it("只接受当前编辑会话且尚未超时的请求", () => {
    expect(editorInsertRejectionReason(note(), payload, 2499)).toBeNull();
    expect(editorInsertRejectionReason(note(), payload, 2500)).toBe(
      "卡片编辑请求已过期"
    );
  });

  it("同卡重开后拒绝旧会话迟到的请求", () => {
    expect(
      editorInsertRejectionReason(note({ sessionId: "session-2" }), payload, 2000)
    ).toBe("卡片编辑目标或数据上下文已变化");
  });
});
