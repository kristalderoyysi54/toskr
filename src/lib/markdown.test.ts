import { describe, expect, it } from "vitest";

import { looksLikeMarkdown, markdownToPlainText } from "./markdown";

describe("markdownToPlainText", () => {
  it("去掉标题与行内标记，同时保留链接地址", () => {
    expect(
      markdownToPlainText(
        "# 标题\n\n**加粗**、*斜体*、~~删除~~、`code` 与 [链接](https://x.com)"
      )
    ).toBe("标题\n\n加粗、斜体、删除、code 与 链接（https://x.com）");
  });

  it("用纯文本符号保留列表、任务状态与嵌套层级", () => {
    expect(
      markdownToPlainText("1. 第一项\n2. [x] 完成\n   - 子项")
    ).toBe("1. 第一项\n2. ☒ 完成\n  • 子项");
  });

  it("保留围栏代码正文，并把 GFM 表格变为制表文本", () => {
    expect(markdownToPlainText("```js\na * b\n```"))
      .toBe("a * b");
    expect(
      markdownToPlainText("| 名称 | 状态 |\n| --- | --- |\n| Toskr | ✅ |")
    ).toBe("名称\t状态\nToskr\t✅");
  });

  it("普通文本保持内容并且转换幂等", () => {
    const text = "第一行\n第二行，访问 www.example.com";
    const plain = markdownToPlainText(text);
    expect(plain).toBe(text);
    expect(markdownToPlainText(plain)).toBe(plain);
  });
});

describe("looksLikeMarkdown", () => {
  it("识别工具条生成的斜体语法", () => {
    expect(looksLikeMarkdown("这是 *重点* 内容")).toBe(true);
  });

  it("普通星号和乘法表达式不误判为斜体", () => {
    expect(looksLikeMarkdown("glob * pattern")).toBe(false);
    expect(looksLikeMarkdown("2 * 3 * 4")).toBe(false);
  });

  it("识别工具条生成的普通与加长代码围栏", () => {
    expect(looksLikeMarkdown("```\nconst value = 1;\n```")).toBe(true);
    expect(looksLikeMarkdown("````\n```\n````")).toBe(true);
  });
});

import { toggleTaskListItem } from "./markdown";

describe("toggleTaskListItem", () => {
  const doc = "标题\n- [ ] 第一项\n- [x] 第二项\n```\n- [ ] 代码里的不算\n```\n- [ ] 第三项";

  it("按渲染序号切换对应任务项，代码围栏内不计数", () => {
    expect(toggleTaskListItem(doc, 0)).toContain("- [x] 第一项");
    expect(toggleTaskListItem(doc, 1)).toContain("- [ ] 第二项");
    const third = toggleTaskListItem(doc, 2)!;
    expect(third).toContain("- [x] 第三项");
    expect(third).toContain("- [ ] 代码里的不算");
  });

  it("序号越界返回 null，原文不动", () => {
    expect(toggleTaskListItem(doc, 9)).toBeNull();
    expect(toggleTaskListItem("没有清单", 0)).toBeNull();
  });

  it("缩进与编号列表形式的任务项同样可切换", () => {
    expect(toggleTaskListItem("  - [ ] 缩进项", 0)).toBe("  - [x] 缩进项");
    expect(toggleTaskListItem("1. [x] 编号任务", 0)).toBe("1. [ ] 编号任务");
  });
});
