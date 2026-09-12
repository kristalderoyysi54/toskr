import { listen } from "@tauri-apps/api/event";

import {
  api,
  MENU_FLYOUT_POINTER_EVENT,
  MENU_FLYOUT_SELECT_EVENT,
} from "@/lib/tauri";

/** 子菜单小窗里的一条：主窗口序列化后经 Rust 转发，动作只保留 id，回传后在主窗口执行。 */
export type MenuFlyoutEntry =
  | {
      kind: "item";
      id: string;
      label: string;
      /** lucide 图标名（小窗按白名单映射；缺省无图标）。 */
      icon?: string;
      shortcut?: string;
      disabled?: boolean;
      destructive?: boolean;
    }
  | { kind: "separator"; id: string }
  | { kind: "label"; id: string; label: string };

/** Rust 转发给小窗的整包。 */
export interface MenuFlyoutPayload {
  entries: MenuFlyoutEntry[];
  /** 键盘打开：小窗先高亮首项，方向键由主窗口转发。 */
  keyboard: boolean;
}

export interface MenuFlyoutSource {
  entries: MenuFlyoutEntry[];
  handlers: Map<string, () => void>;
}

/** 条目登记：把 JSX 上的 onClick 换成可回传的 id。 */
export function createMenuFlyoutRegistry(): MenuFlyoutSource & {
  register: (handler: () => void) => string;
} {
  const handlers = new Map<string, () => void>();
  return {
    entries: [],
    handlers,
    register: (handler) => {
      const id = `fly-${handlers.size + 1}`;
      handlers.set(id, handler);
      return id;
    },
  };
}

/** 条目估算高度（pt）：与小窗样式一致，只用于首帧摆放，真实高度由小窗回报。 */
export function estimateMenuFlyoutHeight(entries: MenuFlyoutEntry[]): number {
  return entries.reduce(
    (sum, entry) => sum + (entry.kind === "item" ? 26 : entry.kind === "label" ? 22 : 9),
    8
  );
}

interface ActiveFlyout {
  /** 打开者标识：触发行卸载时只关自己打开的小窗，不误关刚被别的触发行接管的小窗。 */
  owner: object;
  handlers: Map<string, () => void>;
  keyboard: boolean;
  onClose: () => void;
  /** 解除对主菜单滚动的跟随。 */
  detach: () => void;
}

let active: ActiveFlyout | null = null;
let pointerInside = false;
let triggerHovered = false;
let closeTimer: number | null = null;
let listenersArmed = false;

const ESCAPE_KEYS = new Set(["Escape", "ArrowLeft"]);
const FORWARD_KEYS = new Set(["ArrowUp", "ArrowDown", "Home", "End", "Enter", " "]);

function clearCloseTimer() {
  if (closeTimer !== null) {
    window.clearTimeout(closeTimer);
    closeTimer = null;
  }
}

/**
 * 让 Radix 右键菜单整体关闭：ContextMenu.Root 没有受控 open，合成 Escape 又不被
 * DismissableLayer 采信（浏览器实测），改为模拟一次「菜单外 pointerdown」触发 onPointerDownOutside。
 */
function closeHostContextMenu() {
  document.body.dispatchEvent(
    new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", button: 0 })
  );
}

/**
 * 主菜单内容可滚动（面板矮、菜单被 Radix 限高时）：触发行随滚动移动则小窗跟着重摆，
 * 触发行滚出主菜单可视区则收起。按帧合并，避免每个 scroll 事件都过一次 IPC。
 */
function followMenuScroll(menuEl: HTMLElement, rowEl: HTMLElement): () => void {
  let timer: number | null = null;
  const onScroll = () => {
    if (timer !== null) return;
    // 用定时器而非 rAF 合并：窗口不在前台时 rAF 会停摆
    timer = setTimeout(() => {
      timer = null;
      const menu = menuEl.getBoundingClientRect();
      const row = rowEl.getBoundingClientRect();
      const rowMid = (row.top + row.bottom) / 2;
      if (rowMid < menu.top || rowMid > menu.bottom) {
        closeMenuFlyout();
        return;
      }
      void api
        .menuFlyoutMove({ menuLeft: menu.left, menuRight: menu.right, top: row.top })
        .catch(() => {});
    }, 16);
  };
  menuEl.addEventListener("scroll", onScroll, { passive: true });
  return () => {
    menuEl.removeEventListener("scroll", onScroll);
    if (timer !== null) clearTimeout(timer);
  };
}

