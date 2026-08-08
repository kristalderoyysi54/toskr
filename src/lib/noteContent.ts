import { detectCode } from "@/lib/code";
import { detectLink } from "@/lib/link";

/** 文本编辑后的卡片类型归一化；详情窗与主 Store 必须共用同一判定。 */
export function normalizeNoteContent(draft: string, hasImages: boolean) {
  const text = draft.trim();
  const url = hasImages ? null : (detectLink(text) ?? null);
  const codeLang = url || !text ? null : (detectCode(text) ?? null);
  const kind = hasImages ? (text ? "text" : "image") : url ? "link" : "text";

  return { text, kind, url, codeLang } as const;
}
