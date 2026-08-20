import { useEffect, useMemo, useRef, useState } from "react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type Modifier,
} from "@dnd-kit/core";
import {
  arrayMove,
  horizontalListSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { motion, MotionConfig } from "motion/react";
import {
  ClipboardList,
  ArrowLeft,
  ArrowRight,
  ArrowUpCircle,
  CheckCheck,
  Eraser,
  Menu,
  PanelBottom,
  PanelLeft,
  PanelRight,
  PanelTop,
  Pencil,
  Pin,
  Plus,
  Star,
  Trash2,
  Rows3,
  Search,
  SearchX,
  Settings2,
  X,
} from "lucide-react";
import { DraftInput } from "@/components/DraftInput";
import { NoteCard } from "@/components/NoteCard";
import { PermissionBanner } from "@/components/PermissionBanner";
import { SafeDeliveryRehearsal } from "@/components/SafeDeliveryRehearsal";
import { WelcomeTour } from "@/components/WelcomeTour";
import { PreviewOverlay } from "@/components/PreviewOverlay";
import { buildBackupPayload, buildMediaIntegrityPayload } from "@/lib/backup";
import {
  clearEditorSessionMedia,
  editorSessionMediaFiles,
  NOTE_EDITOR_SESSION_RELEASE_EVENT,
  releaseEditorSessionMedia,
  subscribeEditorMediaReleases,
  type NoteEditorSessionReleasePayload,
} from "@/lib/editorSessionMedia";
import {
  DATA_RUNTIME_READY_EVENT,
  reloadAfterPersistenceConflict,
  reportDataActivity,
  resumePendingDataOperation,
  runCompleteBackupImport,
  runCompleteBackupExport,
  runDataLocationOperation,
  runRecoveryDataLocationOperation,
  runLegacyJsonImport,
} from "@/lib/dataOperations";
import {
  beginDataGenerationLease,
  DATA_CONTEXT_INVALIDATED_EVENT,
  currentDataGeneration,
  matchesDataGeneration,
} from "@/lib/dataGeneration";
import { UpdateDialog } from "@/components/UpdateDialog";
import { SectionGroup } from "@/components/SectionGroup";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { SelectionBar } from "@/components/SelectionBar";
import { PreflightComposer } from "@/components/PreflightComposer";
import { ResultLinkDialog } from "@/components/ResultLinkDialog";
import { ResultVerificationDialog } from "@/components/ResultVerificationDialog";
import { TargetLensBar } from "@/components/TargetLensBar";
import {
  clearDeliveryRedactionSessions,
  closeResultReturnDialog,
  deliveryCandidatesForCapturedNote,
  deliveryPlaceholderEvidence,
  linkCapturedNoteToDelivery,
  RESULT_LINK_CHANGED_EVENT,
} from "@/lib/resultReturn";
import { closeResultVerificationDialog } from "@/lib/resultVerification";
import {
  DELIVERY_ACTIVITY_CLEARED_EVENT,
  getRecentDeliveryEventsCached,
  invalidateDeliveryActivityCache,
} from "@/lib/deliveryActivity";
import {
  SimpleMenu,
  SimpleMenuItem,
  SimpleMenuLabel,
  SimpleMenuSeparator,
} from "@/components/SimpleMenu";
import {
  TASK_DONE_KEY,
  TASK_OVERDUE_COLLAPSED_KEY,
  TASK_SPARKS_COLLAPSED_KEY,
} from "@/components/TaskPage";
import { RemindersPage } from "@/components/RemindersPage";
import { ContentTabs } from "@/components/ContentTabs";
import { MessagePage } from "@/components/messages/MessagePage";
import { TaskTile } from "@/components/TaskRow";
import { SecretPage } from "@/components/SecretPage";
import { TaskQuickAdd } from "@/components/TaskQuickAdd";
import { EmptyState } from "@/components/ui/empty-state";
import { floatingSurface } from "@/components/ui/floating-surface";
import { focusRing } from "@/components/ui/focus-ring";
import { GlowingEffect } from "@/components/ui/glowing-effect";
import { IconButton } from "@/components/ui/icon-button";
import { Kbd } from "@/components/ui/kbd";
import { ScrollArea } from "@/components/ui/scroll-area";
import { StripScroller } from "@/components/ui/strip-scroller";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  armNoteEditUndo,
  clearDoneTasksWithUndo,
  clearDoneWithUndo,
  copyCheckedAsList,
  deleteNotesWithUndo,
  deleteTasksWithUndo,
  enrichLinkMeta,
  noteEditorSessionReleased,
  openNoteDetail,
  toggleNoteDetail,
  NOTE_TAGS_EVENT,
  refreshOpenNoteDetail,
  RUN_PENDING_UNDO_EVENT,
  sendCheckedToChat,
  sendNotesToChat,
  undoableTip,
  warnWithPanel,
  type NoteEditPayload,
  type NoteTagsPayload,
} from "@/lib/actions";
import { clipTimeBand } from "@/lib/cliprow";
import {
  materializeRichCapture,
  restoreRichCaptureAliases,
} from "@/lib/richCapture";
import { billDueLabel, dueBillsToRemind } from "@/lib/bills";
import { bucketTasksForDisplay, dueTasksToRemind } from "@/lib/tasks";
import { springSnappy, tweenExit } from "@/lib/motion";
import {
  advancePermissionGuard,
  initialPermissionGuardState,
} from "@/lib/permissionGuard";
import { imageCaption, previewOf } from "@/lib/format";
import { SHORTCUTS } from "@/lib/shortcuts";
import { clearPendingUndo, runPendingUndo, setPendingUndo, tip } from "@/lib/tip";
import { silentUpdateFlow } from "@/lib/updater";
import {
  legacyAiApiKey,
  migrateLegacyAiApiKey,
  withoutLegacyAiApiKey,
} from "@/lib/aiKeyMigration";
import { matchNote, matchSecretNote } from "@/lib/search";
import { isSecretEnvelope, openFromChinese } from "@/lib/secret/secret";
import { scrollPageToStart } from "@/lib/pageScroll";
import {
  shouldHidePanelOnBlur,
  triggerKeepsPanelOpen,
} from "@/lib/panelBehavior";
import { applyRuntimeSettings } from "@/lib/runtimeSettings";
import {
  applySettingsPatch,
  broadcastSettings,
  installSettingsSyncHost,
  SETTINGS_AI_KEY_CHANGED,
  SETTINGS_DATA_HEALTH_RESULT,
  SETTINGS_SECTION,
  SETTINGS_START_SAFE_REHEARSAL,
  type SafeRehearsalLaunchRequest,
} from "@/lib/settingsSync";
import {
  isSafeRehearsalText,
  safeRehearsalLaunchEvent,
} from "@/lib/onboarding";
import {
  api,
  EDGE_HIDE_STATE_EVENT,
  HUD_OPEN_PANEL_EVENT,
  MESSAGE_WATCH_EVENT,
  PANEL_MOVED_EVENT,
  CLIP_EVENT,
  CLIP_PAUSE_EVENT,
  STEALTH_EVENT,
  TARGET_CHANGED_EVENT,
  TRIGGER_EVENT,
  UNDO_CAPTURE_EVENT,
  type ClipPayload,
  type EdgeHideStatePayload,
  type HudOpenPanelPayload,
  type MessageWatchCapture,
  type TargetSnapshot,
  type TriggerPayload,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { registerAliasQuickAddListener } from "@/lib/aliasQuickAdd";
import { restoreAliases } from "@/lib/delivery/aliasEntities";
import { clearDeliveryDraftImages } from "@/lib/delivery/imageFirewall";
import {
  CLIPBOARD_ID,
  INBOX_ID,
  noteImages,
  PANEL_WIDTH_MAX,
  PANEL_WIDTH_MIN,
  SECRET_ID,
  SECTION_COLORS,
  TASK_INBOX_ID,
  useNotesStore,
  type NoteContentBlock,
  type PageId,
  type Settings,
} from "@/store/notesStore";
import { useUIStore } from "@/store/uiStore";
import { useDeliveryStore } from "@/store/deliveryStore";
import {
  isDataOperationLocked,
  useDataOperationStore,
} from "@/store/dataOperationStore";
import {
  currentPersistenceRevision,
  enterPersistenceConflict,
  flushPendingWrites,
  PERSISTENCE_CONFLICT_EVENT,
} from "@/store/persistStorage";
import {
  applyTargetEvent,
  beginTargetBlurObservation,
  observeTargetAfterBlur,
  refreshTarget,
  targetObservationPending,
  useTargetStore,
} from "@/store/targetStore";

/** 本会话捕获的卡片 id 栈（HUD 撤销用，无需持久化）。 */
const captureHistory: { id: string; dataGeneration: number }[] = [];

/** 横栏「已完成」过滤哨兵值（与真实分组 id 隔离）。 */
const DONE_FILTER = "__done__";
const MEDIA_GC_GRACE_MS = 30_000;

function mediaIntegrityStateJson(): string {
  return JSON.stringify(
    buildMediaIntegrityPayload(
      useNotesStore.getState(),
      editorSessionMediaFiles()
    )
  );
}

function handleMediaGcFailure(error: unknown): void {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    String((error as { code: unknown }).code) === "externalConflict"
  ) {
    enterPersistenceConflict(error);
  }
}

function runScheduledMediaGc() {
  if (isDataOperationLocked()) return;
  const lease = beginDataGenerationLease();
  void flushPendingWrites()
    .then(() => {
      const revision = currentPersistenceRevision();
      if (!revision) throw new Error("媒体 GC 缺少持久化基线");
      return api.runMediaGc(mediaIntegrityStateJson(), Date.now(), revision);
    })
    .catch((error) => {
      handleMediaGcFailure(error);
      /* 健康检查会报告未完成项；后台 GC 不用正文日志轰炸用户。 */
    })
    .finally(lease.release);
}

function scheduleMediaGc(files: string[], graceMs = MEDIA_GC_GRACE_MS) {
  const unique = [...new Set(files.filter(Boolean))];
  if (!unique.length || isDataOperationLocked()) return;
  const lease = beginDataGenerationLease();
  void flushPendingWrites()
    .then(() => api.scheduleMediaGc(unique, Date.now() + graceMs))
    .then(() => {
      const revision = currentPersistenceRevision();
      if (!revision) throw new Error("媒体 GC 缺少持久化基线");
      return api.runMediaGc(mediaIntegrityStateJson(), Date.now(), revision);
    })
    .catch(handleMediaGcFailure)
    .finally(lease.release);
}

