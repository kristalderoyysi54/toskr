import { describe, expect, it } from "vitest";

import { mapCaretBetweenTexts } from "./caretLocate";

describe("mapCaretBetweenTexts", () => {
  it("渲染文本 → 源文本：跳过 Markdown 标记", () => {
    const source = "# 标题\n\n第一段 **加粗** 文字\n\n第二段结尾";
    const visible = "标题\n第一段 加粗 文字\n第二段结尾";
    const offset = visible.indexOf("第二段") + 2;
    expect(mapCaretBetweenTexts(visible, source, offset)).toBe(source.indexOf("第二段") + 2);
  });

  it("源文本 → 渲染文本（退出编辑回滚定位）", () => {
    const source = "- [ ] 待办一\n- [ ] 待办二很长的一项";
    const visible = "待办一\n待办二很长的一项";
    const offset = source.indexOf("很长");
    expect(mapCaretBetweenTexts(source, visible, offset)).toBe(visible.indexOf("很长"));
  });

  it("开头位置取后方片段", () => {
    expect(mapCaretBetweenTexts("abc def", "**abc** def", 0)).toBe(2);
  });

  it("同文本直接返回", () => {
    expect(mapCaretBetweenTexts("abc", "abc", 2)).toBe(2);
  });
});

