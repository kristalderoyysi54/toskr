import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/store/persistStorage", () => ({
  tauriStateStorage: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

vi.mock("motion/react", async () => {
  const React = await import("react");
  const staticElement = (tag: "div" | "img") =>
    React.forwardRef<HTMLElement, Record<string, unknown>>(function StaticMotion(
      {
        children,
        initial: _initial,
        animate: _animate,
        exit: _exit,
        transition: _transition,
        variants: _variants,
        custom: _custom,
        ...props
      },
      ref
    ) {
      return React.createElement(tag, { ...props, ref }, children as React.ReactNode);
    });
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
    motion: {
      div: staticElement("div"),
      img: staticElement("img"),
    },
  };
});

import { PreviewOverlay } from "@/components/PreviewOverlay";
import {
  defaultSettings,
  INBOX_ID,
  TASK_INBOX_ID,
  useNotesStore,
} from "@/store/notesStore";
import { useUIStore } from "@/store/uiStore";

function renderPreview() {
  Object.assign(useNotesStore.getInitialState(), useNotesStore.getState());
  Object.assign(useUIStore.getInitialState(), useUIStore.getState());
  return renderToStaticMarkup(<PreviewOverlay />);
}

describe("PreviewOverlay 富图文保序", () => {
  beforeEach(() => {
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    vi.stubGlobal("document", {
      activeElement: null,
      querySelector: () => null,
    });
    vi.stubGlobal("window", {
      innerWidth: 380,
      innerHeight: 700,
      setTimeout: vi.fn(),
    });
    useNotesStore.setState({
      sections: [{ id: INBOX_ID, name: "收件箱" }],
      notes: [],
      tasks: [],
      taskSections: [{ id: TASK_INBOX_ID, name: "收集箱" }],
      checkedIds: [],
      settings: defaultSettings(),
      undoStack: [],
    });
    useUIStore.setState({ previewId: null, previewEditing: false });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("交错图文编辑只开放文字块，图片仍固定在原位置", () => {
    const { id } = useNotesStore.getState().addNote("", {
      contentBlocks: [
        { type: "text", text: "图前正文" },
        { type: "image", file: "inline.png", alt: "流程图" },
        { type: "text", text: "图后正文" },
      ],
    });
    useUIStore.getState().openPreview(id!, true);

    const html = renderPreview();

    expect(html.indexOf("图前正文")).toBeLessThan(html.indexOf("查看流程图"));
    expect(html.indexOf("查看流程图")).toBeLessThan(html.indexOf("图后正文"));
    expect(html.match(/<textarea/g)).toHaveLength(2);
    expect(html).toContain('aria-label="文字段落 1"');
    expect(html).toContain('aria-label="文字段落 2"');
    expect(html).toContain("仅编辑文字，图片位置已锁定");
    expect(html).not.toContain("从卡片移除这张图片");
    expect(html).toContain("保存");
  });

  it("交错图文预览态保序并提供明确的文字编辑入口", () => {
    const { id } = useNotesStore.getState().addNote("", {
      contentBlocks: [
        { type: "text", text: "图前正文" },
        { type: "image", file: "inline.png" },
        { type: "text", text: "图后正文" },
      ],
    });
    useUIStore.getState().openPreview(id!, false);

    const html = renderPreview();

    expect(html.indexOf("图前正文")).toBeLessThan(html.indexOf("查看图片 1"));
    expect(html.indexOf("查看图片 1")).toBeLessThan(html.indexOf("图后正文"));
    expect(html).not.toContain("<textarea");
    expect(html).toContain('aria-label="编辑文字（图片位置固定）"');
  });

  it("普通文本仍可进入原有编辑态", () => {
    const { id } = useNotesStore.getState().addNote("普通文本");
    useUIStore.getState().openPreview(id!, true);

    const html = renderPreview();

    expect(html).toContain("<textarea");
    expect(html).toContain("保存");
  });

  it("正文后只有普通附件时保留原有编辑行为", () => {
    const { id } = useNotesStore.getState().addNote("普通组合卡", {
      attachments: ["tail.png"],
    });
    useUIStore.getState().openPreview(id!, true);

    const html = renderPreview();

    expect(html).toContain("<textarea");
    expect(html).toContain("保存");
  });
});
