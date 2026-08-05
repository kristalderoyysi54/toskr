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
} from "@dnd-kit/core";
import {
  horizontalListSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { motion, MotionConfig } from "motion/react";
import {
  CheckCircle2,
  Circle,
  ClipboardList,
  ArrowLeft,
  ArrowRight,
  CheckCheck,
  Eraser,
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
import { PreviewOverlay } from "@/components/PreviewOverlay";
import { SectionGroup } from "@/components/SectionGroup";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { SelectionBar } from "@/components/SelectionBar";
import {
  SimpleMenu,
  SimpleMenuItem,
  SimpleMenuLabel,
  SimpleMenuSeparator,
} from "@/components/SimpleMenu";
import { TaskPage, TASK_DONE_KEY } from "@/components/TaskPage";
import { TaskTile } from "@/components/TaskRow";
import { TaskQuickAdd } from "@/components/TaskQuickAdd";
import { EmptyState } from "@/components/ui/empty-state";
import { floatingSurface } from "@/components/ui/floating-surface";
import { IconButton } from "@/components/ui/icon-button";
import { Kbd } from "@/components/ui/kbd";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  clearDoneTasksWithUndo,
  clearDoneWithUndo,
  copyCheckedAsList,
  deleteNotesWithUndo,
  deleteTasksWithUndo,
  enrichLinkMeta,
  sendCheckedToChat,
  sendNotesToChat,
  undoableTip,
} from "@/lib/actions";
import { bucketTasksForDisplay, dueTasksToRemind } from "@/lib/tasks";
import { springSnappy, tweenExit } from "@/lib/motion";
import { previewOf } from "@/lib/format";
import { SHORTCUTS } from "@/lib/shortcuts";
import { runPendingUndo, setPendingUndo, tip } from "@/lib/tip";
import { silentUpdateFlow } from "@/lib/updater";
import { matchNote } from "@/lib/search";
import { broadcastSettings, installSettingsSyncHost } from "@/lib/settingsSync";
import {
  api,
  HUD_OPEN_PANEL_EVENT,
  PANEL_MOVED_EVENT,
  CLIP_EVENT,
  CLIP_PAUSE_EVENT,
  STEALTH_EVENT,
  TRIGGER_EVENT,
  UNDO_CAPTURE_EVENT,
  type ClipPayload,
  type HudOpenPanelPayload,
  type TriggerPayload,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";
import {
  CLIPBOARD_ID,
  INBOX_ID,
  noteImages,
  PANEL_WIDTH_MAX,
  PANEL_WIDTH_MIN,
  SECTION_COLORS,
  TASK_INBOX_ID,
  useNotesStore,
  type Settings,
} from "@/store/notesStore";
import { useUIStore } from "@/store/uiStore";

/** 本会话捕获的卡片 id 栈（HUD 撤销用，无需持久化）。 */
const captureHistory: string[] = [];

/** 横栏「已完成」过滤哨兵值（与真实分组 id 隔离）。 */
const DONE_FILTER = "__done__";

/** 横栏分组胶囊管理能力（与竖栏分组头对齐）。 */
interface PillManage {
  rename: (id: string, name: string) => void;
  move: (id: string, dir: -1 | 1) => void;
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
      onClick={onPick}
      onDoubleClick={() => {
        if (manage) {
          setName(item.name);
          setRenaming(true);
        }
      }}
      className={pillCls(on)}
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
          <div className="flex items-center gap-1 px-2 py-1.5">
            {SECTION_COLORS.map((c) => (
              <button
                key={c}
                aria-label="设置分组色"
                onClick={() => manage.setColor?.(item.id, c)}
                className="size-3.5 rounded-full ring-offset-1 transition-transform hover:scale-125"
                style={{ backgroundColor: c }}
              />
            ))}
            <button
              aria-label="清除颜色"
              onClick={() => manage.setColor?.(item.id, undefined)}
              className="size-3.5 rounded-full border border-dashed border-muted-foreground/50 transition-transform hover:scale-125"
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
  return (
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
}

/** 横栏滚动容器：细滚动条 + 纵向滚轮转横向滑动（Paste 手感）。 */
function StripScroller({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        el.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  return (
    <div
      ref={ref}
      className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden [&::-webkit-scrollbar]:hidden"
    >
      {children}
    </div>
  );
}

const SIDEBAR_EDGE_LABEL = {
  right: "靠右显示",
  left: "靠左显示",
  top: "靠上显示",
  bottom: "靠下显示",
} as const;

/** 应用边栏停靠：开=接管位置（清手动拖动）；关=恢复自动停靠。 */
async function applySidebar(on: boolean, edge: Settings["sidebarEdge"]) {
  useNotesStore.getState().setSettings({
    rightSidebar: on,
    sidebarEdge: edge,
    panelFreeX: null,
    panelFreeY: null,
  });
  await api.setPanelFreePos(null, null).catch(() => {});
  await api.setSidebarMode(on, edge).catch(() => {});
  if (!on) void api.showPanel();
}

/**
 * 常驻页面滑层：三页始终挂载，切页只动 transform/opacity（GPU 合成），
 * 零挂载成本——重列表页（剪贴板缩略图墙）切入不再掉帧。offset 为
 * 该页与当前页的序差：0=激活；负=藏左侧；正=藏右侧。动画结束后
 * visibility:hidden 停掉不活动页的绘制。
 */
function PageSlide({
  offset,
  children,
}: {
  offset: number;
  children: React.ReactNode;
}) {
  const active = offset === 0;
  return (
    <motion.div
      initial={false}
      animate={
        active
          ? { x: 0, opacity: 1, visibility: "visible" as const }
          : {
              x: offset < 0 ? -24 : 24,
              opacity: 0,
              transitionEnd: { visibility: "hidden" as const },
            }
      }
      transition={springSnappy}
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
  const open = useUIStore((s) => s.open);
  const page = useUIStore((s) => s.page);
  const pinned = useUIStore((s) => s.pinned);
  const announce = useUIStore((s) => s.announce);
  const searchOpen = useUIStore((s) => s.searchOpen);
  const query = useUIStore((s) => s.query);
  const doneOpen = useUIStore((s) => s.doneOpen);
  const sections = useNotesStore((s) => s.sections);
  const notes = useNotesStore((s) => s.notes);
  const tasks = useNotesStore((s) => s.tasks);
  const taskSections = useNotesStore((s) => s.taskSections);
  const settings = useNotesStore((s) => s.settings);
  const onboarding = settings.onboarding;
  /** 收起动画结束隐藏窗口时，是否归还焦点给原前台应用。 */
  const restoreFocusRef = useRef(true);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const dragExpandRef = useRef<{ sec: string; timer: number } | null>(null);

  const openPanel = async () => {
    try {
      await api.showPanel();
    } catch {
      /* Tauri 环境外忽略 */
    }
    useUIStore.getState().setOpen(true);
  };

  const closePanel = (restoreFocus: boolean) => {
    restoreFocusRef.current = restoreFocus;
    useUIStore.getState().setOpen(false);
  };

  // 正常启动保持隐藏，让第一次双击快捷键执行“显示”而不是误判为“关闭”。
  // 仅在监听不可用时自动打开，继续承载首启授权引导。
  useEffect(() => {
    let alive = true;
    void api
      .tapStatus()
      .then(({ installed, listening }) => {
        if (alive && (!installed || !listening)) void openPanel();
      })
      .catch(() => {
        /* Tauri 环境外忽略 */
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 应用级权限守护（常驻，与面板显隐无关）：
  // - 辅助功能授权后 3s 内自动重装监听（无需重启）
  // - tap 已创建却持续收不到事件 → 判定输入监控权限被扣（Sequoia 特征）
  useEffect(() => {
    let alive = true;
    let prevHealthy: boolean | null = null;
    let stuckTicks = 0;
    const check = async () => {
      try {
        const [ax, tap] = await Promise.all([api.axTrusted(false), api.tapStatus()]);
        if (!alive) return;
        if (tap.listening && tap.installed && !tap.receiving) stuckTicks += 1;
        else stuckTicks = 0;
        const stuck = !tap.listening || stuckTicks >= 4;
        useUIStore.getState().setPermission(ax, tap.installed, tap.receiving, stuck);
        const healthy = tap.installed && tap.receiving;
        if (prevHealthy === false && healthy) {
          tip("ok", "键盘监听已就绪，双击 ⇧ 试试 ✓");
        }
        prevHealthy = healthy;
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
    };
  }, []);

  // ===== Rust 事件闭环 =====

  // 触发事件：开关面板 / 捕获入库（去重裁决后回调 HUD）
  useEffect(() => {
    const unlisten = listen<TriggerPayload>(TRIGGER_EVENT, (event) => {
      const payload = event.payload;
      if (payload.kind === "toggle") {
        const { open: isOpen, pinned: isPinned } = useUIStore.getState();
        // 前端链路回执：报障时与 Rust 侧「双击触发」拼成完整链路
        void api.diagNote(`前端收到 Toggle: open=${isOpen} pinned=${isPinned}`);
        // 钉住 = 常驻：双击快捷键不收起面板（Esc / 取消图钉可收）；
        // 专用面板快捷键（force）意图明确，钉住时也执行收起
        if (isOpen && isPinned && !payload.force) {
          tip("info", "面板已固定 · 按 Esc 或取消图钉可收起");
          return;
        }
        if (isOpen) closePanel(true);
        else void openPanel();
        return;
      }
      const { result, id } = useNotesStore.getState().addNote(payload.text, {
        sourceApp: payload.appName ?? undefined,
        sourceBundle: payload.bundleId ?? undefined,
        // 文本不写死 kind，交给 addNote 检测（URL → 链接卡）
        kind: payload.contentKind === "image" ? "image" : undefined,
        imageFile: payload.imageFile ?? undefined,
        imageW: payload.imageW ?? undefined,
        imageH: payload.imageH ?? undefined,
      });
      if (result === "empty") return;
      void api.showCaptureHud(
        result === "duplicate" ? "duplicate" : "added",
        previewOf(payload.text)
      );
      if (result === "added" && id) {
        void enrichLinkMeta(id);
        captureHistory.push(id);
        setPendingUndo(() => {
          const undoId = captureHistory.pop();
          const exists =
            undoId && useNotesStore.getState().notes.some((n) => n.id === undoId);
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
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // HUD 悬停撤销请求
  useEffect(() => {
    const unlisten = listen(UNDO_CAPTURE_EVENT, () => {
      runPendingUndo();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // 独立模式拖动面板 → 记住位置（去抖持久化）
  useEffect(() => {
    let timer = 0;
    const unlisten = listen<{ x: number; y: number }>(PANEL_MOVED_EVENT, (event) => {
      const { x, y } = event.payload;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        useNotesStore.getState().setSettings({
          panelFreeX: Math.round(x),
          panelFreeY: Math.round(y),
        });
      }, 400);
    });
    return () => {
      window.clearTimeout(timer);
      unlisten.then((fn) => fn());
    };
  }, []);

  // 点击 HUD 气泡：展开面板。到期提醒切任务页定位任务，其余高亮刚捕获的卡片
  useEffect(() => {
    const unlisten = listen<HudOpenPanelPayload>(HUD_OPEN_PANEL_EVENT, (event) => {
      const p = event.payload ?? {};
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
        // 先切页（setPage 会清 focusedId），再定位目标任务
        useUIStore.getState().setPage("tasks");
        if (p.taskId) flash(p.taskId);
      } else {
        const lastId = captureHistory[captureHistory.length - 1];
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
    const timer = window.setInterval(check, 30_000);
    return () => {
      unsub();
      window.clearInterval(timer);
    };
  }, []);

  // 剪贴板保留时长清理：水合后一次 + 每 30 分钟（固定卡豁免）
  useEffect(() => {
    const prune = () => {
      useNotesStore
        .getState()
        .pruneClipHistory()
        .forEach((f) => void api.removeImage(f).catch(() => {}));
    };
    if (useNotesStore.persist.hasHydrated()) prune();
    const unsub = useNotesStore.persist.onFinishHydration(() => prune());
    const timer = window.setInterval(prune, 1_800_000);
    return () => {
      unsub();
      window.clearInterval(timer);
    };
  }, []);

  // 托盘暂停剪贴板收集 → 同步持久化（0 = 恢复）
  useEffect(() => {
    const unlisten = listen<number>(CLIP_PAUSE_EVENT, (event) => {
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
      useNotesStore.getState().setSettings({ stealth: event.payload });
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // 剪贴板历史：watcher 推送 → 静默入库（重复内容由 addNote 去重吞掉）
  useEffect(() => {
    const unlisten = listen<ClipPayload>(CLIP_EVENT, (event) => {
      const p = event.payload;
      // 暂停收集期间丢弃（到期自动恢复，无需额外定时器）
      const pauseUntil = useNotesStore.getState().settings.clipPauseUntil;
      if (pauseUntil && Date.now() < pauseUntil) return;
      const removed = useNotesStore.getState().addClipNote(p.text, {
        sourceApp: p.appName ?? undefined,
        sourceBundle: p.bundleId ?? undefined,
        kind: p.contentKind === "image" ? "image" : "text",
        imageFile: p.imageFile ?? undefined,
        imageW: p.imageW ?? undefined,
        imageH: p.imageH ?? undefined,
      });
      // 被裁剪卡片的图片附件落盘清理（尽力而为）
      removed.forEach((f) => void api.removeImage(f).catch(() => {}));
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // 失焦：自动隐藏（Pin 豁免）+ 刷新发送目标（防 Pin 场景目标漂移）
  useEffect(() => {
    const win = getCurrentWebviewWindow();
    const unlisten = win.onFocusChanged(({ payload: focused }) => {
      if (focused) return;
      window.setTimeout(() => {
        void api.refreshPrevApp();
      }, 300);
      // 稍等前台归属稳定再判定：焦点若只是移到自家窗口（空格图片预览、
      // 设置窗），应用仍在前台 → 不算离开，面板不收（未钉住场景）
      window.setTimeout(async () => {
        const { open: isOpen, pinned: isPinned } = useUIStore.getState();
        const { hideOnBlur } = useNotesStore.getState().settings;
        if (!(isOpen && !isPinned && hideOnBlur)) return;
        const stillOurs = await api.isSelfFrontmost().catch(() => false);
        if (!stillOurs) closePanel(false);
      }, 120);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
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
        orphanImages.forEach((f) => void api.removeImage(f).catch(() => {}));
        if (removed > 0) undoableTip(`已清空剪贴板历史 ${removed} 条`);
        else tip("info", "剪贴板历史已是空的");
      },
    });
    return cleanup;
  }, []);

  // 设置变化后广播给设置窗口（托盘隐身切换等外部改动也能同步）
  useEffect(() => useNotesStore.subscribe(() => broadcastSettings()), []);

  // 持久化水合后把运行时配置下发给 Rust
  useEffect(() => {
    const push = (settings: Settings) => {
      void api.setHotkeyConfig(settings.hotkeyModifier, settings.hotkeyGapMs);
      void api.setPanelHotkey(settings.panelToggleHotkey).catch(() => {});
      void api.setCompanionConfig(settings.companionEnabled, settings.companionApps);
      void api.setCompanionGap(settings.companionGap);
      void api
        .setSidebarMode(settings.rightSidebar, settings.sidebarEdge)
        .catch(() => {});
      void api.setPanelFreePos(settings.panelFreeX, settings.panelFreeY);
      void api.setPanelWidth(settings.panelWidth);
      // 垂直覆盖为会话内临时值（切换吸附目标即重置），不做启动恢复
      void api.setStealth(settings.stealth);
      void api.setSound(settings.soundEnabled);
      void api.setDoubleTapMode(settings.doubleTapCaptureOnly);
      void api.setClipWatch(settings.clipHistory);
      void api.setClipPause(settings.clipPauseUntil ?? 0);
      void api.setClipRules(
        settings.clipIgnoreConcealed,
        settings.clipIgnoreTransient,
        settings.clipExcludedApps
      );
      void api.setWindowTheme(settings.theme);
      void api.setExcludedApps(settings.excludedApps);
      void api.setVibrancy(settings.vibrancy, settings.vibrancyMaterial);
      void api.setWindowAlpha(settings.windowOpacity);
    };
    if (useNotesStore.persist.hasHydrated()) {
      push(useNotesStore.getState().settings);
    }
    const unsub = useNotesStore.persist.onFinishHydration((state) => {
      push(state.settings);
      // 迁移提交：新数据文件尚不存在（数据还在旧存储）时立即落盘一次
      void api
        .readDataFile()
        .then((raw) => {
          if (!raw) useNotesStore.setState({});
        })
        .catch(() => {});
    });
    return unsub;
  }, []);

  // 静默检查更新：启动 8 秒后一次 + 之后每日一次（常驻后台、重启频率低，
  // 只查启动那一次会长期错过新版）。发现新版右上角气泡提醒。
  useEffect(() => {
    const timer = window.setTimeout(() => void silentUpdateFlow(), 8000);
    const daily = window.setInterval(
      () => void silentUpdateFlow(),
      24 * 60 * 60 * 1000
    );
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(daily);
    };
  }, []);

  // 首次使用（引导未完成）：自动弹出面板并钉住——新用户不知道双击 ⇧，
  // 面板必须自己出现且不因失焦消失，三步上手引导才有机会被看到。
  // 必须等水合完成再判断，否则老用户会被默认值误弹（onboarding 默认 done=false）
  useEffect(() => {
    const showForFirstRun = () => {
      if (useNotesStore.getState().settings.onboarding.done) return;
      useUIStore.getState().setPinned(true);
      useUIStore.getState().setOpen(true);
      void api.showPanel();
    };
    if (useNotesStore.persist.hasHydrated()) {
      showForFirstRun();
      return;
    }
    const unsub = useNotesStore.persist.onFinishHydration(() => showForFirstRun());
    return unsub;
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
        defaultPath: "toskr-backup.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return;
      const { sections: secs, notes: ns, tasks: ts } = useNotesStore.getState();
      await api.exportFile(
        path,
        JSON.stringify({ sections: secs, notes: ns, tasks: ts }, null, 2)
      );
      tip("ok", "已导出备份");
    } catch (e) {
      tip("warn", `导出失败：${e}`);
    }
  };

  const importBackup = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (typeof path !== "string") return;
      const raw = await api.importFile(path);
      const added = useNotesStore.getState().importMerge(JSON.parse(raw));
      tip("ok", `导入完成（合并）：笔记 ${added.notes} 条，任务 ${added.tasks} 个`);
    } catch (e) {
      tip("warn", `导入失败：${e}`);
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
        .filter((section) => section.id !== CLIPBOARD_ID)
        .map((section) => {
          const inSection = notes.filter(
            (n) => n.sectionId === section.id && matchNote(n, q)
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

  const noteMatchCount = grouped.reduce(
    (a, g) => a + g.active.length + g.done.length,
    0
  );
  const matchCount = page === "clipboard" ? clipNotes.length : noteMatchCount;

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
      ...taskBuckets.overdue.map((t) => t.id),
      ...taskBuckets.sparks.map((t) => t.id),
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

  /** 当前页的键盘导航序列。 */
  const navIds =
    page === "tasks" ? taskNavIds : page === "clipboard" ? clipNavIds : noteNavIds;

  // 可见顺序同步到 uiStore，供 Shift 范围选中使用
  useEffect(() => {
    useUIStore.getState().setNavIds(navIds);
  }, [navIds]);

  const activeCount = notes.filter((n) => !n.done).length;
  const doneCount = notes.length - activeCount;
  const activeTaskCount = tasks.filter((t) => t.status !== "done").length;
  const doneTaskCount = tasks.length - activeTaskCount;

  // 页面序（笔记/任务/剪贴板）：常驻页按序差决定滑向（左侧页藏左、右侧页藏右）
  const pageIndex = page === "notes" ? 0 : page === "tasks" ? 1 : 2;
  /** 上/下横栏形态：剪贴板页走 Paste 式方形卡横向串。 */
  const horizontalBar =
    settings.rightSidebar &&
    (settings.sidebarEdge === "top" || settings.sidebarEdge === "bottom");
  /** 横栏下笔记输入通栏默认收起，由工具栏「添加笔记」按钮唤出。 */
  const [barDraftOpen, setBarDraftOpen] = useState(false);

  // ===== 面板内快捷键（Esc 分层 + 全键盘导航） =====
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
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

      // ⌃Tab：笔记 → 任务 → 剪贴板 循环（⌘1-9 已被快发占用，取浏览器切标签页惯例）
      if (e.key === "Tab" && e.ctrlKey) {
        e.preventDefault();
        const ui = useUIStore.getState();
        const order = ["notes", "tasks", "clipboard"] as const;
        const next = order[(order.indexOf(ui.page) + 1) % order.length];
        ui.setPage(next);
        return;
      }
      // ⌘← / ⌘→：按 tab 顺序左右切换（输入框内保留系统的行首/行尾跳转）
      if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && e.metaKey) {
        if (editable) return;
        e.preventDefault();
        const ui = useUIStore.getState();
        const order = ["notes", "tasks", "clipboard"] as const;
        const idx = order.indexOf(ui.page);
        const next =
          e.key === "ArrowRight"
            ? Math.min(idx + 1, order.length - 1)
            : Math.max(idx - 1, 0);
        ui.setPage(order[next]);
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
          closePanel(true);
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
      // 两页均可用；仅任务页禁用（任务 id 会污染勾选态，切回后「已选 N」错乱）
      const onNotesPage = useUIStore.getState().page !== "tasks";
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
      // Space = 全文预览（Paste 风格）；链接卡「明细」= 开网页；
      // 任务页 = 完成态二态直切（与鼠标点状态点的三态循环是刻意差异）
      if (e.key === " " && ui.focusedId) {
        e.preventDefault();
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
          // 图片卡 Space = 系统 Quick Look 原尺寸（与 macOS 空格预览心智一致）
          void api.quickLook(noteImages(focusedNote));
        } else {
          ui.openPreview(ui.focusedId);
        }
        return;
      }
      if (e.key === "x" && !e.metaKey && ui.focusedId) {
        e.preventDefault();
        if (ui.page === "tasks") {
          useNotesStore.getState().toggleTaskDone(ui.focusedId);
        } else {
          useNotesStore.getState().toggleChecked(ui.focusedId);
        }
        return;
      }
      if (e.key === "Enter" && !e.metaKey && ui.focusedId) {
        e.preventDefault();
        if (ui.page === "tasks") {
          ui.setEditingId(ui.focusedId);
        } else {
          ui.openPreview(ui.focusedId, true);
        }
        return;
      }
      if (e.key === "Backspace" && e.metaKey && ui.focusedId) {
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
  }, [navIds]);

  // ===== 跨分组拖拽 =====
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
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
    const state = useNotesStore.getState();
    const activeNote = state.notes.find((n) => n.id === activeId);
    if (!activeNote) return;

    const targetSection = overId.startsWith("sec:")
      ? overId.slice(4)
      : (state.notes.find((n) => n.id === overId)?.sectionId ?? null);
    if (!targetSection) return;

    if (targetSection !== activeNote.sectionId) {
      state.moveNotes([activeId], targetSection);
    }
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
    const overId = String(over.id);
    if (overId.startsWith("sec:")) return;
    if (active.id !== over.id) {
      useNotesStore.getState().reorderNotes(String(active.id), overId);
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

  /** 页签三连（普通模式独占一行；横栏并入标题行居中）。 */
  const pageTabs = (
    <>
      <PageTab
        active={page === "notes"}
        onClick={() => useUIStore.getState().setPage("notes")}
      >
        笔记
      </PageTab>
      <PageTab
        active={page === "tasks"}
        badge={taskBuckets.overdue.length}
        onClick={() => useUIStore.getState().setPage("tasks")}
      >
        任务
      </PageTab>
      <PageTab
        active={page === "clipboard"}
        onClick={() => useUIStore.getState().setPage("clipboard")}
      >
        剪贴板
      </PageTab>
    </>
  );

  return (
    <MotionConfig reducedMotion="user">
    <TooltipProvider delayDuration={400}>
      <div
        className="h-screen w-screen overflow-hidden text-foreground"
        onContextMenu={(e) => e.preventDefault()}
      >
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
                "panel-surface relative flex h-full w-full flex-col overflow-hidden rounded-xl",
                "border border-foreground/10",
                !open && "pointer-events-none"
              )}
            >
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
                <span className="text-label tabular-nums text-muted-foreground">
                  {page === "notes"
                    ? activeCount
                    : page === "tasks"
                      ? activeTaskCount
                      : clipNotes.length}
                </span>
                {/* 横栏：页签 + 分组胶囊并入标题行居中（Paste 式），少占一到两行高度 */}
                {horizontalBar && (
                  <div
                    role="tablist"
                    aria-label="页面"
                    className="absolute left-1/2 top-1/2 flex max-w-[60%] -translate-x-1/2 -translate-y-1/2 items-center gap-1 overflow-x-auto [&::-webkit-scrollbar]:hidden"
                  >
                    {pageTabs}
                    {page === "notes" && (
                      <>
                        <span aria-hidden className="mx-1 h-3.5 w-px shrink-0 bg-border" />
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
                      </>
                    )}
                    {page === "tasks" && (
                      <>
                        <span aria-hidden className="mx-1 h-3.5 w-px shrink-0 bg-border" />
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
                      </>
                    )}
                  </div>
                )}
                <div className="ml-auto flex items-center gap-0.5">
                  {/* 横栏：输入通栏收起，这里按需唤出（仅上下布局出现） */}
                  {horizontalBar && page === "notes" && (
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
                  {page !== "clipboard" && (page === "notes" ? doneCount : doneTaskCount) > 0 && (
                    <Tipped
                      label={
                        page === "notes"
                          ? `清理 ${doneCount} 条已完成`
                          : `清理 ${doneTaskCount} 个已完成任务`
                      }
                    >
                      <IconButton
                        label={
                          page === "notes"
                            ? `清理 ${doneCount} 条已完成`
                            : `清理 ${doneTaskCount} 个已完成任务`
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
                  {page !== "tasks" && (
                    <Tipped label="卡片密度：舒适 / 紧凑">
                      <IconButton
                        label="卡片密度：舒适 / 紧凑"
                        withTitle={false}
                        pressed={settings.cardDensity === "compact"}
                        onClick={() => {
                          const cur = useNotesStore.getState().settings.cardDensity;
                          useNotesStore.getState().setSettings({
                            cardDensity: cur === "compact" ? "comfortable" : "compact",
                          });
                        }}
                      >
                        <Rows3 />
                      </IconButton>
                    </Tipped>
                  )}
                  {(page !== "tasks" || doneTaskCount > 0) && (
                    <span aria-hidden className="mx-0.5 h-3.5 w-px bg-border" />
                  )}
                  {/* 全局工具：停靠模式 / 固定 / 设置 */}
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
                      const label = settings.rightSidebar
                        ? `边栏已开启（${SIDEBAR_EDGE_LABEL[settings.sidebarEdge]}）· 点击换停靠缘或关闭`
                        : "边栏停靠：贴屏幕某缘显示（与伴随磁吸互斥）";
                      return (
                        <Tipped label={label}>
                          <IconButton
                            label={label}
                            withTitle={false}
                            pressed={settings.rightSidebar}
                            onClick={toggle}
                          >
                            <EdgeIcon />
                          </IconButton>
                        </Tipped>
                      );
                    }}
                  >
                    {(close) => (
                      <>
                        <SimpleMenuLabel>边栏停靠（与伴随磁吸互斥）</SimpleMenuLabel>
                        {(["right", "left", "top", "bottom"] as const).map((edge) => (
                          <SimpleMenuItem
                            key={edge}
                            onClick={() => {
                              close();
                              void applySidebar(true, edge);
                            }}
                          >
                            {settings.rightSidebar && settings.sidebarEdge === edge
                              ? "✓ "
                              : ""}
                            {SIDEBAR_EDGE_LABEL[edge]}
                          </SimpleMenuItem>
                        ))}
                        <SimpleMenuSeparator />
                        <SimpleMenuItem
                          disabled={!settings.rightSidebar}
                          onClick={() => {
                            close();
                            void applySidebar(false, settings.sidebarEdge);
                          }}
                        >
                          关闭边栏（恢复自动停靠）
                        </SimpleMenuItem>
                      </>
                    )}
                  </SimpleMenu>
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

              {/* 页面切换：笔记 / 任务 / 剪贴板（⌃Tab 循环）。
                  横栏形态并入标题行居中（Paste 式单行头部），不再单占一行 */}
              {!horizontalBar && (
                <div
                  role="tablist"
                  aria-label="页面"
                  className="mx-3 mb-1.5 flex items-center gap-1"
                >
                  {pageTabs}
                </div>
              )}

              <PermissionBanner />

              {searchOpen && page !== "tasks" && (
                <div className="surface-inset mx-3 mb-1.5 flex items-center gap-1.5 rounded-lg border border-foreground/10 px-2 py-1 focus-within:border-primary/50">
                  <Search className="size-3 shrink-0 text-muted-foreground/70" />
                  <input
                    ref={searchInputRef}
                    autoFocus
                    value={query}
                    placeholder="搜索卡片…"
                    onChange={(e) => useUIStore.getState().setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        useUIStore.getState().setSearchOpen(false);
                      }
                    }}
                    className="h-5 w-full bg-transparent text-body outline-none placeholder:text-muted-foreground/60"
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
                <PageSlide offset={2 - pageIndex}>
                {horizontalBar ? (
                  <StripScroller>
                    {clipNotes.length === 0 ? (
                      <p className="px-4 py-6 text-body text-muted-foreground/60">
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
                <ScrollArea className="min-h-0 flex-1 px-2">
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
                        <div className="flex flex-col gap-1 pb-2 pl-2 pt-1">
                          {visibleClipNotes.map((n) => (
                            <NoteCard key={n.id} note={n} query={q} />
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
                <PageSlide offset={0 - pageIndex}>
                {horizontalBar ? (
                  <>
                  <StripScroller>
                    {stripNotes.length === 0 ? (
                      <p className="px-4 py-6 text-body text-muted-foreground/60">
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
              <ScrollArea className="min-h-0 flex-1 px-2">
                {!onboarding.done && <OnboardingCard />}
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
                      {grouped.map(({ section, active, done }) => (
                        <SectionGroup
                          key={section.id}
                          section={section}
                          activeNotes={active}
                          doneNotes={done}
                          query={q}
                        />
                      ))}
                      {!q && (
                        <button
                          onClick={() => useNotesStore.getState().addSection()}
                          className="mb-2 ml-2 flex items-center gap-1 rounded-md px-1.5 py-1 text-label text-muted-foreground/60 outline-none hover:bg-black/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/50 dark:hover:bg-white/10"
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
                <PageSlide offset={1 - pageIndex}>
                  {horizontalBar ? (
                    <>
                      <StripScroller>
                        {stripTasks.length === 0 ? (
                          <p className="px-4 py-6 text-body text-muted-foreground/60">
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
                    <TaskPage buckets={taskBuckets} now={taskNow} />
                  )}
                </PageSlide>
              </div>

              {/* 横栏形态寸土寸金：批量操作条不占通栏（双击/⌘⏎/右键仍可发送） */}
              {!horizontalBar && <SelectionBar />}
              {/* 横栏形态：输入通栏默认不占空间，工具栏 + 按钮唤出 */}
              {page === "notes" && (!horizontalBar || barDraftOpen) && <DraftInput />}

              <PreviewOverlay />
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
      className="py-1 text-center text-label text-muted-foreground/50"
    >
      还有 {remaining} 条…
    </div>
  );
}

function OnboardingCard() {
  const onboarding = useNotesStore((s) => s.settings.onboarding);
  const axOk = useUIStore((s) => s.permissionAx);

  const Step = ({ done, children }: { done: boolean; children: React.ReactNode }) => (
    <li className="flex items-start gap-1.5">
      {done ? (
        <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />
      ) : (
        <Circle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/40" />
      )}
      <span className={cn("text-label leading-normal", done && "text-muted-foreground line-through")}>
        {children}
        {done && <span className="sr-only">，已完成</span>}
      </span>
    </li>
  );

  return (
    <div className="mx-1 mb-2 mt-1 rounded-xl border border-foreground/10 bg-surface-raised/90 p-3 elevation-3">
      <p className="mb-1.5 text-body font-semibold">三步上手</p>
      <ul aria-live="polite" className="flex flex-col gap-1">
        <Step done={axOk}>在系统设置授权「辅助功能」</Step>
        <Step done={onboarding.captured}>
          去任意应用选中一段文字，连按两次 <Kbd>⇧</Kbd> 捕获
        </Step>
        <Step done={onboarding.sent}>
          勾选卡片，按 <Kbd>⌘⏎</Kbd> 发送回你的 AI 对话
        </Step>
      </ul>
    </div>
  );
}

/** chrome 级图标钮的 Radix 提示（行级高重复件按政策保留原生 title）。 */
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
  active,
  badge,
  onClick,
  children,
}: {
  active: boolean;
  badge?: number;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-label outline-none",
        "transition-[color,background-color,transform] duration-100",
        "focus-visible:ring-2 focus-visible:ring-primary/50 active:scale-[0.97]",
        active
          ? "border-border bg-primary/10 font-medium text-foreground dark:border-input"
          : "border-transparent text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/5"
      )}
    >
      {children}
      {/* token-exception: 徽标 9px 为重塑前原始尺寸，用户指定还原 */}
      {!!badge && (
        <span className="rounded-full bg-destructive/90 px-1.5 text-[9px] font-semibold leading-4 tabular-nums text-white">
          {badge}
        </span>
      )}
    </button>
  );
}

