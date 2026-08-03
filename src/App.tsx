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
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { AnimatePresence, motion } from "motion/react";
import {
  CheckCircle2,
  Circle,
  ClipboardList,
  CornerUpRight,
  Eraser,
  Pin,
  Plus,
  Rows3,
  Search,
  Settings2,
  X,
} from "lucide-react";
import { DraftInput } from "@/components/DraftInput";
import { NoteCard } from "@/components/NoteCard";
import { PermissionBanner } from "@/components/PermissionBanner";
import { PreviewOverlay } from "@/components/PreviewOverlay";
import { SectionGroup } from "@/components/SectionGroup";
import { SelectionBar } from "@/components/SelectionBar";
import { TaskPage, TASK_DONE_KEY } from "@/components/TaskPage";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TooltipProvider } from "@/components/ui/tooltip";
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
import { previewOf } from "@/lib/format";
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
  PANEL_WIDTH_MAX,
  PANEL_WIDTH_MIN,
  useNotesStore,
  type Settings,
} from "@/store/notesStore";
import { useUIStore } from "@/store/uiStore";

/** 本会话捕获的卡片 id 栈（HUD 撤销用，无需持久化）。 */
const captureHistory: string[] = [];

/** 页面切换滑动（方向感知：正向左滑进、反向右滑进；spring 与整板一致）。 */
const PAGE_SLIDE = {
  enter: (dir: number) => ({ x: dir >= 0 ? 24 : -24, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (dir: number) => ({ x: dir >= 0 ? -24 : 24, opacity: 0 }),
};

export default function App() {
  const open = useUIStore((s) => s.open);
  const page = useUIStore((s) => s.page);
  const pinned = useUIStore((s) => s.pinned);
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
      const { open: isOpen, pinned: isPinned } = useUIStore.getState();
      const { hideOnBlur } = useNotesStore.getState().settings;
      if (isOpen && !isPinned && hideOnBlur) closePanel(false);
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
      void api.setPanelFreePos(settings.panelFreeX, settings.panelFreeY);
      void api.setPanelWidth(settings.panelWidth);
      // 垂直覆盖为会话内临时值（切换吸附目标即重置），不做启动恢复
      void api.setStealth(settings.stealth);
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

  // 启动静默检查更新：发现新版右上角气泡提醒（不自动下载，不打扰）
  useEffect(() => {
    const timer = window.setTimeout(() => void silentUpdateFlow(), 8000);
    return () => window.clearTimeout(timer);
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

  // 剪贴板分页渲染：保留时长开到年/永久后可能上万条，一次性渲染会卡
  const [clipShown, setClipShown] = useState(200);
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

  // 页面切换方向（按 tab 顺序 笔记/任务/剪贴板：目标在右则向左滑入）
  const pageIndex = page === "notes" ? 0 : page === "tasks" ? 1 : 2;
  const prevPageIndexRef = useRef(pageIndex);
  const pageDirection = pageIndex - prevPageIndexRef.current;
  useEffect(() => {
    prevPageIndexRef.current = pageIndex;
  }, [pageIndex]);

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
          void api.quickLook(focusedNote.imageFile);
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

  return (
    <TooltipProvider delayDuration={400}>
      <div
        className="h-screen w-screen overflow-hidden text-foreground"
        onContextMenu={(e) => e.preventDefault()}
      >
        <AnimatePresence
          onExitComplete={() => {
            void api.hidePanel(restoreFocusRef.current);
          }}
        >
          {open && (
            <motion.div
              key="panel"
              initial={{ x: 28, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: 20, opacity: 0 }}
              transition={{ type: "spring", stiffness: 480, damping: 40 }}
              className={cn(
                "panel-surface relative flex h-full w-full flex-col overflow-hidden rounded-[14px]",
                "border border-black/10 dark:border-white/10"
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
                className="flex items-center gap-2 px-4 pb-2 pt-3.5"
              >
                <h1
                  data-tauri-drag-region
                  title="拖动此处可移动面板（未吸附时）"
                  className="cursor-grab select-none text-[13px] font-semibold tracking-tight active:cursor-grabbing"
                >
                  Toskr
                </h1>
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {page === "notes"
                    ? activeCount
                    : page === "tasks"
                      ? activeTaskCount
                      : clipNotes.length}
                </span>
                <div className="ml-auto flex items-center gap-0.5">
                  {page !== "clipboard" && (page === "notes" ? doneCount : doneTaskCount) > 0 && (
                    <button
                      aria-label="清理已完成"
                      title={
                        page === "notes"
                          ? `清理 ${doneCount} 条已完成`
                          : `清理 ${doneTaskCount} 个已完成任务`
                      }
                      onClick={
                        page === "notes" ? clearDoneWithUndo : clearDoneTasksWithUndo
                      }
                      className="rounded-md p-1 text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
                    >
                      <Eraser className="size-3.5" />
                    </button>
                  )}
                  {(settings.panelFreeX !== null || settings.panelFreeY !== null) && (
                    <button
                      aria-label="重置面板位置"
                      title="重置面板位置：清除手动拖动，恢复自动停靠（伴随目标 / 屏幕右缘）"
                      onClick={() => {
                        useNotesStore
                          .getState()
                          .setSettings({ panelFreeX: null, panelFreeY: null });
                        void api.setPanelFreePos(null, null);
                        void api.showPanel();
                      }}
                      className="rounded-md p-1 text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
                    >
                      <CornerUpRight className="size-3.5" />
                    </button>
                  )}
                  {page !== "tasks" && (
                    <>
                      <button
                        aria-label="搜索（⌘F）"
                        title="搜索（⌘F）"
                        onClick={() => {
                          useUIStore.getState().setSearchOpen(!searchOpen);
                          window.setTimeout(() => searchInputRef.current?.focus(), 30);
                        }}
                        className={cn(
                          "rounded-md p-1 text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10",
                          searchOpen && "bg-black/5 text-foreground dark:bg-white/10"
                        )}
                      >
                        <Search className="size-3.5" />
                      </button>
                      <button
                        aria-label="切换卡片密度"
                        title="卡片密度：舒适 / 紧凑"
                        onClick={() => {
                          const cur = useNotesStore.getState().settings.cardDensity;
                          useNotesStore.getState().setSettings({
                            cardDensity: cur === "compact" ? "comfortable" : "compact",
                          });
                        }}
                        className="rounded-md p-1 text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
                      >
                        <Rows3 className="size-3.5" />
                      </button>
                    </>
                  )}
                  <button
                    aria-label={pinned ? "取消固定" : "固定面板"}
                    title={pinned ? "取消固定" : "固定（失焦不隐藏）"}
                    onClick={() => useUIStore.getState().setPinned(!pinned)}
                    className={cn(
                      "rounded-md p-1 text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10",
                      pinned && "bg-black/5 text-foreground dark:bg-white/10"
                    )}
                  >
                    <Pin className={cn("size-3.5", pinned && "fill-current")} />
                  </button>
                  <button
                    aria-label="设置"
                    title="设置"
                    onClick={() => api.openSettingsWindow()}
                    className="rounded-md p-1 text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
                  >
                    <Settings2 className="size-3.5" />
                  </button>
                </div>
              </header>

              {/* 页面切换：笔记 / 任务 / 剪贴板（⌃Tab 循环），任务 tab 带已到期红色计数 */}
              <div className="mx-3 mb-1.5 flex items-center gap-1">
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
              </div>

              <PermissionBanner />

              <div className="relative min-h-0 flex-1 overflow-hidden">
                <AnimatePresence initial={false} custom={pageDirection}>
                  <motion.div
                    key={page}
                    custom={pageDirection}
                    variants={PAGE_SLIDE}
                    initial="enter"
                    animate="center"
                    exit="exit"
                    transition={{ type: "spring", stiffness: 480, damping: 40 }}
                    className="absolute inset-0 flex min-h-0 flex-col"
                  >
                    {page === "tasks" ? (
                      <TaskPage buckets={taskBuckets} now={taskNow} />
                    ) : (
                      <>
              {searchOpen && (
                <div className="mx-3 mb-1.5 flex items-center gap-1.5 rounded-lg border border-black/10 bg-white/60 px-2 py-1 dark:border-white/10 dark:bg-white/[0.06]">
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
                    className="h-5 w-full bg-transparent text-[12px] outline-none placeholder:text-muted-foreground/60"
                  />
                  {q && (
                    <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                      {matchCount}
                    </span>
                  )}
                  <button
                    aria-label="关闭搜索"
                    onClick={() => useUIStore.getState().setSearchOpen(false)}
                    className="shrink-0 rounded p-0.5 text-muted-foreground/70 hover:text-foreground"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              )}

              {page === "clipboard" ? (
                <ScrollArea className="min-h-0 flex-1 px-2">
                  {clipNotes.length === 0 ? (
                    <div className="flex flex-col items-center gap-2 px-6 pb-10 pt-16 text-center">
                      <ClipboardList className="size-6 text-muted-foreground/40" />
                      <p className="text-[13px] font-medium text-muted-foreground">
                        {!settings.clipHistory
                          ? "剪贴板历史未开启"
                          : q
                            ? `没有匹配「${q}」的记录`
                            : "还没有剪贴板记录"}
                      </p>
                      {!settings.clipHistory && (
                        <p className="text-[11px] leading-relaxed text-muted-foreground/70">
                          在 设置 → 通用 开启「剪贴板历史」后，
                          <br />
                          复制过的内容会自动收集到这里。
                        </p>
                      )}
                    </div>
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
                            <button
                              onClick={() => setClipShown((v) => v + 200)}
                              className="mx-auto mb-1 rounded-md px-3 py-1 text-[11px] text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
                            >
                              加载更多（还有 {clipNotes.length - clipShown} 条）
                            </button>
                          )}
                        </div>
                      </SortableContext>
                    </DndContext>
                  )}
                </ScrollArea>
              ) : (
              <ScrollArea className="min-h-0 flex-1 px-2">
                {!onboarding.done && <OnboardingCard />}
                {notes.length === 0 ? (
                  onboarding.done ? (
                    <EmptyState />
                  ) : null
                ) : matchCount === 0 && q ? (
                  <p className="px-4 py-10 text-center text-[12px] text-muted-foreground/60">
                    没有匹配「{q}」的卡片
                  </p>
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
                          className="mb-2 ml-2 flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground/60 hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
                        >
                          <Plus className="size-3" /> 新建分组
                        </button>
                      )}
                    </div>
                  </DndContext>
                )}
              </ScrollArea>
              )}

              <SelectionBar />
              {page === "notes" && <DraftInput />}
                      </>
                    )}
                  </motion.div>
                </AnimatePresence>
              </div>

              <PreviewOverlay />
              {showShortcuts && <ShortcutHelp />}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </TooltipProvider>
  );
}

function OnboardingCard() {
  const onboarding = useNotesStore((s) => s.settings.onboarding);
  const axOk = useUIStore((s) => s.permissionAx);

  const Step = ({ done, children }: { done: boolean; children: React.ReactNode }) => (
    <li className="flex items-start gap-1.5">
      {done ? (
        <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-500" />
      ) : (
        <Circle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/40" />
      )}
      <span className={cn("text-[11.5px] leading-relaxed", done && "text-muted-foreground line-through")}>
        {children}
      </span>
    </li>
  );

  return (
    <div className="mx-1 mb-2 mt-1 rounded-xl border border-black/10 bg-white/50 p-3 dark:border-white/10 dark:bg-white/[0.05]">
      <p className="mb-1.5 text-[12px] font-semibold">三步上手</p>
      <ul className="flex flex-col gap-1">
        <Step done={axOk}>在系统设置授权「辅助功能」</Step>
        <Step done={onboarding.captured}>
          去任意应用选中一段文字，连按两次{" "}
          <kbd className="rounded border border-black/10 bg-black/5 px-1 text-[10px] dark:border-white/15 dark:bg-white/10">
            ⇧
          </kbd>{" "}
          捕获
        </Step>
        <Step done={onboarding.sent}>勾选卡片，按 ⌘⏎ 发送回你的 AI 对话</Step>
      </ul>
    </div>
  );
}

const SHORTCUTS: [string, string][] = [
  ["⇧⇧", "捕获选中文本 / 呼出面板"],
  ["⌘← →", "切换顶部页签（⌃Tab 循环）"],
  ["↑ ↓", "移动焦点卡片"],
  ["Space", "全文预览（预览中 ↑↓ 切换）"],
  ["Enter", "编辑（预览内 ⌘⏎ 保存）"],
  ["x", "勾选 / 取消勾选"],
  ["⌘A", "全选可见卡片"],
  ["⌘⏎", "发送勾选到对话"],
  ["⌘1-9", "快发第 N 张卡（按住 ⌘ 看角标）"],
  ["⌘C", "复制勾选为列表"],
  ["⌘⌫", "删除焦点卡片"],
  ["⌘F", "搜索"],
  ["Esc", "逐层退出（预览→搜索→选择→面板）"],
];

/** 长按 ⌥ 弹出的快捷键速查层。 */
function ShortcutHelp() {
  return (
    <div className="absolute inset-x-3 bottom-3 z-50 rounded-xl border border-black/10 bg-white/95 p-3 shadow-2xl dark:border-white/10 dark:bg-zinc-900/95">
      <p className="mb-1.5 text-[11px] font-semibold text-muted-foreground">快捷键</p>
      <div className="grid grid-cols-1 gap-y-0.5">
        {SHORTCUTS.map(([key, desc]) => (
          <div key={key} className="flex items-center gap-2 text-[11px]">
            <kbd className="min-w-10 rounded border border-black/10 bg-black/5 px-1 py-0.5 text-center text-[10px] tabular-nums dark:border-white/15 dark:bg-white/10">
              {key}
            </kbd>
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
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px]",
        active
          ? "border-primary/50 bg-primary/10 font-medium text-foreground"
          : "border-transparent text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/5"
      )}
    >
      {children}
      {!!badge && (
        <span className="rounded-full bg-red-500/90 px-1.5 text-[9px] font-semibold leading-4 tabular-nums text-white">
          {badge}
        </span>
      )}
    </button>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-2 px-6 pb-10 pt-16 text-center">
      <p className="text-[13px] font-medium text-muted-foreground">还没有内容</p>
      <p className="text-[11px] leading-relaxed text-muted-foreground/70">
        在任意应用中选中文字后连按两次{" "}
        <kbd className="rounded border border-black/10 bg-black/5 px-1 py-0.5 text-[10px] dark:border-white/15 dark:bg-white/10">
          ⇧ Shift
        </kbd>{" "}
        即可捕获到这里；
        <br />
        也可以在下方直接记下想法或提示词。
      </p>
    </div>
  );
}
