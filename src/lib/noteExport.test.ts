import { describe, expect, it } from "vitest";

import { CLIPBOARD_ID, INBOX_ID, SECRET_ID, type Note } from "@/store/notesStore";
import { buildNotesExportPlan, notesExportFilename } from "./noteExport";

const baseNote = (overrides: Partial<Note> = {}): Note => ({
  id: "note-1",
  text: "正文",
  sectionId: INBOX_ID,
  done: false,
  createdAt: new Date(2026, 7, 22, 9, 5).getTime(),
  ...overrides,
});

const sections = [{ id: INBOX_ID, name: "收件箱" }];

describe("笔记内容导出", () => {
  it("按权威块保留图文顺序，并只归档一次重复图片", () => {
    const plan = buildNotesExportPlan({
      notes: [
        baseNote({
          title: "发布说明",
          tags: ["交付"],
          contentBlocks: [
            { type: "text", text: "第一段" },
            { type: "image", file: "img-a.png", alt: "示意图" },
            { type: "text", text: "第二段" },
            { type: "image", file: "img-a.png" },
          ],
        }),
      ],
      sections,
      exportedAtMs: new Date(2026, 7, 22, 10, 30).getTime(),
    });

    expect(plan.mediaFiles).toEqual(["img-a.png"]);
    expect(plan.noteCount).toBe(1);
    expect(plan.markdown).toContain("## 发布说明");
    expect(plan.markdown).toContain("分组：收件箱");
    expect(plan.markdown).toContain("标签：#交付");
    expect(plan.markdown.indexOf("第一段")).toBeLessThan(
      plan.markdown.indexOf("![示意图](media/img-a.png)")
    );
    expect(plan.markdown.indexOf("![示意图](media/img-a.png)")).toBeLessThan(
      plan.markdown.indexOf("第二段")
    );
    expect(plan.markdown.match(/media\/img-a\.png/g)).toHaveLength(2);
  });

  it("把纯文本放入自适应围栏，避免 HTML 与远程图片被导出预览激活", () => {
    const plan = buildNotesExportPlan({
      notes: [baseNote({ text: "<script>x</script>\n![追踪](https://example.com/p.gif)\n```" })],
      sections,
    });

    expect(plan.markdown).toContain(
      "````text\n<script>x</script>\n![追踪](https://example.com/p.gif)\n```\n````"
    );
  });

  it("兼容旧图片卡并去掉自动尺寸占位正文", () => {
    const plan = buildNotesExportPlan({
      notes: [
        baseNote({
          kind: "image",
          text: "图片 120×80",
          imageFile: "img-main.png",
          attachments: ["img-more.png"],
        }),
      ],
      sections,
    });

    expect(plan.markdown).not.toContain("图片 120×80");
    expect(plan.markdown).toContain("media/img-main.png");
    expect(plan.markdown).toContain("media/img-more.png");
    expect(plan.mediaFiles).toEqual(["img-main.png", "img-more.png"]);
  });

  it.each([
    baseNote({ kind: "secret" }),
    baseNote({ sectionId: SECRET_ID }),
    baseNote({ sectionId: CLIPBOARD_ID }),
  ])("拒绝秘文和剪贴历史混入普通笔记包", (note) => {
    expect(() => buildNotesExportPlan({ notes: [note], sections })).toThrow(
      "秘文与剪贴历史不能作为普通笔记导出"
    );
  });

  it("转义标题和图片 alt，生成不含笔记标题的稳定文件名", () => {
    const plan = buildNotesExportPlan({
      notes: [
        baseNote({
          title: "标题\n#二级",
          contentBlocks: [{ type: "image", file: "img-a.png", alt: "a](b\n图" }],
        }),
      ],
      sections,
    });

    expect(plan.markdown).toContain("## 标题 \\#二级");
    expect(plan.markdown).toContain("![a\\](b 图](media/img-a.png)");
    expect(notesExportFilename(3, new Date(2026, 7, 22).getTime())).toBe(
      "Toskr-笔记-2026-08-22-3条.zip"
    );
  });
});
