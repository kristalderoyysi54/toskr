import { describe, expect, it } from "vitest";

import {
  applyPromptTemplate,
  buildSendText,
  formatAsNumberedList,
  mergeTexts,
} from "./format";

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

describe("applyPromptTemplate", () => {
  it("无占位符退化为前缀拼接（向后兼容）", () => {
    expect(applyPromptTemplate("请翻译：", "hello")).toBe("请翻译：\n\nhello");
    expect(applyPromptTemplate("只发模板", "")).toBe("只发模板");
  });

  it("{内容} 注入到占位位置", () => {
    expect(applyPromptTemplate("上文\n{内容}\n下文", "正文")).toBe("上文\n正文\n下文");
  });

  it("{占位} / {content} 别名与大小写", () => {
    expect(applyPromptTemplate("读提示词{占位}并优化", "P")).toBe("读提示词P并优化");
    expect(applyPromptTemplate("A {Content} B", "x")).toBe("A x B");
  });

  it("多处占位全部替换", () => {
    expect(applyPromptTemplate("{内容}和{内容}", "x")).toBe("x和x");
  });

  it("内容含 $& 等 replace 特殊序列不被解释", () => {
    expect(applyPromptTemplate("说：{内容}", "价格 $& 100$'")).toBe("说：价格 $& 100$'");
  });

  it("空内容时占位符替换为空", () => {
    expect(applyPromptTemplate("A{内容}B", "")).toBe("AB");
  });
});
