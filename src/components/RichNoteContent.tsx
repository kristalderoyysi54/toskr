import { useEffect, useRef, useState } from "react";
import { Maximize2, Send, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { useNoteImage } from "@/lib/media";
import type { TextSelection } from "@/lib/selectionFormat";
import {
  removeNoteContentBlockAt,
  replaceNoteTextBlockAt,
  type NoteContentBlock,
} from "@/lib/noteContentBlocks";
import {
  api,
  type ImagePreviewSource,
} from "@/lib/tauri";
import type { ImagePreviewEditContext } from "@/lib/imageEditor";
import { cn } from "@/lib/utils";

export function RichImageBlock({
  block,
  files,
  index,
  previewSource,
  editContext,
  onOpen,
  selected,
  onSelect,
}: {
  block: Extract<NoteContentBlock, { type: "image" }>;
  files: string[];
  index: number;
  previewSource?: ImagePreviewSource;
  editContext?: ImagePreviewEditContext;
  onOpen?: (files: string[], index: number) => void;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const url = useNoteImage(block.file);
  const label = block.alt?.trim() || `图片 ${index + 1}`;
  const open = () =>
    onOpen
      ? onOpen(files, index)
      : void api.quickLook(files, index, previewSource, editContext);
  return (
    <figure className="my-3 flex justify-center">
      <button
        type="button"
        aria-label={`${onSelect ? "选择" : "查看"}${label}`}
        title={onSelect ? "单击选中，双击查看" : "查看原图"}
        aria-pressed={onSelect ? selected : undefined}
        onClick={onSelect ?? open}
        onDoubleClick={onSelect ? open : undefined}
        className={cn(
          "inline-flex min-h-12 min-w-12 max-w-full items-center justify-center overflow-hidden rounded-lg",
          "border border-foreground/10 bg-black/[0.03] outline-none dark:bg-white/[0.04]",
          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
          selected && "border-primary/60 ring-2 ring-primary/45"
        )}
      >
        {url ? (
          <img
            src={url}
            alt={label}
            width={block.width}
            height={block.height}
            className="h-auto max-h-[70vh] max-w-full object-contain"
          />
        ) : (
          <span className="block h-28 w-48 max-w-full animate-pulse bg-black/5 dark:bg-white/5" />
        )}
      </button>
    </figure>
  );
}

/** 编辑态图片块：显示稳定边界和常驻操作，避免小图靠猜命中区域。 */
export function EditableRichImageBlock({
  block,
  files,
  imageIndex,
  blockIndex,
  previewSource,
  editContext,
  selected,
  onSelect,
  onOpen,
  onRemove,
  onSend,
  sendDisabledReason,
}: {
  block: Extract<NoteContentBlock, { type: "image" }>;
  files: string[];
  imageIndex: number;
  blockIndex: number;
  previewSource?: ImagePreviewSource;
  editContext?: ImagePreviewEditContext;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onRemove: () => void;
  onSend?: () => void;
  sendDisabledReason?: string | null;
}) {
  const number = imageIndex + 1;
  const label = block.alt?.trim() || `图片 ${number}`;
  return (
    <section
      data-rich-image-edit-block={blockIndex}
      data-selected={selected}
      className={cn(
        "rounded-xl border border-dashed border-foreground/15 bg-muted/15 p-2",
        selected && "border-primary/55 bg-primary/[0.04]"
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-label text-muted-foreground">图片 {number}</span>
        <div role="toolbar" aria-label={`图片 ${number} 操作`} className="flex gap-1">
          <IconButton label={`查看${label}`} size="xs" onClick={onOpen}>
            <Maximize2 />
          </IconButton>
          <IconButton
            label={`删除${label}`}
            size="xs"
            tone="danger"
            onClick={onRemove}
          >
            <Trash2 />
          </IconButton>
        </div>
      </div>
      <RichImageBlock
        block={block}
        files={files}
        index={imageIndex}
        previewSource={previewSource}
        editContext={editContext}
        onOpen={() => onOpen()}
        selected={selected}
        onSelect={onSelect}
      />
      {selected && onSend && (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={!!sendDisabledReason}
            title={
              sendDisabledReason
                ? `发送选中不可用：${sendDisabledReason}`
                : `只发送图片 ${number}`
            }
            onClick={onSend}
          >
            <Send />
            发送选中
          </Button>
        </div>
      )}
    </section>
  );
}

/** 按权威块顺序渲染富卡；有来源卡时图片预览可继续安全发送整卡。 */
export function RichNoteContent({
  blocks,
  previewSource,
  editContext,
}: {
  blocks: NoteContentBlock[];
  previewSource?: ImagePreviewSource;
  editContext?: ImagePreviewEditContext;
}) {
  const imageFiles = blocks.flatMap((block) =>
    block.type === "image" ? [block.file] : []
  );
  let imageIndex = 0;
  return (
    <div className="space-y-1 font-mono text-body leading-relaxed">
      {blocks.map((block, index) => {
        if (block.type === "text") {
          return (
            <p
              key={`text-${index}`}
              className="whitespace-pre-wrap [overflow-wrap:anywhere]"
            >
              {block.text}
            </p>
          );
        }
        const currentImage = imageIndex++;
        return (
          <RichImageBlock
            key={`image-${index}-${block.file}`}
            block={block}
            files={imageFiles}
            index={currentImage}
            previewSource={previewSource}
            editContext={editContext}
          />
        );
      })}
    </div>
  );
}

type RichNoteTextEditorProps = {
  blocks: NoteContentBlock[];
  previewSource?: ImagePreviewSource;
  editContext?: ImagePreviewEditContext;
  onOpenImage?: (files: string[], index: number) => void;
  onChange: (blocks: NoteContentBlock[]) => void;
  onSave: () => void;
  onCancel: () => void;
  onSendSelection?: (blocks: NoteContentBlock[]) => void;
  sendDisabledReason?: string | null;
  onSelectionActiveChange?: (active: boolean) => void;
  onTextSelectionChange?: (
    value: {
      text: string;
      selection: TextSelection;
      textarea: HTMLTextAreaElement;
    } | null
  ) => void;
};

/**
 * 图文混合卡的无损编辑 seam：文字按块编辑，图片保序且可在原位删除。
 * textarea 使用 defaultValue，避免 React 回写切断 WKWebView 原生撤销分组。
 */
export function RichNoteTextEditor({
  blocks,
  previewSource,
  editContext,
  onOpenImage,
  onChange,
  onSave,
  onCancel,
  onSendSelection,
  sendDisabledReason,
  onSelectionActiveChange,
  onTextSelectionChange,
}: RichNoteTextEditorProps) {
  const firstTextRef = useRef<HTMLTextAreaElement>(null);
  const selectionActiveChangeRef = useRef(onSelectionActiveChange);
  selectionActiveChangeRef.current = onSelectionActiveChange;
  const textSelectionChangeRef = useRef(onTextSelectionChange);
  textSelectionChangeRef.current = onTextSelectionChange;
  const [selectedImageBlock, setSelectedImageBlock] = useState<number | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => firstTextRef.current?.focus(), 30);
    selectionActiveChangeRef.current?.(false);
    textSelectionChangeRef.current?.(null);
    return () => {
      window.clearTimeout(timer);
      selectionActiveChangeRef.current?.(false);
      textSelectionChangeRef.current?.(null);
    };
  }, []);

  const imageFiles = blocks.flatMap((block) =>
    block.type === "image" ? [block.file] : []
  );
  const syncTextSelection = (textarea: HTMLTextAreaElement) => {
    const selection = {
      start: textarea.selectionStart,
      end: textarea.selectionEnd,
    };
    if (selection.start === selection.end) {
      onSelectionActiveChange?.(false);
      onTextSelectionChange?.(null);
      return;
    }
    setSelectedImageBlock(null);
    onSelectionActiveChange?.(true);
    onTextSelectionChange?.({
      text: textarea.value,
      selection,
      textarea,
    });
  };
  let imageIndex = 0;
  let textIndex = 0;
  return (
    <div
      aria-label="图文文字编辑器"
      className="space-y-2 font-mono text-body leading-relaxed"
    >
      <p className="text-label text-muted-foreground">
        图片位置已锁定；点图片选中，双击或点右上角查看；选中文字或图片后可发送选中
      </p>
      {blocks.map((block, index) => {
        if (block.type === "image") {
          const currentImage = imageIndex++;
          return (
            <EditableRichImageBlock
              key={`image-${index}-${block.file}`}
              block={block}
              files={imageFiles}
              imageIndex={currentImage}
              blockIndex={index}
              previewSource={previewSource}
              editContext={editContext}
              selected={selectedImageBlock === index}
              onSelect={() => {
                setSelectedImageBlock(index);
                onSelectionActiveChange?.(true);
                onTextSelectionChange?.(null);
              }}
              onOpen={() => onOpenImage?.(imageFiles, currentImage)}
              onRemove={() => {
                onChange(removeNoteContentBlockAt(blocks, index));
                setSelectedImageBlock(null);
                onSelectionActiveChange?.(false);
              }}
              onSend={onSendSelection ? () => onSendSelection([block]) : undefined}
              sendDisabledReason={sendDisabledReason}
            />
          );
        }
        const currentText = textIndex++;
        return (
          <textarea
            key={`text-${index}`}
            ref={currentText === 0 ? firstTextRef : undefined}
            aria-label={`文字段落 ${currentText + 1}`}
            defaultValue={block.text}
            rows={Math.min(12, Math.max(3, block.text.split("\n").length + 1))}
            onChange={(event) =>
              onChange(replaceNoteTextBlockAt(blocks, index, event.target.value))
            }
            onSelect={(event) => syncTextSelection(event.currentTarget)}
            onScroll={(event) => syncTextSelection(event.currentTarget)}
            onPointerDown={() => setSelectedImageBlock(null)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter" && event.metaKey) {
                event.preventDefault();
                onSave();
              } else if (event.key === "Escape") {
                event.preventDefault();
                onCancel();
              }
            }}
            className={cn(
              "min-h-20 w-full resize-y rounded-md border border-border bg-muted/30 p-2 outline-none",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
            )}
          />
        );
      })}
    </div>
  );
}
