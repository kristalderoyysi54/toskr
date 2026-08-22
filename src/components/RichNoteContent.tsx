import { useEffect, useRef } from "react";

import { useNoteImage } from "@/lib/media";
import {
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
}: {
  block: Extract<NoteContentBlock, { type: "image" }>;
  files: string[];
  index: number;
  previewSource?: ImagePreviewSource;
  editContext?: ImagePreviewEditContext;
  onOpen?: (files: string[], index: number) => void;
}) {
  const url = useNoteImage(block.file);
  const label = block.alt?.trim() || `图片 ${index + 1}`;
  return (
    <figure className="my-3">
      <button
        type="button"
        aria-label={`查看${label}`}
        onClick={() =>
          onOpen
            ? onOpen(files, index)
            : void api.quickLook(files, index, previewSource, editContext)
        }
        className={cn(
          "block w-full overflow-hidden rounded-lg border border-foreground/10 bg-black/[0.03] outline-none",
          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background dark:bg-white/[0.04]"
        )}
      >
        {url ? (
          <img
            src={url}
            alt={label}
            width={block.width}
            height={block.height}
            className="h-auto max-h-[70vh] w-full object-contain"
          />
        ) : (
          <span className="block h-28 w-full animate-pulse bg-black/5 dark:bg-white/5" />
        )}
      </button>
    </figure>
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
};

/**
 * 有序图文卡的无损编辑 seam：只开放现有文字块，图片作为不可移动锚点。
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
}: RichNoteTextEditorProps) {
  const firstTextRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => firstTextRef.current?.focus(), 30);
    return () => window.clearTimeout(timer);
  }, []);

  const imageFiles = blocks.flatMap((block) =>
    block.type === "image" ? [block.file] : []
  );
  let imageIndex = 0;
  let textIndex = 0;
  return (
    <div
      aria-label="图文文字编辑器"
      className="space-y-2 font-mono text-body leading-relaxed"
    >
      <p className="text-label text-muted-foreground">
        图片位置已锁定；点击图片可查看或打码
      </p>
      {blocks.map((block, index) => {
        if (block.type === "image") {
          const currentImage = imageIndex++;
          return (
            <RichImageBlock
              key={`image-${index}-${block.file}`}
              block={block}
              files={imageFiles}
              index={currentImage}
              previewSource={previewSource}
              editContext={editContext}
              onOpen={onOpenImage}
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
