import { describe, expect, it } from "vitest";

import type { NotePreviewPayload } from "./actions";
import { refreshPreviewPayload } from "./previewPayload";

const note = (overrides: Partial<NotePreviewPayload> = {}): NotePreviewPayload => ({
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
