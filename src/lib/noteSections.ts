import { CLIPBOARD_ID, SECRET_ID, type Section } from "@/store/notesStore";

/** 剪贴卡可存入的笔记分组（详情窗没有 store，经 payload 传入同一形状）。 */
export type NoteSectionOption = Pick<Section, "id" | "name" | "color">;

export function noteSectionOptions(sections: readonly Section[]): NoteSectionOption[] {
  return sections
    .filter((section) => section.id !== CLIPBOARD_ID && section.id !== SECRET_ID)
    .map(({ id, name, color }) => ({ id, name, color }));
}
