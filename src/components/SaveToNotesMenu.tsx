import { Folder, FolderInput, Inbox } from "lucide-react";

import { SimpleMenu, SimpleMenuItem, SimpleMenuLabel } from "@/components/SimpleMenu";
import { IconButton } from "@/components/ui/icon-button";
import type { NoteSectionOption } from "@/lib/noteSections";
import { INBOX_ID } from "@/store/notesStore";

/** 分组菜单项：收件箱用收件箱图标，其余用分组色文件夹。 */
export function NoteSectionMenuItems({
  sections,
  onPick,
  close,
}: {
  sections: readonly NoteSectionOption[];
  onPick: (sectionId: string) => void;
  close: () => void;
}) {
  return (
    <>
      {sections.map((section) => (
        <SimpleMenuItem key={section.id} title={section.name} onClick={() => {
          close();
          onPick(section.id);
        }}>
          {section.id === INBOX_ID
            ? <Inbox className="size-3.5 shrink-0" />
            : <Folder className="size-3.5 shrink-0" style={{ color: section.color }} />}
          <span className="min-w-0 flex-1 truncate">{section.name}</span>
        </SimpleMenuItem>
      ))}
    </>
  );
}

/** 剪贴详情页「存入笔记」：点开即选分组（详情页空间充裕，不走卡片的单击/长按二段式）。 */
export function SaveToNotesMenu({
  sections,
  onPick,
  size,
  side = "bottom",
}: {
  sections: readonly NoteSectionOption[];
  onPick: (sectionId: string) => void;
  size?: "xs";
  side?: "top" | "bottom";
}) {
  if (!sections.length) return null;
  return (
    <SimpleMenu
      portal
      side={side}
      className="flex"
      menuAriaLabel="存入笔记分组"
      menuClassName="w-52"
      trigger={({ open, toggle, controls }) => (
        <IconButton
          label="存入笔记分组"
          size={size}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? controls : undefined}
          onClick={toggle}
        >
          <FolderInput className="size-3.5" />
        </IconButton>
      )}
    >
      {(close) => (
        <>
          <SimpleMenuLabel>存入笔记分组</SimpleMenuLabel>
          <NoteSectionMenuItems sections={sections} onPick={onPick} close={close} />
        </>
      )}
    </SimpleMenu>
  );
}
