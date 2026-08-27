import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import {
  Bold,
  Check,
  ChevronDown,
  Copy,
  Italic,
  Link2,
  Send,
  VenetianMask,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { floatingSurface } from "@/components/ui/floating-surface";
import { IconButton } from "@/components/ui/icon-button";
import { Kbd } from "@/components/ui/kbd";
import {
  ALIAS_PRESET_CATEGORIES,
  suggestAliasCategory,
} from "@/lib/delivery/aliasEntities";
import { detectLink } from "@/lib/link";
import {
  applyBlockFormat,
  applyMarkdownLink,
  blockFormatAt,
  hasInlineFormat,
  markdownHrefAtSelection,
  toggleInlineFormat,
  type BlockSelectionFormat,
  type SelectionEdit,
  type TextSelection,
} from "@/lib/selectionFormat";
import { cn } from "@/lib/utils";

const BLOCK_FORMATS: ReadonlyArray<{
  id: BlockSelectionFormat;
  label: string;
  shortcut: string;
}> = [
  { id: "paragraph", label: "文本", shortcut: "⌥⌘0" },
  { id: "heading1", label: "标题 1", shortcut: "⌥⌘1" },
  { id: "heading2", label: "标题 2", shortcut: "⌥⌘2" },
  { id: "heading3", label: "标题 3", shortcut: "⌥⌘3" },
  { id: "numbered-list", label: "编号列表", shortcut: "⌥⌘4" },
  { id: "bullet-list", label: "项目符号列表", shortcut: "⌥⌘5" },
  { id: "todo-list", label: "核对清单", shortcut: "⌥⌘6" },
  { id: "code-block", label: "代码块", shortcut: "⌥⌘7" },
];

const formatLabel = (id: BlockSelectionFormat) =>
  BLOCK_FORMATS.find((item) => item.id === id)?.label ?? "文本";

/** 「文本」菜单展开态跨选区记忆：展开过的，下一次选中仍是展开（用户指定）。
 *  组件随选区消失而卸载，状态只能挂模块级。 */
let stickyFormatOpen = false;

export function TextSelectionToolbar({
  text,
  selection,
  onApply,
  onAddAlias,
  onSendSelection,
  onCopySelection,
  sendDisabledReason,
  readOnly = false,
  anchorStyle = null,
}: {
  text: string;
  selection: TextSelection;
  onApply: (edit: SelectionEdit) => void;
  /** 选区附近的绝对定位样式（left/top/transform）；null 回退窗口底部居中。 */
  anchorStyle?: React.CSSProperties | null;
  /** 传入即出现「加入词典」：把选中文字快速录为化名词条（原文可改、类别可换）。 */
  onAddAlias?: (originalText: string, category: string) => void;
  /** 传入即出现「发送选中」：只把选中片段发到当前目标（选词/选段模式的部分发送）。 */
  onSendSelection?: (selectedText: string) => void;
  /** 传入即出现「复制选中」。 */
  onCopySelection?: (selectedText: string) => void;
  /** 目标未就绪时的禁用原因；有值则发送按钮禁用并以此作提示。 */
  sendDisabledReason?: string | null;
  /** 只读来源（如合并预览）：隐藏改写类控件，仅保留词典等非改写操作。 */
  readOnly?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const outerRef = useRef<HTMLDivElement>(null);
  const linkInputRef = useRef<HTMLInputElement>(null);
  const aliasInputRef = useRef<HTMLInputElement>(null);
  const [formatOpen, setFormatOpenState] = useState(() => stickyFormatOpen && !readOnly);
  /** remember=false 的关闭只影响本次（如打开链接面板时让位），不改记忆。 */
  const setFormatOpen = (
    open: boolean | ((previous: boolean) => boolean),
    remember = true
  ) => {
    setFormatOpenState((previous) => {
      const next = typeof open === "function" ? open(previous) : open;
      if (remember) stickyFormatOpen = next;
      return next;
    });
  };
  const [linkOpen, setLinkOpen] = useState(false);
  const [href, setHref] = useState("");
  const [aliasOpen, setAliasOpen] = useState(false);
  const [aliasText, setAliasText] = useState("");
  const [aliasCategory, setAliasCategory] = useState(
    ALIAS_PRESET_CATEGORIES[0].code
  );
  const currentBlock = blockFormatAt(text, selection);
  const selectedText = text.slice(selection.start, selection.end);
  const canLink = !selectedText.includes("\n");
  // 工具条就近浮动后可能贴着窗顶：上方放不下时弹层向下翻，避免被窗口裁掉。
  // anchorStyle 必须在依赖里：展开态跨选区记忆下重新挂载时，首帧 anchorStyle
  // 尚为 null（底部居中，top 很大→判上弹），随后锚点到位跳到选区旁却不再重测，
  // 靠顶选区的菜单就会向上弹出窗顶（只见下半截）。锚点变化一律重测。
  const [popBelow, setPopBelow] = useState(false);
  useLayoutEffect(() => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    // token-exception: 310≈格式菜单全高估值（8 项），纯翻转判定非视觉样式
    setPopBelow(rect.top < 310);
  }, [formatOpen, linkOpen, aliasOpen, selection.start, selection.end, anchorStyle]);

  // 就近定位按实测宽度钳回容器：绝对定位的 shrink-to-fit 会在贴近右缘时把
  // 工具条压到竖排（外层已 w-max 定宽），这里再把 left 修到完整可见的位置。
  // 直接改 style 不走 state，避免测量→渲染回环。
  useLayoutEffect(() => {
    const el = outerRef.current;
    const parent = el?.offsetParent as HTMLElement | null;
    if (!el || !parent || !anchorStyle) return;
    const half = el.offsetWidth / 2;
    const desired = Number.parseFloat(String(anchorStyle.left ?? "0"));
    const clamped = Math.min(
      Math.max(desired, half + 6),
      Math.max(parent.clientWidth - half - 6, half + 6)
    );
    if (clamped !== desired) el.style.left = `${clamped}px`;
  }, [anchorStyle]);

  const openAlias = () => {
    setFormatOpen(false, false);
    setLinkOpen(false);
    setAliasText(selectedText.trim());
    setAliasCategory(suggestAliasCategory(selectedText));
    setAliasOpen(true);
    window.setTimeout(() => aliasInputRef.current?.focus(), 0);
  };

  const applyAlias = () => {
    const value = aliasText.trim();
    if (!value || !onAddAlias) return;
    onAddAlias(value, aliasCategory);
    setAliasOpen(false);
  };
  const suggestedHref = useMemo(
    () => markdownHrefAtSelection(text, selection) ?? detectLink(selectedText) ?? "",
    [selectedText, selection, text]
  );

  const openLink = () => {
    if (!canLink) return;
    setFormatOpen(false, false);
    setHref(suggestedHref);
    setLinkOpen(true);
    window.setTimeout(() => linkInputRef.current?.focus(), 0);
  };

  const applyLink = () => {
    if (!href.trim()) return;
    onApply(applyMarkdownLink(text, selection, href));
    setLinkOpen(false);
  };

  useEffect(() => {
    // 展开态跨选区记忆：上次展开的，换个选区仍然展开
    setFormatOpenState(stickyFormatOpen && !readOnly);
    setLinkOpen(false);
    setAliasOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.start, selection.end]);

  useEffect(() => {
    if (!formatOpen && !linkOpen && !aliasOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setFormatOpen(false);
        setLinkOpen(false);
        setAliasOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [aliasOpen, formatOpen, linkOpen]);

  // WKWebView 的 button 不保证接管焦点；工具条挂载期间从窗口捕获快捷键最稳。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && (formatOpen || linkOpen || aliasOpen)) {
        event.preventDefault();
        event.stopPropagation();
        setFormatOpen(false);
        setLinkOpen(false);
        setAliasOpen(false);
        return;
      }
      if (event.target instanceof HTMLInputElement) return;
      if (readOnly) return;
      if (!event.metaKey) return;
      const key = event.key.toLowerCase();
      if (!event.altKey && key === "b") {
        event.preventDefault();
        onApply(toggleInlineFormat(text, selection, "bold"));
      } else if (!event.altKey && key === "i") {
        event.preventDefault();
        onApply(toggleInlineFormat(text, selection, "italic"));
      } else if (!event.altKey && key === "k") {
        event.preventDefault();
        openLink();
      } else if (event.altKey && /^Digit[0-7]$/.test(event.code)) {
        event.preventDefault();
        const format = BLOCK_FORMATS[Number(event.code.slice(-1))]?.id;
        if (format) onApply(applyBlockFormat(text, selection, format));
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  });

  return (
    <div
      ref={outerRef}
      className={cn(
        // w-max：绝对定位贴近容器右缘时 shrink-to-fit 会把内容压成竖排
        "absolute z-40 w-max",
        !anchorStyle && "bottom-14 left-1/2 -translate-x-1/2"
      )}
      style={anchorStyle ?? undefined}
    >
      <motion.div
        ref={rootRef}
        role="toolbar"
        aria-label="文字格式"
        initial={{ opacity: 0, y: 4, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.12 }}
        onPointerDown={(event) => {
          if (!(event.target as Element).closest("input")) event.preventDefault();
        }}
        className={cn(
          "relative flex items-center gap-0.5 rounded-lg p-1 text-foreground",
          floatingSurface(2)
        )}
      >
        {linkOpen && (
          <form
            aria-label="添加链接"
            onSubmit={(event) => {
              event.preventDefault();
              applyLink();
            }}
            className={cn(
              "absolute left-1/2 flex w-64 -translate-x-1/2 items-center gap-1 rounded-lg p-1.5",
              popBelow ? "top-full mt-1" : "bottom-full mb-1",
              floatingSurface(2)
            )}
          >
            <input
              ref={linkInputRef}
              aria-label="链接地址"
              value={href}
              onChange={(event) => setHref(event.target.value)}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Escape") {
                  event.preventDefault();
                  setLinkOpen(false);
                }
              }}
              placeholder="粘贴链接地址"
              className="h-7 min-w-0 flex-1 rounded-md border border-foreground/10 bg-background px-2 text-body outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
            />
            <Button type="submit" size="xs" disabled={!href.trim()}>
              应用
            </Button>
          </form>
        )}

        {aliasOpen && (
          <form
            aria-label="加入化名词典"
            onSubmit={(event) => {
              event.preventDefault();
              applyAlias();
            }}
            className={cn(
              "absolute left-1/2 flex w-72 -translate-x-1/2 flex-col gap-1.5 rounded-lg p-1.5",
              popBelow ? "top-full mt-1" : "bottom-full mb-1",
              floatingSurface(2)
            )}
          >
            <input
              ref={aliasInputRef}
              aria-label="词条原文"
              value={aliasText}
              onChange={(event) => setAliasText(event.target.value)}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Escape") {
                  event.preventDefault();
                  setAliasOpen(false);
                }
              }}
              placeholder="要化名的原文（可修改）"
              className="h-7 min-w-0 rounded-md border border-foreground/10 bg-background px-2 text-body outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
            />
            <div className="flex items-center gap-1">
              <div
                role="radiogroup"
                aria-label="化名类别"
                className="flex min-w-0 flex-1 flex-wrap gap-1"
              >
                {ALIAS_PRESET_CATEGORIES.map((category) => (
                  <button
                    key={category.code}
                    type="button"
                    role="radio"
                    aria-checked={aliasCategory === category.code}
                    onClick={() => setAliasCategory(category.code)}
                    className={cn(
                      "rounded-md px-1.5 py-0.5 text-micro outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                      aliasCategory === category.code
                        ? "bg-primary/15 font-medium text-foreground"
                        : "bg-black/5 text-muted-foreground hover:text-foreground dark:bg-white/10"
                    )}
                  >
                    {category.label}
                  </button>
                ))}
              </div>
              <Button type="submit" size="xs" disabled={!aliasText.trim()}>
                加入
              </Button>
            </div>
          </form>
        )}

        {(onSendSelection || onCopySelection) && (
          <>
            {/* 工具条作用于「选中的那段」而非整卡——首次使用光看图标看不出来，
                所以左端常显选区字数，发送按钮也带上文字 */}
            <span className="px-1 text-micro tabular-nums text-muted-foreground">
              已选 {[...selectedText].length} 字
            </span>
            {onSendSelection && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                title={
                  sendDisabledReason
                    ? `发送选中不可用：${sendDisabledReason}`
                    : "只把选中片段发到当前目标"
                }
                disabled={!!sendDisabledReason || !selectedText.trim()}
                onClick={() => onSendSelection(selectedText)}
              >
                <Send />
                发送选中
              </Button>
            )}
            {onCopySelection && (
              <IconButton
                label="复制选中片段"
                disabled={!selectedText}
                stopPropagation={false}
                onClick={() => onCopySelection(selectedText)}
              >
                <Copy />
              </IconButton>
            )}
            {(onAddAlias || !readOnly) && (
              <div className="mx-0.5 h-4 w-px bg-foreground/10" />
            )}
          </>
        )}
        {onAddAlias && (
          <IconButton
            label="加入化名词典：发出自动替换，收回自动恢复"
            pressed={aliasOpen}
            stopPropagation={false}
            onClick={openAlias}
          >
            <VenetianMask />
          </IconButton>
        )}
        {!readOnly && (
          <>
            {onAddAlias && <div className="mx-0.5 h-4 w-px bg-foreground/10" />}
            <IconButton
              label={canLink ? "添加链接（⌘K）" : "链接不支持跨行选区"}
              pressed={linkOpen || !!markdownHrefAtSelection(text, selection)}
              disabled={!canLink}
              stopPropagation={false}
              onClick={openLink}
            >
              <Link2 />
            </IconButton>
            <IconButton
              label="粗体（⌘B）"
              pressed={hasInlineFormat(text, selection, "bold")}
              stopPropagation={false}
              onClick={() => onApply(toggleInlineFormat(text, selection, "bold"))}
            >
              <Bold />
            </IconButton>
            <IconButton
              label="斜体（⌘I）"
              pressed={hasInlineFormat(text, selection, "italic")}
              stopPropagation={false}
              onClick={() => onApply(toggleInlineFormat(text, selection, "italic"))}
            >
              <Italic />
            </IconButton>

            <div className="mx-0.5 h-4 w-px bg-foreground/10" />
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-haspopup="menu"
              aria-expanded={formatOpen}
              onClick={() => {
                setLinkOpen(false);
                setFormatOpen((open) => !open);
              }}
            >
              {formatLabel(currentBlock)}
              <ChevronDown className={cn("transition-transform", formatOpen && "rotate-180")} />
            </Button>
          </>
        )}

        {formatOpen && (
          <div
            role="menu"
            aria-label="文字样式"
            className={cn(
              "absolute right-0 w-48 rounded-lg p-1",
              popBelow ? "top-full mt-1" : "bottom-full mb-1",
              floatingSurface(2)
            )}
          >
            {BLOCK_FORMATS.map((item) => {
              const active = item.id === currentBlock;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  onClick={() => {
                    onApply(applyBlockFormat(text, selection, item.id));
                    setFormatOpen(false, false);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-body outline-none",
                    "hover:bg-black/5 focus-visible:bg-black/5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background dark:hover:bg-white/10 dark:focus-visible:bg-white/10",
                    active && "bg-black/5 dark:bg-white/10"
                  )}
                >
                  <span className="min-w-0 flex-1 font-medium">{item.label}</span>
                  {active && <Check className="size-3 text-primary" />}
                  <Kbd inline>{item.shortcut}</Kbd>
                </button>
              );
            })}
          </div>
        )}
      </motion.div>
    </div>
  );
}
