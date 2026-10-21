import { describe, expect, it } from "vitest";

import { detectClipSmart } from "./clipSmart";

const localFmt = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
};

describe("detectClipSmart · 颜色", () => {
  it("#rrggbb：四种色彩空间输出", () => {
    expect(detectClipSmart("#3b82f6")).toEqual({
      kind: "color",
      hex: "#3B82F6",
      rgb: "rgb(59 130 246)",
      hsl: "hsl(217 91% 60%)",
      oklch: "oklch(0.623 0.188 259.8)",
      swatch: "#3B82F6",
    });
  });

  it("#rgb 短写展开；白色无彩色 H 置 0", () => {
    expect(detectClipSmart("#FFF")).toMatchObject({
      hex: "#FFFFFF",
      hsl: "hsl(0 0% 100%)",
      oklch: "oklch(1.000 0.000 0.0)",
    });
    expect(detectClipSmart("#808080")).toMatchObject({ oklch: "oklch(0.600 0.000 0.0)" });
  });

  it("纯红 oklch 与参考公式一致", () => {
    expect(detectClipSmart("#ff0000")).toMatchObject({
      hsl: "hsl(0 100% 50%)",
      oklch: "oklch(0.628 0.258 29.2)",
    });
  });

  it("#rgba / #rrggbbaa：alpha<1 输出 8 位 hex 与 / alpha", () => {
    expect(detectClipSmart("#3b82f680")).toMatchObject({
      hex: "#3B82F680",
      rgb: "rgb(59 130 246 / 0.502)",
      swatch: "#3B82F680",
    });
    expect(detectClipSmart("#f008")).toMatchObject({ hex: "#FF000088" });
    // alpha=ff 视为不透明
    expect(detectClipSmart("#3b82f6ff")).toMatchObject({ hex: "#3B82F6", rgb: "rgb(59 130 246)" });
  });

  it("rgb()/rgba() 逗号与空格语法", () => {
    expect(detectClipSmart("rgb(59, 130, 246)")).toMatchObject({ hex: "#3B82F6" });
    expect(detectClipSmart("rgba(59,130,246,0.5)")).toMatchObject({
      hex: "#3B82F680",
      rgb: "rgb(59 130 246 / 0.5)",
    });
    expect(detectClipSmart("rgb(59 130 246 / 50%)")).toMatchObject({ rgb: "rgb(59 130 246 / 0.5)" });
    expect(detectClipSmart("RGB(100%, 0%, 0%)")).toMatchObject({ hex: "#FF0000" });
  });

  it("hsl()/hsla()", () => {
    expect(detectClipSmart("hsl(0 100% 50%)")).toMatchObject({ hex: "#FF0000", rgb: "rgb(255 0 0)" });
    expect(detectClipSmart("hsla(120deg, 100%, 25%, 0.25)")).toMatchObject({
      hex: "#00800040",
      rgb: "rgb(0 128 0 / 0.25)",
      hsl: "hsl(120 100% 25%)",
    });
  });

  it("越界/非法 → null", () => {
    for (const s of [
      "rgb(256 0 0)",
      "rgb(-1, 0, 0)",
      "rgb(0 0 0 / 1.5)",
      "rgb(0 0)",
      "rgb(0, 0, 0 / 0.5)",
      "hsl(0 101% 50%)",
      "#12345",
      "#ggg",
    ]) {
      expect(detectClipSmart(s), s).toBeNull();
    }
  });

  it("不带 # 的裸十六进制 → null", () => {
    for (const s of ["abc", "3b82f6", "deadbeef"]) expect(detectClipSmart(s), s).toBeNull();
  });
});

describe("detectClipSmart · JSON", () => {
  it("对象：pretty/minified/summary", () => {
    expect(detectClipSmart('  {"a": 1, "b": [1, 2]}\n')).toEqual({
      kind: "json",
      pretty: '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}',
      minified: '{"a":1,"b":[1,2]}',
      summary: "对象 · 2 键",
    });
  });

  it("数组 summary，多行原文也认", () => {
    expect(detectClipSmart("[\n 1,\n 2,\n 3\n]")).toMatchObject({ kind: "json", summary: "数组 · 3 项" });
  });

  it("解析失败 / 空容器 / 括号不配对 → null", () => {
    for (const s of ["{a: 1}", '{"a": 1,}', "{}", "[]", '{"a":1]', "[1, 2"]) {
      expect(detectClipSmart(s), s).toBeNull();
    }
  });
});

describe("detectClipSmart · 时间戳", () => {
  it("10 位秒", () => {
    expect(detectClipSmart("1700000000")).toEqual({
      kind: "timestamp",
      ms: 1_700_000_000_000,
      unit: "秒",
      local: localFmt(1_700_000_000_000),
    });
  });

  it("13 位毫秒", () => {
    expect(detectClipSmart("1700000000123")).toEqual({
      kind: "timestamp",
      ms: 1_700_000_000_123,
      unit: "毫秒",
      local: localFmt(1_700_000_000_123),
    });
  });

  it("超出 2000–2100 → null", () => {
    for (const s of ["0946684799", "9999999999", "0000000000000", "4102444800001"]) {
      expect(detectClipSmart(s), s).toBeNull();
    }
  });

  it("其他位数 → null", () => {
    for (const s of ["17000000", "170000000000", "17000000000000"]) {
      expect(detectClipSmart(s), s).toBeNull();
    }
  });
});

describe("detectClipSmart · 邮箱", () => {
  it("合法地址", () => {
    expect(detectClipSmart(" foo.bar+tag@mail.example.com ")).toEqual({
      kind: "email",
      address: "foo.bar+tag@mail.example.com",
    });
  });

  it("非法 / mailto / 超长 → null", () => {
    for (const s of [
      "mailto:a@b.com",
      "a@b",
      "a@b.c",
      "a b@c.com",
      "a@-b.com",
      "@b.com",
      "a@@b.com",
      `${"a".repeat(250)}@b.com`,
    ]) {
      expect(detectClipSmart(s), s).toBeNull();
    }
  });
});

describe("detectClipSmart · 明确不支持", () => {
  it("算式/日期/电话/URL/路径/普通文本 → null", () => {
    for (const s of [
      "1280*0.85",
      "2026-10-20",
      "138-0013-8000",
      "13800138000",
      "+86 138 0013 8000",
      "https://example.com/a?b=1",
      "example.com",
      "/Users/me/file.txt",
      "~/Documents/a.md",
      "C:\\Users\\a.txt",
      "hello world",
      "#3b82f6 is blue",
      "",
      "   ",
    ]) {
      expect(detectClipSmart(s), s).toBeNull();
    }
  });

  it("超过 100_000 字符 → null", () => {
    expect(detectClipSmart(`[${"1,".repeat(50_000)}1]`)).toBeNull();
  });
});
