import { detectCode } from "@/lib/code";
import { detectLink } from "@/lib/link";
import { looksLikeMarkdown } from "@/lib/markdownDetection";

/** 文本编辑后的卡片类型归一化；详情窗与主 Store 必须共用同一判定。 */
export function normalizeNoteContent(
  draft: string,
  hasImages: boolean,
  preferMarkdown = false
) {
  const text = draft.trim();
  const markdown = preferMarkdown && looksLikeMarkdown(text);
  const url = hasImages || markdown ? null : (detectLink(text) ?? null);
  const codeLang = url || !text || markdown ? null : (detectCode(text) ?? null);
  const kind = hasImages ? (text ? "text" : "image") : url ? "link" : "text";

  return { text, kind, url, codeLang } as const;
}

/** 新增 Markdown 语法表示显式格式意图；已有代码 glob 不应被误判。 */
export function normalizeEditedNoteContent(
  previous: {
    text: string;
    kind?: string | null;
    codeLang?: string | null;
    url?: string | null;
  },
  draft: string,
  hasImages: boolean
) {
  const previousLooksMarkdown = looksLikeMarkdown(previous.text);
  const previousWasMarkdown =
    previousLooksMarkdown &&
    !previous.codeLang &&
    previous.kind !== "link" &&
    !previous.url;
  const preferMarkdown =
    looksLikeMarkdown(draft) &&
    (previousWasMarkdown || !previousLooksMarkdown);
  return normalizeNoteContent(draft, hasImages, preferMarkdown);
}
