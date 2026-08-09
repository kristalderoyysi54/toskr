import { useEffect, useRef } from "react";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuCheckboxItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
} from "toskr";

/** 卡片右键菜单（对应应用内 NoteCard 的操作组）：挂载后自动在热区左上派发
 *  contextmenu 事件，让真实菜单以打开态呈现在卡内。 */
export const Menu = () => {
  const zone = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = zone.current;
    if (!el) return;
    const t = setTimeout(() => {
      const r = el.getBoundingClientRect();
      el.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          clientX: r.left + 28,
          clientY: r.top + 24,
        })
      );
    }, 80);
    return () => clearTimeout(t);
  }, []);

  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <div
          ref={zone}
          style={{
            width: 400,
            height: 300,
            border: "1px dashed rgba(0,0,0,0.2)",
            borderRadius: 10,
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "flex-end",
            padding: 12,
            color: "rgba(0,0,0,0.35)",
            fontSize: 12,
          }}
        >
          在此区域右键打开菜单
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuLabel>卡片操作</ContextMenuLabel>
        <ContextMenuItem>
          编辑内容<ContextMenuShortcut>⌘E</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem>
          复制文本<ContextMenuShortcut>⌘C</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuCheckboxItem checked>置顶</ContextMenuCheckboxItem>
        <ContextMenuSeparator />
        <ContextMenuLabel>优先级</ContextMenuLabel>
        <ContextMenuRadioGroup value="medium">
          <ContextMenuRadioItem value="high">高</ContextMenuRadioItem>
          <ContextMenuRadioItem value="medium">中</ContextMenuRadioItem>
          <ContextMenuRadioItem value="low">低</ContextMenuRadioItem>
        </ContextMenuRadioGroup>
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger>移动到分组</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem>收集箱</ContextMenuItem>
            <ContextMenuItem>工作</ContextMenuItem>
            <ContextMenuItem>灵感</ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive">
          删除卡片<ContextMenuShortcut>⌫</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
};
