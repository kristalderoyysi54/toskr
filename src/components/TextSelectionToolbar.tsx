import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { Bold, Check, ChevronDown, Italic, Link2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { floatingSurface } from "@/components/ui/floating-surface";
import { IconButton } from "@/components/ui/icon-button";
import { Kbd } from "@/components/ui/kbd";
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
];

const formatLabel = (id: BlockSelectionFormat) =>
  BLOCK_FORMATS.find((item) => item.id === id)?.label ?? "文本";

export function TextSelectionToolbar({
  text,
  selection,
  onApply,
}: {
  text: string;
  selection: TextSelection;
  onApply: (edit: SelectionEdit) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const linkInputRef = useRef<HTMLInputElement>(null);
  const [formatOpen, setFormatOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [href, setHref] = useState("");
  const currentBlock = blockFormatAt(text, selection);
  const selectedText = text.slice(selection.start, selection.end);
  const canLink = !selectedText.includes("\n");
  const suggestedHref = useMemo(
    () => markdownHrefAtSelection(text, selection) ?? detectLink(selectedText) ?? "",
    [selectedText, selection, text]
  );

  const openLink = () => {
    if (!canLink) return;
    setFormatOpen(false);
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
    setFormatOpen(false);
    setLinkOpen(false);
  }, [selection.start, selection.end]);

  useEffect(() => {
    if (!formatOpen && !linkOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setFormatOpen(false);
        setLinkOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [formatOpen, linkOpen]);

  // WKWebView 的 button 不保证接管焦点；工具条挂载期间从窗口捕获快捷键最稳。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && (formatOpen || linkOpen)) {
        event.preventDefault();
        event.stopPropagation();
        setFormatOpen(false);
        setLinkOpen(false);
        return;
      }
      if (event.target instanceof HTMLInputElement) return;
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
      } else if (event.altKey && /^Digit[0-5]$/.test(event.code)) {
        event.preventDefault();
        const format = BLOCK_FORMATS[Number(event.code.slice(-1))]?.id;
        if (format) onApply(applyBlockFormat(text, selection, format));
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  });

  return (
    <div className="absolute bottom-3 left-1/2 z-30 -translate-x-1/2">
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
              "absolute bottom-full left-1/2 mb-1 flex w-64 -translate-x-1/2 items-center gap-1 rounded-lg p-1.5",
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
              className="h-7 min-w-0 flex-1 rounded-md border border-foreground/10 bg-background px-2 text-body outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-primary/50"
            />
            <Button type="submit" size="xs" disabled={!href.trim()}>
              应用
            </Button>
          </form>
        )}

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

        {formatOpen && (
          <div
            role="menu"
            aria-label="文字样式"
            className={cn(
              "absolute bottom-full right-0 mb-1 w-48 rounded-lg p-1",
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
                    setFormatOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-body outline-none",
                    "hover:bg-black/5 focus-visible:bg-black/5 focus-visible:ring-2 focus-visible:ring-primary/40 dark:hover:bg-white/10 dark:focus-visible:bg-white/10",
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
