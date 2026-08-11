import { describe, expect, it } from "vitest";

import { looksLikeMarkdown } from "./markdown";

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
