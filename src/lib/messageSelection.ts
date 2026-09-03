export interface SelectAllKeyGesture {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** 消息页有独立选择态；这里只接管当前活动视图的纯 ⌘A。 */
export function messageSelectAllIds(
  event: SelectAllKeyGesture,
  visibleIds: readonly string[],
  context: { active: boolean; editable: boolean }
): string[] | null {
  if (
    !context.active ||
    context.editable ||
    event.key.toLocaleLowerCase() !== "a" ||
    !event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    event.shiftKey
  ) {
    return null;
  }
  return [...visibleIds];
}
