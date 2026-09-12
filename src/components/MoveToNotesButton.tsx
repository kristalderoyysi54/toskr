import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Folder, Inbox } from "lucide-react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import { SimpleMenu, SimpleMenuItem, SimpleMenuLabel } from "@/components/SimpleMenu";
import { IconButton } from "@/components/ui/icon-button";
import { createLongPress } from "@/lib/longPress";
import { CLIPBOARD_ID, INBOX_ID, SECRET_ID, useNotesStore } from "@/store/notesStore";
import { useUIStore } from "@/store/uiStore";

/** 单击收件箱、长按选分类；沿用卡片的多选感知移动回调。 */
export function MoveToNotesButton({
  onMove,
  onMenuOpen,
}: {
  onMove: (sectionId?: string) => void;
  onMenuOpen: () => void;
}) {
  const sections = useNotesStore((state) => state.sections);
  const page = useUIStore((state) => state.page);
  const visible = useUIStore((state) => state.open);
  const [pressing, setPressing] = useState(false);
  const openMenu = useRef<() => void>(() => {});
  const closeMenu = useRef<() => void>(() => {});
  const press = useMemo(() => createLongPress(() => openMenu.current()), []);
  const cancel = useCallback(() => { press.cancel(); setPressing(false); }, [press]);
  useEffect(() => {
    press.cancel();
    closeMenu.current();
    setPressing(false);
  }, [page, visible, press]);
  useEffect(() => {
    if (!pressing) return;
    const onHidden = () => { if (document.hidden) cancel(); };
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", onHidden);
    const unlisten = getCurrentWebviewWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused) cancel();
    });
    return () => {
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", onHidden);
      void unlisten.then((fn) => fn()).catch(() => {});
    };
  }, [pressing, cancel]);
  useEffect(() => () => press.cancel(), [press]);

  return (
    <SimpleMenu
      portal
      side="top"
      className="flex"
      menuAriaLabel="移入笔记分类"
      menuClassName="w-52"
      onOpenChange={(open) => { if (open) onMenuOpen(); }}
      trigger={({ open, toggle, controls }) => {
        openMenu.current = () => { if (!open) toggle(); };
        closeMenu.current = () => { if (open) toggle(); };
        return (
          <IconButton
            label="移入笔记（长按选择分类）"
            surface
            reveal={open ? "always" : "hover-focus"}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={open ? controls : undefined}
            className="touch-none"
            onPointerDown={(event) => {
              event.stopPropagation();
              if (event.button === 0 && event.isPrimary) {
                setPressing(true);
                press.start(event.clientX, event.clientY);
              }
            }}
            onPointerMove={(event) => press.move(event.clientX, event.clientY)}
            onPointerUp={() => { press.release(); setPressing(false); }}
            onPointerLeave={cancel}
            onPointerCancel={cancel}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") event.stopPropagation();
            }}
            onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
            onClick={(event) => {
              const suppressed = press.consumeClick();
              if (event.detail !== 0 && suppressed) return;
              if (open) { toggle(); return; }
              press.release();
              onMove();
            }}
          >
            <Inbox className="size-3" />
          </IconButton>
        );
      }}
    >
      {(close) => (
        <>
          <SimpleMenuLabel>移入笔记分类</SimpleMenuLabel>
          {sections.filter((section) => section.id !== CLIPBOARD_ID && section.id !== SECRET_ID)
            .map((section) => (
              <SimpleMenuItem key={section.id} title={section.name} onClick={() => {
                close();
                onMove(section.id);
              }}>
                {section.id === INBOX_ID
                  ? <Inbox className="size-3.5 shrink-0" />
                  : <Folder className="size-3.5 shrink-0" style={{ color: section.color }} />}
                <span className="min-w-0 flex-1 truncate">{section.name}</span>
              </SimpleMenuItem>
            ))}
        </>
      )}
    </SimpleMenu>
  );
}