function userError(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/** 横栏分组胶囊管理能力（与竖栏分组头对齐）。 */
interface PillManage {
  rename: (id: string, name: string) => void;
  move: (id: string, dir: -1 | 1) => void;
  /** 横栏分组胶囊拖拽排序（笔记分组）。 */
  reorder?: (activeId: string, overId: string) => void;
  remove: (id: string) => void;
  /** 不可删除的固定分组（收件箱/收集箱）。 */
  lockedId: string;
  setColor?: (id: string, c?: string) => void;
  toggleKeep?: (id: string) => void;
  keepOn?: (id: string) => boolean;
  /** 全选该组卡片（笔记）。 */
  checkAll?: (id: string) => void;
  /** 行尾「+」新建分组。 */
  add?: () => void;
}

const pillCls = (on: boolean) =>
  cn(
    "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-label",
    on
      ? "border-border bg-primary/10 font-medium text-foreground dark:border-input"
      : "border-transparent text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/5"
  );

/** 单个分组胶囊：点选过滤；双击改名；右键管理菜单（改名/色板/保留/移动/删除）。 */
function GroupPill({
  item,
  on,
  onPick,
  manage,
}: {
  item: { id: string; name: string; color?: string };
  on: boolean;
  onPick: () => void;
  manage?: PillManage;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({
      id: `pill:${item.id}`,
      disabled: !manage?.reorder,
    });
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(item.name);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (renaming) window.setTimeout(() => inputRef.current?.focus(), 30);
  }, [renaming]);
  const commit = () => {
    if (manage && name.trim() && name.trim() !== item.name) {
      manage.rename(item.id, name.trim());
    }
    setRenaming(false);
  };
  if (renaming) {
    return (
      <input
        ref={inputRef}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") setRenaming(false);
        }}
        onBlur={commit}
        className="h-6 w-24 shrink-0 rounded-full border border-border bg-transparent px-2.5 text-label outline-none"
      />
    );
  }
  const trigger = () => (
    <button
      ref={manage?.reorder ? setNodeRef : undefined}
      {...(manage?.reorder ? attributes : {})}
      {...(manage?.reorder ? listeners : {})}
      style={
        manage?.reorder
          ? {
              transform: CSS.Transform.toString(transform),
              transition,
            }
          : undefined
      }
      onClick={onPick}
      onDoubleClick={() => {
        if (manage) {
          setName(item.name);
          setRenaming(true);
        }
      }}
      className={cn(
        pillCls(on),
        manage?.reorder && "cursor-grab touch-none active:cursor-grabbing",
        isDragging && "z-10 opacity-70 elevation-2"
      )}
    >
      <span
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: item.color ?? "#98989d" }}
      />
      {item.name}
    </button>
  );
  if (!manage) return trigger();
  // 胶囊行在 overflow-x-auto 容器内，SimpleMenu 的绝对定位下拉会被裁剪；
  // 改用 Radix ContextMenu（portal 逃逸裁剪，与卡片右键同栈、本窗口已验证可用）
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{trigger()}</ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        {manage.checkAll && (
          <ContextMenuItem onClick={() => manage.checkAll?.(item.id)}>
            <CheckCheck className="size-3.5" /> 全选此组
          </ContextMenuItem>
        )}
        <ContextMenuItem
          onClick={() => {
            setName(item.name);
            setRenaming(true);
          }}
        >
          <Pencil className="size-3.5" /> 重命名
        </ContextMenuItem>
        {manage.setColor && (
          <div className="flex flex-wrap items-center gap-1.5 px-2 py-1.5">
            {SECTION_COLORS.map((c) => (
              <button
                key={c}
                aria-label="设置分组色"
                onClick={() => manage.setColor?.(item.id, c)}
                className="size-3.5 shrink-0 rounded-full ring-offset-1 transition-transform hover:scale-125"
                style={{ backgroundColor: c }}
              />
            ))}
            <button
              aria-label="清除颜色"
              onClick={() => manage.setColor?.(item.id, undefined)}
              className="size-3.5 shrink-0 rounded-full border border-dashed border-muted-foreground/75 transition-transform hover:scale-125"
            />
          </div>
        )}
        {manage.toggleKeep && (
          <ContextMenuItem
            title="组内卡片发送后不标记完成，适合 Prompt 库等长期复用内容"
            onClick={() => manage.toggleKeep?.(item.id)}
          >
            <Star
              className={cn("size-3.5", manage.keepOn?.(item.id) && "fill-current")}
            />{" "}
            {manage.keepOn?.(item.id) ? "取消发送后保留" : "发送后保留"}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => manage.move(item.id, -1)}>
          <ArrowLeft className="size-3.5" /> 左移
        </ContextMenuItem>
        <ContextMenuItem onClick={() => manage.move(item.id, 1)}>
          <ArrowRight className="size-3.5" /> 右移
        </ContextMenuItem>
        {item.id !== manage.lockedId && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              variant="destructive"
              onClick={() => manage.remove(item.id)}
            >
              <Trash2 className="size-3.5" /> 删除分组
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** 横栏分组胶囊行（Paste 顶栏样式）：全部 + 各分组（带色点），点选过滤。 */
function GroupPills({
  items,
  active,
  onPick,
  bare,
  manage,
  doneCount,
}: {
  items: { id: string; name: string; color?: string }[];
  active: string | null;
  onPick: (id: string | null) => void;
  /** 并入标题行时去掉外层留白与滚动（由父容器统一处理）。 */
  bare?: boolean;
  manage?: PillManage;
  /** 已完成数量（>0 时显示「已完成」胶囊，选中值为 DONE_FILTER）。 */
  doneCount?: number;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const row = (
    <div
      className={
        bare
          ? "flex shrink-0 items-center gap-1"
          : "slim-scroll flex shrink-0 items-center gap-1 overflow-x-auto px-3 pb-1 pt-0.5"
      }
    >
      <button onClick={() => onPick(null)} className={pillCls(active === null)}>
        全部
      </button>
      {items.map((s) => (
        <GroupPill
          key={s.id}
          item={s}
          on={active === s.id}
          onPick={() => onPick(active === s.id ? null : s.id)}
          manage={manage}
        />
      ))}
      {doneCount !== undefined && doneCount > 0 && (
        <button
          onClick={() => onPick(active === DONE_FILTER ? null : DONE_FILTER)}
          className={cn(pillCls(active === DONE_FILTER), "text-muted-foreground")}
        >
          ✓ 已完成 {doneCount}
        </button>
      )}
      {manage?.add && (
        <button
          aria-label="新建分组"
          title="新建分组（双击胶囊可改名）"
          onClick={manage.add}
          className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/5"
        >
          <Plus className="size-3.5" />
        </button>
      )}
    </div>
  );

  if (!manage?.reorder) return row;
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={({ active: dragged, over }) => {
        if (!over || dragged.id === over.id) return;
        manage.reorder?.(
          String(dragged.id).replace(/^pill:/, ""),
          String(over.id).replace(/^pill:/, "")
        );
      }}
    >
      <SortableContext
        items={items.map((item) => `pill:${item.id}`)}
        strategy={horizontalListSortingStrategy}
      >
        {row}
      </SortableContext>
    </DndContext>
  );
}

const SIDEBAR_EDGE_LABEL = {
  right: "靠右显示",
  left: "靠左显示",
  top: "靠上显示",
  bottom: "靠下显示",
} as const;

/** 应用边栏停靠：开=接管位置（清手动拖动）；关=恢复自动停靠。
 *  `set_sidebar_mode` 在 Rust 侧面板可见时会自行 request_show_panel 重排
 *  （开/关两种方向都会），这里不再额外调用 api.showPanel()——本菜单只能
 *  从已展开的面板内点开，重复调用曾导致贴边隐藏锚点在关闭边栏时被连续
 *  建立两次（诊断日志里 2ms 内两条「锚点建立」）。 */
async function applySidebar(on: boolean, edge: Settings["sidebarEdge"]) {
  useNotesStore.getState().setSettings({
    rightSidebar: on,
    sidebarEdge: edge,
    panelFreeX: null,
    panelFreeY: null,
  });
  await api.setPanelFreePos(null, null).catch(() => {});
  await api.setSidebarMode(on, edge).catch(() => {});
}

/** 页签拖拽只允许横向位移（@dnd-kit/modifiers 不在依赖里，就地实现）。 */
const lockYAxis: Modifier = ({ transform }) => ({ ...transform, y: 0 });

/** 页签中文名（顺序由 settings.pageOrder 决定）。 */
const PAGE_LABEL: Record<PageId, string> = {
  clipboard: "剪贴",
  notes: "内容",
  tasks: "提醒",
  secret: "秘文",
};

/**
 * 常驻页面滑层：三页始终挂载，切页只动 transform/opacity（GPU 合成），
 * 零挂载成本——重列表页（剪贴板缩略图墙）切入不再掉帧。offset 为
 * 该页与当前页的序差：0=激活；负=藏左侧；正=藏右侧。动画结束后
 * visibility:hidden 停掉不活动页的绘制。
 */
function PageSlide({
  offset,
  contentRef,
  children,
}: {
  offset: number;
  contentRef: React.Ref<HTMLDivElement>;
  children: React.ReactNode;
}) {
  const active = offset === 0;
  // visibility 由 React 受控，不走 motion 的 transitionEnd：退出动画刚完成
  // 或被打断的一两帧内切回该页时，延迟应用的 transitionEnd hidden 会盖过
  // 切入时设置的 visible，把已激活页面整页藏掉（来回切 tab 概率性白屏）。
  const [hidden, setHidden] = useState(!active);
  if (active && hidden) setHidden(false);
  const activeRef = useRef(active);
  activeRef.current = active;
  return (
    <motion.div
      ref={contentRef}
      aria-hidden={!active}
      initial={false}
      animate={
        active ? { x: 0, opacity: 1 } : { x: offset < 0 ? -24 : 24, opacity: 0 }
      }
      onAnimationComplete={(def) => {
        // 仅「退出动画完成且此刻仍非激活」才停掉绘制；切入动画完成或
        // 退出中途被切回打断（stop 也可能触发完成回调）都不隐藏
        const isExit =
          typeof def === "object" &&
          def !== null &&
          (def as { opacity?: number }).opacity === 0;
        if (isExit && !activeRef.current) setHidden(true);
      }}
      transition={springSnappy}
      style={{ visibility: hidden ? "hidden" : "visible" }}
      className={cn(
        "absolute inset-0 flex min-h-0 flex-col",
        !active && "pointer-events-none"
      )}
    >
      {children}
    </motion.div>
  );
}

export default function App() {
  const dataOperationLocked = useDataOperationStore((state) => state.locked);
  const dataOperationMessage = useDataOperationStore((state) => state.message);
  const dataOperationPhase = useDataOperationStore((state) => state.phase);
  const open = useUIStore((s) => s.open);
  const page = useUIStore((s) => s.page);
  const contentSubview = useUIStore((s) => s.contentSubview);
  const pinned = useUIStore((s) => s.pinned);
  const updateAvail = useUIStore((s) => s.updateAvail);
  const announce = useUIStore((s) => s.announce);
  const searchOpen = useUIStore((s) => s.searchOpen);
  const query = useUIStore((s) => s.query);
  const doneOpen = useUIStore((s) => s.doneOpen);
  const sections = useNotesStore((s) => s.sections);
  const notes = useNotesStore((s) => s.notes);
  const tasks = useNotesStore((s) => s.tasks);
  const messages = useNotesStore((s) => s.messages);
  const taskSections = useNotesStore((s) => s.taskSections);
  const settings = useNotesStore((s) => s.settings);
  const onboarding = settings.onboarding;
  /** 收起动画结束隐藏窗口时，是否归还焦点给原前台应用。 */
  const restoreFocusRef = useRef(true);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const dragExpandRef = useRef<{ sec: string; timer: number } | null>(null);

  // Native 两阶段事务可跨 WebView reload 存活。默认保持只读，查询 status 后
  // 要么续接 rehydrate/finalize，要么安全 rollback；绝不让旧 JS 状态穿透。
  useEffect(() => {
    let alive = true;
    void api
      .getDataLocationStatus()
      .then(async (status) => {
        if (!alive) return;
        if (status.pendingOperationId) {
          await resumePendingDataOperation(status.pendingOperationId);
          return;
        }
        if (status.initializationFailure) {
          // 相位必须先于 enterPersistenceConflict：其事件是同步派发的，
          // 冲突处理器按相位判断是否落盘标记（见 PERSISTENCE_CONFLICT_EVENT 监听）
          reportDataActivity({
            locked: true,
            phase: "storageRecovery",
            message: `存储初始化失败：${status.initializationFailure.message}`,
          });
          enterPersistenceConflict(status.initializationFailure);
          return;
        }
        if (status.conflictPending) {
          const conflict = {
            code: "externalConflict",
            message: "检测到尚未处理的数据冲突",
          };
          enterPersistenceConflict(conflict);
          reportDataActivity({
            locked: true,
            phase: "conflict",
            message: conflict.message,
          });
          return;
        }
        await useNotesStore.persist.rehydrate();
        if (!alive) return;
        reportDataActivity({ locked: false, phase: "idle", message: "" });
      })
      .catch((error) => {
        if (!alive) return;
        const locked = isDataOperationLocked();
        reportDataActivity({
          locked,
          phase: locked ? "rollback" : "idle",
          message: locked
            ? `待完成数据事务恢复失败：${userError(error)}`
            : `待完成数据事务已回滚：${userError(error)}`,
        });
      });
    return () => {
      alive = false;
    };
  }, []);

  const openPanel = async (shortcutHoldOpen = false) => {
    useUIStore.getState().setShortcutHoldOpen(shortcutHoldOpen);
    try {
      await api.showPanel(shortcutHoldOpen);
    } catch {
      /* Tauri 环境外忽略 */
    }
    useUIStore.getState().setOpen(true);
    void refreshTarget();
  };

  const closePanel = (restoreFocus: boolean) => {
    restoreFocusRef.current = restoreFocus;
    const ui = useUIStore.getState();
    ui.setShortcutHoldOpen(false);
    ui.setOpen(false);
  };

  const dismissPanel = () => {
    useUIStore.getState().setShortcutHoldOpen(false);
    void api
      .edgeHideNow(true)
      .then((handled) => {
        if (!handled && useUIStore.getState().open) closePanel(true);
      })
      .catch(() => closePanel(true));
  };

  // 正常启动保持隐藏，让第一次双击快捷键执行“显示”而不是误判为“关闭”。
  // 监听不可用仍会自动打开授权引导，但必须等数据闸门解锁：新档案由下面的
  // initialPanelSetup 先固定/磁吸再显示，避免权限分支抢跑而闪现独立态。
  useEffect(() => {
    let alive = true;
    let needsPermissionPanel = false;
    const maybeOpenPermissionPanel = () => {
      if (
        !alive ||
        !needsPermissionPanel ||
        isDataOperationLocked() ||
        !useNotesStore.persist.hasHydrated()
      ) return;
      if (!useNotesStore.getState().settings.initialPanelSetupDone) return;
      needsPermissionPanel = false;
      void openPanel();
    };
    void api
      .tapStatus()
      .then(({ installed, listening }) => {
        if (!alive || (installed && listening)) return;
        needsPermissionPanel = true;
        maybeOpenPermissionPanel();
      })
      .catch(() => {
        /* Tauri 环境外忽略 */
      });
    window.addEventListener(DATA_RUNTIME_READY_EVENT, maybeOpenPermissionPanel);
    return () => {
      alive = false;
      window.removeEventListener(
        DATA_RUNTIME_READY_EVENT,
        maybeOpenPermissionPanel
      );
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 应用级权限守护（常驻，与面板显隐无关）：
  // - 辅助功能授权后 3s 内自动重装监听（无需重启）
  // - 判「输入监控被扣」只认铁证，不再把「启动后没人打字」当故障
  //   （更新重启后必现 12s 误报横幅，诱导用户无谓点「重置授权/重启」）：
  //   铁证 = 系统授权查询连续为否，或本窗口收到过按键而 tap 始终无事件
  useEffect(() => {
    let alive = true;
    let wasStuck = false;
    let guard = initialPermissionGuardState();
    // 不健康窗口内 webview 自己收到 keydown = 键盘活动确凿存在的反证
    const onKeyEvidence = () => {
      guard.webviewKeySeen = true;
    };
    window.addEventListener("keydown", onKeyEvidence, { capture: true });
    const check = async () => {
      try {
        const [ax, tap] = await Promise.all([api.axTrusted(false), api.tapStatus()]);
        if (!alive) return;
        const advanced = advancePermissionGuard(guard, tap);
        guard = advanced.state;
        const stuck = advanced.stuck;
        useUIStore.getState().setPermission(ax, tap.installed, tap.receiving, stuck);
        const healthy = tap.installed && tap.receiving;
        // 就绪气泡只做「从故障恢复」的确认；普通启动后的首次按键不打扰
        if (wasStuck && healthy) {
          tip("ok", "键盘监听已就绪，双击 ⇧ 试试 ✓");
          wasStuck = false;
        } else if (stuck) {
          wasStuck = true;
        }
        if (ax && !tap.installed) {
          await api.retryTap();
        }
      } catch {
        /* Tauri 环境外忽略 */
      }
    };
    void check();
    const timer = window.setInterval(check, 3000);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener("keydown", onKeyEvidence, { capture: true });
    };
  }, []);

  // ===== Rust 事件闭环 =====

  // 前台观察器只在目标语义变化时推送快照；事件本身即新基线，不做前端轮询。
  useEffect(() => {
    const unlisten = listen<TargetSnapshot>(TARGET_CHANGED_EVENT, (event) => {
      applyTargetEvent(event.payload);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // 独立详情窗也有发送按钮；只同步最新快照，不让它建立第二套目标推断。
  useEffect(
    () =>
      useTargetStore.subscribe((state, previous) => {
        if (state.snapshot && state.snapshot !== previous.snapshot) {
          void emitTo("textpreview", TARGET_CHANGED_EVENT, state.snapshot).catch(() => {});
        }
      }),
    []
  );

  // 触发事件：开关面板 / 捕获入库（去重裁决后回调 HUD）
  useEffect(() => {
    const unlisten = listen<TriggerPayload>(TRIGGER_EVENT, (event) => {
      const payload = event.payload;
      if (isDataOperationLocked()) {
        const clipboardWarning =
          payload.kind === "captured" ? payload.clipboardWarning : null;
        tip(
          "warn",
          clipboardWarning
            ? `数据操作进行中，捕获暂时停用 · ${clipboardWarning}`
            : "数据操作进行中，捕获暂时停用"
        );
        return;
      }
      if (payload.kind === "toggle") {
        const shortcutHoldOpen = triggerKeepsPanelOpen(payload);
        const { open: isOpen, pinned: isPinned, edgeHidden } = useUIStore.getState();
        // 前端链路回执：报障时与 Rust 侧「双击触发」拼成完整链路
        void api.diagNote(
          `前端收到 Toggle: source=${payload.source} open=${isOpen} pinned=${isPinned} edgeHidden=${edgeHidden}`
        );
        // 面板正贴边隐藏（仅露出细条）时，内容层从未收起过，前端 open 仍是
        // true——这时快捷键的意图必然是「唤出」，不能按老逻辑当成「已经开着
        // 所以收起」，否则会把面板直接关掉（现网复现：按快捷键反而收起）。
        // show_panel_on_main 会自行取消贴边隐藏（诊断日志「贴边隐藏: 取消
        // （唤出面板）」），这里只需确保 open 不被误切成 false。
        if (edgeHidden) {
          void api.diagNote("贴边: 快捷键唤出");
          void openPanel(shortcutHoldOpen);
          return;
        }
        // 钉住 = 常驻：双击快捷键不收起面板（Esc / 取消图钉可收）；
        // 专用面板快捷键（force）意图明确，钉住时也执行收起
        if (isOpen && isPinned && !payload.force) {
          tip("info", "面板已固定 · 按 Esc 或取消图钉可收起");
          return;
        }
        if (isOpen) closePanel(true);
        else void openPanel(shortcutHoldOpen);
        return;
      }
      const capturedAt = Number.isFinite(payload.capturedAtMs)
        ? payload.capturedAtMs
        : Date.now();

      // 所有捕获形态共用一个入库收尾，避免富捕获另造 HUD、撤销与结果关联分支。
      const commitCapture = (
        captureText: string,
        aliasRestoredCount: number | null,
        contentBlocks?: NoteContentBlock[],
        captureWarning: string | null = payload.clipboardWarning
      ) => {
        const { result, id } = useNotesStore.getState().addNote(captureText, {
          sourceApp: payload.appName ?? undefined,
          sourceBundle: payload.bundleId ?? undefined,
          // contentBlocks 一旦存在就是唯一真源；旧图片字段只服务单图兼容路径。
          contentBlocks,
          kind:
            contentBlocks === undefined && payload.contentKind === "image"
              ? "image"
              : undefined,
          imageFile:
            contentBlocks === undefined ? payload.imageFile ?? undefined : undefined,
          imageW:
            contentBlocks === undefined ? payload.imageW ?? undefined : undefined,
          imageH:
            contentBlocks === undefined ? payload.imageH ?? undefined : undefined,
          createdAt: capturedAt,
        });
        if (result === "empty") return result;
        const imageCount =
          contentBlocks?.filter((block) => block.type === "image").length ?? 0;
        const capturePreview =
          captureText || (imageCount > 1 ? `图片 ×${imageCount}` : "图片");
        const showCaptureResult = async () => {
          let associationSuggested = false;
          let autoLinked = false;
          if (result === "added" && id && payload.bundleId) {
            try {
              const events = await getRecentDeliveryEventsCached(100);
              const current = useNotesStore
                .getState()
                .notes.find((note) => note.id === id);
              const candidates = current
                ? deliveryCandidatesForCapturedNote(current, events)
                : [];
              // 占位符指纹（对恢复前原文判定）+ 唯一候选 = 双重证据，免确认自动归位；
              // 只有时间窗证据时维持「右键确认」建议，多候选不动
              if (
                candidates.length === 1 &&
                deliveryPlaceholderEvidence(candidates[0].deliveryId, payload.text)
              ) {
                autoLinked = await linkCapturedNoteToDelivery(id, candidates[0]);
              }
              associationSuggested = !autoLinked && candidates.length === 1;
            } catch {
              // 建议是增强能力；活动记录不可用不能吞掉捕获 HUD。
            }
          }
          void api.showCaptureHud(
            result === "duplicate" ? "duplicate" : "added",
            previewOf(capturePreview),
            captureWarning,
            associationSuggested,
            aliasRestoredCount,
            autoLinked
          );
        };
        void showCaptureResult();
        if (id && isSafeRehearsalText(payload.text)) {
          const rehearsal = useNotesStore.getState().settings.onboarding;
          if (
            rehearsal.rehearsalActive &&
            rehearsal.rehearsalStep === "capture"
          ) {
            useNotesStore.getState().transitionOnboarding({
              type: "sampleCaptured",
              noteId: id,
            });
          }
        }
        if (result === "added" && id) {
          void enrichLinkMeta(id);
          captureHistory.push({ id, dataGeneration: currentDataGeneration() });
          setPendingUndo(() => {
            const entry = captureHistory.pop();
            const undoId = entry?.id;
            const exists =
              entry &&
              matchesDataGeneration(entry.dataGeneration) &&
              undoId &&
              useNotesStore.getState().notes.some((n) => n.id === undoId);
            if (exists && undoId) {
              useNotesStore.getState().deleteNotes([undoId], "撤销捕获");
              void api.hudFeedback("undone", "已撤销");
            } else {
              void api.hudFeedback("undone", "没有可撤销的捕获");
            }
          });
          useNotesStore.getState().markOnboarding({ captured: true });
          useUIStore.getState().setFlashId(id);
          window.setTimeout(() => {
            if (useUIStore.getState().flashId === id) {
              useUIStore.getState().setFlashId(null);
            }
          }, 1800);
        }
        return result;
      };

      const captureSettings = useNotesStore.getState().settings;

      // 秘文识别（双击 ⇧ 解密主路径）：开启秘文且捕获文本是可解析的中文密文信封 →
      // 逐密钥试解、路由到「秘文」页（明文不落盘），绝不进普通笔记，也绕开别名还原
      // （别名字面替换会损坏密文）。isSecretEnvelope 结构+魔数校验，误判概率趋近于零。
      if (captureSettings.secretEnabled && isSecretEnvelope(payload.text)) {
        const secretOpts = {
          sourceApp: payload.appName ?? undefined,
          sourceBundle: payload.bundleId ?? undefined,
          createdAt: capturedAt,
        };
        void (async () => {
          const res = await openFromChinese(
            payload.text,
            useNotesStore.getState().settings.secretKeys
          );
          if (res.status === "locked") {
            const { result } = useNotesStore
              .getState()
              .addSecretNote(payload.text, { keyId: null, direction: "in" }, secretOpts);
            if (result !== "empty") tip("warn", "识别到密文，但没有匹配的密钥");
            return;
          }
          if (res.status === "plaintext") {
            const { result, id } = useNotesStore
              .getState()
              .addSecretNote(
                payload.text,
                { keyId: res.keyId, keyLabel: res.keyLabel, direction: "in" },
                secretOpts
              );
            if (result === "duplicate") {
              tip("duplicate", "这条秘文已在秘文页");
            } else if (result === "added" && id) {
              // undoable=true：HUD 悬停出「撤销」，与普通捕获一致
              setPendingUndo(() => {
                useNotesStore.getState().deleteNotes([id], "撤销解密");
                void api.hudFeedback("undone", "已撤销");
              });
              tip("added", `已解密 1 条 · 用【${res.keyLabel}】`, true);
            }
          }
        })();
        return;
      }

      const shouldRestoreAliases =
        payload.contentKind !== "image" &&
        captureSettings.aliasEntitiesEnabled &&
        captureSettings.aliasAutoRestoreOnCapture;

      if (!payload.html) {
        const aliasRestore = shouldRestoreAliases
          ? restoreAliases(payload.text, captureSettings.aliasEntities)
          : null;
        commitCapture(
          aliasRestore?.text ?? payload.text,
          aliasRestore?.restoredCount ?? null
        );
        return;
      }

      // HTML 图片可能异步落盘：持有 generation 租约，若数据位置在此期间变化，
      // 丢弃结果并立即回收刚生成的媒体，绝不写进新账本。
      const lease = beginDataGenerationLease();
      void materializeRichCapture({
        plainText: payload.text,
        html: payload.html,
        sourceUrl: payload.sourceUrl,
      })
        .then((rich) => {
          if (!matchesDataGeneration(lease.generation) || isDataOperationLocked()) {
            scheduleMediaGc(
              rich.contentBlocks.flatMap((block) =>
                block.type === "image" ? [block.file] : []
              ),
              0
            );
            return;
          }
          const restored = shouldRestoreAliases
            ? restoreRichCaptureAliases(rich, captureSettings.aliasEntities)
            : { ...rich, restoredCount: 0 };
          const captureWarning = [
            payload.clipboardWarning,
            restored.omittedImageCount > 0
              ? `${restored.omittedImageCount} 张图片未能保存`
              : null,
          ]
            .filter((warning): warning is string => !!warning)
            .join(" · ") || null;
          if (restored.omittedImageCount > 0 && restored.omittedSchemes.length > 0) {
            void api.diagNote(
              `富图片: 解析丢弃 ${restored.omittedSchemes.join(",")}`
            );
          }
          const result = commitCapture(
            restored.text,
            shouldRestoreAliases ? restored.restoredCount : null,
            restored.contentBlocks,
            captureWarning
          );
          if (result === "empty" && restored.omittedImageCount > 0) {
            tip("warn", `${restored.omittedImageCount} 张图片未能保存`);
          }
        })
        .catch(() => {
          // 富读取失败时仍保存同一 generation 的 AX/plain fallback，不吞正文。
          if (!matchesDataGeneration(lease.generation) || isDataOperationLocked()) {
            return;
          }
          const restored = shouldRestoreAliases
            ? restoreAliases(payload.text, captureSettings.aliasEntities)
            : null;
          const fallbackWarning = [
            payload.clipboardWarning,
            "图片读取失败，已保存文字",
          ].filter(Boolean).join(" · ");
          const result = commitCapture(
            restored?.text ?? payload.text,
            restored?.restoredCount ?? null,
            undefined,
            fallbackWarning
          );
          if (result === "empty") {
            tip("warn", "图片读取失败，未保存到可读取内容");
          }
        })
        .finally(lease.release);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // 详情窗等非主窗口的「加入化名词典」请求：主面板统一取号写入
  useEffect(() => {
    const unlisten = registerAliasQuickAddListener();
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  // HUD 悬停撤销请求
  useEffect(() => {
    const unlisten = listen(UNDO_CAPTURE_EVENT, () => {
      if (isDataOperationLocked()) return;
      runPendingUndo();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // 使用概览可开始/继续演练；继续保留当前步骤，重跑也不清理用户卡片或任务成就。
  useEffect(() => {
    const subscription = listen<SafeRehearsalLaunchRequest>(
      SETTINGS_START_SAFE_REHEARSAL,
      (event) => {
        if (isDataOperationLocked()) {
          tip("warn", "数据操作进行中，暂不能开始演练");
          return;
        }
        const notes = useNotesStore.getState();
        notes.transitionOnboarding(
          safeRehearsalLaunchEvent(
            notes.settings.onboarding,
            event.payload?.mode ?? "start"
          )
        );
        useUIStore.getState().setPage("notes");
        useUIStore.getState().setPinned(true);
        useUIStore.getState().setOpen(true);
        void api.showPanel();
      }
    );
    return () => {
      void subscription.then((unlisten) => unlisten());
    };
  }, []);

  // 独立模式拖动面板 → 记住位置（去抖持久化）
  useEffect(() => {
    let timer = 0;
    const unlisten = listen<{ x: number; y: number }>(PANEL_MOVED_EVENT, (event) => {
      const { x, y } = event.payload;
      // 只有真实用户移动会从 Native 进入这里；一旦移动，快捷键保护即解除。
      useUIStore.getState().setShortcutHoldOpen(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (isDataOperationLocked()) return;
        useNotesStore.getState().setSettings({
          panelFreeX: Math.round(x),
          panelFreeY: Math.round(y),
        });
        // 拖拽落定：停在屏幕左右缘 → Rust 侧吸平入坞贴边隐藏（Dock 式）。
        // 吸平会回传一次 panel-moved（机器移动），本回调重入一次即收敛
        void api.evaluateDragDock().catch(() => {});
      }, 400);
    });
    return () => {
      window.clearTimeout(timer);
      unlisten.then((fn) => fn());
    };
  }, []);

  // 图钉状态同步给 Rust：钉住只豁免失焦，已入坞后的光标收起照常工作。
  useEffect(() => {
    void api.setPanelPinned(pinned).catch(() => {});
  }, [pinned]);

  // 贴边隐藏运行态（Rust → 前端）：active 时失焦不走真实隐藏（滑出取代），
  // hidden 时快捷键/双击唤出要识别成「贴边唤回」而非「开关切换到关闭」
  useEffect(() => {
    const unlisten = listen<EdgeHideStatePayload>(EDGE_HIDE_STATE_EVENT, (event) => {
      useUIStore.getState().setEdgeHideState(event.payload.active, event.payload.hidden);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // 点击 HUD 气泡：展开面板。到期提醒切任务页定位任务，其余高亮刚捕获的卡片
  useEffect(() => {
    const unlisten = listen<HudOpenPanelPayload>(HUD_OPEN_PANEL_EVENT, (event) => {
      const p = event.payload ?? {};
      // 更新提醒：打开面板并唤起更新对话框
      if (p.update) {
        useUIStore.getState().setUpdateDialogOpen(true);
        if (!useUIStore.getState().open) void openPanel();
        return;
      }
      // 直达设置窗指定分区，不动面板
      if (p.settings) {
        void api.openSettingsWindow();
        void emitTo("settings", SETTINGS_SECTION, p.settings);
        return;
      }
      const flash = (id: string) => {
        useUIStore.getState().setFocusedId(id);
        useUIStore.getState().setFlashId(id);
        window.setTimeout(() => {
          if (useUIStore.getState().flashId === id) {
            useUIStore.getState().setFlashId(null);
          }
        }, 1800);
      };
      if (p.page === "tasks") {
        // 先切页（setPage 会清 focusedId），再定位目标任务/账单
        useUIStore.getState().setPage("tasks");
        if (p.billId) {
          useUIStore.getState().setRemindersSubview("subscriptions");
          // bill: 前缀隔离账单/任务的高亮 id 空间（BillRow 按前缀比对）
          flash(`bill:${p.billId}`);
        } else if (p.taskId) {
          useUIStore.getState().setRemindersSubview("tasks");
          flash(p.taskId);
        }
      } else {
        const lastEntry = captureHistory[captureHistory.length - 1];
        const lastId =
          lastEntry && matchesDataGeneration(lastEntry.dataGeneration)
            ? lastEntry.id
            : undefined;
        if (lastId) flash(lastId);
      }
      if (!useUIStore.getState().open) void openPanel();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // 任务到期提醒：水合后即扫一次（补发休眠/重启期间错过的），此后每 30s。
  // 粘性 HUD 可能被后续捕获气泡顶掉，任务页「已到期」红区是兜底真相来源。
  useEffect(() => {
    const check = () => {
      if (isDataOperationLocked()) return;
      const { tasks: all, markTasksReminded } = useNotesStore.getState();
      const due = dueTasksToRemind(all, Date.now());
      if (!due.length) return;
      const text =
        due.length === 1 ? previewOf(due[0].text) : `${due.length} 个任务已到期`;
      void api.hudFeedback(
        "due",
        text,
        false,
        true,
        due.length === 1 ? due[0].id : undefined
      );
      markTasksReminded(due.map((t) => t.id));
    };
    if (useNotesStore.persist.hasHydrated()) check();
    const unsub = useNotesStore.persist.onFinishHydration(() => check());
    window.addEventListener(DATA_RUNTIME_READY_EVENT, check);
    const timer = window.setInterval(check, 30_000);
    return () => {
      unsub();
      window.removeEventListener(DATA_RUNTIME_READY_EVENT, check);
      window.clearInterval(timer);
    };
  }, []);

  // 账单到期提醒（与任务轮询平行，职责独立）：先滚动到期的 active 订阅
  // （可跨多期补记消费历史），再按多档提前量判定提醒并打点去重。
  useEffect(() => {
    const check = () => {
      if (isDataOperationLocked()) return;
      const now = Date.now();
      useNotesStore.getState().rollBillsIfDue(now);
      const state = useNotesStore.getState();
      const due = dueBillsToRemind(state.bills, now);
      if (!due.length) return;
      const text =
        due.length === 1
          ? billDueLabel(due[0].bill, now, state.settings.currencySymbol)
          : `${due.length} 笔账单即将到期`;
      void api.hudFeedback(
        "due",
        text,
        false,
        true,
        due.length === 1 ? `bill:${due[0].bill.id}` : undefined
      );
      state.markBillsReminded(
        due.map((h) => ({ billId: h.bill.id, offset: h.offset }))
      );
    };
    if (useNotesStore.persist.hasHydrated()) check();
    const unsub = useNotesStore.persist.onFinishHydration(() => check());
    window.addEventListener(DATA_RUNTIME_READY_EVENT, check);
    const timer = window.setInterval(check, 30_000);
    return () => {
      unsub();
      window.removeEventListener(DATA_RUNTIME_READY_EVENT, check);
      window.clearInterval(timer);
    };
  }, []);

  // 剪贴板保留时长清理：水合后一次 + 每 30 分钟（固定卡豁免）
  useEffect(() => {
    const prune = () => {
      if (isDataOperationLocked()) return;
      useNotesStore
        .getState()
        .pruneClipHistory()
        .forEach((file) => scheduleMediaGc([file]));
    };
    if (useNotesStore.persist.hasHydrated()) prune();
    const unsub = useNotesStore.persist.onFinishHydration(() => prune());
    window.addEventListener(DATA_RUNTIME_READY_EVENT, prune);
    const timer = window.setInterval(prune, 1_800_000);
    return () => {
      unsub();
      window.removeEventListener(DATA_RUNTIME_READY_EVENT, prune);
      window.clearInterval(timer);
    };
  }, []);

  // 托盘暂停剪贴板收集 → 同步持久化（0 = 恢复）
  useEffect(() => {
    const unlisten = listen<number>(CLIP_PAUSE_EVENT, (event) => {
      if (isDataOperationLocked()) return;
      useNotesStore.getState().setSettings({
        clipPauseUntil: event.payload > 0 ? event.payload : null,
      });
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // 托盘隐身开关 → 同步持久化
  useEffect(() => {
    const unlisten = listen<boolean>(STEALTH_EVENT, (event) => {
      if (isDataOperationLocked()) return;
      useNotesStore.getState().setSettings({ stealth: event.payload });
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // 剪贴板历史：watcher 推送 → 静默入库（重复内容由 addNote 去重吞掉）
  useEffect(() => {
    const unlisten = listen<ClipPayload>(CLIP_EVENT, (event) => {
      if (isDataOperationLocked()) return;
      const p = event.payload;
      // 暂停收集期间丢弃（到期自动恢复，无需额外定时器）
      const pauseUntil = useNotesStore.getState().settings.clipPauseUntil;
      if (pauseUntil && Date.now() < pauseUntil) return;
      const capturedAt = Number.isFinite(p.capturedAtMs)
        ? p.capturedAtMs
        : Date.now();
      // 「连续复制两次自动置顶」的可撤销气泡：静默收集的唯一破例，
      // 因为置顶是手势触发的状态变化，用户需要确认与反悔的机会
      const announceAutoKept = (
        autoKept?: { id: string; preview: string }
      ) => {
        if (!autoKept) return;
        setPendingUndo(() => {
          useNotesStore.getState().toggleNoteKeep(autoKept.id);
          void api.hudFeedback("undone", "已取消置顶");
        });
        tip("ok", `已置顶「${autoKept.preview}」`, true);
      };
      if (!p.html) {
        const clipResult = useNotesStore.getState().addClipNote(p.text, {
          sourceApp: p.appName ?? undefined,
          sourceBundle: p.bundleId ?? undefined,
          kind: p.contentKind === "image" ? "image" : "text",
          imageFile: p.imageFile ?? undefined,
          imageW: p.imageW ?? undefined,
          imageH: p.imageH ?? undefined,
          createdAt: capturedAt,
        });
        scheduleMediaGc(clipResult.orphanImages);
        announceAutoKept(clipResult.autoKept);
        return;
      }

      // HTML 的图片下载可能比下一次复制慢：持有数据 generation 租约，完成后
      // 仍按复制时刻插入。pasteboard 许可已在 Rust 发事件前释放，不阻塞后续复制。
      const lease = beginDataGenerationLease();
      void materializeRichCapture({
        plainText: p.text,
        html: p.html,
        sourceUrl: p.sourceUrl,
      })
        .then((rich) => {
          if (!matchesDataGeneration(lease.generation) || isDataOperationLocked()) {
            scheduleMediaGc(
              rich.contentBlocks.flatMap((block) =>
                block.type === "image" ? [block.file] : []
              ),
              0
            );
            return;
          }
          const clipResult = useNotesStore.getState().addClipNote(rich.text, {
            sourceApp: p.appName ?? undefined,
            sourceBundle: p.bundleId ?? undefined,
            contentBlocks: rich.contentBlocks,
            createdAt: capturedAt,
          });
          scheduleMediaGc(clipResult.orphanImages);
          announceAutoKept(clipResult.autoKept);
          if (rich.omittedImageCount > 0) {
            tip(
              "warn",
              `已保存可读取内容，${rich.omittedImageCount} 张图片未能保存`
            );
            if (rich.omittedSchemes.length > 0) {
              void api.diagNote(
                `富图片: 解析丢弃 ${rich.omittedSchemes.join(",")}`
              );
            }
          }
        })
        .catch(() => {
          // 富读取失败时仍保存同一 generation 的 plain fallback，不吞正文。
          if (matchesDataGeneration(lease.generation) && !isDataOperationLocked()) {
            const clipResult = useNotesStore.getState().addClipNote(p.text, {
              sourceApp: p.appName ?? undefined,
              sourceBundle: p.bundleId ?? undefined,
              kind: "text",
              createdAt: capturedAt,
            });
            announceAutoKept(clipResult.autoKept);
            tip("warn", "图片读取失败，已保存文字");
          }
        })
        .finally(lease.release);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // 推推桥先把完整 raw 对象写入 JSONL；主窗口维护独立结构化消息投影。
  useEffect(() => {
    const unlisten = listen<MessageWatchCapture>(
      MESSAGE_WATCH_EVENT,
      (event) => {
        if (isDataOperationLocked()) return;
        const store = useNotesStore.getState();
        const result = store.ingestMessageCaptures([event.payload]);
        if (result.added > 0) {
          void api.hudFeedback("added", "已捕获推推关注消息");
        }
      }
    );
    return () => {
      unlisten.then((stop) => stop());
    };
  }, []);

  // 水合/切换数据目录后，从 append-only JSONL 恢复消息投影。只读本地文件，
  // 不连接、不打开也不切换推推会话。
  useEffect(() => {
    let alive = true;
    let loading = false;
    const restore = () => {
      if (
        !alive ||
        loading ||
        isDataOperationLocked() ||
        !useNotesStore.persist.hasHydrated()
      ) return;
      loading = true;
      void api
        .getMessageWatchCaptures(1_000)
        .then((captures) => {
          if (alive && !isDataOperationLocked()) {
            useNotesStore.getState().ingestMessageCaptures(captures);
          }
        })
        .catch(() => {})
        .finally(() => {
          loading = false;
        });
    };
    if (useNotesStore.persist.hasHydrated()) restore();
    const stopHydration = useNotesStore.persist.onFinishHydration(restore);
    window.addEventListener(DATA_RUNTIME_READY_EVENT, restore);
    return () => {
      alive = false;
      stopHydration();
      window.removeEventListener(DATA_RUNTIME_READY_EVENT, restore);
    };
  }, []);

  // 失焦：自动隐藏（Pin 豁免）+ 刷新发送目标（防 Pin 场景目标漂移）
  useEffect(() => {
    const win = getCurrentWebviewWindow();
    let focusEpoch = 0;
    const unlisten = win.onFocusChanged(({ payload: focused }) => {
      const epoch = ++focusEpoch;
      if (focused) {
        if (useUIStore.getState().open && !targetObservationPending()) {
          void refreshTarget();
        }
        return;
      }
      // 同步先关发送闸门，再让 Native 采样；即使 A→B→Toskr 全程短于轮询周期，
      // 未真正接受到 B observation 前也不能用旧 A 的存活校验恢复 ready。
      beginTargetBlurObservation();
      // 等焦点归属完成一个事件循环：Native 只在确证 settings/textpreview/imgpreview
      // 已聚焦时把它视为 Toskr 内部切窗；否则仍建立外部 observation 屏障。
      window.setTimeout(() => {
        void observeTargetAfterBlur();
      }, 0);
      window.setTimeout(() => {
        if (epoch === focusEpoch) void observeTargetAfterBlur();
      }, 300);
      // 稍等前台归属稳定再判定：焦点若只是移到自家窗口（空格图片预览、
      // 设置窗），应用仍在前台 → 不算离开，面板不收（未钉住场景）
      window.setTimeout(async () => {
        const {
          open: isOpen,
          pinned: isPinned,
          edgeHideActive,
          shortcutHoldOpen,
        } = useUIStore.getState();
        const { hideOnBlur } = useNotesStore.getState().settings;
        if (
          !shouldHidePanelOnBlur({
            open: isOpen,
            pinned: isPinned,
            hideOnBlur,
            shortcutHoldOpen,
          })
        ) {
          return;
        }
        const stillOurs = await api.isSelfFrontmost().catch(() => false);
        if (stillOurs) return;
        // 未钉住时任何停靠形态失焦都要收起：贴边隐藏接管期间「收起」的
        // 方式是滑出仅露出细条（Dock 式的隐藏，不是真实 hide——否则连
        // 细条都没了，触边唤回/快捷键唤回都会失效）；其余形态走原有真实隐藏
        if (edgeHideActive) {
          void api.edgeHideNow().catch(() => {});
        } else {
          closePanel(false);
        }
      }, 120);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // WebView 从后台/睡眠可见态恢复时复核一次；不设 interval。
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && useUIStore.getState().open) {
        void refreshTarget();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  // 外观：面板不透明度写入 CSS 变量（实时生效）
  const panelOpacity = useNotesStore((s) => s.settings.panelOpacity);
  useEffect(() => {
    document.documentElement.style.setProperty("--panel-alpha", String(panelOpacity));
  }, [panelOpacity]);

  // 设置窗口同步宿主：响应 state 请求 / 应用 patch / 代理导出导入
  useEffect(() => {
    const cleanup = installSettingsSyncHost({
      onExport: () => void exportBackup(),
      onImport: () => void importBackup(),
      onClearClip: () => {
        const { removed, orphanImages } = useNotesStore.getState().clearClipHistory();
        scheduleMediaGc(orphanImages);
        if (removed > 0) undoableTip(`已清空剪贴板历史 ${removed} 条`);
        else tip("info", "剪贴板历史已是空的");
      },
      onDataOperation: (plan) => {
        void runDataLocationOperation(plan)
          .then((result) => {
            reportDataActivity({
              locked: false,
              phase: "complete",
              message: result.message,
            });
            tip("ok", result.message);
          })
          .catch((error) => {
            const message = `数据操作失败：${userError(error)}`;
            reportDataActivity({
              locked: isDataOperationLocked(),
              phase: "rollback",
              message,
            });
            tip("warn", message);
          });
      },
      onDataRecoveryOperation: (plan) => {
        void runRecoveryDataLocationOperation(plan)
          .then((result) => {
            reportDataActivity({
              locked: false,
              phase: "complete",
              message: result.message,
            });
            tip("ok", result.message);
          })
          .catch((error) => {
            const message = `数据恢复失败：${userError(error)}`;
            reportDataActivity({
              locked: isDataOperationLocked(),
              phase: isDataOperationLocked() ? "storageRecovery" : "rollback",
              message,
            });
            tip("warn", message);
          });
      },
      onDataHealth: () => {
        void api
          .inspectMediaIntegrity(mediaIntegrityStateJson())
          .then((report) => emitTo("settings", SETTINGS_DATA_HEALTH_RESULT, report))
          .catch((error) => {
            tip("warn", `健康检查失败：${userError(error)}`);
          });
      },
      onDataConflictAction: (action) => {
        const reload = () =>
          reloadAfterPersistenceConflict()
            .then(() => tip("ok", "已重新加载磁盘新版本"))
            .catch((error) => tip("warn", `重新加载失败：${userError(error)}`));
        if (action === "reload") {
          void reload();
          return;
        }
        if (action === "retryStorage" || action === "loadDefault") {
          const recover =
            action === "retryStorage"
              ? api.retryStorageInitialization
              : api.loadDefaultFromRecovery;
          void recover()
            .then(async () => {
              await reload();
              tip(
                "ok",
                action === "retryStorage"
                  ? "存储挂载已恢复"
                  : "已明确加载默认数据目录"
              );
            })
            .catch((error) =>
              tip("warn", `存储恢复失败：${userError(error)}`)
            );
          return;
        }
        void import("@tauri-apps/plugin-dialog")
          .then(({ save }) =>
            save({
              defaultPath: "toskr-conflict-recovery.toskr-backup",
              filters: [
                { name: "Toskr 恢复副本", extensions: ["toskr-backup"] },
              ],
            })
          )
          .then(async (path) => {
            if (!path) return;
            await api.exportConflictRecoveryBackup(
              path,
              JSON.stringify(buildBackupPayload(useNotesStore.getState()))
            );
            tip("ok", "当前内存已另存为恢复副本");
            await reload();
          })
          .catch((error) => tip("warn", `另存恢复副本失败：${userError(error)}`));
      },
    });
    return cleanup;
  }, []);

  // 设置变化后广播给设置窗口（托盘隐身切换等外部改动也能同步）
  useEffect(() => useNotesStore.subscribe(() => broadcastSettings()), []);

  useEffect(() => {
    const onConflict = (event: Event) => {
      // 存储恢复模式（初始化失败）自有横幅与出口；必须在落盘任何标记之前判断——
      // 曾因先 markDataConflict 后判相位，把恢复态误持久化成「外部修改」伪冲突，
      // 导致之后每次启动都被陈旧标记冻结在只读（2026-08 事故）。
      if (useDataOperationStore.getState().phase === "storageRecovery") {
        return;
      }
      // 把真实错误进诊断日志：冲突原因不再靠猜（CAS 拒绝 / 读取失败 / 事务门）
      const detail = (event as CustomEvent).detail;
      void api.diagNote(`数据冲突事件: ${userError(detail)}`);
      const message = "检测到数据文件被外部修改，已停止自动覆盖";
      void api
        .markDataConflict()
        .then(() => {
          reportDataActivity({
            locked: true,
            phase: "conflict",
            message,
          });
          tip("warn", `${message}；请在设置 → 数据中选择处理方式`);
        })
        .catch((error) => {
          reportDataActivity({
            locked: true,
            phase: "rollback",
            message: `冲突状态持久化失败：${userError(error)}`,
          });
        });
    };
    window.addEventListener(PERSISTENCE_CONFLICT_EVENT, onConflict);
    return () => window.removeEventListener(PERSISTENCE_CONFLICT_EVENT, onConflict);
  }, []);

  useEffect(() => {
    const invalidated = listen(DATA_CONTEXT_INVALIDATED_EVENT, () => {
      captureHistory.length = 0;
      clearPendingUndo();
      clearEditorSessionMedia();
      clearDeliveryRedactionSessions();
      closeResultReturnDialog();
      closeResultVerificationDialog();
      useDeliveryStore.getState().closeDraft();
      clearDeliveryDraftImages();
    });
    const activityCleared = listen(DELIVERY_ACTIVITY_CLEARED_EVENT, () => {
      invalidateDeliveryActivityCache();
      closeResultReturnDialog();
      closeResultVerificationDialog();
      window.dispatchEvent(new Event(RESULT_LINK_CHANGED_EVENT));
    });
    return () => {
      invalidated.then((stop) => stop());
      activityCleared.then((stop) => stop());
    };
  }, []);

  // 文本详情窗的写回通道：编辑保存 / 发送都回到主面板执行
  // （主面板是唯一持久化写入方，详情窗只读展示 + 发事件）
  useEffect(() => {
    const stopEditorMediaReleases = subscribeEditorMediaReleases((release) => {
      if (matchesDataGeneration(release.dataGeneration)) {
        scheduleMediaGc(release.files);
      }
    });
    let hydrated = useNotesStore.persist.hasHydrated();
    if (hydrated) runScheduledMediaGc();
    const stopHydrationSweep = useNotesStore.persist.onFinishHydration(() => {
      hydrated = true;
      runScheduledMediaGc();
    });
    const onRuntimeReady = () => {
      hydrated = true;
      runScheduledMediaGc();
    };
    window.addEventListener(DATA_RUNTIME_READY_EVENT, onRuntimeReady);
    const stopGcWatch = useNotesStore.subscribe((state, previous) => {
      if (state.notes !== previous.notes || state.undoStack !== previous.undoStack) {
        const before = new Set(previous.notes.flatMap(noteImages));
        const after = new Set(state.notes.flatMap(noteImages));
        scheduleMediaGc([...before].filter((file) => !after.has(file)));
        if (hydrated) runScheduledMediaGc();
      }
    });
    const subs = [
      listen<NoteEditPayload>("toskr://note-edit", (e) => {
        if (
          isDataOperationLocked() ||
          !matchesDataGeneration(e.payload.dataGeneration)
        ) {
          // 静默丢弃会让用户误信已保存；面板可能贴边隐藏，必须带回可见告知
          warnWithPanel(
            "编辑未保存：数据上下文已变化，请复制内容后重新打开卡片",
            "note-edit rejected"
          );
          return;
        }
        if (e.payload.format === "blocks") {
          useNotesStore
            .getState()
            .updateNoteContent(e.payload.id, e.payload.contentBlocks);
        } else {
          useNotesStore
            .getState()
            .updateNoteText(e.payload.id, e.payload.text, e.payload.images);
          // 收尾保存可撤销：留 30s 宽限，撤销还原引用后 GC 复查会放过这些文件
          scheduleMediaGc(
            e.payload.discardedImages ?? [],
            e.payload.origin ? undefined : 0
          );
        }
        // 编辑中的静默自动保存：会话未结束，不释放媒体会话、不提示、不抓链接
        if (e.payload.autosave) return;
        if (e.payload.sessionId) {
          releaseEditorSessionMedia(e.payload.sessionId);
        }
        void enrichLinkMeta(e.payload.id);
        if (e.payload.origin) {
          armNoteEditUndo(e.payload.id, e.payload.origin);
        } else {
          tip("ok", "已保存");
        }
      }),
      listen<{ id: string; dataGeneration: number; text?: string }>(
        "toskr://note-send",
        (e) => {
        if (
          isDataOperationLocked() ||
          !matchesDataGeneration(e.payload.dataGeneration)
        ) {
          warnWithPanel(
            "发送已取消：数据上下文已变化，请重新打开卡片后再发送",
            "note-send rejected"
          );
          return;
        }
        // text 存在 = 详情窗「发送选中」：只发选中片段，仍以该卡为来源
        void sendNotesToChat(
          [e.payload.id],
          undefined,
          e.payload.text !== undefined
            ? { overrideText: e.payload.text }
            : undefined
        );
        }
      ),
      // 详情窗移除组合卡里的某张图（可撤销；磁盘文件保留，撤销要还原得回来）
      listen<{ id: string; file: string; dataGeneration: number }>(
        "toskr://note-image-remove",
        (e) => {
        if (
          isDataOperationLocked() ||
          !matchesDataGeneration(e.payload.dataGeneration)
        ) {
          warnWithPanel(
            "移除图片未生效：数据上下文已变化，请重新打开卡片",
            "note-image-remove rejected"
          );
          return;
        }
        const { noteDeleted } = useNotesStore
          .getState()
          .removeNoteImage(e.payload.id, e.payload.file);
        scheduleMediaGc([e.payload.file]);
        undoableTip(noteDeleted ? "已删除 1 条" : "已移除图片");
        }
      ),
      // 详情窗 ⌘Z：执行当前待撤销动作（与点击 HUD「撤销」同路），
      // 随后重推详情窗内容——撤销后窗内展示不能停留在回退前
      listen(RUN_PENDING_UNDO_EVENT, () => {
        runPendingUndo();
        void refreshOpenNoteDetail();
      }),
      // 详情窗标签编辑写回（sanitize 在 store 内统一执行）
      listen<NoteTagsPayload>(NOTE_TAGS_EVENT, (e) => {
        if (
          isDataOperationLocked() ||
          !matchesDataGeneration(e.payload.dataGeneration)
        ) {
          warnWithPanel(
            "标签未保存：数据上下文已变化，请重新打开卡片",
            "note-tags rejected"
          );
          return;
        }
        useNotesStore.getState().setNoteTags(e.payload.id, e.payload.tags);
      }),
      // 详情编辑取消时仅删本次新增、且没有被任意卡片引用的图片；剪贴板
      // 内容哈希可能命中已有文件，不能由详情窗直接删盘。
      listen<{ files: string[]; dataGeneration: number }>(
        "toskr://note-image-discard",
        (e) => {
        if (
          isDataOperationLocked() ||
          !matchesDataGeneration(e.payload.dataGeneration)
        )
          return;
        scheduleMediaGc(e.payload.files, 0);
        }
      ),
      listen<NoteEditorSessionReleasePayload>(
        NOTE_EDITOR_SESSION_RELEASE_EVENT,
        (e) => {
          releaseEditorSessionMedia(e.payload.targetSessionId);
          // 当前会话被释放 = 详情窗收起/关闭，发送按钮回落「发送」语义
          noteEditorSessionReleased(e.payload.targetSessionId);
        }
      ),
    ];
    return () => {
      stopEditorMediaReleases();
      stopHydrationSweep();
      window.removeEventListener(DATA_RUNTIME_READY_EVENT, onRuntimeReady);
      stopGcWatch();
      subs.forEach((p) => p.then((fn) => fn()));
    };
  }, []);

  // 持久化水合后把运行时配置下发给 Rust
  useEffect(() => {
    const pendingMigrations = new Set<number>();
    const migrateAiKey = (source: Settings) => {
      const legacyKey = legacyAiApiKey(source);
      const generation = currentDataGeneration();
      if (
        !legacyKey ||
        isDataOperationLocked() ||
        pendingMigrations.has(generation)
      ) return;
      pendingMigrations.add(generation);
      void migrateLegacyAiApiKey(source, {
        setAiApiKey: api.setAiApiKey,
        commit: () => {
          // Keychain IPC 在途时可能切换数据目录或修改其他设置：只移除当前
          // 仍匹配的旧 secret，绝不把 source 快照覆盖回新 settings。
          const current = useNotesStore.getState().settings;
          if (
            !matchesDataGeneration(generation) ||
            isDataOperationLocked() ||
            legacyAiApiKey(current) !== legacyKey
          ) return;
          useNotesStore.setState({
            settings: withoutLegacyAiApiKey(current),
          });
        },
      }).then((result) => {
        if (
          result === "failed" &&
          matchesDataGeneration(generation) &&
          legacyAiApiKey(useNotesStore.getState().settings) === legacyKey
        ) {
          tip(
            "warn",
            "AI 密钥迁移到 macOS 钥匙串失败；旧副本仍保留，请到设置中重试"
          );
        }
      }).finally(() => pendingMigrations.delete(generation));
    };
    // 历史状态自愈：贴边隐藏已是无开关的默认能力；伴随只在命中目标时接管，
    // 因此两者不再互斥。固定边栏仍与伴随接管互斥。
    const heal = (settings: Settings): Settings => {
      const patch: Partial<Settings> = {};
      if (!settings.autoEdgeHide) patch.autoEdgeHide = true;
      if (
        (patch.companionEnabled ?? settings.companionEnabled) &&
        settings.rightSidebar
      ) {
        patch.rightSidebar = false;
        patch.panelFreeX = null;
        patch.panelFreeY = null;
      }
      if (!Object.keys(patch).length) return settings;
      useNotesStore.getState().setSettings(patch);
      return useNotesStore.getState().settings;
    };
    // 伴随模式沿用既有“常显示”默认；默认贴边能力本身不再强制图钉，
    // 快捷键呼出由单次会话保护精确控制。
    const applyModeDefaults = (settings: Settings): Settings => {
      if (settings.companionEnabled) {
        useUIStore.getState().setPinned(true);
      }
      return settings;
    };
    if (useNotesStore.persist.hasHydrated()) {
      const settings = applyModeDefaults(heal(useNotesStore.getState().settings));
      applyRuntimeSettings(settings);
      migrateAiKey(settings);
    }
    const unsub = useNotesStore.persist.onFinishHydration((state) => {
      const settings = applyModeDefaults(heal(state.settings));
      applyRuntimeSettings(settings);
      migrateAiKey(settings);
      // 迁移提交：新数据文件尚不存在（数据还在旧存储）时立即落盘一次
      void api
        .readDataSnapshot()
        .then((snapshot) => {
          if (!snapshot.content) useNotesStore.setState({});
        })
        .catch(() => {});
    });
    const stopDataActivity = useDataOperationStore.subscribe((state, previous) => {
      if (
        previous.locked &&
        !state.locked &&
        useNotesStore.persist.hasHydrated()
      ) {
        migrateAiKey(useNotesStore.getState().settings);
      }
    });
    return () => {
      unsub();
      stopDataActivity();
    };
  }, []);

  // 设置窗显式 set/delete 后清除当前数据目录可能残留的旧 JSON key；数据事务
  // 期间只记意图，解锁后再写，避免 Keychain 事件穿透目录切换的写闸。
  useEffect(() => {
    let clearPending = false;
    const clearLegacyKey = () => {
      if (isDataOperationLocked()) {
        clearPending = true;
        return;
      }
      const current = useNotesStore.getState().settings;
      clearPending = false;
      if (!legacyAiApiKey(current)) return;
      useNotesStore.setState({ settings: withoutLegacyAiApiKey(current) });
    };
    const subscription = listen(SETTINGS_AI_KEY_CHANGED, clearLegacyKey);
    const stopDataActivity = useDataOperationStore.subscribe((state) => {
      if (clearPending && !state.locked) clearLegacyKey();
    });
    return () => {
      void subscription.then((unlisten) => unlisten());
      stopDataActivity();
    };
  }, []);

  // 静默检查更新：启动 8 秒后一次 + 之后每 30 分钟一次（常驻后台、重启频率低，
  // 只查启动那一次会长期错过新版）。发现新版右上角气泡提醒；同版本去重在
  // silentUpdateFlow 内，不会重复弹泡/重复下载。
  useEffect(() => {
    const timer = window.setTimeout(() => void silentUpdateFlow(), 8000);
    const periodic = window.setInterval(
      () => void silentUpdateFlow(),
      30 * 60 * 1000
    );
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(periodic);
    };
  }, []);

  // 首个数据档案只消费一次默认态：先固定，再启用伴随磁吸，最后显示面板。
  // 独立标记与 onboarding 解耦，避免升级用户或重跑安全演练时被改写磁吸偏好。
  // Native 任一步失败都不落“已完成”，下次启动会幂等重试；老档案由 v17 迁移
  // 直接标记完成。数据运行时解锁前禁止写入，避免初始化穿透目录事务闸门。
  useEffect(() => {
    let alive = true;
    let applying = false;

    // 应用级首启（webview localStorage，跨数据档案）：安装后第一次启动默认
    // 亮出主面板——新档案的完整 setup 在下方另有流程；老档案（迁移已标记
    // initialPanelSetupDone）只做展示，不改伴随/图钉偏好
    try {
      if (!window.localStorage.getItem("toskr-first-launch-shown")) {
        window.localStorage.setItem("toskr-first-launch-shown", "1");
        useUIStore.getState().setOpen(true);
        void api.showPanel();
      }
    } catch {
      /* localStorage 不可用则跳过 */
    }

    const showActiveOnboarding = (settings: Settings) => {
      const current = settings.onboarding;
      if (current.done || !current.rehearsalActive) return;
      useUIStore.getState().setPinned(true);
      useUIStore.getState().setOpen(true);
      void api.showPanel();
    };

    const reconcileInitialPanel = () => {
      if (
        !alive ||
        applying ||
        isDataOperationLocked() ||
        !useNotesStore.persist.hasHydrated()
      ) return;

      const settings = useNotesStore.getState().settings;
      if (settings.initialPanelSetupDone) {
        showActiveOnboarding(settings);
        return;
      }

      applying = true;
      const side = settings.sidebarEdge === "left" ? "left" : "right";
      useNotesStore.getState().setSettings({
        companionEnabled: true,
        rightSidebar: false,
        panelFreeX: null,
        panelFreeY: null,
      });
      useUIStore.getState().setPinned(true);
      useUIStore.getState().setOpen(true);

      void (async () => {
        try {
          // 配置顺序很重要：先解除边栏/自由位置，再让 companion 以最终状态
          // 计算首次布局；showPanel 最后执行，避免先按独立模式闪现一帧。
          await api.setPanelPinned(true);
          await api.setPanelFreePos(null, null);
          await api.setSidebarMode(false, settings.sidebarEdge);
          await api.setCompanionGap(settings.companionGap);
          await api.setCompanionConfig(true, settings.companionApps, side);
          await api.showPanel();
          if (!alive || isDataOperationLocked()) return;
          useNotesStore.getState().setSettings({ initialPanelSetupDone: true });
          await flushPendingWrites();
        } catch {
          // 打开面板优先于增强布局；未持久完成的标记会在下次启动从磁盘重试。
          if (alive) void api.showPanel().catch(() => {});
        } finally {
          applying = false;
        }
      })();
    };

    if (useNotesStore.persist.hasHydrated()) {
      reconcileInitialPanel();
    }
    const unsub = useNotesStore.persist.onFinishHydration(reconcileInitialPanel);
    window.addEventListener(DATA_RUNTIME_READY_EVENT, reconcileInitialPanel);
    return () => {
      alive = false;
      unsub();
      window.removeEventListener(DATA_RUNTIME_READY_EVENT, reconcileInitialPanel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 上手引导完成庆祝
  const prevOnboardingDone = useRef(onboarding.done);
  useEffect(() => {
    if (onboarding.done && !prevOnboardingDone.current) {
      tip("ok", "上手完成，Toskr 已就绪 🎉");
    }
    prevOnboardingDone.current = onboarding.done;
  }, [onboarding.done]);

  const exportBackup = async () => {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({
        defaultPath: "toskr-complete-backup.toskr-backup",
        filters: [{ name: "Toskr 完整备份", extensions: ["toskr-backup"] }],
      });
      if (!path) return;
      const inspection = await runCompleteBackupExport(path);
      tip(
        "ok",
        `完整备份已验证：${inspection.counts.notes} 条笔记、${inspection.counts.messages} 条消息、${inspection.counts.tasks} 个任务、${inspection.counts.media} 个媒体`
      );
    } catch (e) {
      tip("warn", `导出失败：${userError(e)}`);
    }
  };

  const importBackup = async () => {
    let importCommitted = false;
    try {
      const { ask, open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({
        multiple: false,
        filters: [
          { name: "Toskr 备份", extensions: ["toskr-backup", "json"] },
        ],
      });
      if (typeof path !== "string") return;
      const inspection = await api.inspectBackup(path);
      const counts = inspection.counts;
      const legacyLimitations = [
        ...inspection.warnings,
        ...(inspection.missingMedia.length
          ? [`引用了 ${inspection.missingMedia.length} 个未随旧 JSON 提供的媒体文件`]
          : []),
      ];
      const confirmed = await ask(
        inspection.format === "complete"
          ? `完整备份已通过 manifest/hash 预检。将恢复 ${counts.notes} 条笔记、${counts.messages} 条消息、${counts.tasks} 个任务、${counts.media} 个媒体，并先创建当前数据恢复点。原始推推 JSONL 账本不在归档内，仍需按设置页路径单独备份；API Key 不在备份中，恢复后需重新配置。继续吗？`
          : `这是旧 JSON，将先创建当前数据恢复点，再按 ID 合并 ${counts.notes} 条笔记、${counts.tasks} 个任务。\n\n完整性限制：\n- ${legacyLimitations.join("\n- ")}\n\n继续吗？`,
        { title: "导入预检", kind: "warning" }
      );
      if (!confirmed) return;
      const operationId = crypto.randomUUID();
      if (inspection.format === "complete") {
        const { result } = await runCompleteBackupImport(
          path,
          operationId,
          inspection.archiveRevision
        );
        importCommitted = true;
        reportDataActivity({
          locked: false,
          phase: "complete",
          message: result.message,
        });
        tip("ok", `完整备份恢复完成：笔记 ${counts.notes} 条，消息 ${counts.messages} 条，媒体 ${counts.media} 个`);
      } else {
        const { added } = await runLegacyJsonImport(
          path,
          operationId,
          inspection.archiveRevision
        );
        importCommitted = true;
        const duplicateSuffix = added.skippedDuplicates
          ? `，跳过重复 ID ${added.skippedDuplicates} 项`
          : "";
        try {
          const health = await api.inspectMediaIntegrity(mediaIntegrityStateJson());
          await emitTo("settings", SETTINGS_DATA_HEALTH_RESULT, health);
          const partial =
            health.missing.length > 0 || inspection.missingMedia.length > 0;
          reportDataActivity({
            locked: false,
            phase: "complete",
            message: partial
              ? `旧 JSON 已部分导入；健康检查仍有 ${health.missing.length} 个缺失媒体`
              : "旧 JSON 已兼容导入并完成数据健康检查",
          });
          tip(
            partial ? "warn" : "ok",
            `${partial ? "旧 JSON 部分合并" : "旧 JSON 合并完成"}：笔记 ${added.notes} 条，任务 ${added.tasks} 个${duplicateSuffix}${partial ? `；缺失媒体 ${health.missing.length} 个` : ""}`
          );
        } catch (postflightError) {
          const message = `旧 JSON 已导入，但完整性报告生成失败：${userError(postflightError)}`;
          reportDataActivity({ locked: false, phase: "complete", message });
          tip("warn", message);
        }
      }
      broadcastSettings();
      runScheduledMediaGc();
    } catch (e) {
      const locked = isDataOperationLocked();
      const message = importCommitted
        ? `导入已完成，但后续刷新失败：${userError(e)}`
        : `导入失败：${userError(e)}`;
      reportDataActivity({
        locked,
        phase: importCommitted ? "complete" : locked ? "rollback" : "idle",
        message,
      });
      tip("warn", message);
    }
  };

  // ===== 列表派生 =====

  const q = query.trim();
  // 笔记页不再显示「剪贴板」分组——剪贴板历史提升为平级 tab
  /** 横栏分组过滤（null=全部；笔记/任务各自独立）。 */
  const [noteGroupFilter, setNoteGroupFilter] = useState<string | null>(null);
  const [taskGroupFilter, setTaskGroupFilter] = useState<string | null>(null);

  const grouped = useMemo(
    () =>
      sections
        .filter(
          (section) => section.id !== CLIPBOARD_ID && section.id !== SECRET_ID
        )
        .map((section) => {
          const inSection = notes.filter(
            // kind!==secret 兜底：秘文卡即便分组孤儿也绝不在笔记页用 NoteCard 渲染
            (n) =>
              n.sectionId === section.id &&
              n.kind !== "secret" &&
              matchNote(n, q)
          );
          return {
            section,
            active: inSection.filter((n) => !n.done),
            done: inSection.filter((n) => n.done),
          };
        })
        .filter((g) => !q || g.active.length + g.done.length > 0),
    [sections, notes, q]
  );
  /** 横栏形态：各分组未完成卡拍平成一条串（分组顺序 → 组内顺序），
   *  可按分组胶囊过滤。 */
  const stripNotes = useMemo(() => {
    if (noteGroupFilter === DONE_FILTER) return grouped.flatMap((g) => g.done);
    return grouped
      .filter((g) => !noteGroupFilter || g.section.id === noteGroupFilter)
      .flatMap((g) => g.active);
  }, [grouped, noteGroupFilter]);
  const stripNoteIds = useMemo(() => stripNotes.map((n) => n.id), [stripNotes]);

  /** 剪贴板 tab：固定（keep）置顶，其余按时间流水（notes 数组新在前）。 */
  const clipNotes = useMemo(() => {
    const list = notes.filter(
      (n) => n.sectionId === CLIPBOARD_ID && matchNote(n, q)
    );
    return [...list.filter((n) => n.keep), ...list.filter((n) => !n.keep)];
  }, [notes, q]);

  /** 秘文 tab：按 kind 筛（对 section 孤儿健壮），时间流水（新在前）。 */
  const secretNotes = useMemo(
    () => notes.filter((n) => n.kind === "secret" && matchSecretNote(n, q)),
    [notes, q]
  );
  const secretNavIds = useMemo(() => secretNotes.map((n) => n.id), [secretNotes]);

  const messageSearchIds = useMemo(() => {
    const needle = q.toLocaleLowerCase();
    return messages
      .filter((message) => {
        if (!needle) return true;
        return [
          message.conversationName,
          message.conversationId,
          message.senderName,
          message.senderUid,
          message.text,
          ...message.context.flatMap((item) => [item.senderName, item.text]),
        ]
          .filter(Boolean)
          .join("\n")
          .toLocaleLowerCase()
          .includes(needle);
      })
      .map((message) => message.id);
  }, [messages, q]);

  const noteMatchCount = grouped.reduce(
    (a, g) => a + g.active.length + g.done.length,
    0
  );
  const matchCount =
    page === "clipboard"
      ? clipNotes.length
      : page === "notes" && contentSubview === "secret"
        ? secretNotes.length
        : page === "notes" && contentSubview === "messages"
          ? messageSearchIds.length
          : noteMatchCount;

  /** 键盘导航覆盖的可见卡片序列（笔记页）。 */
  const noteNavIds = useMemo(
    () =>
      grouped.flatMap((g) =>
        g.section.collapsed
          ? []
          : [
              ...g.active.map((n) => n.id),
              ...(doneOpen[g.section.id] ? g.done.map((n) => n.id) : []),
            ]
      ),
    [grouped, doneOpen]
  );

  // ===== 任务页派生 =====

  // 到期分区需要随时间推移刷新（任务不变但"是否逾期"在变），30s 一跳
  const [taskNow, setTaskNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setTaskNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const taskBuckets = useMemo(
    () => bucketTasksForDisplay(tasks, taskSections, taskNow),
    [tasks, taskSections, taskNow]
  );
  /** 横栏形态：到期 → 灵感 → 各组进行中/待办拍平（不含已完成），
   *  可按分组胶囊过滤。 */
  const stripTasks = useMemo(() => {
    const flat = [
      ...taskBuckets.overdue,
      ...taskBuckets.sparks,
      ...taskBuckets.groups.flatMap((g) => g.tasks),
    ];
    if (taskGroupFilter === DONE_FILTER) return taskBuckets.done;
    if (!taskGroupFilter) return flat;
    return flat.filter(
      (t) => (t.sectionId ?? TASK_INBOX_ID) === taskGroupFilter
    );
  }, [taskBuckets, taskGroupFilter]);
  const taskNavIds = useMemo(
    () => [
      ...(doneOpen[TASK_OVERDUE_COLLAPSED_KEY]
        ? []
        : taskBuckets.overdue.map((t) => t.id)),
      ...(doneOpen[TASK_SPARKS_COLLAPSED_KEY]
        ? []
        : taskBuckets.sparks.map((t) => t.id)),
      ...taskBuckets.groups.flatMap((g) =>
        g.section.collapsed ? [] : g.tasks.map((t) => t.id)
      ),
      ...(doneOpen[TASK_DONE_KEY] ? taskBuckets.done.map((t) => t.id) : []),
    ],
    [taskBuckets, doneOpen]
  );

  // 剪贴板分页渲染：保留时长开到年/永久后可能上万条，一次性渲染会卡；
  // 首屏 60 张在启动时随常驻页挂载（切页零成本），滚动哨兵按 200 递增
  const [clipShown, setClipShown] = useState(60);
  const visibleClipNotes = useMemo(
    () => clipNotes.slice(0, clipShown),
    [clipNotes, clipShown]
  );
  const clipNavIds = useMemo(
    () => visibleClipNotes.map((n) => n.id),
    [visibleClipNotes]
  );
  /** 纵向列表的时间分组（Raycast 剪贴板风格）：置顶独立一组，其余按时间段
   *  连续合并；手动拖动重排后同段名可能再现，key 取组首元素 id 保证稳定。
   *  taskNow 30s 心跳顺带驱动段边界随时间推移（刚刚 → 1 小时内）。 */
  const clipBands = useMemo(() => {
    const bands: { band: string; notes: typeof visibleClipNotes }[] = [];
    for (const n of visibleClipNotes) {
      const band = n.keep ? "置顶" : clipTimeBand(n.createdAt, taskNow);
      const last = bands[bands.length - 1];
      if (last && last.band === band) last.notes.push(n);
      else bands.push({ band, notes: [n] });
    }
    return bands;
  }, [visibleClipNotes, taskNow]);

  /** 上/下横栏形态：三页走方形卡片串（导航序也切到串序）。 */
  const horizontalBar =
    settings.rightSidebar &&
    (settings.sidebarEdge === "top" || settings.sidebarEdge === "bottom");
  const stripTaskIds = useMemo(() => stripTasks.map((t) => t.id), [stripTasks]);

  /** 当前页的键盘导航序列（横栏 = 胶囊过滤后的卡片串序）。 */
  const navIds =
    page === "tasks"
      ? horizontalBar
        ? stripTaskIds
        : taskNavIds
      : page === "clipboard"
        ? clipNavIds
        : page === "notes" && contentSubview === "secret"
          ? secretNavIds
          : page === "notes" && contentSubview === "messages"
            ? []
            : horizontalBar
              ? stripNoteIds
              : noteNavIds;

  // 可见顺序同步到 uiStore，供 Shift 范围选中使用
  useEffect(() => {
    const ui = useUIStore.getState();
    ui.setNavIds(navIds);
    if (ui.focusedId && !navIds.includes(ui.focusedId)) {
      ui.setFocusedId(null);
    }
  }, [navIds]);

  const activeCount = notes.filter((n) => !n.done).length;
  const doneCount = notes.length - activeCount;
  const activeTaskCount = tasks.filter((t) => t.status !== "done").length;
  const doneTaskCount = tasks.length - activeTaskCount;

  // 页面序：用户可拖动页签重排（持久化）。常驻页按序差决定滑向
  // （左侧页藏左、右侧页藏右），所以顺序一变滑动方向立刻跟着变
  const pageOrder = useNotesStore((s) => s.settings.pageOrder);
  const clipHistory = useNotesStore((s) => s.settings.clipHistory);
  const secretEnabled = useNotesStore((s) => s.settings.secretEnabled);
  const messagesEnabled = useNotesStore((s) => s.settings.messagesEnabled);
  const subscriptionsEnabled = useNotesStore((s) => s.settings.subscriptionsEnabled);
  const welcomeTourSeen = useNotesStore((s) => s.settings.welcomeTourSeen);
  // 内容域（消息/秘文）都未启用时回到经典形态：一级页签「剪贴 · 笔记 · 提醒」，
  // 不出现「内容」二级导航；由设置页显式开关控制（均默认关闭）
  const contentDomainsOn = secretEnabled || messagesEnabled;
  // 秘文合并进「内容」二级导航，不再占一级页签；关闭剪贴历史则隐藏剪贴页。
  const visiblePages = useMemo(
    () =>
      pageOrder.filter(
        (p) => p !== "secret" && (p !== "clipboard" || clipHistory)
      ),
    [pageOrder, clipHistory]
  );
  const pageIndex = Math.max(0, pageOrder.indexOf(page));
  const orderOf = (p: PageId) => Math.max(0, pageOrder.indexOf(p));
  const clipboardPageRef = useRef<HTMLDivElement>(null);
  const notesPageRef = useRef<HTMLDivElement>(null);
  const tasksPageRef = useRef<HTMLDivElement>(null);
  const secretPageRef = useRef<HTMLDivElement>(null);
  const pageRootRef: Record<PageId, React.RefObject<HTMLDivElement | null>> = {
    clipboard: clipboardPageRef,
    notes: notesPageRef,
    tasks: tasksPageRef,
    secret: secretPageRef,
  };
  const scrollTabPageToStart = (id: PageId) => {
    scrollPageToStart(
      pageRootRef[id].current,
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  };
  // 停在剪贴页时把功能关掉 → 该页已不可达，切到页序上的第一个可见页
  useEffect(() => {
    if (page === "secret") {
      useUIStore.getState().setPage("notes");
      if (secretEnabled) useUIStore.getState().setContentSubview("secret");
      return;
    }
    if (!visiblePages.includes(page)) {
      useUIStore.getState().setPage(visiblePages[0] ?? "notes");
    }
  }, [visiblePages, page, secretEnabled]);

  useEffect(() => {
    if (!secretEnabled && contentSubview === "secret") {
      useUIStore.getState().setContentSubview("notes");
    }
  }, [contentSubview, secretEnabled]);

  useEffect(() => {
    if (!messagesEnabled && contentSubview === "messages") {
      useUIStore.getState().setContentSubview("notes");
    }
  }, [messagesEnabled, contentSubview]);
  /** 横栏下笔记输入通栏默认收起，由工具栏「添加笔记」按钮唤出。 */
  const [barDraftOpen, setBarDraftOpen] = useState(false);

  // 落盘兜底：persist 有 400ms 防抖窗口，且没有任何退出路径主动冲刷——
  // 面板隐藏（托盘退出前的必经态）立即 flush，压缩「改完即退」丢写窗口
  useEffect(() => {
    const flushOnHide = () => {
      if (document.visibilityState === "hidden") {
        void flushPendingWrites().catch(() => {
          /* 冲突恢复流程已有专门提示通道 */
        });
      }
    };
    document.addEventListener("visibilitychange", flushOnHide);
    return () => document.removeEventListener("visibilitychange", flushOnHide);
  }, []);

  // 视图即选择作用域：切走页面/子视图即清空多选。剪贴与笔记共用一份
  // checkedIds，不清则快捷键（⌘⏎/⌘C/合并）会作用于另一页不可见的卡片。
  // 用 store 订阅而非 React effect：setPage 内同步触发，跳转流程随后的
  // setFocusedId/setChecked 不会被迟到的清空误伤
  useEffect(() => {
    return useUIStore.subscribe((state, prev) => {
      if (
        state.page === prev.page &&
        state.contentSubview === prev.contentSubview
      )
        return;
      const st = useNotesStore.getState();
      if (st.checkedIds.length) st.clearChecked();
    });
  }, []);

  // ===== 面板内快捷键（Esc 分层 + 全键盘导航） =====
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (useDeliveryStore.getState().open) return;
      if (isDataOperationLocked()) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const target = e.target as HTMLElement | null;
      const editable =
        !!target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT");

      // 预览层打开时的按键优先级最高（Paste 风格）
      {
        const ui = useUIStore.getState();
        if (ui.previewId) {
          if (e.key === "Escape" || (e.key === " " && !editable)) {
            e.preventDefault();
            if (ui.previewEditing) ui.setPreviewEditing(false);
            else ui.closePreview();
            return;
          }
          if (editable) return;
          if (e.key === "Enter" && !e.metaKey) {
            e.preventDefault();
            ui.setPreviewEditing(true);
            return;
          }
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (!navIds.length) return;
            const idx = navIds.indexOf(ui.previewId);
            const next =
              e.key === "ArrowDown"
                ? navIds[Math.min(idx + 1, navIds.length - 1)]
                : navIds[Math.max(idx - 1, 0)];
            if (next && next !== ui.previewId) ui.openPreview(next);
            return;
          }
          return;
        }
      }

      // 拖拽把手聚焦中 = 键盘拖拽模式：Space/方向键让给 dnd-kit
      // （否则任务页 Space 会同时拾起排序 + 切完成，双动作打架）
      if (target?.closest?.("[data-drag-handle]")) return;

      // ⌃Tab：按页签顺序循环（⌘1-9 已被快发占用，取浏览器切标签页惯例）。
      // 用可见页序而非硬编码：页签可拖动重排，剪贴板关闭时该页也不该被切到
      if (e.key === "Tab" && e.ctrlKey) {
        e.preventDefault();
        const ui = useUIStore.getState();
        const cur = Math.max(0, visiblePages.indexOf(ui.page));
        ui.setPage(visiblePages[(cur + 1) % visiblePages.length]);
        return;
      }
      // ⌘← / ⌘→：按页签顺序左右切换（输入框内保留系统的行首/行尾跳转）
      if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && e.metaKey) {
        if (editable) return;
        e.preventDefault();
        const ui = useUIStore.getState();
        const idx = Math.max(0, visiblePages.indexOf(ui.page));
        const next =
          e.key === "ArrowRight"
            ? Math.min(idx + 1, visiblePages.length - 1)
            : Math.max(idx - 1, 0);
        ui.setPage(visiblePages[next]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        const ui = useUIStore.getState();
        if (ui.editingId) {
          // 任务详情展开中：先收起（编辑控件的失焦保存已各自处理）
          ui.setEditingId(null);
        } else if (ui.searchOpen) {
          ui.setSearchOpen(false);
        } else if (useNotesStore.getState().checkedIds.length) {
          useNotesStore.getState().clearChecked();
        } else {
          dismissPanel();
        }
        return;
      }
      if (e.key === "f" && e.metaKey) {
        e.preventDefault();
        useUIStore.getState().setSearchOpen(true);
        window.setTimeout(() => searchInputRef.current?.focus(), 30);
        return;
      }
      // 以下发送/勾选类快捷键操作的是笔记 checkedIds——剪贴板卡也是笔记，
      // 两页均可用；任务页禁用（任务 id 污染勾选态）；秘文页也禁用——密文卡
      // 只用自身按钮操作，绝不走普通发送/多选/列表复制管线（会暴露/误发密文）。
      const currentUi = useUIStore.getState();
      const onNotesPage =
        currentUi.page === "clipboard" ||
        (currentUi.page === "notes" && currentUi.contentSubview === "notes");
      if (e.key === "Enter" && e.metaKey) {
        if (!onNotesPage) return;
        e.preventDefault();
        void sendCheckedToChat();
        return;
      }
      // ⌘1-9：按可见顺序直接发送第 N 张卡（Paste 式快发）
      if (e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && /^[1-9]$/.test(e.key)) {
        if (editable || !onNotesPage) return;
        const id = navIds[Number(e.key) - 1];
        if (id) {
          e.preventDefault();
          void sendNotesToChat([id]);
        }
        return;
      }
      if (e.key === "c" && e.metaKey && !e.shiftKey && !e.altKey) {
        const hasSelection = !!window.getSelection()?.toString();
        if (!editable && !hasSelection && onNotesPage) {
          e.preventDefault();
          void copyCheckedAsList();
        }
        return;
      }
      if (e.key === "a" && e.metaKey && !editable) {
        if (!onNotesPage) return;
        e.preventDefault();
        useNotesStore.getState().setChecked(navIds);
        return;
      }
      // ⌘Z：撤销上一步（HUD 悬停撤销的键盘等价入口，复用同一 pendingUndo 槽）
      if (e.key === "z" && e.metaKey && !e.shiftKey) {
        if (editable) return; // 输入框/文本区让位原生撤销
        e.preventDefault();
        runPendingUndo();
        return;
      }
      if (editable) return;

      const ui = useUIStore.getState();
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!navIds.length) return;
        e.preventDefault();
        const idx = ui.focusedId ? navIds.indexOf(ui.focusedId) : -1;
        const next =
          e.key === "ArrowDown"
            ? navIds[Math.min(idx + 1, navIds.length - 1)]
            : navIds[Math.max(idx - 1, 0)];
        ui.setFocusedId(next);
        return;
      }
      // ←/→ 在卡片序列中前后移动并选中（横栏=左右相邻，竖栏=上/下一张；
      // ⌘←→ 仍是切页，输入框内不拦）
      if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !e.metaKey) {
        if (editable) return;
        if (!navIds.length) return;
        e.preventDefault();
        const idx = ui.focusedId ? navIds.indexOf(ui.focusedId) : -1;
        const next =
          e.key === "ArrowRight"
            ? navIds[Math.min(idx + 1, navIds.length - 1)]
            : navIds[Math.max(idx - 1, 0)];
        ui.setFocusedId(next);
        // 笔记/剪贴板：左右导航即单选（蓝色选中态，⌘⏎ 可直发）；
        // 任务/秘文页无普通勾选语义，只保持焦点环
        if (
          (ui.page === "clipboard" ||
            (ui.page === "notes" && ui.contentSubview === "notes")) &&
          next
        ) {
          useNotesStore.getState().setChecked([next]);
          ui.setAnchorId(next);
        }
        return;
      }
      // Space = 全文预览（Paste 风格）；链接卡「明细」= 开网页；
      // 任务页 = 完成态二态直切（与鼠标点状态点的三态循环是刻意差异）
      if (e.key === " " && ui.focusedId) {
        e.preventDefault();
        // 秘文页：Space 不开详情窗（会明文暴露密文正文）；解密走卡片自身点击
        if (ui.page === "secret" || (ui.page === "notes" && ui.contentSubview !== "notes")) return;
        if (ui.page === "tasks") {
          useNotesStore.getState().toggleTaskDone(ui.focusedId);
          return;
        }
        const focusedNote = useNotesStore
          .getState()
          .notes.find((n) => n.id === ui.focusedId);
        if (focusedNote?.kind === "link" && focusedNote.url) {
          void api.openUrl(focusedNote.url);
        } else if (focusedNote?.kind === "image" && focusedNote.imageFile) {
          // 图片卡 Space = 原尺寸预览（与 macOS 空格预览心智一致），
          // 带笔记上下文以便预览窗内联编辑文字备注（占位符不算备注）
          void api.quickLook(noteImages(focusedNote), 0, {
            id: focusedNote.id,
            text: imageCaption(focusedNote),
            dataGeneration: currentDataGeneration(),
          });
        } else {
          // 文字类 → 桌面居中的文本详情窗；同卡再按空格收起（Quick Look 心智）
          void toggleNoteDetail(ui.focusedId);
        }
        return;
      }
      if (e.key === "x" && !e.metaKey && ui.focusedId) {
        e.preventDefault();
        // 秘文页无勾选语义：不可见的勾选态会污染 checkedIds
        if (ui.page === "secret" || (ui.page === "notes" && ui.contentSubview !== "notes")) return;
        if (ui.page === "tasks") {
          useNotesStore.getState().toggleTaskDone(ui.focusedId);
        } else {
          useNotesStore.getState().toggleChecked(ui.focusedId);
        }
        return;
      }
      // d = 完成态切换（done，与 x 勾选、p 常用同族的单键卡片操作）。
      // 任务页不接管：那边 Space/x 已是完成切换；秘文页无完成语义
      if (e.key === "d" && !e.metaKey && !e.ctrlKey && !e.altKey && ui.focusedId) {
        if (!onNotesPage) return;
        e.preventDefault();
        const st = useNotesStore.getState();
        const focused = st.notes.find((n) => n.id === ui.focusedId);
        if (!focused) return;
        st.toggleDone(focused.id);
        // 标完成后卡片可能因分组「隐藏已完成」当场消失，补一句确认
        tip("ok", focused.done ? "已取消完成" : "已标记完成");
        return;
      }
      // p = 置顶/常用切换（keep 双域语义：剪贴卡=置顶不清理，笔记卡=常用）
      if (e.key === "p" && !e.metaKey && !e.ctrlKey && !e.altKey && ui.focusedId) {
        if (
          ui.page === "secret" ||
          ui.page === "tasks" ||
          (ui.page === "notes" && ui.contentSubview !== "notes")
        ) return;
        e.preventDefault();
        const st = useNotesStore.getState();
        const focused = st.notes.find((n) => n.id === ui.focusedId);
        if (!focused) return;
        st.toggleNoteKeep(focused.id);
        const isClipCard = focused.sectionId === CLIPBOARD_ID;
        tip(
          "ok",
          focused.keep
            ? isClipCard
              ? "已取消置顶"
              : "已取消常用"
            : isClipCard
              ? "已置顶"
              : "已设为常用"
        );
        return;
      }
      // Enter 恒为编辑、发送恒 ⌘⏎（2026-08-20 收口）：剪贴页原「有勾选即
      // 回车直发」随勾选状态翻转语义，←/→ 导航会静默单选，极易误发外部
      if (e.key === "Enter" && !e.metaKey && ui.focusedId) {
        e.preventDefault();
        // 秘文页：Enter 不开详情窗（同 Space，避免明文暴露/编辑损坏密文）
        if (ui.page === "secret" || (ui.page === "notes" && ui.contentSubview !== "notes")) return;
        if (ui.page === "tasks") {
          ui.setEditingId(ui.focusedId);
        } else {
          // 文字类 → 文本详情窗直接进入编辑；图片仍走面板内预览层
          openNoteDetail(ui.focusedId, true);
        }
        return;
      }
      // ⇧⌘⌫：清理当前页已完成（Finder 清空废纸篓同族手势；带撤销）。
      // 剪贴/秘文页无「清理已完成」语义，不拦截以免吞掉按键
      if (e.key === "Backspace" && e.metaKey && e.shiftKey) {
        if (ui.page === "notes" && ui.contentSubview === "notes") {
          e.preventDefault();
          clearDoneWithUndo();
        } else if (ui.page === "tasks") {
          e.preventDefault();
          clearDoneTasksWithUndo();
        }
        return;
      }
      if (e.key === "Backspace" && e.metaKey && !e.shiftKey && ui.focusedId) {
        e.preventDefault();
        const idx = navIds.indexOf(ui.focusedId);
        const nextFocus = navIds[idx + 1] ?? navIds[idx - 1] ?? null;
        if (ui.page === "tasks") {
          deleteTasksWithUndo([ui.focusedId], "已删除 1 个任务");
        } else {
          deleteNotesWithUndo([ui.focusedId], "已删除 1 条");
        }
        ui.setFocusedId(nextFocus);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // visiblePages：⌃Tab / ⌘←→ 的切页序随页签顺序与剪贴板开关变化
  }, [navIds, visiblePages]);

  // ===== 跨分组拖拽 =====
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  // 页签重排用更大的启动阈值：页签首要动作是切页，4px 容易把「手抖的点击」
  // 吃成拖拽（点了没反应）；6px 拖起来仍然跟手
  const tabSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const clearDragExpand = () => {
    if (dragExpandRef.current) {
      window.clearTimeout(dragExpandRef.current.timer);
      dragExpandRef.current = null;
    }
  };

  const onDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) return;
    const overId = String(over.id);
    const activeId = String(active.id);
    if (activeId.startsWith("sec:")) return;
    const state = useNotesStore.getState();
    if (!state.notes.some((n) => n.id === activeId)) return;

    const targetSection = overId.startsWith("sec:")
      ? overId.slice(4)
      : (state.notes.find((n) => n.id === overId)?.sectionId ?? null);
    if (!targetSection) return;

    // 跨组换组只在松手时结算（onDragEnd）：分组是纵向堆叠且高度自适应的，
    // 拖拽途中真把卡搬走会让原组变矮、下方各组整体上移，指针下方又变回原组
    // → 搬回去 → 布局再变，形成同步自激振荡，撞上 React 嵌套更新上限后
    // 整棵树被卸载（面板全白且只能重启）。舒展密度卡更高，位移必然跨过组边界，
    // 所以必现；紧缩密度位移小才表现为偶现。

    // 拖到折叠组上悬停 500ms 自动展开
    const section = state.sections.find((s) => s.id === targetSection);
    if (section?.collapsed) {
      if (dragExpandRef.current?.sec !== targetSection) {
        clearDragExpand();
        dragExpandRef.current = {
          sec: targetSection,
          timer: window.setTimeout(() => {
            useNotesStore.getState().toggleSectionCollapsed(targetSection);
            dragExpandRef.current = null;
          }, 500),
        };
      }
    } else if (dragExpandRef.current) {
      clearDragExpand();
    }
  };

  const onDragEnd = (event: DragEndEvent) => {
    clearDragExpand();
    const { active, over } = event;
    if (!over) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    if (activeId.startsWith("sec:")) {
      const state = useNotesStore.getState();
      const targetSectionId = overId.startsWith("sec:")
        ? overId.slice(4)
        : (state.notes.find((note) => note.id === overId)?.sectionId ?? null);
      if (targetSectionId) {
        state.reorderSections(activeId.slice(4), targetSectionId);
      }
      return;
    }
    // 卡片落地：先归组再定位。onDragOver 全程不动列表结构，跨组换组在这里结算
    const state = useNotesStore.getState();
    const activeNote = state.notes.find((n) => n.id === activeId);
    if (!activeNote) return;
    const targetSectionId = overId.startsWith("sec:")
      ? overId.slice(4)
      : (state.notes.find((n) => n.id === overId)?.sectionId ?? null);
    if (!targetSectionId) return;
    if (targetSectionId !== activeNote.sectionId) {
      state.moveNotes([activeId], targetSectionId);
    }
    // 落在分组容器（含折叠组）上只归组，组内位置保持原样
    if (!overId.startsWith("sec:") && activeId !== overId) {
      state.reorderNotes(activeId, overId);
    }
  };

  // ===== 长按 ⌥ 显示快捷键提示层；⌘ 按住显示 ⌘1-9 快发角标 =====
  const [showShortcuts, setShowShortcuts] = useState(false);
  useEffect(() => {
    let timer = 0;
    const clearAlt = () => {
      if (timer) {
        window.clearTimeout(timer);
        timer = 0;
      }
      setShowShortcuts(false);
    };
    const down = (e: KeyboardEvent) => {
      if (e.key === "Meta") useUIStore.getState().setCmdHeld(true);
      if (e.key === "Alt" && !timer) {
        timer = window.setTimeout(() => setShowShortcuts(true), 650);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "Meta") useUIStore.getState().setCmdHeld(false);
      if (e.key === "Alt") clearAlt();
    };
    const blur = () => {
      clearAlt();
      useUIStore.getState().setCmdHeld(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  // ===== 宽度拖拽 =====
  const [resizing, setResizing] = useState(false);
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.screenX;
    const startW = useNotesStore.getState().settings.panelWidth;
    setResizing(true);
    // 拖拽期间暂停贴边隐藏计时（光标途经面板边界时不误触发滑出）
    void api.setPanelDragActive(true).catch(() => {});
    let latest = startW;
    let raf = 0;
    const onMove = (ev: PointerEvent) => {
      const width = Math.min(
        PANEL_WIDTH_MAX,
        Math.max(PANEL_WIDTH_MIN, startW + (startX - ev.screenX))
      );
      latest = width;
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          void api.setPanelWidth(latest);
        });
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setResizing(false);
      void api.setPanelDragActive(false).catch(() => {});
      useNotesStore.getState().setSettings({ panelWidth: Math.round(latest) });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // ===== 上下缘高度拖拽 =====
  const [vResizing, setVResizing] = useState<"top" | "bottom" | null>(null);
  const startVResize = (edge: "top" | "bottom") => (e: React.PointerEvent) => {
    e.preventDefault();
    setVResizing(edge);
    void api.setPanelDragActive(true).catch(() => {});
    let lastY = e.screenY;
    let pending = 0;
    let raf = 0;
    let latest: { topOffset: number; height: number | null } | null = null;
    const onMove = (ev: PointerEvent) => {
      pending += ev.screenY - lastY;
      lastY = ev.screenY;
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          const delta = pending;
          pending = 0;
          if (delta !== 0) {
            api
              .adjustPanelEdge(edge, delta)
              .then((v) => {
                latest = v;
              })
              .catch(() => {});
          }
        });
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setVResizing(null);
      void api.setPanelDragActive(false).catch(() => {});
      // 垂直调节为会话内临时值：切换吸附目标即恢复自动同高，不持久化
      void latest;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  /** 双击上/下缘 → 复位为自动高度（伴随=同目标窗口，经典=近全高）。 */
  const resetVertical = () => {
    void api.setPanelVertical(0, null);
    useNotesStore.getState().setSettings({ panelTopOffset: 0, panelHeight: null });
  };

  /** 页签三连（普通模式独占一行；横栏并入标题行居中）：按用户页序渲染，
   *  可按住横向拖动重排（拖拽阈值 6px，短按仍是切页）。 */
  const pageTabs = (
    <DndContext
      sensors={tabSensors}
      collisionDetection={closestCenter}
      modifiers={[lockYAxis]}
      onDragEnd={({ active, over }) => {
        if (!over || active.id === over.id) return;
        const from = pageOrder.indexOf(active.id as PageId);
        const to = pageOrder.indexOf(over.id as PageId);
        if (from < 0 || to < 0) return;
        useNotesStore
          .getState()
          .setSettings({ pageOrder: arrayMove(pageOrder, from, to) });
      }}
    >
      <SortableContext items={visiblePages} strategy={horizontalListSortingStrategy}>
        {visiblePages.map((id) => (
          <PageTab
            key={id}
            id={id}
            active={page === id}
            badge={
              id === "tasks"
                ? taskBuckets.overdue.length
                : id === "notes" && messagesEnabled
                  ? messages.filter((message) => message.status === "new").length
                  : undefined
            }
            onClick={() => useUIStore.getState().setPage(id)}
            onDoubleClick={() => scrollTabPageToStart(id)}
          >
            {id === "notes" && !contentDomainsOn
              ? "笔记"
              : id === "tasks" && !subscriptionsEnabled
                ? "任务"
                : PAGE_LABEL[id]}
          </PageTab>
        ))}
      </SortableContext>
    </DndContext>
  );

  return (
    <MotionConfig reducedMotion="user">
    <TooltipProvider delayDuration={400}>
      <div
        className="h-screen w-screen overflow-hidden text-foreground"
        onContextMenu={(e) => e.preventDefault()}
      >
        {dataOperationLocked && (
          <div
            role="status"
            aria-live="assertive"
            aria-busy="true"
            className="fixed inset-0 z-50 flex items-center justify-center bg-background/90 px-6 backdrop-blur-sm"
          >
            <div className="rounded-xl border border-border bg-popover px-4 py-3 text-center shadow-lg">
              <p className="text-title font-medium">数据暂时只读</p>
              <p className="mt-1 text-body text-muted-foreground">
                {dataOperationMessage || "正在验证并切换数据目录…"}
              </p>
              {/* 仅恢复/冲突态给引导：瞬态事务（prepare/rehydrate…）几秒内自行解锁 */}
              {(dataOperationPhase === "storageRecovery" ||
                dataOperationPhase === "conflict") && (
                <Button
                  size="sm"
                  className="mt-2.5"
                  onClick={() => {
                    void api.openSettingsWindow();
                    void emitTo("settings", SETTINGS_SECTION, "data");
                  }}
                >
                  前往设置处理
                </Button>
              )}
            </div>
          </div>
        )}
        {/* 面板内容树常驻：呼出只播 transform/opacity（GPU 合成层），
            避免每次打开重新挂载整棵卡片树造成的掉帧；收起动画完成后再隐藏窗口 */}
            <motion.div
              key="panel"
              initial={false}
              // 隐藏位姿沿停靠缘方向：右/默认→右侧、左→左侧、上→上方、下→下方，
              // 出入动画即「从所在缘划出/划入」
              animate={
                open
                  ? { x: 0, y: 0, opacity: 1 }
                  : {
                      x:
                        !settings.rightSidebar || settings.sidebarEdge === "right"
                          ? 16
                          : settings.sidebarEdge === "left"
                            ? -16
                            : 0,
                      y:
                        settings.rightSidebar && settings.sidebarEdge === "top"
                          ? -16
                          : settings.rightSidebar && settings.sidebarEdge === "bottom"
                            ? 16
                            : 0,
                      opacity: 0,
                    }
              }
              // 进场 spring 保手感；退场用短 tween 果断结束——spring 的静止判定
              // 有长尾，会拖住窗口隐藏时机，露出毛玻璃空板（内容先没、面板后没）
              transition={open ? springSnappy : tweenExit}
              onAnimationComplete={() => {
                if (!useUIStore.getState().open) {
                  void api.hidePanel(restoreFocusRef.current);
                }
              }}
              className={cn(
                // 不加静态外边框：`border-foreground/10` 在浅色是黑 10%、深色是
                // 白 10%，正是用户否决的「随系统颜色的那圈描边」（像素实测面板
                // 左缘 1pt 亮带 #35475b vs 面板底 #22354b）。轮廓交给 rounded-xl
                // + 窗口投影 + 指针追随的 GlowingEffect，不靠常驻线
                "panel-surface relative flex h-full w-full flex-col overflow-hidden rounded-xl",
                !open && "pointer-events-none"
              )}
            >
              {/* 整体外边框光晕：锥形弧沿边框追随指针（z-30 盖过内容边缘，
                  pointer-events-none 不挡任何交互；浮层 z-50 仍在其上） */}
              <GlowingEffect
                className="z-30"
                borderWidth={1}
                spread={40}
                proximity={64}
                inactiveZone={0.55}
              />
              {/* 首启欢迎导览（z-40 盖内容；数据锁定遮罩 z-50 仍优先） */}
              {!welcomeTourSeen && open && <WelcomeTour />}
              {/* 左缘宽度拖拽把手 */}
              <div
                onPointerDown={startResize}
                title="拖拽调整宽度"
                className={cn(
                  "absolute inset-y-0 left-0 z-20 w-1.5 cursor-col-resize",
                  "hover:bg-primary/25",
                  resizing && "bg-primary/40"
                )}
              />
              {/* 上缘高度把手（双击复位自动高度） */}
              <div
                onPointerDown={startVResize("top")}
                onDoubleClick={resetVertical}
                title="拖拽调整顶部位置 · 双击复位自动高度"
                className={cn(
                  "absolute inset-x-0 top-0 z-20 h-1.5 cursor-row-resize",
                  "hover:bg-primary/25",
                  vResizing === "top" && "bg-primary/40"
                )}
              />
              {/* 下缘高度把手（双击复位自动高度） */}
              <div
                onPointerDown={startVResize("bottom")}
                onDoubleClick={resetVertical}
                title="拖拽调整高度 · 双击复位自动高度"
                className={cn(
                  "absolute inset-x-0 bottom-0 z-20 h-1.5 cursor-row-resize",
                  "hover:bg-primary/25",
                  vResizing === "bottom" && "bg-primary/40"
                )}
              />

              <header
                data-tauri-drag-region
                className="relative flex items-center gap-2 px-4 pb-2 pt-3.5"
              >
                <h1
                  data-tauri-drag-region
                  title="拖动此处可移动面板（未吸附时）"
                  className="cursor-grab select-none text-title font-semibold tracking-tight active:cursor-grabbing"
                >
                  Toskr
                </h1>
                {/* 有新版本时亮起（点击弹更新对话框）；无更新不占位 */}
                {updateAvail && (
                  <button
                    onClick={() => useUIStore.getState().setUpdateDialogOpen(true)}
                    className={cn(
                      "flex shrink-0 items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5",
                      "text-micro font-medium text-primary outline-none",
                      "hover:bg-primary/15 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                    )}
                  >
                    <ArrowUpCircle className="size-3" /> 更新
                  </button>
                )}
                {/* 横栏：页签固定在标题旁（左），分组胶囊独立居中——
                    切页时页签位置不动，胶囊各自居中，互不牵连 */}
                {horizontalBar && (
                  <div role="tablist" aria-label="页面" className="surface-inset flex shrink-0 items-center rounded-lg p-0.5">
                    {pageTabs}
                  </div>
                )}
                {horizontalBar &&
                  (page === "tasks" ||
                    (page === "notes" && contentSubview === "notes")) && (
                  <div className="absolute left-1/2 top-1/2 flex max-w-[46%] -translate-x-1/2 -translate-y-1/2 items-center gap-1 overflow-x-auto [&::-webkit-scrollbar]:hidden">
                    {page === "notes" && contentSubview === "notes" && (
                      <GroupPills
                          bare
                          items={grouped.map((g) => g.section)}
                          active={noteGroupFilter}
                          onPick={setNoteGroupFilter}
                          doneCount={grouped.reduce((n, g) => n + g.done.length, 0)}
                          manage={{
                            rename: (id, n) =>
                              useNotesStore.getState().renameSection(id, n),
                            move: (id, d) =>
                              useNotesStore.getState().moveSection(id, d),
                            reorder: (activeId, overId) =>
                              useNotesStore
                                .getState()
                                .reorderSections(activeId, overId),
                            remove: (id) => {
                              if (noteGroupFilter === id) setNoteGroupFilter(null);
                              useNotesStore.getState().deleteSection(id);
                            },
                            lockedId: INBOX_ID,
                            setColor: (id, c) =>
                              useNotesStore.getState().setSectionColor(id, c),
                            toggleKeep: (id) =>
                              useNotesStore.getState().toggleSectionKeep(id),
                            keepOn: (id) =>
                              !!useNotesStore
                                .getState()
                                .sections.find((s) => s.id === id)?.keepAfterSend,
                            checkAll: (id) => {
                              const g = grouped.find((x) => x.section.id === id);
                              if (g?.active.length) {
                                useNotesStore
                                  .getState()
                                  .setChecked(g.active.map((n) => n.id));
                              }
                            },
                            add: () => useNotesStore.getState().addSection(),
                          }}
                        />
                    )}
                    {page === "tasks" && (
                      <GroupPills
                          bare
                          items={taskSections}
                          active={taskGroupFilter}
                          onPick={setTaskGroupFilter}
                          doneCount={taskBuckets.done.length}
                          manage={{
                            rename: (id, n) =>
                              useNotesStore.getState().renameTaskSection(id, n),
                            move: (id, d) =>
                              useNotesStore.getState().moveTaskSection(id, d),
                            remove: (id) => {
                              if (taskGroupFilter === id) setTaskGroupFilter(null);
                              useNotesStore.getState().deleteTaskSection(id);
                            },
                            lockedId: TASK_INBOX_ID,
                            add: () =>
                              useNotesStore.getState().addTaskSection(),
                          }}
                        />
                    )}
                  </div>
                )}
                <div className="ml-auto flex items-center gap-0.5">
                  {/* 横栏：输入通栏收起，这里按需唤出（仅上下布局出现） */}
                  {horizontalBar && page === "notes" && contentSubview === "notes" && (
                    <Tipped label={barDraftOpen ? "收起输入" : "添加笔记"}>
                      <IconButton
                        label={barDraftOpen ? "收起输入" : "添加笔记"}
                        withTitle={false}
                        pressed={barDraftOpen}
                        onClick={() =>
                          setBarDraftOpen((v) => {
                            const next = !v;
                            if (next) {
                              // WKWebView 点击不给焦点：唤出后主动聚焦输入框
                              window.setTimeout(() => {
                                document
                                  .querySelector<HTMLTextAreaElement>(
                                    'textarea[placeholder*="添加笔记"]'
                                  )
                                  ?.focus();
                              }, 60);
                            }
                            return next;
                          })
                        }
                      >
                        <Plus />
                      </IconButton>
                    </Tipped>
                  )}
                  {/* 页面级工具：搜索 / 清理 / 密度 —— 与右侧全局工具用分隔线区分 */}
                  {page !== "tasks" && (
                    <Tipped label="搜索（⌘F）">
                      <IconButton
                        label="搜索（⌘F）"
                        withTitle={false}
                        pressed={searchOpen}
                        onClick={() => {
                          useUIStore.getState().setSearchOpen(!searchOpen);
                          window.setTimeout(() => searchInputRef.current?.focus(), 30);
                        }}
                      >
                        <Search />
                      </IconButton>
                    </Tipped>
                  )}
                  {horizontalBar &&
                    page !== "clipboard" &&
                    (page !== "notes" || contentSubview === "notes") &&
                    (page === "notes" ? doneCount : doneTaskCount) > 0 && (
                    <Tipped
                      label={
                        page === "notes"
                          ? `清理 ${doneCount} 条已完成（⇧⌘⌫）`
                          : `清理 ${doneTaskCount} 个已完成任务（⇧⌘⌫）`
                      }
                    >
                      <IconButton
                        label={
                          page === "notes"
                            ? `清理 ${doneCount} 条已完成（⇧⌘⌫）`
                            : `清理 ${doneTaskCount} 个已完成任务（⇧⌘⌫）`
                        }
                        withTitle={false}
                        onClick={
                          page === "notes" ? clearDoneWithUndo : clearDoneTasksWithUndo
                        }
                      >
                        <Eraser />
                      </IconButton>
                    </Tipped>
                  )}
                  {horizontalBar && (page !== "tasks" || doneTaskCount > 0) && (
                    <span aria-hidden className="mx-0.5 h-3.5 w-px bg-border" />
                  )}
                  {/* 横栏保留现有停靠工具；竖向把密度、停靠和固定收进单一菜单。 */}
                  <SimpleMenu
                    side="bottom"
                    align="end"
                    className="flex"
                    trigger={({ toggle }) => {
                      const EdgeIcon =
                        settings.sidebarEdge === "left"
                          ? PanelLeft
                          : settings.sidebarEdge === "top"
                            ? PanelTop
                            : settings.sidebarEdge === "bottom"
                              ? PanelBottom
                              : PanelRight;
                      const label = horizontalBar
                        ? settings.rightSidebar
                          ? `停靠：${SIDEBAR_EDGE_LABEL[settings.sidebarEdge]} · 点击调整位置`
                          : settings.companionEnabled
                            ? "伴随磁吸与方向"
                            : "面板位置与伴随磁吸"
                        : "竖向面板选项";
                      return (
                        <Tipped label={label}>
                          <IconButton
                            label={label}
                            withTitle={false}
                            pressed={horizontalBar ? settings.rightSidebar : undefined}
                            onClick={toggle}
                          >
                            {horizontalBar ? <EdgeIcon /> : <Menu />}
                          </IconButton>
                        </Tipped>
                      );
                    }}
                  >
                    {(close) => (
                      <>
                        {!horizontalBar && (
                          <>
                            <SimpleMenuLabel>显示</SimpleMenuLabel>
                            {page !== "tasks" &&
                              (page !== "notes" || contentSubview === "notes") && (
                              <SimpleMenuItem
                                onClick={() => {
                                  close();
                                  const current =
                                    useNotesStore.getState().settings.cardDensity;
                                  useNotesStore.getState().setSettings({
                                    cardDensity:
                                      current === "compact" ? "comfortable" : "compact",
                                  });
                                }}
                              >
                                <Rows3 className="size-3.5" />
                                {settings.cardDensity === "compact"
                                  ? "使用舒适卡片"
                                  : "使用紧缩列表"}
                              </SimpleMenuItem>
                            )}
                            {page !== "clipboard" &&
                              (page !== "notes" || contentSubview === "notes") &&
                              (page === "notes" ? doneCount : doneTaskCount) > 0 && (
                                <SimpleMenuItem
                                  onClick={() => {
                                    close();
                                    if (page === "notes") clearDoneWithUndo();
                                    else clearDoneTasksWithUndo();
                                  }}
                                >
                                  <Eraser className="size-3.5" />
                                  {/* nowrap 撑宽菜单：min-w 下长文案+快捷键会折行错位 */}
                                  <span className="whitespace-nowrap">
                                    {page === "notes"
                                      ? `清理 ${doneCount} 条已完成`
                                      : `清理 ${doneTaskCount} 个已完成任务`}
                                  </span>
                                  <span className="ml-auto pl-2 text-micro text-muted-foreground">
                                    ⇧⌘⌫
                                  </span>
                                </SimpleMenuItem>
                              )}
                            <SimpleMenuSeparator />
                          </>
                        )}
                        {/* 伴随开启时选择目标窗口左右侧；未开启时边栏为可选项，
                            不选择即自由摆放，真实拖到外侧屏缘后自动收起。 */}
                        <SimpleMenuLabel>
                          {settings.companionEnabled ? "磁吸方向" : "固定边栏（可选）"}
                        </SimpleMenuLabel>
                        {(settings.companionEnabled
                          ? (["right", "left"] as const)
                          : (["right", "bottom"] as const)
                        ).map((edge) => {
                          const activeEdge =
                            settings.rightSidebar && settings.sidebarEdge === edge;
                          if (settings.companionEnabled) {
                            // 磁吸模式：左右选磁吸在软件哪一侧
                            const vertical = edge === "bottom";
                            const side =
                              settings.sidebarEdge === "left" ? "left" : "right";
                            const checked = !vertical && edge === side;
                            return (
                              <SimpleMenuItem
                                key={edge}
                                disabled={vertical}
                                title={
                                  vertical
                                    ? "伴随磁吸仅支持左右侧"
                                    : "面板磁吸在目标软件的这一侧"
                                }
                                onClick={() => {
                                  close();
                                  // 上下项已 disabled 不会进到这里；类型上仍需收窄。
                                  // 走 applySettingsPatch：磁吸方向同步 + 持久化 + 广播一条路径
                                  applySettingsPatch({
                                    sidebarEdge: edge === "left" ? "left" : "right",
                                  });
                                }}
                              >
                                {checked ? "✓ " : ""}
                                {SIDEBAR_EDGE_LABEL[edge]}
                              </SimpleMenuItem>
                            );
                          }
                          // 默认自由摆放；固定边栏只是显式可选布局。
                          return (
                            <SimpleMenuItem
                              key={edge}
                              title={
                                activeEdge
                                  ? "再次点击取消边栏，恢复自由拖动"
                                  : "固定为屏幕边栏；自由模式拖到外侧屏缘也会自动收起"
                              }
                              onClick={() => {
                                close();
                                void applySidebar(!activeEdge, edge);
                              }}
                            >
                              {activeEdge ? "✓ " : ""}
                              {SIDEBAR_EDGE_LABEL[edge]}
                            </SimpleMenuItem>
                          );
                        })}
                        <SimpleMenuSeparator />
                        <SimpleMenuItem
                          title="目标应用存在时吸附并跟随；没有可用目标时保持自由拖动，拖到外侧屏缘后自动收起（应用清单在 设置 → 伴随停靠）"
                          onClick={() => {
                            applySettingsPatch({
                              companionEnabled:
                                !useNotesStore.getState().settings.companionEnabled,
                            });
                          }}
                        >
                          {settings.companionEnabled ? "✓ " : ""}伴随磁吸
                        </SimpleMenuItem>
                        {!horizontalBar && (
                          <>
                            <SimpleMenuSeparator />
                            <SimpleMenuItem
                              onClick={() => {
                                close();
                                useUIStore.getState().setPinned(!pinned);
                              }}
                            >
                              <Pin className={cn("size-3.5", pinned && "fill-current")} />
                              {pinned ? "取消固定" : "固定 · 失焦不隐藏"}
                            </SimpleMenuItem>
                          </>
                        )}
                      </>
                    )}
                  </SimpleMenu>
                  {horizontalBar && (
                    <Tipped label={pinned ? "取消固定" : "固定（失焦不隐藏）"}>
                      <IconButton
                        label={pinned ? "取消固定" : "固定（失焦不隐藏）"}
                        withTitle={false}
                        pressed={pinned}
                        onClick={() => useUIStore.getState().setPinned(!pinned)}
                      >
                        <Pin className={cn("size-3.5", pinned && "fill-current")} />
                      </IconButton>
                    </Tipped>
                  )}
                  <Tipped label="设置">
                    <IconButton
                      label="设置"
                      withTitle={false}
                      onClick={() => api.openSettingsWindow()}
                    >
                      <Settings2 />
                    </IconButton>
                  </Tipped>
                </div>
              </header>

              <TargetLensBar />

              {/* 页面切换：笔记 / 任务 / 剪贴板（⌃Tab 循环）。
                  横栏形态并入标题行居中（Paste 式单行头部），不再单占一行。
                  两处轨道均不加 elevation-1：深色毛玻璃上 inset 黑影读成
                  一圈最外层黑框（2026-08-14 用户否决），只留 surface-inset 底 */}
              {!horizontalBar && (
                <div
                  role="tablist"
                  aria-label="页面"
                  className="surface-inset mx-3 mb-1.5 inline-flex w-fit items-center self-start rounded-lg p-0.5"
                >
                  {pageTabs}
                </div>
              )}

              <PermissionBanner />

              {searchOpen && page !== "tasks" && (
                <div className="surface-inset mx-3 mb-1.5 flex items-center gap-1.5 rounded-lg border border-foreground/10 px-2 py-1 focus-within:border-primary/50">
                  <Search className="size-3 shrink-0 text-muted-foreground" />
                  <input
                    ref={searchInputRef}
                    autoFocus
                    value={query}
                    placeholder={
                      page === "notes" && contentSubview === "messages"
                        ? "搜索消息、群或发送者…"
                        : page === "notes" && contentSubview === "secret"
                          ? "搜索秘文…"
                          : "搜索卡片…"
                    }
                    onChange={(e) => useUIStore.getState().setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        useUIStore.getState().setSearchOpen(false);
                      }
                    }}
                    className="h-5 w-full bg-transparent text-body outline-none placeholder:text-muted-foreground"
                  />
                  {q && (
                    <span className="shrink-0 text-micro tabular-nums text-muted-foreground">
                      {matchCount}
                    </span>
                  )}
                  <IconButton
                    label="关闭搜索"
                    size="2xs"
                    onClick={() => useUIStore.getState().setSearchOpen(false)}
                  >
                    <X />
                  </IconButton>
                </div>
              )}

              {/* 三页常驻堆叠：切页只动 transform/opacity，零挂载成本（同面板开合方案） */}
              <div className="relative min-h-0 flex-1 overflow-hidden">
                <PageSlide
                  offset={orderOf("clipboard") - pageIndex}
                  contentRef={clipboardPageRef}
                >
                {horizontalBar ? (
                  <StripScroller>
                    {clipNotes.length === 0 ? (
                      <p className="px-4 py-6 text-body text-muted-foreground">
                        {settings.clipHistory ? "还没有剪贴板记录" : "剪贴板历史未开启"}
                      </p>
                    ) : (
                      <DndContext
                        sensors={sensors}
                        collisionDetection={closestCenter}
                        onDragOver={onDragOver}
                        onDragEnd={onDragEnd}
                        onDragCancel={clearDragExpand}
                      >
                        <SortableContext
                          items={clipNavIds}
                          strategy={horizontalListSortingStrategy}
                        >
                          <div className="flex h-full items-stretch gap-2.5 px-3 pb-2 pt-1">
                            {visibleClipNotes.map((n) => (
                              <NoteCard key={n.id} note={n} query={q} strip />
                            ))}
                            {clipNotes.length > clipShown && (
                              <ClipLoadMore
                                remaining={clipNotes.length - clipShown}
                                onLoad={() => setClipShown((v) => v + 200)}
                              />
                            )}
                          </div>
                        </SortableContext>
                      </DndContext>
                    )}
                  </StripScroller>
                ) : (
                <ScrollArea className="min-h-0 flex-1 px-2.5" viewportClassName="px-1">
                  {clipNotes.length === 0 ? (
                    <EmptyState
                      icon={<ClipboardList />}
                      title={
                        !settings.clipHistory
                          ? "剪贴板历史未开启"
                          : q
                            ? `没有匹配「${q}」的记录`
                            : "还没有剪贴板记录"
                      }
                      hint={
                        !settings.clipHistory ? (
                          <>
                            在 设置 → 通用 开启「剪贴板历史」后，
                            <br />
                            复制过的内容会自动收集到这里。
                          </>
                        ) : undefined
                      }
                    />
                  ) : (
                    <DndContext
                      sensors={sensors}
                      collisionDetection={closestCenter}
                      onDragOver={onDragOver}
                      onDragEnd={onDragEnd}
                      onDragCancel={clearDragExpand}
                    >
                      <SortableContext
                        items={clipNavIds}
                        strategy={verticalListSortingStrategy}
                      >
                        <div className="flex flex-col pb-2 pt-1">
                          {clipBands.map(({ band, notes: bandNotes }, bi) => (
                            <div key={`${band}-${bandNotes[0]!.id}`}>
                              <div
                                className={cn(
                                  "flex items-center gap-2 pb-1",
                                  bi === 0 ? "pt-0.5" : "pt-2.5"
                                )}
                              >
                                <span className="text-micro font-medium text-muted-foreground">
                                  {band}
                                </span>
                                <span className="h-px flex-1 bg-border/60" />
                              </div>
                              {/* 紧缩=零间距流水（行底 hover 才浮现，靠行高节奏分行）；舒适=卡片间距 */}
                              <div
                                className={cn(
                                  "flex flex-col",
                                  settings.cardDensity !== "compact" && "gap-1"
                                )}
                              >
                                {bandNotes.map((n, i) => (
                                  <NoteCard
                                    key={n.id}
                                    note={n}
                                    query={q}
                                    // 邻卡 id 只在时间段内传递：选中描边的
                                    // 连续段不跨段头合并
                                    prevId={bandNotes[i - 1]?.id}
                                    nextId={bandNotes[i + 1]?.id}
                                  />
                                ))}
                              </div>
                            </div>
                          ))}
                          {clipNotes.length > clipShown && (
                            <ClipLoadMore
                              remaining={clipNotes.length - clipShown}
                              onLoad={() => setClipShown((v) => v + 200)}
                            />
                          )}
                        </div>
                      </SortableContext>
                    </DndContext>
                  )}
                </ScrollArea>
                )}
                </PageSlide>
                <PageSlide
                  offset={orderOf("notes") - pageIndex}
                  contentRef={notesPageRef}
                >
                {contentDomainsOn && <ContentTabs />}
                {contentSubview === "messages" ? (
                  <MessagePage query={q} horizontal={horizontalBar} />
                ) : contentSubview === "secret" ? (
                  <SecretPage
                    notes={secretNotes}
                    query={q}
                    horizontal={horizontalBar}
                  />
                ) : horizontalBar ? (
                  <>
                  <StripScroller>
                    {stripNotes.length === 0 ? (
                      <p className="px-4 py-6 text-body text-muted-foreground">
                        没有未完成的笔记卡片
                      </p>
                    ) : (
                      <DndContext
                        sensors={sensors}
                        collisionDetection={closestCenter}
                        onDragOver={onDragOver}
                        onDragEnd={onDragEnd}
                        onDragCancel={clearDragExpand}
                      >
                        <SortableContext
                          items={stripNoteIds}
                          strategy={horizontalListSortingStrategy}
                        >
                          <div className="flex h-full items-stretch gap-2.5 px-3 pb-2 pt-1">
                            {stripNotes.map((n) => (
                              <NoteCard key={n.id} note={n} query={q} strip />
                            ))}
                          </div>
                        </SortableContext>
                      </DndContext>
                    )}
                  </StripScroller>
                  </>
                ) : (
              <ScrollArea className="min-h-0 flex-1 px-2.5" viewportClassName="px-1">
                {(!onboarding.done || onboarding.rehearsalActive) && (
                  <SafeDeliveryRehearsal />
                )}
                {notes.length === 0 ? (
                  onboarding.done ? (
                    <EmptyState
                      title="还没有内容"
                      hint={
                        <>
                          在任意应用中选中文字后连按两次 <Kbd>⇧ Shift</Kbd>{" "}
                          即可捕获到这里；
                          <br />
                          也可以在下方直接记下想法或提示词。
                        </>
                      }
                    />
                  ) : null
                ) : matchCount === 0 && q ? (
                  <EmptyState icon={<SearchX />} title={`没有匹配「${q}」的卡片`} />
                ) : (
                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragOver={onDragOver}
                    onDragEnd={onDragEnd}
                    onDragCancel={clearDragExpand}
                  >
                    <div className="pb-2 pt-1">
                      <SortableContext
                        items={grouped.map(({ section }) => `sec:${section.id}`)}
                        strategy={verticalListSortingStrategy}
                      >
                        {grouped.map(({ section, active, done }) => (
                          <SectionGroup
                            key={section.id}
                            section={section}
                            activeNotes={active}
                            doneNotes={done}
                            query={q}
                          />
                        ))}
                      </SortableContext>
                      {!q && (
                        <button
                          onClick={() => useNotesStore.getState().addSection()}
                          className="mb-2 ml-2 flex items-center gap-1 rounded-md px-1.5 py-1 text-label text-muted-foreground outline-none hover:bg-black/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background dark:hover:bg-white/10"
                        >
                          <Plus className="size-3" /> 新建分组
                        </button>
                      )}
                    </div>
                  </DndContext>
                )}
              </ScrollArea>
                )}
                </PageSlide>
                <PageSlide
                  offset={orderOf("tasks") - pageIndex}
                  contentRef={tasksPageRef}
                >
                  {horizontalBar ? (
                    <>
                      <StripScroller>
                        {stripTasks.length === 0 ? (
                          <p className="px-4 py-6 text-body text-muted-foreground">
                            没有进行中的任务
                          </p>
                        ) : (
                          <div className="flex h-full items-stretch gap-2.5 px-3 pb-2 pt-1">
                            {stripTasks.map((t) => (
                              <TaskTile key={t.id} task={t} now={taskNow} />
                            ))}
                          </div>
                        )}
                      </StripScroller>
                      {/* 横栏也保留快速添加（含 💡 灵感切换） */}
                      <TaskQuickAdd />
                    </>
                  ) : (
                    <RemindersPage buckets={taskBuckets} now={taskNow} />
                  )}
                </PageSlide>
              </div>

              {/* 横栏以右下紧凑浮条保留显式预检与模式选择，不占内容通栏。 */}
              {(page !== "notes" || contentSubview === "notes") && (
                <SelectionBar compact={horizontalBar} />
              )}
              {/* 横栏形态：输入通栏默认不占空间，工具栏 + 按钮唤出 */}
              {page === "notes" && contentSubview === "notes" && (!horizontalBar || barDraftOpen) && <DraftInput />}

              <PreviewOverlay />
              <PreflightComposer horizontal={horizontalBar} />
              <ResultLinkDialog />
              <ResultVerificationDialog />
              <UpdateDialog />
              {showShortcuts && <ShortcutHelp />}
              {/* HUD 是独立无焦点窗口，屏幕阅读器听不到——tip() 文案镜像到此播报 */}
              <div aria-live="polite" role="status" className="sr-only">
                {announce}
              </div>
            </motion.div>
      </div>
    </TooltipProvider>
    </MotionConfig>
  );
}

/** 剪贴板分页哨兵：滚到底附近自动加载下一页（本地数据即时，无 loading 态）。 */
function ClipLoadMore({
  remaining,
  onLoad,
}: {
  remaining: number;
  onLoad: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onLoadRef = useRef(onLoad);
  onLoadRef.current = onLoad;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 提前 120px 预载，滚动无停顿；IntersectionObserver 的可见性计算
    // 已含祖先 overflow 裁剪，root 用默认视口即可
    const ob = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onLoadRef.current();
      },
      { rootMargin: "120px" }
    );
    ob.observe(el);
    return () => ob.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      className="py-1 text-center text-label text-muted-foreground"
    >
      还有 {remaining} 条…
    </div>
  );
}

/** chrome 级图标钮的 Radix 提示（行级高重复件按政策保留原生 title）；
 *  「仅指针可打开」策略统一在 ui/tooltip.tsx 实现。 */
function Tipped({ label, children }: { label: string; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-64 text-label">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

/** 长按 ⌥ 弹出的快捷键速查层。 */
function ShortcutHelp() {
  return (
    <div className={cn("absolute inset-x-3 bottom-3 z-50 rounded-xl p-3", floatingSurface(3))}>
      <p className="mb-1.5 text-label font-semibold text-muted-foreground">快捷键</p>
      <div className="grid grid-cols-1 gap-y-0.5">
        {SHORTCUTS.map(([key, desc]) => (
          <div key={key} className="flex items-center gap-2 text-label">
            <Kbd className="min-w-10 py-0.5">{key}</Kbd>
            <span className="text-muted-foreground">{desc}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 顶部页面切换标签（样式对齐设置窗口 Segmented 手感）。 */
function PageTab({
  id,
  active,
  badge,
  onClick,
  onDoubleClick,
  children,
}: {
  id: PageId;
  active: boolean;
  badge?: number;
  onClick: () => void;
  onDoubleClick: () => void;
  children: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });
  return (
    <button
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        // 拖拽中压过相邻页签，避免被后一个盖住半截
        zIndex: isDragging ? 1 : undefined,
      }}
      {...attributes}
      {...listeners}
      // 必须在 attributes 之后：dnd-kit 会带上 role="button"，
      // 覆盖掉页签的 tab 语义（无障碍读屏会把它念成普通按钮）
      role="tab"
      aria-selected={active}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      title={`切换到${typeof children === "string" ? children : PAGE_LABEL[id]}；双击返回列表起点`}
      className={cn(
        "relative flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-label outline-none",
        "transition-[color,background-color,transform] duration-(--duration-control)",
        focusRing,
        "active:scale-[0.97]",
        isDragging && "cursor-grabbing opacity-80",
        active
          ? // 浮起 thumb（2026-08-13 随 Segmented 轨道化联动，替代灰胶囊）：
            // 白片+微投影承托选中，仍无描边无蓝色；轨道见 tablist 容器
            "border-transparent bg-segmented-thumb font-medium text-foreground shadow-(--segmented-thumb-shadow)"
          : "border-transparent text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/5"
      )}
    >
      {children}
      {/* 16px 正圆：min-w=h 锁死单数字为圆，两位数由 min-width 让位撑成胶囊。
          字号走 text-micro（10px）——9px 在 16px 圆里笔画糊、占比过小，视觉上「不正」 */}
      {!!badge && (
        <span className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-destructive/90 px-1 text-micro font-semibold tabular-nums text-white">
          {badge}
        </span>
      )}
    </button>
  );
}
