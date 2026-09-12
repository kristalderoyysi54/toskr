import { useEffect, useMemo, useRef, useState } from "react";
import { Command } from "lucide-react";

import { Kbd } from "@/components/ui/kbd";
import { floatingSurface } from "@/components/ui/floating-surface";
import { sendCheckedToChat, sendNotesToChat } from "@/lib/actions";
import { buildCommandItems, type CommandItem } from "@/lib/commandItems";
import { api } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { CLIPBOARD_ID, useNotesStore } from "@/store/notesStore";
import { useUIStore } from "@/store/uiStore";

/**
 * ⌘K 命令面板（O3，2026-09-12）：动作 + 卡片/任务搜索。
 * 键盘接管走 window capture（WKWebView 点击不给焦点的既有约定）；Esc 只关自己。
 */
export function CommandPalette() {
  const open = useUIStore((s) => s.commandPaletteOpen);
  const page = useUIStore((s) => s.page);
  const contentSubview = useUIStore((s) => s.contentSubview);
  const focusedId = useUIStore((s) => s.focusedId);
  const notes = useNotesStore((s) => s.notes);
  const tasks = useNotesStore((s) => s.tasks);
  const checkedCount = useNotesStore((s) => s.checkedIds.length);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const close = () => useUIStore.getState().setCommandPaletteOpen(false);
  const items = useMemo<CommandItem[]>(() => {
    if (!open) return [];
    const ui = useUIStore.getState();
    return buildCommandItems(
      {
        page,
        contentSubview,
        checkedCount,
        focusedNoteId: focusedId,
        notes,
        tasks,
        clipboardSectionId: CLIPBOARD_ID,
        actions: {
          sendChecked: (opts) => void sendCheckedToChat(undefined, opts),
          sendNote: (id, opts) => void sendNotesToChat([id], undefined, opts),
          setPage: (next) => ui.setPage(next),
          addSection: () => useNotesStore.getState().addSection(),
          openSettings: () => void api.openSettingsWindow(),
          openRecentDelivery: () => ui.requestRecentDelivery(),
          openSearch: () => ui.setSearchOpen(true),
          focusNote: (id, target) => {
            ui.setPage(target);
            ui.setFocusedId(id);
            ui.setAnchorId(id);
          },
          focusTask: (id) => {
            ui.setPage("tasks");
            ui.setFocusedId(id);
          },
        },
      },
      query
    );
  }, [open, page, contentSubview, checkedCount, focusedId, notes, tasks, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setCursor(0);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 20);
    return () => window.clearTimeout(timer);
  }, [open]);
  useEffect(() => {
    setCursor(0);
  }, [query]);
  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        setCursor((current) => {
          if (items.length === 0) return 0;
          const next = event.key === "ArrowDown" ? current + 1 : current - 1;
          return (next + items.length) % items.length;
        });
      } else if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        const item = items[cursor];
        if (item) {
          close();
          item.run();
        }
      } else if (event.key === "k" && event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () => window.removeEventListener("keydown", handler, { capture: true });
  }, [open, items, cursor]);
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${cursor}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  if (!open) return null;
  let lastGroup: CommandItem["group"] | null = null;
  return (
    <>
      <div aria-hidden className="absolute inset-0 z-40 bg-black/15 dark:bg-black/35" onClick={close} />
      <div
        role="dialog"
        aria-label="命令面板"
        className={cn("absolute inset-x-3 top-14 z-50 flex max-h-[70%] flex-col rounded-xl p-1.5", floatingSurface(3))}
      >
        <div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
          <Command className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            placeholder="输入命令，或搜索卡片、任务…"
            aria-label="命令或搜索词"
            onChange={(event) => setQuery(event.target.value)}
            className="h-5 min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-muted-foreground"
          />
          <Kbd inline>Esc</Kbd>
        </div>
        <div ref={listRef} role="listbox" aria-label="命令列表" className="min-h-0 flex-1 overflow-y-auto py-1">
          {items.length === 0 && (
            <p className="px-2 py-3 text-center text-label text-muted-foreground">没有匹配的命令或卡片</p>
          )}
          {items.map((item, index) => {
            const showGroup = item.group !== lastGroup;
            lastGroup = item.group;
            return (
              <div key={item.id}>
                {showGroup && (
                  <p className="px-2 pb-0.5 pt-1.5 text-micro font-medium text-muted-foreground">{item.group}</p>
                )}
                <div
                  role="option"
                  aria-selected={index === cursor}
                  data-index={index}
                  onMouseEnter={() => setCursor(index)}
                  onClick={() => {
                    close();
                    item.run();
                  }}
                  className={cn(
                    "flex cursor-default items-center gap-2 rounded-md px-2 py-1 text-body",
                    index === cursor && "bg-accent text-accent-foreground"
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.hint && <span className="shrink-0 text-micro text-muted-foreground">{item.hint}</span>}
                  {item.shortcut && <Kbd inline>{item.shortcut}</Kbd>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
