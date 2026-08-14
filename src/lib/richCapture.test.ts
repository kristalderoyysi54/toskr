import { describe, expect, it, vi } from "vitest";

import {
  materializeRichCapture,
  restoreRichCaptureAliases,
} from "./richCapture";

describe("materializeRichCapture", () => {
  it("把本地化结果映射回每一个原始图片位置", async () => {
    const localize = vi.fn().mockResolvedValue([
      { index: 0, ok: true, file: "a.png", width: 10, height: 20 },
    ]);
    const result = await materializeRichCapture(
      {
        plainText: "前 后",
        html: '<p>前</p><img src="https://img.test/a.png" alt="图"><p>后</p><img src="https://img.test/a.png">',
      },
      localize
    );

    expect(localize).toHaveBeenCalledWith(
      ["https://img.test/a.png"],
      undefined
    );
    expect(result).toEqual({
      text: "前\n后",
      contentBlocks: [
        { type: "text", text: "前" },
        { type: "image", file: "a.png", alt: "图", width: 10, height: 20 },
        { type: "text", text: "后" },
        { type: "image", file: "a.png", width: 10, height: 20 },
      ],
      omittedImageCount: 0,
      omittedSchemes: [],
    });
  });

  it("图片失败时保留文字并只报告数量，不暴露源 URL", async () => {
    const result = await materializeRichCapture(
      {
        plainText: "正文 image.png",
        html: '<p>正文</p><img src="https://private.test/token.png?secret=1">',
      },
      async () => [{ index: 0, ok: false, reason: "httpFailed" }]
    );
    expect(result).toEqual({
      text: "正文",
      contentBlocks: [{ type: "text", text: "正文" }],
      omittedImageCount: 1,
      omittedSchemes: [],
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("逐块恢复化名且不改变图文顺序", () => {
    const result = restoreRichCaptureAliases(
      {
        text: "你好 [USER_01]\n再见 [USER_01]",
        contentBlocks: [
          { type: "text", text: "你好 [USER_01]" },
          { type: "image", file: "a.png" },
          { type: "text", text: "再见 [USER_01]" },
        ],
        omittedImageCount: 0,
        omittedSchemes: [],
      },
      [{
        id: "alias-1",
        category: "USER",
        originalText: "小明",
        placeholder: "[USER_01]",
        createdAtMs: 1,
        updatedAtMs: 1,
      }]
    );

    expect(result).toMatchObject({
      text: "你好 小明\n再见 小明",
      restoredCount: 2,
      contentBlocks: [
        { type: "text", text: "你好 小明" },
        { type: "image", file: "a.png" },
        { type: "text", text: "再见 小明" },
      ],
    });
  });
});
