import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  EditableRichImageBlock,
  RichNoteTextEditor,
} from "@/components/RichNoteContent";

vi.mock("@/lib/media", () => ({
  useNoteImage: () => "asset://tiny-image",
}));

describe("EditableRichImageBlock", () => {
  it("小图保持原尺寸热区，并为当前块提供明确的查看和删除操作", () => {
    const html = renderToStaticMarkup(
      <EditableRichImageBlock
        block={{ type: "image", file: "tiny.png", width: 12, height: 8 }}
        files={["tiny.png"]}
        imageIndex={0}
        blockIndex={1}
        selected
        onSelect={vi.fn()}
        onOpen={vi.fn()}
        onRemove={vi.fn()}
      />
    );

    expect(html).toContain('data-rich-image-edit-block="1"');
    expect(html).toContain('data-selected="true"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-label="查看图片 1"');
    expect(html).toContain('aria-label="删除图片 1"');
    expect(html).toContain("min-h-12 min-w-12");
    expect(html).toContain("max-w-full");
    expect(html).not.toContain("h-auto max-h-[70vh] w-full");
  });

  it("文字在前图片在后的混合卡仍在编辑器内部呈现图片操作", () => {
    const html = renderToStaticMarkup(
      <RichNoteTextEditor
        blocks={[
          { type: "text", text: "正文" },
          { type: "image", file: "tail.png", width: 16, height: 10 },
        ]}
        onChange={vi.fn()}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    expect(html).toContain('aria-label="图文文字编辑器"');
    expect(html).toContain('data-rich-image-edit-block="1"');
    expect(html).toContain('aria-label="删除图片 1"');
  });

  it("图文编辑态选中图片后显示发送选中入口", () => {
    const html = renderToStaticMarkup(
      <EditableRichImageBlock
        block={{ type: "image", file: "selected.png", alt: "订单截图" }}
        files={["selected.png"]}
        imageIndex={0}
        blockIndex={1}
        selected
        onSelect={vi.fn()}
        onOpen={vi.fn()}
        onRemove={vi.fn()}
        onSend={vi.fn()}
      />
    );

    expect(html).toContain('data-selected="true"');
    expect(html).toContain("发送选中");
    expect(html).toContain("只发送图片 1");
  });
});
