import { useEffect, useMemo, useState } from "react";
import {
  AlarmClock,
  Check,
  ChevronRight,
  Copy,
  Crosshair,
  Hourglass,
  ListTodo,
  NotebookPen,
  RotateCcw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SlidingTabIndicator } from "@/components/ui/sliding-tab-indicator";
import { StripScroller } from "@/components/ui/strip-scroller";
import { WindowedListItem } from "@/components/WindowedListItem";
import { aiErrorTip, requestAi } from "@/lib/aiClient";
import { presetCfgDue, presetCfgLabel } from "@/lib/tasks";
import { api, type MessageSourceOverlayPayload } from "@/lib/tauri";
import { setPendingUndo, tip } from "@/lib/tip";
import { cn } from "@/lib/utils";
import {
  INBOX_ID,
  useNotesStore,
  type MessageItem,
} from "@/store/notesStore";

type Filter = "new" | "waiting" | "done";

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: "new", label: "待处理" },
  { value: "waiting", label: "等待回复" },
  { value: "done", label: "已处理" },
];

function displayTime(value: number): string {
  const date = new Date(value);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return new Intl.DateTimeFormat("zh-CN", {
    ...(sameDay ? {} : { month: "numeric", day: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function messageMatches(message: MessageItem, query: string): boolean {
  if (!query) return true;
  const value = [
    message.conversationName,
    message.conversationId,
    message.senderName,
    message.senderUid,
    message.text,
    ...message.context.flatMap((item) => [item.senderName, item.senderUid, item.text]),
  ]
    .filter(Boolean)
    .join("\n")
    .toLocaleLowerCase();
  return value.includes(query.toLocaleLowerCase());
}

function reasonLabels(message: MessageItem, ruleNames: Map<string, string>): string[] {
  return [
    ...(message.mentionedSelf ? ["@我"] : []),
    ...(message.followedSender ? ["特别关注"] : []),
    ...message.matchedRuleIds.map((id) => ruleNames.get(id) || "组合规则"),
  ];
}

function aiInput(message: MessageItem): string {
  const context = message.context.length
    ? message.context
        .map(
          (item) =>
            `${item.senderName || item.senderUid || "未知发送者"}：${item.text || `[${item.messageType || "非文本消息"}]`}`
        )
        .join("\n")
    : "（没有可用前文；不要自行补造背景）";
  return `群：${message.conversationName || message.conversationId}\n发送者：${message.senderName || message.senderUid || "未知"}\n\n捕获时已加载的前文：\n${context}\n\n需要回复的消息：\n${message.text || `[${message.messageType || "非文本消息"}]`}`;
}

export function MessagePage({
  query = "",
  horizontal = false,
}: {
  query?: string;
  /** 上/下横栏形态：卡片改横排瓷砖串（与剪贴/秘文横栏同款），正文卡内滚动。 */
  horizontal?: boolean;
}) {
  const messages = useNotesStore((state) => state.messages);
  const rules = useNotesStore((state) => state.settings.messageWatchRules);
  const duePresets = useNotesStore((state) => state.settings.duePresets);
  const [filter, setFilter] = useState<Filter>("new");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [checkedIds, setCheckedIds] = useState<ReadonlySet<string>>(new Set());
  const [anchorId, setAnchorId] = useState<string | null>(null);
  // 多选只在当前筛选视图内有意义：切页/改搜索即清空
  useEffect(() => {
    setCheckedIds(new Set());
    setAnchorId(null);
  }, [filter, query]);
  const ruleNames = useMemo(
    () => new Map(rules.map((rule) => [rule.id, rule.name] as const)),
    [rules]
  );
  const filtered = useMemo(
    () =>
      messages.filter(
        (message) =>
          (filter === "done"
            ? message.status === "done" || message.status === "archived"
            : message.status === filter) && messageMatches(message, query.trim())
      ),
    [filter, messages, query]
  );
  const counts = useMemo(
    () => ({
      new: messages.filter((message) => message.status === "new").length,
      waiting: messages.filter((message) => message.status === "waiting").length,
      done: messages.filter(
        (message) => message.status === "done" || message.status === "archived"
      ).length,
    }),
    [messages]
  );

  const draftReply = async (message: MessageItem) => {
    if (busyId) return;
    setBusyId(message.id);
    try {
      const input = aiInput(message);
      const scan = await api.scanSensitiveText(input);
      if (!scan.complete || scan.warnings.length) {
        tip("warn", "隐私检查未完整覆盖消息，未发送给 AI");
        return;
      }
      if (scan.findings.length) {
        tip("warn", `检测到 ${scan.findings.length} 处敏感信息，未发送给 AI`);
        return;
      }
      const draft = await requestAi({
        system:
          "你是工作沟通回复助手。基于用户给出的有限上下文，写一条简洁、可编辑的中文回复草稿。不得编造事实；信息不足时用澄清问题。只输出草稿，不要解释。",
        user: input,
        maxTokens: 500,
      });
      useNotesStore.getState().saveMessageAiDraft(message.id, draft);
      tip("ok", "回复草稿已生成；不会自动发送到IM");
    } catch (error) {
      tip("warn", aiErrorTip(error));
    } finally {
      setBusyId(null);
    }
  };

  const clearDone = () => {
    const store = useNotesStore.getState();
    const removed = store.messages.filter(
      (message) => message.status === "done" || message.status === "archived"
    );
    if (!removed.length) return;
    store.removeMessages(removed.map((message) => message.id));
    setPendingUndo(() => useNotesStore.getState().restoreMessages(removed));
    tip("ok", `已清空 ${removed.length} 条已处理消息`, true);
  };

  // 整卡多选（与剪贴/笔记卡同款 Finder 语义）：单击替换、⌘ 累加/移出、
  // Shift 锚点范围、再点唯一已选取消。选择集恒在单一筛选视图内，撤销一步还原。
  const checkedInView = filtered.filter((message) => checkedIds.has(message.id));
  const handleCardClick = (id: string) => (event: React.MouseEvent) => {
    // 卡内控件（悬浮钮/展开/前文/草稿操作）与文本划选不触发整卡选择
    if ((event.target as HTMLElement).closest("button, a, input")) return;
    if (window.getSelection()?.toString()) return;
    if (event.shiftKey && anchorId && anchorId !== id) {
      const ids = filtered.map((message) => message.id);
      const from = ids.indexOf(anchorId);
      const to = ids.indexOf(id);
      if (from >= 0 && to >= 0) {
        const [lo, hi] = from < to ? [from, to] : [to, from];
        setCheckedIds(new Set([...checkedIds, ...ids.slice(lo, hi + 1)]));
        return;
      }
    }
    setAnchorId(id);
    if (event.metaKey) {
      const next = new Set(checkedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setCheckedIds(next);
      return;
    }
    if (checkedIds.size === 1 && checkedIds.has(id)) {
      setCheckedIds(new Set());
      return;
    }
    setCheckedIds(new Set([id]));
  };
  const clearSelection = () => {
    setCheckedIds(new Set());
    setAnchorId(null);
  };
  const bulkDone = () => {
    const ids = checkedInView.map((message) => message.id);
    if (!ids.length) return;
    const prev = filter as "new" | "waiting";
    useNotesStore.getState().setMessagesStatus(ids, "done");
    clearSelection();
    setPendingUndo(() => useNotesStore.getState().setMessagesStatus(ids, prev));
    tip("ok", `已处理 ${ids.length} 条消息`, true);
  };
  const bulkRestore = () => {
    const ids = checkedInView.map((message) => message.id);
    if (!ids.length) return;
    useNotesStore.getState().setMessagesStatus(ids, "new");
    clearSelection();
    setPendingUndo(() => useNotesStore.getState().setMessagesStatus(ids, "done"));
    tip("ok", `已恢复 ${ids.length} 条为待处理`, true);
  };
  const bulkRemove = () => {
    const removed = checkedInView;
    if (!removed.length) return;
    useNotesStore.getState().removeMessages(removed.map((message) => message.id));
    clearSelection();
    setPendingUndo(() => useNotesStore.getState().restoreMessages(removed));
    tip("ok", `已删除 ${removed.length} 条消息`, true);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 选择态整行接管：批量条与筛选 tabs 同宽互斥（切页本会清空选择，
          并排放在 380px 内会把 tabs 挤到换行错位） */}
      {checkedInView.length > 0 ? (
        <div className="flex min-h-7 items-center px-4 pb-2 pt-1">
          <span className="tabular-nums text-label font-medium">
            已选 {checkedInView.length}
          </span>
          <div className="ml-auto flex items-center gap-1">
            {filter === "done" ? (
              <Button size="xs" onClick={bulkRestore}>
                <RotateCcw data-icon="inline-start" />恢复
              </Button>
            ) : (
              <Button size="xs" onClick={bulkDone}>
                <Check data-icon="inline-start" />已处理
              </Button>
            )}
            <IconButton label="删除所选消息" size="xs" tone="danger" onClick={bulkRemove}>
              <Trash2 />
            </IconButton>
            <IconButton label="取消选择" size="xs" onClick={clearSelection}>
              <X />
            </IconButton>
          </div>
        </div>
      ) : (
        <div className="flex min-h-7 items-center px-4 pb-2 pt-1">
          <div role="tablist" aria-label="消息状态" className="flex items-center gap-0.5">
            {FILTERS.map(({ value, label }) => (
              <button
                key={value}
                role="tab"
                aria-selected={filter === value}
                onClick={() => setFilter(value)}
                className={cn(
                  "relative rounded-md px-2 py-1 text-label outline-none transition-colors",
                  filter === value
                    ? "font-semibold text-foreground"
                    : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                )}
              >
                {filter === value && (
                  <SlidingTabIndicator layoutId="message-filter-thumb" variant="quiet" />
                )}
                <span className="relative z-10">
                  {label}
                  {counts[value] > 0 && (
                    <span className="ml-1 tabular-nums text-micro text-muted-foreground">
                      {counts[value]}
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
          {filter === "done" && counts.done > 0 && (
            <Button variant="ghost" size="xs" className="ml-auto" onClick={clearDone}>
              <Trash2 data-icon="inline-start" />清空
            </Button>
          )}
        </div>
      )}
      {horizontal ? (
        <StripScroller>
          {filtered.length ? (
            <div className="flex h-full items-stretch gap-2 px-3 pb-2 pt-0.5">
              {filtered.map((message) => (
                <MessageCard
                  key={message.id}
                  message={message}
                  reasons={reasonLabels(message, ruleNames)}
                  busy={busyId === message.id}
                  duePresets={duePresets}
                  onDraft={() => void draftReply(message)}
                  checked={checkedIds.has(message.id)}
                  onCardClick={handleCardClick(message.id)}
                  strip
                />
              ))}
            </div>
          ) : (
            <p className="px-4 py-6 text-body text-muted-foreground">
              {query ? `没有匹配「${query}」的消息` : emptyTitle(filter)}
            </p>
          )}
        </StripScroller>
      ) : (
        <ScrollArea className="min-h-0 flex-1 px-2.5" viewportClassName="px-1">
          {filtered.length ? (
            <div className="flex flex-col gap-1.5 pb-3 pt-0.5">
              {filtered.map((message, index) => (
                <WindowedListItem
                  key={message.id}
                  itemId={`message:${message.id}`}
                  estimatedHeight={160}
                  eager={index < 12}
                >
                  <MessageCard
                    message={message}
                    reasons={reasonLabels(message, ruleNames)}
                    busy={busyId === message.id}
                    duePresets={duePresets}
                    onDraft={() => void draftReply(message)}
                    checked={checkedIds.has(message.id)}
                    onCardClick={handleCardClick(message.id)}
                  />
                </WindowedListItem>
              ))}
            </div>
          ) : (
            <EmptyState
              title={query ? `没有匹配「${query}」的消息` : emptyTitle(filter)}
              hint={
                messages.length === 0
                  ? "开启只读监听后，@你、关注的人或组合规则命中的群消息会出现在这里。"
                  : undefined
              }
            />
          )}
        </ScrollArea>
      )}
    </div>
  );
}

function emptyTitle(filter: Filter): string {
  return filter === "new"
    ? "没有待处理消息"
    : filter === "waiting"
      ? "没有等待回复的消息"
      : "还没有已处理消息";
}

/** 个人触达信号（@我/特别关注）比规则命中更值得一眼看到。 */
const STRONG_REASONS = new Set(["@我", "特别关注"]);

function MessageCard({
  message,
  reasons,
  busy,
  duePresets,
  onDraft,
  checked = false,
  onCardClick,
  strip = false,
}: {
  message: MessageItem;
  reasons: string[];
  busy: boolean;
  duePresets: ReturnType<typeof useNotesStore.getState>["settings"]["duePresets"];
  onDraft: () => void;
  checked?: boolean;
  /** 整卡点击选择（Finder 语义在父层；卡内控件与文本划选已被父层过滤）。 */
  onCardClick?: (event: React.MouseEvent) => void;
  /** 横栏瓷砖形态：定宽、随栏高伸展，正文区内滚（不再折叠/展开）。 */
  strip?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [remindOpen, setRemindOpen] = useState(false);
  const body = message.text || `[${message.messageType || "非文本消息"}]`;
  const sender = message.senderName || message.senderUid || "未知发送者";
  const conversation = message.conversationName || message.conversationId;
  // 私聊会话名与发送者同名时不重复展示
  const showConversation = Boolean(conversation) && conversation !== sender;
  const done = message.status === "done" || message.status === "archived";
  const overlay: MessageSourceOverlayPayload = {
    sourceApp: message.sourceApp ?? "",
    sourceBundle: message.sourceBundle ?? "",
    conversationName: conversation,
    senderName: sender,
    text: body,
    reason: reasons.join(" · ") || "组合关注",
  };
  const convert = (
    mode: "task" | "reminder" | "waiting",
    dueAt?: number | null
  ) => {
    const result = useNotesStore.getState().messageToTask(message.id, mode, dueAt);
    if (result.result === "existing") tip("warn", "这条消息已经关联任务");
    else if (result.result === "added") {
      tip("ok", mode === "waiting" ? "已加入等待回复" : mode === "reminder" ? "已创建提醒" : "已转为任务");
    }
  };
  const markDone = () => {
    const prev = message.status;
    useNotesStore.getState().setMessageStatus(message.id, "done");
    setPendingUndo(() => useNotesStore.getState().setMessageStatus(message.id, prev));
    tip("ok", "已标记处理", true);
  };

  return (
    <article
      data-checked={checked || undefined}
      onClick={onCardClick}
      // Shift 点选做范围选择时按住 Shift 的 mousedown 会拉出文本选区，先掐掉
      onMouseDown={(event) => {
        if (event.shiftKey) event.preventDefault();
      }}
      className={cn(
        "group relative rounded-xl border border-foreground/10 bg-card/80 px-3 py-2.5 shadow-(--shadow-card) transition-[box-shadow] duration-(--duration-control)",
        !strip && "list-render-unit list-render-message",
        // 与剪贴/笔记卡同款选中语言：ring 光环 + 抬升（不用 border，不挤内容）
        checked && "ring-2 ring-primary/70 elevation-2",
        strip && "flex h-full w-72 shrink-0 flex-col"
      )}
    >
      {checked && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-[inherit] bg-primary/[0.1] dark:bg-primary/[0.16]"
        />
      )}
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 truncate text-title font-semibold">{sender}</span>
        {reasons.map((reason, index) => (
          <span
            key={`${reason}-${index}`}
            title={reason}
            className={cn(
              "surface-inset max-w-28 shrink-0 truncate rounded-sm px-1 py-px text-micro",
              STRONG_REASONS.has(reason)
                ? "font-medium text-foreground"
                : "text-muted-foreground"
            )}
          >
            {reason}
          </span>
        ))}
        <span className="ml-auto shrink-0 pl-1 text-micro tabular-nums text-muted-foreground">
          {displayTime(message.occurredAtMs ?? message.receivedAtMs)}
        </span>
      </div>
      {(showConversation || message.linkedTaskId) && (
        <div className="mt-px flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-micro text-muted-foreground">
            {showConversation ? conversation : null}
          </span>
          {message.linkedTaskId && (
            <span className="shrink-0 text-micro text-muted-foreground">已转任务</span>
          )}
        </div>
      )}

      {/* 瓷砖形态正文区内滚（含前文/草稿），竖排形态为普通文档流 */}
      <div className={cn(strip && "slim-scroll min-h-0 flex-1 overflow-y-auto")}>
      <p
        className={cn(
          "mt-1.5 whitespace-pre-wrap break-words text-body leading-relaxed",
          !expanded && !strip && "line-clamp-4"
        )}
      >
        {body}
      </p>
      {!strip && [...body].length > 120 && (
        <button
          className="mt-1 text-label text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "收起全文" : `展开全文 · ${[...body].length} 字`}
        </button>
      )}

      {message.context.length > 0 && (
        <div className="mt-1.5">
          <button
            className="flex items-center gap-1 text-label text-muted-foreground transition-colors hover:text-foreground"
            aria-expanded={contextOpen}
            onClick={() => setContextOpen((value) => !value)}
          >
            <ChevronRight
              className={cn(
                "size-3 transition-transform duration-(--duration-control) motion-reduce:transition-none",
                contextOpen && "rotate-90"
              )}
            />
            前文 · {message.context.length}
          </button>
          {contextOpen && (
            <div className="surface-inset mt-1.5 space-y-1.5 rounded-lg p-2">
              {message.context.map((item) => (
                <div key={item.messageId} className="text-label leading-relaxed">
                  <span className="font-medium">
                    {item.senderName || item.senderUid || "未知发送者"}
                  </span>
                  <span className="text-muted-foreground">：{item.text || `[${item.messageType || "非文本消息"}]`}</span>
                </div>
              ))}
              <p className="text-micro text-muted-foreground">
                仅来自捕获时客户端内存，不会补拉历史或改变已读。
              </p>
            </div>
          )}
        </div>
      )}

      {message.aiDraft && (
        <div className="surface-inset mt-2 rounded-lg p-2">
          <div className="mb-1 flex items-center gap-1 text-micro font-medium text-muted-foreground">
            <Sparkles className="size-3" /> AI 草稿
          </div>
          <p className="whitespace-pre-wrap break-words text-body leading-relaxed">{message.aiDraft}</p>
          <div className="mt-1 flex gap-1">
            <Button
              variant="ghost"
              size="xs"
              onClick={() => void api.copyText(message.aiDraft!).then(() => tip("ok", "草稿已复制"))}
            >
              <Copy data-icon="inline-start" />复制
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                useNotesStore.getState().addNote(message.aiDraft!, {
                  sectionId: INBOX_ID,
                  sourceApp: message.sourceApp,
                  sourceBundle: message.sourceBundle,
                });
                tip("ok", "草稿已保存为笔记");
              }}
            >
              <NotebookPen data-icon="inline-start" />存为笔记
            </Button>
          </div>
        </div>
      )}
      </div>

      {/* 悬停操作组：与笔记卡同语言（hover/键盘焦点显现；opacity 方案保 Tab 可达）。
          提醒弹层是 portal（焦点/hover 都不在卡内），开着时强制显形防触发钮凭空消失。 */}
      <div
        className={cn(
          "absolute bottom-1.5 right-1.5 flex gap-0.5",
          "pointer-events-none opacity-0 transition-opacity duration-(--duration-control) motion-reduce:transition-none",
          "group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100",
          (busy || remindOpen) && "pointer-events-auto opacity-100"
        )}
      >
        <IconButton
          label="在IM中定位该群（滚动会话列表并高亮；不打开会话）"
          size="xs"
          surface
          onClick={() =>
            void api
              .locateMessageSource(overlay)
              .catch((error) => tip("warn", String(error).slice(0, 60) || "定位失败"))
          }
        >
          <Crosshair />
        </IconButton>
        <IconButton
          label={busy ? "AI 草稿生成中…" : "生成 AI 回复草稿（仅保存，不自动发送）"}
          size="xs"
          surface
          disabled={busy}
          onClick={onDraft}
        >
          <Sparkles className={cn(busy && "animate-pulse")} />
        </IconButton>
        <IconButton label="转为任务" size="xs" surface onClick={() => convert("task")}>
          <ListTodo />
        </IconButton>
        {/* Radix Popover（portal + 自动避让）：卡片在列表顶/底时 SimpleMenu 的
            inline 弹层会被 ScrollArea 视口裁剪，portal 弹层不受任何祖先 overflow 影响 */}
        <Popover open={remindOpen} onOpenChange={setRemindOpen}>
          <PopoverTrigger asChild>
            <IconButton label="创建提醒" size="xs" surface>
              <AlarmClock />
            </IconButton>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="slim-scroll max-h-[var(--radix-popover-content-available-height)] w-40 gap-0 overflow-y-auto p-1.5"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <p className="px-2 py-1 text-micro font-medium text-muted-foreground">提醒时间</p>
            {duePresets.map((preset) => (
              <button
                key={preset.id}
                onClick={() => {
                  convert("reminder", presetCfgDue(preset, Date.now()));
                  setRemindOpen(false);
                }}
                className="w-full rounded-md px-2 py-1 text-left text-body hover:bg-black/5 dark:hover:bg-white/10"
              >
                {presetCfgLabel(preset)}
              </button>
            ))}
          </PopoverContent>
        </Popover>
        {message.status !== "waiting" && (
          <IconButton label="转入等待回复" size="xs" surface onClick={() => convert("waiting")}>
            <Hourglass />
          </IconButton>
        )}
        {done ? (
          <>
            <IconButton
              label="恢复为待处理"
              size="xs"
              surface
              onClick={() => {
                useNotesStore.getState().setMessageStatus(message.id, "new");
                tip("ok", "已恢复为待处理");
              }}
            >
              <RotateCcw />
            </IconButton>
            <IconButton
              label="删除这条消息（原始账本不受影响）"
              size="xs"
              surface
              tone="danger"
              onClick={() => {
                const snapshot = useNotesStore
                  .getState()
                  .messages.find((item) => item.id === message.id);
                if (!snapshot) return;
                useNotesStore.getState().removeMessages([message.id]);
                setPendingUndo(() =>
                  useNotesStore.getState().restoreMessages([snapshot])
                );
                tip("ok", "已删除这条消息", true);
              }}
            >
              <Trash2 />
            </IconButton>
          </>
        ) : (
          <IconButton label="标记已处理" size="xs" surface onClick={markDone}>
            <Check />
          </IconButton>
        )}
      </div>
    </article>
  );
}
