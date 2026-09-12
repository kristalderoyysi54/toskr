import { noteContentBlocks, textBlockRanges, textFromContentBlocks } from "@/lib/noteContentBlocks";
import { imageCaption } from "@/lib/format";
import type { DeliverySegment } from "@/lib/tauri";
import type { Note } from "@/store/notesStore";
import type { DeliveryDraft } from "./types";

type ImageAnchor = { offset: number; fileIndex: number };
export type TextReplacement = { startUtf16: number; endUtf16: number; replacement: string };

function fromAnchors(text: string, anchors: ImageAnchor[]): DeliverySegment[] {
  const encoder = new TextEncoder();
  const result: DeliverySegment[] = [];
  let offset = 0;
  let bytes = 0;
  for (const anchor of [...anchors, { offset: text.length, fileIndex: -1 }]) {
    const piece = text.slice(offset, anchor.offset);
    const end = bytes + encoder.encode(piece).length;
    if (piece.trim()) result.push({ kind: "text", start: bytes, end });
    if (anchor.fileIndex >= 0) result.push({ kind: "image", fileIndex: anchor.fileIndex });
    offset = anchor.offset;
    bytes = end;
  }
  return result;
}

/** 多卡编号正文仍沿用 buildSendText；图片以正文位置绑定，不另造一份正文。 */
export function orderedSourceSegments(notes: readonly Note[], text: string, files: readonly string[]): DeliverySegment[] | null {
  const captions = notes.map(note => note.kind === "image" ? imageCaption(note) || null : note.text);
  const count = captions.filter(value => value !== null).length;
  const anchors: ImageAnchor[] = [];
  const used = new Set<string>();
  let assembled = "";
  let number = 0;
  for (let index = 0; index < notes.length; index++) {
    const caption = captions[index];
    const blocks = noteContentBlocks(notes[index]);
    if (caption !== null && textFromContentBlocks(blocks) !== caption) return null;
    if (caption !== null && number > 0) assembled += "\n";
    if (caption !== null && count > 1) assembled += `${number + 1}. `;
    const base = assembled.length;
    const ranges = textBlockRanges(blocks);
    let local = 0;
    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
      const block = blocks[blockIndex];
      if (block.type === "text") {
        local = caption === null ? 0 : ranges.find(range => range.blockIndex === blockIndex)!.end;
      } else if (!used.has(block.file)) {
        const fileIndex = files.indexOf(block.file);
        if (fileIndex < 0) return null;
        anchors.push({ offset: base + local, fileIndex });
        used.add(block.file);
      }
    }
    if (caption !== null) { assembled += caption; number++; }
  }
  return assembled === text && used.size === files.length && files.length > 0
    ? fromAnchors(text, anchors) : null;
}

function imageAnchors(text: string, segments: readonly DeliverySegment[]): ImageAnchor[] | null {
  const bytes = new TextEncoder().encode(text);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const anchors: ImageAnchor[] = [];
  let end = 0;
  try {
    for (const segment of segments) {
      if (segment.kind === "image") {
        anchors.push({ offset: decoder.decode(bytes.slice(0, end)).length, fileIndex: segment.fileIndex });
      } else {
        if (segment.start < end || segment.end <= segment.start || segment.end > bytes.length) return null;
        if (decoder.decode(bytes.slice(end, segment.start)).trim()) return null;
        decoder.decode(bytes.slice(segment.start, segment.end));
        end = segment.end;
      }
    }
    if (decoder.decode(bytes.slice(end)).trim()) return null;
  } catch { return null; }
  return anchors;
}

/** 模板只出现一次正文时保留块序；重复正文无法一对一对应图片，显式降级。 */
export function wrapOrderedSegments(source: string, wrapped: string, segments: readonly DeliverySegment[] | null): DeliverySegment[] | null {
  if (!segments) return null;
  const anchors = imageAnchors(source, segments);
  if (!anchors) return null;
  const start = source ? wrapped.indexOf(source) : wrapped.length;
  if (start < 0 || (source && wrapped.indexOf(source, start + source.length) >= 0)) return null;
  return fromAnchors(wrapped, anchors.map(anchor => ({ ...anchor, offset: start + anchor.offset })));
}

/** 按确定的替换区间更新图片位置；跨图片的替换不可解释，拒绝猜测位置。 */
export function remapOrderedSegments(before: string, after: string, segments: readonly DeliverySegment[] | null, replacements: readonly TextReplacement[]): DeliverySegment[] | null {
  if (!segments) return null;
  const anchors = imageAnchors(before, segments);
  if (!anchors) return null;
  const edits = [...replacements].sort((a, b) => a.startUtf16 - b.startUtf16);
  let rebuilt = "", cursor = 0;
  for (const edit of edits) {
    if (typeof edit.replacement !== "string" || edit.startUtf16 < cursor || edit.endUtf16 < edit.startUtf16 || edit.endUtf16 > before.length) return null;
    rebuilt += before.slice(cursor, edit.startUtf16) + edit.replacement;
    cursor = edit.endUtf16;
  }
  rebuilt += before.slice(cursor);
  if (rebuilt !== after) return null;
  const mapped: ImageAnchor[] = [];
  for (const anchor of anchors) {
    let offset = anchor.offset;
    for (const edit of edits) {
      if (edit.startUtf16 < anchor.offset && edit.endUtf16 > anchor.offset) return null;
      if (edit.endUtf16 <= anchor.offset) offset += edit.replacement.length - (edit.endUtf16 - edit.startUtf16);
    }
    mapped.push({ ...anchor, offset });
  }
  return fromAnchors(after, mapped);
}

/** 预检和实际发送共用同一次段版本/附件完整性检查。 */
export function currentDraftSegments(draft: DeliveryDraft): DeliverySegment[] | undefined {
  const segments = draft.segments;
  if (!segments || draft.finalText !== (draft.segmentsText ?? draft.assembledText)) return undefined;
  const anchors = imageAnchors(draft.finalText, segments);
  if (!anchors || anchors.length !== draft.imageFiles.length ||
      new Set(anchors.map(anchor => anchor.fileIndex)).size !== anchors.length ||
      anchors.some(anchor => !Number.isInteger(anchor.fileIndex) || anchor.fileIndex < 0 || anchor.fileIndex >= draft.imageFiles.length)) return undefined;
  return segments;
}

export function deliverySequencePreview(draft: DeliveryDraft): string[] {
  const bytes = new TextEncoder().encode(draft.finalText);
  const decoder = new TextDecoder();
  const segments = currentDraftSegments(draft) ?? [
    ...(draft.finalText.trim() ? [{ kind: "text" as const, start: 0, end: bytes.length }] : []),
    ...draft.imageFiles.map((_, fileIndex) => ({ kind: "image" as const, fileIndex })),
  ];
  return segments.map(segment => {
    if (segment.kind === "image") return `图片 ${segment.fileIndex + 1}`;
    const text = decoder.decode(bytes.slice(segment.start, segment.end));
    return `文字：${text.slice(0, 80)}${text.length > 80 ? "…" : ""}`;
  });
}
