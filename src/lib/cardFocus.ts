/** 隐藏页里的焦点卡不能触发 scrollIntoView，否则会横向滚动页面滑层。 */
export function shouldScrollFocusedCard(
  focused: boolean,
  insideHiddenPage: boolean,
  pointerFocused = false
): boolean {
  return focused && !insideHiddenPage && !pointerFocused;
}
