import {
  parseRichClipboard,
  type RichClipboardBlock,
} from "@/lib/richClipboard";
import { api, type LocalizedRichImage } from "@/lib/tauri";
import {
  textFromContentBlocks,
  type NoteContentBlock,
} from "@/lib/noteContentBlocks";
import {
  restoreAliases,
  type AliasEntity,
} from "@/lib/delivery/aliasEntities";

export interface RichCaptureInput {
  plainText: string;
  html?: string | null;
  sourceUrl?: string | null;
}

export interface MaterializedRichCapture {
  text: string;
  contentBlocks: NoteContentBlock[];
  omittedImageCount: number;
}

export interface RestoredRichCapture extends MaterializedRichCapture {
  restoredCount: number;
}

type ImageLocalizer = (
  sources: string[],
  sourceUrl?: string | null
) => Promise<LocalizedRichImage[]>;

function materializeBlocks(
  blocks: RichClipboardBlock[],
  localized: LocalizedRichImage[]
): { blocks: NoteContentBlock[]; failed: number } {
  const byIndex = new Map(localized.map((image) => [image.index, image]));
  let failed = 0;
  const result = blocks.flatMap((block): NoteContentBlock[] => {
    if (block.type === "text") return [{ type: "text", text: block.text }];
    const image = byIndex.get(block.index);
    if (!image?.ok || !image.file) {
      failed += 1;
      return [];
    }
    return [{
      type: "image",
      file: image.file,
      ...(block.alt ? { alt: block.alt } : {}),
      ...(image.width ? { width: image.width } : {}),
      ...(image.height ? { height: image.height } : {}),
    }];
  });
  return { blocks: result, failed };
}

/**
 * 把同一次 pasteboard 快照物化为本地有序块。HTML 只在本地做无行为扫描；
 * Native 返回的失败项不携带原 URL，失败图片从卡中省略并单独计数。
 */
export async function materializeRichCapture(
  input: RichCaptureInput,
  localize: ImageLocalizer = api.localizeRichClipboardImages
): Promise<MaterializedRichCapture> {
  const parsed = parseRichClipboard(input);
  if (!parsed.imageSources.length) {
    return {
      text: parsed.text,
      contentBlocks: parsed.blocks.flatMap((block): NoteContentBlock[] =>
        block.type === "text" ? [{ type: "text", text: block.text }] : []
      ),
      omittedImageCount: parsed.omittedImageCount,
    };
  }

  const localized = await localize(parsed.imageSources, input.sourceUrl);
  const materialized = materializeBlocks(parsed.blocks, localized);
  const contentBlocks = materialized.blocks;
  return {
    text: textFromContentBlocks(contentBlocks),
    contentBlocks,
    omittedImageCount: parsed.omittedImageCount + materialized.failed,
  };
}

/**
 * 逐个恢复文字块中的本机化名，图片块及其相对顺序保持不变。
 * 不能只恢复 plainText：contentBlocks 是富卡的权威内容。
 */
export function restoreRichCaptureAliases(
  capture: MaterializedRichCapture,
  dictionary: readonly AliasEntity[]
): RestoredRichCapture {
  let restoredCount = 0;
  const contentBlocks = capture.contentBlocks.map((block): NoteContentBlock => {
    if (block.type === "image") return block;
    const restored = restoreAliases(block.text, dictionary);
    restoredCount += restored.restoredCount;
    return { type: "text", text: restored.text };
  });
  return {
    ...capture,
    text: textFromContentBlocks(contentBlocks),
    contentBlocks,
    restoredCount,
  };
}
