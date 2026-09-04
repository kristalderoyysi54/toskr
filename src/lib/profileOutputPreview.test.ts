import { describe, expect, it } from "vitest";

import { buildDeliveryOutputPreview } from "./profileOutputPreview";

const source = "# 标题\n\n- **完成**：[文档](https://example.com)";

describe("buildDeliveryOutputPreview", () => {
  it("原文模式逐字保留测试内容", () => {
    expect(buildDeliveryOutputPreview(source, "plain")).toBe(source);
  });

  it("无 Markdown 模式复用发送转换器", () => {
    expect(buildDeliveryOutputPreview(source, "strip-markdown")).toBe(
      "标题\n\n• 完成：文档（https://example.com）"
    );
  });

  it("代码块模式复用发送围栏格式", () => {
    expect(buildDeliveryOutputPreview(source, "code")).toBe(
      `\`\`\`\n${source}\n\`\`\``
    );
  });

  it("空内容不生成空代码围栏", () => {
    expect(buildDeliveryOutputPreview("", "code")).toBe("");
  });
});
