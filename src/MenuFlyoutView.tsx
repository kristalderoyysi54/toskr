import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  Check,
  Copy,
  Expand,
  Eye,
  EyeOff,
  FileDown,
  FileText,
  Folder,
  FolderInput,
  Inbox,
  Link2,
  ListChecks,
  ListOrdered,
  Merge,
  Pencil,
  PenLine,
  Plus,
  ScanText,
  Send,
  Sparkles,
  Tag,
  Trash2,
  Wand2,
  type LucideIcon,
} from "lucide-react";

import type { MenuFlyoutEntry, MenuFlyoutPayload } from "@/lib/menuFlyout";
import {
  api,
  MENU_FLYOUT_CLICK_EVENT,
  MENU_FLYOUT_CURSOR_EVENT,
  MENU_FLYOUT_EVENT,
  MENU_FLYOUT_KEY_EVENT,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** 小窗里允许的图标白名单（按 lucide displayName 映射；主窗口序列化时只传名字）。 */
const ICONS: Record<string, LucideIcon> = {
  Check, Copy, Expand, Eye, EyeOff, FileDown, FileText, Folder, FolderInput, Inbox, Link2,
  ListChecks, ListOrdered, Merge, Pencil, PenLine, Plus, ScanText, Send, Sparkles, Tag, Trash2, Wand2,
};

/** 原生 click 与 Rust 轮询点击可能同时到达，同一条目 150ms 内只提交一次。 */
const SELECT_DEDUPE_MS = 150;

/**
 * 右键子菜单独立小窗（menuflyout）：不可聚焦、置顶；条目由主窗口序列化后经 Rust 转发。
 * 悬停高亮与点击兜底由 Rust 光标轮询驱动（不可聚焦窗口收不到 mouseMoved），
 * 键盘导航由主窗口转发；选中后只回传 id，动作在主窗口执行。
 */
export default function MenuFlyoutView() {
  const [payload, setPayload] = useState<MenuFlyoutPayload | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const lastSelect = useRef<{ id: string; at: number } | null>(null);

  const items = payload?.entries.filter(
    (entry): entry is Extract<MenuFlyoutEntry, { kind: "item" }> =>
      entry.kind === "item" && !entry.disabled
  ) ?? [];

  const select = (id: string) => {
    const now = performance.now();
    if (lastSelect.current && lastSelect.current.id === id && now - lastSelect.current.at < SELECT_DEDUPE_MS) {
      return;
    }
    lastSelect.current = { id, at: now };
    void api.menuFlyoutSelect(id).catch(() => {});
  };
  const itemAt = (x: number, y: number) => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-flyout-id]");
    if (!el || el.dataset.flyoutDisabled === "true") return null;
    return el.dataset.flyoutId ?? null;
  };

  useEffect(() => {
    const subs = [
      listen<MenuFlyoutPayload>(MENU_FLYOUT_EVENT, (event) => {
        setPayload(event.payload);
        const first = event.payload.entries.find(
          (entry) => entry.kind === "item" && !entry.disabled
        );
        setHighlight(event.payload.keyboard && first ? first.id : null);
        lastSelect.current = null;
      }),
      listen<{ inside: boolean; x: number; y: number }>(MENU_FLYOUT_CURSOR_EVENT, (event) => {
        if (!event.payload.inside) {
          setHighlight((current) => (payloadRef.current?.keyboard ? current : null));
          return;
        }
        const id = itemAt(event.payload.x, event.payload.y);
        setHighlight(id);
      }),
      listen<{ inside: boolean; x: number; y: number }>(MENU_FLYOUT_CLICK_EVENT, (event) => {
        const id = itemAt(event.payload.x, event.payload.y);
        if (id) select(id);
      }),
      listen<{ key: string }>(MENU_FLYOUT_KEY_EVENT, (event) => {
        const enabled = itemsRef.current;
        if (enabled.length === 0) return;
        const index = enabled.findIndex((entry) => entry.id === highlightRef.current);
        const move = (next: number) => setHighlight(enabled[(next + enabled.length) % enabled.length]!.id);
        switch (event.payload.key) {
          case "ArrowDown": move(index + 1); break;
          case "ArrowUp": move(index <= 0 ? enabled.length - 1 : index - 1); break;
          case "Home": move(0); break;
          case "End": move(enabled.length - 1); break;
          case "Enter":
          case " ":
            if (highlightRef.current) select(highlightRef.current);
            break;
        }
      }),
    ];
    return () => {
      subs.forEach((sub) => void sub.then((stop) => stop()));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 事件回调只读最新值，避免重新订阅
  const payloadRef = useRef(payload);
  payloadRef.current = payload;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const highlightRef = useRef(highlight);
  highlightRef.current = highlight;

  // 渲染后回报真实高度，Rust 按锚点重新夹紧摆放
  useLayoutEffect(() => {
    if (!payload || !boxRef.current) return;
    void api.menuFlyoutResize(boxRef.current.offsetHeight).catch(() => {});
  }, [payload]);

  if (!payload) return <div className="h-screen w-screen" />;
  return (
    // p-3（12px）与 Rust MENU_FLYOUT_SHADOW_PAD 同值：窗口四周这圈透明边距用来画投影，
    // Rust 回报的光标坐标以窗口框左上角为原点；回报高度仍是菜单盒本身
    <div className="h-screen w-screen overflow-hidden p-3 text-foreground">
      <div
        ref={boxRef}
        role="menu"
        aria-label="子菜单"
        // 与 ContextMenuContent 同款材质与投影；小窗本身透明、不带系统阴影
        className="max-h-[560px] overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 [&::-webkit-scrollbar]:hidden"
      >
        {payload.entries.map((entry) => {
          if (entry.kind === "separator") {
            return <div key={entry.id} role="separator" className="-mx-1 my-1 h-px bg-border" />;
          }
          if (entry.kind === "label") {
            return (
              <div key={entry.id} className="px-1.5 py-1 text-micro font-medium text-muted-foreground">
                {entry.label}
              </div>
            );
          }
          const Icon = entry.icon ? ICONS[entry.icon] : undefined;
          const active = highlight === entry.id;
          return (
            <div
              key={entry.id}
              role="menuitem"
              aria-disabled={entry.disabled || undefined}
              data-flyout-id={entry.id}
              data-flyout-disabled={entry.disabled ? "true" : undefined}
              onClick={() => { if (!entry.disabled) select(entry.id); }}
              className={cn(
                "flex cursor-default select-none items-center gap-1.5 rounded-sm px-1.5 py-1 text-sm",
                "[&_svg]:size-3.5 [&_svg]:shrink-0",
                entry.disabled && "opacity-45",
                active && !entry.destructive && "bg-accent text-accent-foreground",
                entry.destructive && "text-destructive",
                active && entry.destructive && "bg-destructive/10 dark:bg-destructive/20"
              )}
            >
              {Icon ? <Icon /> : null}
              <span className="min-w-0 flex-1 truncate">{entry.label}</span>
              {entry.shortcut && (
                <span className="ml-auto text-micro tracking-widest text-muted-foreground">
                  {entry.shortcut}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
