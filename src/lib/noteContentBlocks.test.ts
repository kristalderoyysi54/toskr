import { describe, expect, it } from "vitest";

import {
  hasOrderedRichLayout,
  mapNoteTextBlocks,
  normalizeNoteContentBlocks,
  noteContentBlocks,
  projectNoteContent,
  replaceNoteImageFile,
  replaceNoteTextBlockAt,
  replaceNoteTextProjection,
  textBlockRanges,
  textFromContentBlocks,
  type NoteContentBlock,
} from "./noteContentBlocks";

describe("mapNoteTextBlocks（卡片级文本处理/恢复化名的结构不变性）", () => {
  const interleaved: NoteContentBlock[] = [
    { type: "image", file: "a.png", width: 10, height: 5 },
    { type: "text", text: "hello" },
    { type: "image", file: "b.png", alt: "截图" },
    { type: "text", text: "world" },
    { type: "image", file: "c.png" },
  ];

  it("逐文字块变换：块数、交错顺序与图片块（含元数据引用）全部不变", () => {
    const next = mapNoteTextBlocks(interleaved, (text) => text.toUpperCase());
    expect(next.map((block) => block.type)).toEqual([
      "image",
      "text",
      "image",
      "text",
      "image",
    ]);
    // 图片块保持原引用：alt/宽高元数据零拷贝、绝不重建
    expect(next[0]).toBe(interleaved[0]);
    expect(next[2]).toBe(interleaved[2]);
    expect(next[4]).toBe(interleaved[4]);
    expect(next[1]).toEqual({ type: "text", text: "HELLO" });
    expect(next[3]).toEqual({ type: "text", text: "WORLD" });
  });

  it("变换无实际改动时保留原块引用（调用方按引用判断是否需要落库）", () => {
    const next = mapNoteTextBlocks(interleaved, (text) => text);
    next.forEach((block, index) => expect(block).toBe(interleaved[index]));
  });
});

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

  it("编辑图片只替换命中图片并保留富图文顺序、alt 与其他块引用", () => {
    const text = { type: "text" as const, text: "前文" };
    const untouched = {
      type: "image" as const,
      file: "b.png",
      width: 20,
      height: 10,
    };
    const blocks: NoteContentBlock[] = [
      text,
      { type: "image", file: "a.png", alt: "截图", width: 100, height: 80 },
      untouched,
      { type: "image", file: "a.png" },
    ];

    const next = replaceNoteImageFile(blocks, "a.png", {
      file: "edited.png",
      width: 640,
      height: 480,
    });

    expect(next.map((block) => block.type)).toEqual([
      "text",
      "image",
      "image",
      "image",
    ]);
    expect(next[0]).toBe(text);
    expect(next[2]).toBe(untouched);
    expect(next[1]).toEqual({
      type: "image",
      file: "edited.png",
      alt: "截图",
      width: 640,
      height: 480,
    });
    expect(next[3]).toEqual({
      type: "image",
      file: "edited.png",
      width: 640,
      height: 480,
    });
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

  it("文字块区间切出的正是投影文本本身（选词模式据此把分词分派回各块）", () => {
    const cases: NoteContentBlock[][] = [
      // 块间需要补换行
      [
        { type: "text", text: "路径：审批管理" },
        { type: "image", file: "a.png" },
        { type: "text", text: "一、商户类型" },
      ],
      // 左块自带换行，不再叠加
      [
        { type: "text", text: "前文\n" },
        { type: "image", file: "b.png" },
        { type: "text", text: "\n\n后文" },
      ],
      // 右块自带换行
      [
        { type: "text", text: "上" },
        { type: "text", text: "\n下" },
      ],
      // 图片在前，正文在后
      [
        { type: "image", file: "c.png" },
        { type: "text", text: "图注" },
      ],
    ];

    for (const blocks of cases) {
      const text = textFromContentBlocks(blocks);
      const ranges = textBlockRanges(blocks);
      // 只覆盖文字块，且按块顺序排列
      expect(ranges.map((r) => r.blockIndex)).toEqual(
        blocks.flatMap((block, i) => (block.type === "text" ? [i] : []))
      );
      // 每段区间切出的就是该块落到投影里的内容，拼回去等于整篇（含块间补的换行）
      let rebuilt = "";
      let cursor = 0;
      for (const range of ranges) {
        rebuilt += text.slice(cursor, range.start) + text.slice(range.start, range.end);
        cursor = range.end;
      }
      expect(rebuilt + text.slice(cursor)).toBe(text);
      expect(ranges.every((r) => r.start <= r.end && r.end <= text.length)).toBe(true);
    }
  });

  it("文字块区间跳过块间补出来的换行", () => {
    const blocks: NoteContentBlock[] = [
      { type: "text", text: "上" },
      { type: "image", file: "a.png" },
      { type: "text", text: "下" },
    ];
    const text = textFromContentBlocks(blocks);
    const ranges = textBlockRanges(blocks);

    expect(text).toBe("上\n下");
    expect(ranges).toEqual([
      { blockIndex: 0, start: 0, end: 1 },
      { blockIndex: 2, start: 2, end: 3 },
    ]);
    expect(text.slice(ranges[0].start, ranges[0].end)).toBe("上");
    expect(text.slice(ranges[1].start, ranges[1].end)).toBe("下");
  });
});
