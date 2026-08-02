import type { Note } from "@/store/notesStore";

/** 笔记是否命中搜索词（大小写不敏感，匹配文本与来源应用名）。 */
export function matchNote(note: Note, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    note.text.toLowerCase().includes(q) ||
    (note.sourceApp?.toLowerCase().includes(q) ?? false)
  );
}

/** 把文本按命中片段切分，供高亮渲染：[{ text, hit }]。 */
export function splitHighlight(
  text: string,
  query: string
): { text: string; hit: boolean }[] {
  const q = query.trim();
  if (!q) return [{ text, hit: false }];
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const parts: { text: string; hit: boolean }[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const idx = lower.indexOf(needle, cursor);
    if (idx < 0) {
      parts.push({ text: text.slice(cursor), hit: false });
      break;
    }
    if (idx > cursor) parts.push({ text: text.slice(cursor, idx), hit: false });
    parts.push({ text: text.slice(idx, idx + needle.length), hit: true });
    cursor = idx + needle.length;
  }
  return parts.length ? parts : [{ text, hit: false }];
}
