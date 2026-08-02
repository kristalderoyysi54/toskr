import { describe, expect, it } from "vitest";

import { buildSendText, formatAsNumberedList, mergeTexts } from "./format";

describe("formatAsNumberedList", () => {
  it("生成编号列表", () => {
    expect(formatAsNumberedList(["内容A", "内容B"])).toBe("1. 内容A\n2. 内容B");
  });

  it("空数组返回空串", () => {
    expect(formatAsNumberedList([])).toBe("");
  });

  it("保留条目内换行", () => {
    expect(formatAsNumberedList(["a\nb", "c"])).toBe("1. a\nb\n2. c");
  });
});

describe("buildSendText", () => {
  it("单条保持原文（不加编号）", () => {
    expect(buildSendText(["只有一条"])).toBe("只有一条");
  });

  it("多条转编号列表", () => {
    expect(buildSendText(["a", "b", "c"])).toBe("1. a\n2. b\n3. c");
  });
});

describe("mergeTexts", () => {
  it("空行分隔合并", () => {
    expect(mergeTexts(["a", "b"])).toBe("a\n\nb");
  });
});
