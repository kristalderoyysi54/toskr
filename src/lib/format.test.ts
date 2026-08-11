import { describe, expect, it } from "vitest";

import {
  applyPromptTemplate,
  buildSendText,
  formatAsNumberedList,
  imageCaption,
  imageListLabel,
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

describe("imageCaption", () => {
  it("捕获占位「图片 W×H」与合并占位「图片 N 张」不算备注", () => {
    expect(imageCaption({ kind: "image", text: "图片 1867×391" })).toBe("");
    expect(imageCaption({ kind: "image", text: "图片 3 张" })).toBe("");
    expect(imageCaption({ kind: "image", text: "  " })).toBe("");
  });

  it("用户写的说明是真实备注", () => {
    expect(imageCaption({ kind: "image", text: "登录页报错截图" })).toBe(
      "登录页报错截图"
    );
    expect(imageCaption({ kind: "image", text: " 带空白 " })).toBe("带空白");
  });

  it("非图片卡原样返回文本", () => {
    expect(imageCaption({ kind: "text", text: "图片 1×1" })).toBe("图片 1×1");
    expect(imageCaption({ text: "无 kind 视为文本" })).toBe("无 kind 视为文本");
  });
});

describe("imageListLabel", () => {
  it("有文字备注时显示编辑后的首行", () => {
    expect(
      imageListLabel(
        {
          kind: "image",
          text: "编辑后的图片说明\n第二行",
          imageW: 231,
          imageH: 242,
        },
        1
      )
    ).toBe("编辑后的图片说明");
  });

  it("无真实备注时回退尺寸或图片数量", () => {
    expect(
      imageListLabel(
        { kind: "image", text: "图片 231×242", imageW: 231, imageH: 242 },
        1
      )
    ).toBe("图片 231×242");
    expect(imageListLabel({ kind: "image", text: "图片 3 张" }, 3)).toBe(
      "图片 ×3"
    );
  });
});
