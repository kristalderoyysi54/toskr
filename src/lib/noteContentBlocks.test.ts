import { describe, expect, it } from "vitest";

import {
  hasOrderedRichLayout,
  normalizeNoteContentBlocks,
  noteContentBlocks,
  projectNoteContent,
  replaceNoteTextBlockAt,
  replaceNoteTextProjection,
  textFromContentBlocks,
  type NoteContentBlock,
} from "./noteContentBlocks";

describe("noteContentBlocks", () => {
  it("保留文字与图片块顺序，并确定性生成旧字段投影", () => {
    const blocks: NoteContentBlock[] = [
      { type: "text", text: "路径：审批管理" },
      { type: "image", file: "a.png", alt: "商户注册", width: 800, height: 600 },
      { type: "text", text: "一、商户类型" },
      { type: "image", file: "b.png" },
    ];

    expect(projectNoteContent(blocks)).toEqual({
      contentBlocks: blocks,
      text: "路径：审批管理\n一、商户类型",
      imageFiles: ["a.png", "b.png"],
      imageFile: "a.png",
      attachments: ["b.png"],
      imageW: 800,
      imageH: 600,
    });
    expect(textFromContentBlocks(blocks)).toBe("路径：审批管理\n一、商户类型");
  });

  it("权威块保留重复图片位置，但兼容附件投影按首次出现去重", () => {
    const projection = projectNoteContent([
      { type: "image", file: "same.png" },
      { type: "text", text: "中间" },
      { type: "image", file: "same.png", alt: "再次出现" },
    ]);

    expect(projection.contentBlocks).toHaveLength(3);
    expect(projection.imageFiles).toEqual(["same.png"]);
    expect(projection.attachments).toBeUndefined();
  });

  it("已有块边界换行不重复，左侧显式空行保持", () => {
    expect(
      textFromContentBlocks([
        { type: "text", text: "甲\n" },
        { type: "text", text: "\n乙" },
        { type: "text", text: "丙" },
      ])
    ).toBe("甲\n乙\n丙");
    expect(
      textFromContentBlocks([
        { type: "text", text: "甲\n\n" },
        { type: "text", text: "乙" },
      ])
    ).toBe("甲\n\n乙");
  });

  it("旧卡缺块时恢复为正文、主图、附件顺序", () => {
    expect(
      noteContentBlocks({
        text: "旧正文",
        imageFile: "main.png",
        attachments: ["extra.png", "main.png"],
        imageW: 10,
        imageH: 20,
      })
    ).toEqual([
      { type: "text", text: "旧正文" },
      { type: "image", file: "main.png", width: 10, height: 20 },
      { type: "image", file: "extra.png" },
    ]);
  });

  it("contentBlocks 存在时不读取漂移的旧投影", () => {
    expect(
      noteContentBlocks({
        contentBlocks: [{ type: "text", text: "权威正文" }],
        text: "过期正文",
        imageFile: "stale.png",
      })
    ).toEqual([{ type: "text", text: "权威正文" }]);
  });

  it("纯文本编辑同步块且保留图片相对顺序，显式附件列表继承元数据", () => {
    const current: NoteContentBlock[] = [
      { type: "image", file: "before.png", width: 12, height: 8 },
      { type: "text", text: "旧" },
      { type: "image", file: "after.png" },
    ];
    expect(replaceNoteTextProjection(current, "新")).toEqual([
      { type: "image", file: "before.png", width: 12, height: 8 },
      { type: "text", text: "新" },
      { type: "image", file: "after.png" },
    ]);
    expect(replaceNoteTextProjection(current, "新", ["before.png", "new.png"])).toEqual([
      { type: "image", file: "before.png", width: 12, height: 8 },
      { type: "text", text: "新" },
      { type: "image", file: "new.png" },
    ]);
  });

  it("拒绝损坏块而不是回退到旧字段", () => {
    expect(() => normalizeNoteContentBlocks([{ type: "image", file: "" }])).toThrow(
      "file"
    );
    expect(() =>
      noteContentBlocks({
        contentBlocks: [{ type: "image", file: "x.png", width: -1 }],
        text: "旧字段不应兜底",
      })
    ).toThrow("width");
  });

  it("只替换文字块并保持全部图片对象与顺序不变", () => {
    const before: NoteContentBlock[] = [
      { type: "text", text: "图前" },
      { type: "image", file: "a.png", alt: "A" },
      { type: "text", text: "图后" },
      { type: "image", file: "b.png", width: 20, height: 10 },
    ];

    const after = replaceNoteTextBlockAt(before, 2, "修改后的图后文字");

    expect(after).toEqual([
      before[0],
      before[1],
      { type: "text", text: "修改后的图后文字" },
      before[3],
    ]);
    expect(after[1]).toBe(before[1]);
    expect(after[3]).toBe(before[3]);
    expect(() => replaceNoteTextBlockAt(before, 1, "不可写入图片位")).toThrow(
      "只能编辑已有文字块"
    );
  });

  it("只在图片后仍有正文时判定为必须块级编辑", () => {
    expect(
      hasOrderedRichLayout([
        { type: "text", text: "前文" },
        { type: "image", file: "tail.png" },
      ])
    ).toBe(false);
    expect(
      hasOrderedRichLayout([
        { type: "image", file: "inline.png" },
        { type: "text", text: "后文" },
      ])
    ).toBe(true);
  });
});
