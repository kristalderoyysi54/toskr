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

/** 双击捕获的落点：设置的分组仍是可写目标则用它，否则（未设/已删/专用域）回收件箱。 */
export function resolveCaptureSectionId(
  sections: Section[],
  captureSectionId: string | null
): string {
  return draftTargetSections(sections).some((section) => section.id === captureSectionId)
    ? captureSectionId!
    : INBOX_ID;
}

/** 设置窗请求笔记分组列表（设置窗不持有笔记数据），主窗口回 NOTE_SECTIONS。 */
export const NOTE_SECTIONS_REQUEST = "toskr://note-sections-request";
export const NOTE_SECTIONS = "toskr://note-sections";
export interface NoteSectionOption {
  id: string;
  name: string;
}
