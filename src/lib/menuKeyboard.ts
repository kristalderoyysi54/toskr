import type { KeyboardEvent as ReactKeyboardEvent } from "react";

/** 菜单内按键不能同时操作底层卡片；Enter/Space 仍交给原生按钮激活。 */
export function handleSimpleMenuKeyDown(event: Pick<ReactKeyboardEvent<HTMLDivElement>, "key" | "currentTarget" | "stopPropagation" | "preventDefault">) {
  event.stopPropagation();
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>(
      "[data-simple-menu-item]:not(:disabled)"
    )
  );
  if (items.length === 0) return;
  event.preventDefault();
  const currentIndex = items.indexOf(event.currentTarget.ownerDocument.activeElement as HTMLButtonElement);
  const nextIndex = event.key === "Home"
    ? 0
    : event.key === "End"
      ? items.length - 1
      : event.key === "ArrowUp"
        ? (currentIndex - 1 + items.length) % items.length
        : (currentIndex + 1 + items.length) % items.length;
  items[nextIndex]?.focus();
}

export function handleSimpleMenuEscape(event: KeyboardEvent, closeAndRestoreFocus: () => void) {
  if (event.key !== "Escape") return;
  event.preventDefault();
  // 同一 window 上还可能有面板快捷键监听；必须连同该事件的后续监听一起阻断。
  event.stopImmediatePropagation();
  closeAndRestoreFocus();
}

export function handlePanelPlacementKeyDown(
  event: ReactKeyboardEvent<HTMLDivElement>,
  placementOpen: boolean,
  setPlacementOpen: (open: boolean) => void
) {
  const target = event.target as HTMLElement;
  if (!target.closest('[role="menu"][data-state="open"]')) return;
  if (placementOpen && event.key === "ArrowLeft") {
    event.preventDefault();
    event.stopPropagation();
    setPlacementOpen(false);
  } else if (!placementOpen && event.key === "ArrowRight" &&
    target.closest("button")?.querySelector("[data-panel-placement]")) {
    event.preventDefault();
    event.stopPropagation();
    setPlacementOpen(true);
  }
}
