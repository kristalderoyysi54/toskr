import type { NotePreviewPayload } from "@/lib/actions";
import { looksLikeMarkdown } from "@/lib/markdown";
import { normalizeNoteContent } from "@/lib/noteContent";

export const NOTE_EDITOR_INSERT_EVENT = "toskr://note-editor-insert";
export const NOTE_EDITOR_INSERT_RESULT_EVENT =
  "toskr://note-editor-insert-result";

export type NoteEditorInsertPayload = {
  requestId: string;
  operationKey: string;
  expiresAt: number;
  targetId: string;
  targetSessionId: string;
  text: string;
  images: string[];
  dataGeneration: number;
};

export type NoteEditorInsertResultPayload = {
  requestId: string;
  targetId: string;
  targetSessionId: string;
  dataGeneration: number;
  status: "applied" | "rejected";
  reason?: string;
};

export const EDITOR_INSERT_REQUEST_TTL_MS = 1500;
export const EDITOR_INSERT_OPERATION_TTL_MS = 5000;
const EDITOR_INSERT_CACHE_MAX = 32;

export function previewIsEditable(
  note: NotePreviewPayload | null
): note is NotePreviewPayload {
  return !!note && note.readOnly !== true;
}

export function editorInsertRejectionReason(
  currentNote: NotePreviewPayload | null,
  payload: NoteEditorInsertPayload,
  now = Date.now()
) {
  if (
    !currentNote ||
    currentNote.id !== payload.targetId ||
    currentNote.sessionId !== payload.targetSessionId ||
    currentNote.dataGeneration !== payload.dataGeneration
  ) {
    return "卡片编辑目标或数据上下文已变化";
  }
  if (!previewIsEditable(currentNote)) {
    return "当前内容为只读预览";
  }
  if (!Number.isFinite(payload.expiresAt) || payload.expiresAt <= now) {
    return "卡片编辑请求已过期";
  }
  return null;
}

export function hasRecentEditorInsertOperation(
  operations: Map<string, number>,
  operationKey: string,
  now = Date.now()
) {
  for (const [key, expiresAt] of operations) {
    if (expiresAt <= now) operations.delete(key);
  }
  return (operations.get(operationKey) ?? 0) > now;
}

export function rememberEditorInsertOperation(
  operations: Map<string, number>,
  operationKey: string,
  now = Date.now()
) {
  operations.set(operationKey, now + EDITOR_INSERT_OPERATION_TTL_MS);
  while (operations.size > EDITOR_INSERT_CACHE_MAX) {
    const oldest = operations.keys().next().value as string | undefined;
    if (!oldest) break;
    operations.delete(oldest);
  }
}

/** 把剪贴板卡内容作为新段落追加到编辑草稿，附件按文件名稳定去重。 */
export function appendPreviewContent(
  currentText: string,
  currentImages: string[],
  incomingText: string,
  incomingImages: string[]
) {
  const incoming = incomingText.trim();
  const separator =
    !incoming || !currentText.trim()
      ? ""
      : currentText.endsWith("\n\n")
        ? ""
        : currentText.endsWith("\n")
          ? "\n"
          : "\n\n";
  const text = incoming ? `${currentText}${separator}${incoming}` : currentText;
  const images = [...new Set([...currentImages, ...incomingImages])];
  return {
    text,
    images,
    selection: { start: text.length, end: text.length },
  };
}

/** Keep the reusable detail window in lockstep with the main note store. */
export function refreshPreviewPayload(note: NotePreviewPayload, draft: string) {
  const { text, kind, url, codeLang } = normalizeNoteContent(
    draft,
    note.images.length > 0
  );
  const payload: NotePreviewPayload = {
    ...note,
    text,
    kind,
    url,
    codeLang,
  };

  return {
    payload,
    markdownView:
      !codeLang && kind !== "link" && looksLikeMarkdown(payload.text),
  };
}
