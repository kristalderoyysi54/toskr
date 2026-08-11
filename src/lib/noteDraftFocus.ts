const NOTE_DRAFT_FIELD_SELECTOR = "[data-note-draft-input] textarea";

/**
 * 分组头等远端入口复用底部笔记输入框；下一帧聚焦，确保分组目标已先刷新。
 */
export function focusNoteDraftInput(): void {
  window.requestAnimationFrame(() => {
    document.querySelector<HTMLTextAreaElement>(NOTE_DRAFT_FIELD_SELECTOR)?.focus();
  });
}
