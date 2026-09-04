import { describe, expect, it } from "vitest";

import { applyTextOpToSelection, TEXT_OPS } from "./textops";

const op = (id: string) => {
  const found = TEXT_OPS.find((o) => o.id === id);
  if (!found) throw new Error(`missing op ${id}`);
  return found.apply;
};

describe("textops", () => {
  it("去首尾空白", () => {
    expect(op("trim")("  hi \n")).toBe("hi");
  });

  it("去空行保留内容行", () => {
    expect(op("strip-blank-lines")("a\n\n  \nb\n")).toBe("a\nb");
  });

  it("大小写转换", () => {
    expect(op("upper")("Abc")).toBe("ABC");
    expect(op("lower")("Abc")).toBe("abc");
  });

  it("JSON 格式化：合法输入两空格缩进", () => {
    expect(op("json-pretty")('{"a":1}')).toBe('{\n  "a": 1\n}');
  });

  it("JSON 格式化：非法输入抛错（调用方兜底提示）", () => {
    expect(() => op("json-pretty")("not json")).toThrow();
  });

  it("URL 解码", () => {
    expect(op("url-decode")("a%20b%2Fc")).toBe("a b/c");
  });

  it("URL 解码：非法序列抛错", () => {
    expect(() => op("url-decode")("%E4%")).toThrow();
  });

  it("去 Markdown 标记", () => {
    const input = "# 标题\n\n- **加粗**项\n> 引用\n`code` 与 [链接](https://x.com)";
    expect(op("strip-md")(input)).toBe(
      "标题\n\n• 加粗项\n\n引用\ncode 与 链接（https://x.com）"
    );
  });

  it("去 Markdown：代码围栏行移除、内容保留", () => {
    expect(op("strip-md")("```js\nconst a = 1;\n```")).toBe("const a = 1;");
  });

  it("选区适配器只替换选中片段，并把选区留在处理结果上", () => {
    const textOp = TEXT_OPS.find((item) => item.id === "upper")!;
    expect(
      applyTextOpToSelection("前 abc 后", { start: 2, end: 5 }, textOp)
    ).toEqual({
      text: "前 ABC 后",
      selection: { start: 2, end: 5 },
    });
  });

  it("选区适配器支持长度变化并钳制越界区间", () => {
    const textOp = TEXT_OPS.find((item) => item.id === "trim")!;
    expect(
      applyTextOpToSelection("  hello  ", { start: 99, end: -9 }, textOp)
    ).toEqual({
      text: "hello",
      selection: { start: 0, end: 5 },
    });
  });
});
