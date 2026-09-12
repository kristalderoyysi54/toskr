/** 右键菜单最宽的一档（NoteCard w-56 = 224px）；判断指针两侧能否放下时按它算。 */
const CONTEXT_MENU_WIDTH = 224
const CONTEXT_MENU_SIDE_OFFSET = 2
const CONTEXT_MENU_PADDING = 8

/**
 * Radix 右键菜单固定 side=right、align=start，避让只沿对齐轴：指针落在面板中段时
 * 左右都放不下，菜单会横向出界被面板窗口裁掉（用户 2026-09-11 截图）。
 * 两侧都不够时把锚点 x 挪到「余量更大的一侧刚好放下」的位置；菜单离指针最多偏几十 px，
 * 但保证完整可见。纯函数，可测。
 */
export function clampedContextMenuX(
  pointerX: number,
  viewportWidth: number,
  menuWidth = CONTEXT_MENU_WIDTH
): number {
  const need = menuWidth + CONTEXT_MENU_SIDE_OFFSET + CONTEXT_MENU_PADDING
  if (pointerX + need <= viewportWidth || pointerX - need >= 0) return pointerX
  return viewportWidth - pointerX >= pointerX
    ? Math.max(0, viewportWidth - need)
    : Math.min(viewportWidth, need)
}

