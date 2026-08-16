import { describe, expect, it } from "vitest";

import {
  applyBlockFormat,
  applyMarkdownLink,
  blockFormatAt,
  hasInlineFormat,
  markdownHrefAtSelection,
  resolveSourceSelection,
  toggleInlineFormat,
} from "./selectionFormat";

describe("selectionFormat：行内格式", () => {
  it("加粗可添加并再次移除，选区始终留在正文", () => {
    const added = toggleInlineFormat("hello world", { start: 6, end: 11 }, "bold");
    expect(added).toEqual({
      text: "hello **world**",
      selection: { start: 8, end: 13 },
    });
    expect(hasInlineFormat(added.text, added.selection, "bold")).toBe(true);
    expect(toggleInlineFormat(added.text, added.selection, "bold")).toEqual({
      text: "hello world",
      selection: { start: 6, end: 11 },
    });
  });

  it("粗体内叠加斜体得到三星语法，切换斜体不破坏粗体", () => {
    const italic = toggleInlineFormat("**word**", { start: 2, end: 6 }, "italic");
    expect(italic.text).toBe("***word***");
    expect(hasInlineFormat(italic.text, italic.selection, "bold")).toBe(true);
    expect(hasInlineFormat(italic.text, italic.selection, "italic")).toBe(true);
    expect(toggleInlineFormat(italic.text, italic.selection, "italic").text).toBe(
      "**word**"
    );
  });

  it("链接标题选区可识别并切换链接外层粗体", () => {
    const text = "**[官网](https://a.com)**";
    const selection = { start: 3, end: 5 };
    expect(hasInlineFormat(text, selection, "bold")).toBe(true);
    const plain = toggleInlineFormat(text, selection, "bold");
    expect(plain).toEqual({
      text: "[官网](https://a.com)",
      selection: { start: 1, end: 3 },
    });
    expect(toggleInlineFormat(plain.text, plain.selection, "bold")).toEqual({
      text,
      selection,
    });
  });

  it("链接包装、标题内地址更新和整段链接地址替换", () => {
    expect(applyMarkdownLink("打开官网", { start: 2, end: 4 }, " https://a.com ")).toEqual({
      text: "打开[官网](https://a.com)",
      selection: { start: 3, end: 5 },
    });
    expect(
      applyMarkdownLink("[官网](https://old.test)", { start: 1, end: 3 }, "https://new.test")
        .text
    ).toBe("[官网](https://new.test)");
    expect(markdownHrefAtSelection("[官网](https://old.test)", { start: 1, end: 3 })).toBe(
      "https://old.test"
    );
    expect(
      applyMarkdownLink(
        "[官网](https://old.test)",
        { start: 0, end: 23 },
        "https://new.test"
      ).text
    ).toBe("[官网](https://new.test)");
  });
});

describe("selectionFormat：块格式", () => {
  it("部分划词会格式化完整行，并替换已有块前缀", () => {
    const result = applyBlockFormat(
      "开头\n- 第一行\n## 第二行\n结尾",
      { start: 5, end: 15 },
      "heading1"
    );
    expect(result.text).toBe("开头\n# 第一行\n# 第二行\n结尾");
    expect(result.selection).toEqual({ start: 3, end: 14 });
    expect(blockFormatAt(result.text, result.selection)).toBe("heading1");
  });

  it("编号跨空行连续计数，正文可移除列表前缀", () => {
    const numbered = applyBlockFormat("甲\n\n- 乙", { start: 0, end: 6 }, "numbered-list");
    expect(numbered.text).toBe("1. 甲\n\n2. 乙");
    expect(applyBlockFormat(numbered.text, numbered.selection, "paragraph").text).toBe(
      "甲\n\n乙"
    );
  });

  it("首字符是换行时不把第二行误当作首行起点", () => {
    expect(applyBlockFormat("\n正文", { start: 0, end: 3 }, "heading1").text).toBe(
      "\n# 正文"
    );
  });

  it("代码块包裹完整行，选区保留在代码正文并可恢复为文本", () => {
    const source = "前\nconst x = 1;\nreturn x;\n后";
    const code = applyBlockFormat(source, { start: 4, end: 20 }, "code-block");

    expect(code).toEqual({
      text: "前\n```\nconst x = 1;\nreturn x;\n```\n后",
      selection: { start: 6, end: 28 },
    });
    expect(blockFormatAt(code.text, code.selection)).toBe("code-block");
    expect(applyBlockFormat(code.text, code.selection, "code-block")).toEqual(code);
    expect(applyBlockFormat(code.text, code.selection, "paragraph")).toEqual({
      text: source,
      selection: { start: 2, end: 24 },
    });
    expect(
      applyBlockFormat(code.text, { start: 2, end: 32 }, "paragraph")
    ).toEqual({
      text: source,
      selection: { start: 2, end: 24 },
    });
  });

  it("代码正文内部选区识别为代码块，内容含三反引号时自动加长围栏", () => {
    const fenced = "```\nalpha\nbeta\n```";
    expect(blockFormatAt(fenced, { start: 7, end: 9 })).toBe("code-block");

    const code = applyBlockFormat("alpha\n```\nbeta", { start: 0, end: 14 }, "code-block");
    expect(code.text).toBe("````\nalpha\n```\nbeta\n````");
    expect(blockFormatAt(code.text, code.selection)).toBe("code-block");
  });
});

describe("selectionFormat：渲染态选区映射", () => {
  it("从 Markdown 可见短句映射回带标记原文", () => {
    expect(
      resolveSourceSelection("# 标题\n\n这是 **重点**", "标题\n这是 重点", {
        start: 6,
        end: 8,
      })
    ).toEqual({ start: 11, end: 13 });
  });

  it("重复文本按可见位置选择最近一次", () => {
    expect(
      resolveSourceSelection("**同名** 和 同名", "同名 和 同名", { start: 5, end: 7 })
    ).toEqual({ start: 9, end: 11 });
  });

  it("渲染后无法精确对应的跨块选区安全拒绝", () => {
    expect(resolveSourceSelection("甲\n\n乙", "甲\n乙", { start: 0, end: 3 })).toBeNull();
  });
});

import { describe as describe2, expect as expect2, it as it2 } from "vitest";
import { applyBlockFormat as applyBlock2, blockFormatAt as blockAt2 } from "./selectionFormat";

describe2("核对清单块格式", () => {
  it2("选区整行转为核对清单，再转回正文剥掉完整前缀", () => {
    const source = "第一行\n第二行";
    const todo = applyBlock2(source, { start: 0, end: source.length }, "todo-list");
    expect2(todo.text).toBe("- [ ] 第一行\n- [ ] 第二行");
    const back = applyBlock2(todo.text, todo.selection, "paragraph");
    expect2(back.text).toBe("第一行\n第二行");
  });

  it2("已勾选清单行被识别为 todo-list，转标题不残留 [x]", () => {
    const source = "- [x] 已完成项";
    expect2(blockAt2(source, { start: 0, end: source.length })).toBe("todo-list");
    const heading = applyBlock2(source, { start: 0, end: source.length }, "heading2");
    expect2(heading.text).toBe("## 已完成项");
  });
});
