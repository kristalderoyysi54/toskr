export const LARGE_TEXT_PREVIEW_THRESHOLD = 100_000;
export const LARGE_TEXT_PREVIEW_CHARS = 12_000;

export function planTextPreviewRender(text: string) {
  const deferred = text.length > LARGE_TEXT_PREVIEW_THRESHOLD;
  return {
    deferred,
    warmupText: deferred
      ? `${text.slice(0, LARGE_TEXT_PREVIEW_CHARS)}…`
      : text,
  };
}
