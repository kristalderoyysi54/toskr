import type { FirewallFinding } from "@/lib/tauri";

export interface FindingSegment {
  text: string;
  /** 命中项；普通文字为 undefined。 */
  finding?: FirewallFinding;
}

/** 按 UTF-16 范围把正文切成「普通 / 命中」片段（P2）；重叠或越界的命中按先到先得跳过。 */
export function sliceFindingSegments(
  text: string,
  findings: readonly FirewallFinding[]
): FindingSegment[] {
  const sorted = [...findings]
    .filter((f) => f.startUtf16 >= 0 && f.endUtf16 > f.startUtf16 && f.endUtf16 <= text.length)
    .sort((a, b) => a.startUtf16 - b.startUtf16);
  const out: FindingSegment[] = [];
  let cursor = 0;
  for (const finding of sorted) {
    if (finding.startUtf16 < cursor) continue;
    if (finding.startUtf16 > cursor) out.push({ text: text.slice(cursor, finding.startUtf16) });
    out.push({ text: text.slice(finding.startUtf16, finding.endUtf16), finding });
    cursor = finding.endUtf16;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor) });
  return out;
}

/** 最终文本里的占位符片段（P3 预演高亮）：按占位符字面切分。 */
export function slicePlaceholderSegments(
  text: string,
  placeholders: readonly string[]
): { text: string; placeholder: boolean }[] {
  const unique = [...new Set(placeholders.filter(Boolean))].sort((a, b) => b.length - a.length);
  if (unique.length === 0 || !text) return text ? [{ text, placeholder: false }] : [];
  const pattern = new RegExp(unique.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  const out: { text: string; placeholder: boolean }[] = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cursor) out.push({ text: text.slice(cursor, start), placeholder: false });
    out.push({ text: match[0], placeholder: true });
    cursor = start + match[0].length;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), placeholder: false });
  return out;
}