function armListeners() {
  if (listenersArmed) return;
  listenersArmed = true;
  void listen<{ id: string }>(MENU_FLYOUT_SELECT_EVENT, (event) => {
    const handler = active?.handlers.get(event.payload.id);
    closeMenuFlyout();
    closeHostContextMenu();
    handler?.();
  });
  void listen<{ inside: boolean }>(MENU_FLYOUT_POINTER_EVENT, (event) => {
    pointerInside = event.payload.inside;
    if (pointerInside) {
      clearCloseTimer();
    } else {
      scheduleCloseIfAway();
    }
  });
}

/** 指针既不在小窗也不在触发行时，稍候收起（跨窗口移动会先离开触发行再进入小窗）。 */
function scheduleCloseIfAway() {
  if (!active || active.keyboard) return;
  clearCloseTimer();
  closeTimer = window.setTimeout(() => {
    closeTimer = null;
    if (!pointerInside && !triggerHovered) closeMenuFlyout();
  }, 320);
}

export function isMenuFlyoutOpen(): boolean {
  return active !== null;
}

export function setMenuFlyoutTriggerHovered(hovered: boolean) {
  triggerHovered = hovered;
  if (hovered) clearCloseTimer();
  else scheduleCloseIfAway();
}

export async function openMenuFlyout(options: {
  owner: object;
  anchorEl: HTMLElement;
  width: number;
  source: MenuFlyoutSource;
  keyboard: boolean;
  onClose: () => void;
}) {
  armListeners();
  clearCloseTimer();
  if (active) {
    active.detach();
    if (active.owner !== options.owner) active.onClose();
  }
  const menuEl =
    options.anchorEl.closest<HTMLElement>("[data-slot='context-menu-content']") ??
    options.anchorEl;
  active = {
    owner: options.owner,
    handlers: options.source.handlers,
    keyboard: options.keyboard,
    onClose: options.onClose,
    detach: followMenuScroll(menuEl, options.anchorEl),
  };
  pointerInside = false;
  const menu = menuEl.getBoundingClientRect();
  const row = options.anchorEl.getBoundingClientRect();
  const payload: MenuFlyoutPayload = {
    entries: options.source.entries,
    keyboard: options.keyboard,
  };
  try {
    await api.showMenuFlyout(
      { menuLeft: menu.left, menuRight: menu.right, top: row.top },
      options.width,
      estimateMenuFlyoutHeight(options.source.entries),
      payload
    );
  } catch (error) {
    void api.diagNote(`子菜单小窗打开失败: ${String(error).slice(0, 120)}`).catch(() => {});
    closeMenuFlyout();
  }
}

/** 仅当小窗仍由该打开者持有时关闭（触发行卸载/主菜单关闭时用）。 */
export function closeMenuFlyoutIfOwner(owner: object) {
  if (active && active.owner === owner) closeMenuFlyout();
}

export function closeMenuFlyout() {
  clearCloseTimer();
  if (!active) return;
  const closing = active;
  active = null;
  pointerInside = false;
  closing.detach();
  void api.hideMenuFlyout().catch(() => {});
  closing.onClose();
}

/**
 * 主菜单容器的键盘拦截：小窗打开时方向键/回车转发给小窗，←/Esc 只收起小窗。
 * 返回 true 表示已处理（调用方应停止 Radix 默认导航）。
 */
export function handleMenuFlyoutKeyDown(event: {
  key: string;
  preventDefault: () => void;
  stopPropagation: () => void;
}): boolean {
  if (!active) return false;
  if (ESCAPE_KEYS.has(event.key)) {
    event.preventDefault();
    event.stopPropagation();
    closeMenuFlyout();
    return true;
  }
  if (FORWARD_KEYS.has(event.key)) {
    event.preventDefault();
    event.stopPropagation();
    active.keyboard = true;
    void api.menuFlyoutKey(event.key).catch(() => {});
    return true;
  }
  return false;
}
