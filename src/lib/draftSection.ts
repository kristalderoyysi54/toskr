import {
  CLIPBOARD_ID,
  INBOX_ID,
  SECRET_ID,
  type Section,
} from "@/store/notesStore";

/**
 * 剪贴板历史与秘文都是专用域，不作为手工新增卡片的目标。
 * 排除秘文组尤为关键：否则明文笔记可被移入秘文组，笔记页按 kind 过滤看不到、
 * 秘文页也按 kind 过滤看不到，卡片会「凭空消失」。
 */
export function draftTargetSections(sections: Section[]): Section[] {
  return sections.filter(
    (section) => section.id !== CLIPBOARD_ID && section.id !== SECRET_ID
  );
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
