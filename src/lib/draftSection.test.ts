import { describe, expect, it } from "vitest";

import {
  draftTargetSections,
  resolveCaptureSectionId,
  resolveDraftSectionId,
} from "./draftSection";
import { CLIPBOARD_ID, INBOX_ID, SECRET_ID, type Section } from "@/store/notesStore";

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

describe("双击捕获目标分组", () => {
  it("未设置时固定收件箱，不跟随排序第一组", () => {
    expect(resolveCaptureSectionId(sections, null)).toBe(INBOX_ID);
  });

  it("设置的分组有效时存入该组", () => {
    expect(resolveCaptureSectionId(sections, "project")).toBe("project");
  });

  it("分组已删除或指向剪贴板/秘文专用域时回收件箱", () => {
    expect(resolveCaptureSectionId(sections, "deleted")).toBe(INBOX_ID);
    expect(resolveCaptureSectionId(sections, CLIPBOARD_ID)).toBe(INBOX_ID);
    expect(resolveCaptureSectionId([...sections, { id: SECRET_ID, name: "秘文" }], SECRET_ID)).toBe(INBOX_ID);
  });
});
