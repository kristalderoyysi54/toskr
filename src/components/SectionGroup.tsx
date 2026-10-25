import { useRef, useState } from "react";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowDown,
  ArrowUp,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  Pencil,
  Plus,
  Star,
  Trash2,
} from "lucide-react";

import { NoteCard } from "@/components/NoteCard";
import { WindowedListItem } from "@/components/WindowedListItem";
import {
  SimpleMenu,
  SimpleMenuItem,
  SimpleMenuSeparator,
} from "@/components/SimpleMenu";
import { EmptyState } from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import { openNoteDetail } from "@/lib/actions";
import { focusNoteDraftInput } from "@/lib/noteDraftFocus";
import { useStickyHeader } from "@/lib/stickyHeader";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import {
  INBOX_ID,
  SECTION_COLORS,
  useNotesStore,
  type Note,
  type Section,
} from "@/store/notesStore";
import { useUIStore } from "@/store/uiStore";
import { sectionName } from "@/lib/i18n/builtinNames";

export function SectionGroup({
  section,
  activeNotes,
  doneNotes,
  query,
  eager = false,
}: {
  section: Section;
  activeNotes: Note[];
  doneNotes: Note[];
  query: string;
  /** 当前页首个分组首帧直出少量卡片，其余由共享视窗观察器挂载。 */
  eager?: boolean;
}) {
  const t = useT();
  const {
    setChecked,
    renameSection,
    deleteSection,
    moveSection,
    toggleSectionCollapsed,
    toggleSectionKeep,
    setSectionColor,
    setSettings,
  } = useNotesStore.getState();
  const compact = useNotesStore((s) => s.settings.cardDensity === "compact");
  const doneOpen = useUIStore((s) => s.doneOpen[section.id] ?? false);

  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(sectionName(section));
  // 单击组名折叠 / 双击改名：延迟消歧，双击时取消未执行的折叠
  const clickTimer = useRef(0);

  // 分组本身可排序；同一 sec:* 投放区也继续承接卡片跨组拖拽。
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({
    id: `sec:${section.id}`,
    data: { type: "section", sectionId: section.id },
  });

  // 吸顶栏保持透明（与毛玻璃底一致），卡片滚到栏下沿渐隐，不与标题叠印
  const { headerRef, bodyRef, scrollToStartIfStuck } = useStickyHeader(
    !!section.collapsed
  );

  const total = activeNotes.length + doneNotes.length;
  const collapsed = !!section.collapsed;

  const checkAll = () => {
    const ids = [...activeNotes, ...doneNotes].map((n) => n.id);
    // 单卡勾选不应让分组父层重 map 全部窗口壳；批量动作触发时再即时读取。
    const merged = new Set([
      ...useNotesStore.getState().checkedIds,
      ...ids,
    ]);
    setChecked([...merged]);
  };

  const addContent = () => {
    setSettings({ lastDraftSectionId: section.id });
    if (collapsed) toggleSectionCollapsed(section.id);
    // 大窗创作（用户 2026-08-27）：落一张草稿卡直接开详情窗编辑——面板太窄
    // 不适合写长内容。失败（数据只读等）时退回聚焦底部输入条的旧行为
    const { result, id } = useNotesStore
      .getState()
      .addNote(t("新笔记"), { sectionId: section.id });
    if (id && (result === "added" || result === "duplicate")) {
      openNoteDetail(id, true, true);
    } else {
      focusNoteDraftInput();
    }
  };

  const commitRename = () => {
    setRenaming(false);
    if (name !== sectionName(section)) renameSection(section.id, name);
  };

  return (
    <section
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      className={cn(
        "relative mb-3 rounded-lg transition-colors",
        isOver && !isDragging && "bg-primary/[0.06] ring-1 ring-primary/30",
        isDragging && "z-10 opacity-70 elevation-2"
      )}
    >
      <div
        ref={headerRef}
        className="group sticky top-0 z-10 mb-1.5 flex h-5 items-center gap-1 pl-0.5 pr-1"
      >
        <IconButton
          label={collapsed ? t("展开分组") : t("折叠分组")}
          aria-expanded={!collapsed}
          size="2xs"
          onClick={() => toggleSectionCollapsed(section.id)}
        >
          {collapsed ? <ChevronRight /> : <ChevronDown />}
        </IconButton>

        {section.color && (
          <span
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: section.color }}
          />
        )}
        {renaming ? (
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" && !e.nativeEvent.isComposing) commitRename();
              if (e.key === "Escape") {
                setName(sectionName(section));
                setRenaming(false);
              }
            }}
            className="h-5 min-w-0 w-32 bg-transparent text-label font-semibold uppercase tracking-[0.08em] outline-none"
          />
        ) : (
          <h3
            {...attributes}
            {...listeners}
            title={t("{name} · 拖动调整分组顺序 · 点击折叠/展开（吸顶时回到组首） · 双击重命名", { name: sectionName(section) })}
            className="min-w-0 cursor-grab select-none touch-none truncate text-label font-semibold uppercase tracking-[0.08em] text-muted-foreground hover:text-foreground active:cursor-grabbing"
            onClick={() => {
              window.clearTimeout(clickTimer.current);
              clickTimer.current = window.setTimeout(() => {
                if (!scrollToStartIfStuck()) toggleSectionCollapsed(section.id);
              }, 220);
            }}
            onDoubleClick={() => {
              window.clearTimeout(clickTimer.current);
              setName(sectionName(section));
              setRenaming(true);
            }}
          >
            {sectionName(section)}
          </h3>
        )}
        {section.keepAfterSend && (
          <Star
            className="size-2.5 shrink-0 fill-current text-muted-foreground"
            aria-label={t("发送后保留")}
          />
        )}
        <span className="shrink-0 text-micro tabular-nums text-muted-foreground">{total}</span>

        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <IconButton
            label={t("在「{name}」中添加内容", { name: sectionName(section) })}
            size="2xs"
            reveal="hover-focus"
            onClick={addContent}
          >
            <Plus />
          </IconButton>
          <SimpleMenu
            portal
            align="end"
            trigger={({ open, toggle }) => (
              <IconButton
                label={t("分组操作")}
                size="2xs"
                reveal="hover-focus"
                onClick={toggle}
                className={open ? "opacity-100 pointer-events-auto" : undefined}
              >
                <MoreHorizontal />
              </IconButton>
            )}
          >
            {(close) => (
              <>
                <SimpleMenuItem
                  disabled={!total}
                  onClick={() => {
                    close();
                    checkAll();
                  }}
                >
                  <CheckSquare className="size-3.5" /> {t("全选此组")}
                </SimpleMenuItem>
                <SimpleMenuItem
                  onClick={() => {
                    close();
                    setName(sectionName(section));
                    setRenaming(true);
                  }}
                >
                  <Pencil className="size-3.5" /> {t("重命名")}
                </SimpleMenuItem>
                <div className="flex flex-wrap items-center gap-1.5 px-2 py-1.5">
                  {SECTION_COLORS.map((c) => (
                    <button
                      key={c}
                      aria-label={t("设置分组色")}
                      onClick={() => {
                        setSectionColor(section.id, c);
                        close();
                      }}
                      className="size-3.5 shrink-0 rounded-full ring-offset-1 transition-transform hover:scale-125"
                      style={{ backgroundColor: c }}
                    />
                  ))}
                  <button
                    aria-label={t("清除颜色")}
                    onClick={() => {
                      setSectionColor(section.id, undefined);
                      close();
                    }}
                    className="size-3.5 shrink-0 rounded-full border border-dashed border-muted-foreground/75 transition-transform hover:scale-125"
                  />
                </div>
                <SimpleMenuSeparator />
                <SimpleMenuItem
                  title={t("组内卡片发送后不标记完成，适合 Prompt 库等长期复用内容")}
                  onClick={() => {
                    close();
                    toggleSectionKeep(section.id);
                  }}
                >
                  <Star
                    className={cn(
                      "size-3.5",
                      section.keepAfterSend && "fill-current"
                    )}
                  />{" "}
                  {section.keepAfterSend ? t("取消发送后保留") : t("发送后保留")}
                </SimpleMenuItem>
                <SimpleMenuSeparator />
                <SimpleMenuItem
                  onClick={() => {
                    close();
                    moveSection(section.id, -1);
                  }}
                >
                  <ArrowUp className="size-3.5" /> {t("上移")}
                </SimpleMenuItem>
                <SimpleMenuItem
                  onClick={() => {
                    close();
                    moveSection(section.id, 1);
                  }}
                >
                  <ArrowDown className="size-3.5" /> {t("下移")}
                </SimpleMenuItem>
                {section.id !== INBOX_ID && (
                  <>
                    <SimpleMenuSeparator />
                    <SimpleMenuItem
                      destructive
                      onClick={() => {
                        close();
                        deleteSection(section.id);
                      }}
                    >
                      <Trash2 className="size-3.5" /> {t("删除分组")}
                    </SimpleMenuItem>
                  </>
                )}
              </>
            )}
          </SimpleMenu>
        </div>
      </div>

      {!collapsed && (
        <div ref={bodyRef} className="-mx-1 -mb-1 px-1 pb-1">
        <SortableContext
          items={[...activeNotes, ...doneNotes].map((n) => n.id)}
          strategy={verticalListSortingStrategy}
        >
          {activeNotes.length === 0 && doneNotes.length === 0 ? (
            <EmptyState variant="inline" title={t("此分组为空")} />
          ) : (
            <div className="flex flex-col gap-1">
              {activeNotes.map((note, index) => (
                <WindowedListItem
                  key={note.id}
                  itemId={note.id}
                  estimatedHeight={compact ? 40 : 116}
                  eager={eager && index < 18}
                >
                  <NoteCard note={note} query={query} />
                </WindowedListItem>
              ))}

              {doneNotes.length > 0 && (
                <>
                  <button
                    onClick={() => useUIStore.getState().toggleDoneOpen(section.id)}
                    className="flex items-center gap-1 px-1 py-0.5 text-micro text-muted-foreground hover:text-foreground"
                  >
                    {doneOpen ? (
                      <ChevronDown className="size-2.5" />
                    ) : (
                      <ChevronRight className="size-2.5" />
                    )}
                    {t("已完成 {n}", { n: doneNotes.length })}
                  </button>
                  {doneOpen &&
                    doneNotes.map((note) => (
                      <WindowedListItem
                        key={note.id}
                        itemId={note.id}
                        estimatedHeight={compact ? 40 : 116}
                      >
                        <NoteCard note={note} query={query} />
                      </WindowedListItem>
                    ))}
                </>
              )}
            </div>
          )}
        </SortableContext>
        </div>
      )}
    </section>
  );
}
