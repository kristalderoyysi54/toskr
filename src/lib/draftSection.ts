import {
  CLIPBOARD_ID,
  INBOX_ID,
  type Section,
} from "@/store/notesStore";

/** 剪贴板历史是只读捕获域，不作为手工新增卡片的目标。 */
export function draftTargetSections(sections: Section[]): Section[] {
  return sections.filter((section) => section.id !== CLIPBOARD_ID);
}

/** 上次选择仍有效则沿用；首次使用或分组已删除时落到当前排序第一组。 */
export function resolveDraftSectionId(
  sections: Section[],
  lastSectionId: string | null
): string {
  const targets = draftTargetSections(sections);
  return targets.some((section) => section.id === lastSectionId)
    ? lastSectionId!
    : (targets[0]?.id ?? INBOX_ID);
}
