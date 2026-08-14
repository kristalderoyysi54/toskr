import type { Note } from "@/store/notesStore";

/**
 * 笔记是否命中搜索词（大小写不敏感，匹配文本、自定义标题、来源应用名与标签）。
 * `#词` 语法只按标签前缀匹配（快速筛出同标签卡片，不混入正文命中）。
 */
export function matchNote(note: Note, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (q.startsWith("#")) {
    const needle = q.slice(1).trim();
    if (!needle) return true;
    return (
      note.tags?.some((tag) => tag.toLowerCase().startsWith(needle)) ?? false
    );
  }
  return (
    note.text.toLowerCase().includes(q) ||
    (note.title?.toLowerCase().includes(q) ?? false) ||
    (note.sourceApp?.toLowerCase().includes(q) ?? false) ||
    (note.tags?.some((tag) => tag.toLowerCase().includes(q)) ?? false)
  );
}

/**
 * 秘文卡搜索：只按密钥名（keyLabel）、自定义标题、来源应用、标签命中，
 * 绝不索引密文正文——明文不落盘，密文匹配既无意义又会误命中。
 */
export function matchSecretNote(note: Note, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (q.startsWith("#")) {
    const needle = q.slice(1).trim();
    if (!needle) return true;
    return note.tags?.some((tag) => tag.toLowerCase().startsWith(needle)) ?? false;
  }
  return (
    (note.secretMeta?.keyLabel?.toLowerCase().includes(q) ?? false) ||
    (note.title?.toLowerCase().includes(q) ?? false) ||
    (note.sourceApp?.toLowerCase().includes(q) ?? false) ||
    (note.tags?.some((tag) => tag.toLowerCase().includes(q)) ?? false)
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
