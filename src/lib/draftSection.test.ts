import { describe, expect, it } from "vitest";

import { draftTargetSections, resolveDraftSectionId } from "./draftSection";
import { CLIPBOARD_ID, INBOX_ID, type Section } from "@/store/notesStore";

const sections: Section[] = [
  { id: CLIPBOARD_ID, name: "剪贴板" },
  { id: "project", name: "项目" },
  { id: INBOX_ID, name: "收件箱" },
];

describe("新增卡片目标分组", () => {
  it("首次使用落到当前排序第一的可写分组，而不是固定收件箱", () => {
    expect(resolveDraftSectionId(sections, null)).toBe("project");
  });

  it("记住上次选择，切页重新挂载后仍解析到同一分组", () => {
    expect(resolveDraftSectionId(sections, INBOX_ID)).toBe(INBOX_ID);
  });

  it("忽略剪贴板组，已记住的分组被删除后回退到当前第一组", () => {
    expect(draftTargetSections(sections).map((section) => section.id)).toEqual([
      "project",
      INBOX_ID,
    ]);
    expect(resolveDraftSectionId(sections, "deleted")).toBe("project");
  });
});
