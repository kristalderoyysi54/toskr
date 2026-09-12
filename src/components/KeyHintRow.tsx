import { Kbd } from "@/components/ui/kbd";
import { keyHintsFor } from "@/lib/commandItems";
import { useNotesStore } from "@/store/notesStore";
import { useUIStore } from "@/store/uiStore";

/** 列表底部随焦点上下文变化的快捷键提示行；长按 Option 显示完整速查表。 */
export function KeyHintRow() {
  const page = useUIStore((s) => s.page);
  const contentSubview = useUIStore((s) => s.contentSubview);
  const editing = useUIStore((s) => s.editingId !== null);
  const searchOpen = useUIStore((s) => s.searchOpen);
  const focusedNote = useUIStore((s) => s.focusedId !== null);
  const checkedCount = useNotesStore((s) => s.checkedIds.length);
  const hints = keyHintsFor({ page, contentSubview, editing, searchOpen, focusedNote, checkedCount });
  return (
    <div
      aria-hidden
      className="mx-3 flex h-5 shrink-0 items-center gap-2.5 overflow-hidden whitespace-nowrap text-micro text-muted-foreground"
    >
      {hints.map(([key, desc]) => (
        <span key={key + desc} className="inline-flex items-center gap-1">
          <Kbd inline>{key}</Kbd>
          {desc}
        </span>
      ))}
    </div>
  );
}
