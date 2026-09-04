import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { TextSelectionToolbar } from "@/components/TextSelectionToolbar";

describe("TextSelectionToolbar", () => {
  it("选词只读格式态仍提供共享文本处理入口", () => {
    const html = renderToStaticMarkup(
      <TextSelectionToolbar
        text="前 abc 后"
        selection={{ start: 2, end: 5 }}
        onApply={vi.fn()}
        onTextOperation={vi.fn()}
        onCopySelection={vi.fn()}
        readOnly
      />
    );

    expect(html).toContain("已选 3 字");
    expect(html).toContain('aria-label="处理选中内容"');
    expect(html).not.toContain("添加链接");
  });

  it("编辑态文本选区显示明确的发送选中入口", () => {
    const html = renderToStaticMarkup(
      <TextSelectionToolbar
        text="保留 只发这段 结尾"
        selection={{ start: 3, end: 7 }}
        onApply={vi.fn()}
        onSendSelection={vi.fn()}
        readOnly
      />
    );

    expect(html).toContain("发送选中");
    expect(html).toContain("只把选中片段发到当前目标");
  });
});
