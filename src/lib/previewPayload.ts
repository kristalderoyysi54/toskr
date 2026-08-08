import type { NotePreviewPayload } from "@/lib/actions";
import { looksLikeMarkdown } from "@/lib/markdown";
import { normalizeNoteContent } from "@/lib/noteContent";

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
