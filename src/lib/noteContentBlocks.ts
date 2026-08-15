export type NoteContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      file: string;
      alt?: string;
      width?: number;
      height?: number;
    };

type NoteContentSource = {
  contentBlocks?: unknown;
  text?: unknown;
  imageFile?: unknown;
  attachments?: unknown;
  imageW?: unknown;
  imageH?: unknown;
};

export type NoteContentProjection = {
  contentBlocks: NoteContentBlock[];
  text: string;
  imageFiles: string[];
  imageFile?: string;
  attachments?: string[];
  imageW?: number;
  imageH?: number;
};

/** 旧扁平编辑器无法表达「图片之后仍有文字」；此形态必须走块级编辑。 */
export function hasOrderedRichLayout(
  blocks: readonly NoteContentBlock[] | null | undefined
): boolean {
  if (!blocks?.some((block) => block.type === "image")) return false;
  let sawImage = false;
  for (const block of blocks) {
    if (block.type === "image") sawImage = true;
    else if (sawImage) return true;
  }
  return false;
}

/**
 * 富卡编辑的唯一写入原语：只替换指定文字块，图片块及全部块顺序原样保留。
 * 空文字在草稿期允许存在，保存时再由 normalizeNoteContentBlocks 去除。
 */
export function replaceNoteTextBlockAt(
  blocks: readonly NoteContentBlock[],
  index: number,
  text: string
): NoteContentBlock[] {
  if (!Number.isInteger(index) || blocks[index]?.type !== "text") {
    throw new Error("只能编辑已有文字块");
  }
  return blocks.map((block, blockIndex) =>
    blockIndex === index ? { type: "text", text } : block
  );
}

function optionalDimension(
  value: unknown,
  field: "width" | "height"
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`contentBlocks.image.${field} 必须是正有限数字`);
  }
  return value;
}

/**
 * 富卡内容的唯一解码 seam。调用方只接收净化后的新对象，避免持久化输入中的
 * 未知字段、空文件名或坏尺寸继续流入 Store 与媒体生命周期。
 */
export function normalizeNoteContentBlocks(value: unknown): NoteContentBlock[] {
  if (!Array.isArray(value)) {
    throw new Error("note.contentBlocks 必须是数组");
  }
  return value.flatMap((entry): NoteContentBlock[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("note.contentBlocks 项必须是对象");
    }
    const block = entry as Record<string, unknown>;
    if (block.type === "text") {
      if (typeof block.text !== "string") {
        throw new Error("contentBlocks.text.text 必须是字符串");
      }
      // 空块不承载顺序或格式信息；空白块仍保留，可表达段落间隔。
      return block.text ? [{ type: "text", text: block.text }] : [];
    }
    if (block.type === "image") {
      if (typeof block.file !== "string" || !block.file) {
        throw new Error("contentBlocks.image.file 必须是非空字符串");
      }
      if (block.alt !== undefined && typeof block.alt !== "string") {
        throw new Error("contentBlocks.image.alt 必须是字符串");
      }
      const width = optionalDimension(block.width, "width");
      const height = optionalDimension(block.height, "height");
      return [
        {
          type: "image",
          file: block.file,
          ...(block.alt !== undefined ? { alt: block.alt } : {}),
          ...(width !== undefined ? { width } : {}),
          ...(height !== undefined ? { height } : {}),
        },
      ];
    }
    throw new Error(`note.contentBlocks.type 无效：${String(block.type)}`);
  });
}

function legacyContentBlocks(note: NoteContentSource): NoteContentBlock[] {
  const blocks: NoteContentBlock[] = [];
  if (typeof note.text === "string" && note.text) {
    blocks.push({ type: "text", text: note.text });
  }

  const rawFiles = [
    typeof note.imageFile === "string" ? note.imageFile : undefined,
    ...(Array.isArray(note.attachments) ? note.attachments : []),
  ];
  const seen = new Set<string>();
  for (const raw of rawFiles) {
    if (typeof raw !== "string" || !raw || seen.has(raw)) continue;
    seen.add(raw);
    const isMain = raw === note.imageFile;
    blocks.push({
      type: "image",
      file: raw,
      ...(isMain && typeof note.imageW === "number" && Number.isFinite(note.imageW) && note.imageW > 0
        ? { width: note.imageW }
        : {}),
      ...(isMain && typeof note.imageH === "number" && Number.isFinite(note.imageH) && note.imageH > 0
        ? { height: note.imageH }
        : {}),
    });
  }
  return blocks;
}

/**
 * 读取 Note 的权威块。新卡只信 contentBlocks；旧卡缺该字段时才从兼容投影
 * 确定性恢复为「正文在前、主图与附件在后」。
 */
export function noteContentBlocks(note: NoteContentSource): NoteContentBlock[] {
  return note.contentBlocks === undefined
    ? legacyContentBlocks(note)
    : normalizeNoteContentBlocks(note.contentBlocks);
}

/**
 * 文本兼容投影：图片不贡献文件名或 alt；相邻文本块之间稳定补一个换行。
 * 任一侧已有换行时不再叠加，并由左块的换行数量优先表达显式空行。
 */
export function textFromContentBlocks(
  blocks: readonly NoteContentBlock[]
): string {
  return projectBlockText(blocks).text;
}

/** 文字块在投影文本里的落点（不含块间补的换行）。 */
export interface TextBlockRange {
  /** 在原 blocks 数组中的下标（图片块不出现在结果里）。 */
  blockIndex: number;
  start: number;
  end: number;
}

/**
 * 各文字块在 textFromContentBlocks 投影里的区间。选词模式按图文顺序摆放
 * 键帽时，用它把整卡分词结果分派回各块——与投影同源，改拼接规则也不会漂移。
 */
export function textBlockRanges(
  blocks: readonly NoteContentBlock[]
): TextBlockRange[] {
  return projectBlockText(blocks).ranges;
}

function projectBlockText(blocks: readonly NoteContentBlock[]): {
  text: string;
  ranges: TextBlockRange[];
} {
  const ranges: TextBlockRange[] = [];
  let text = "";
  let seen = 0;
  blocks.forEach((block, blockIndex) => {
    if (block.type !== "text") return;
    // 首块原样落地；其后任一侧已有换行就不再叠加，都没有才补一个分隔换行
    let lead = "";
    let body = block.text;
    if (seen > 0) {
      if (text.endsWith("\n")) body = block.text.replace(/^\n+/, "");
      else if (!block.text.startsWith("\n")) lead = "\n";
    }
    seen += 1;
    ranges.push({
      blockIndex,
      start: text.length + lead.length,
      end: text.length + lead.length + body.length,
    });
    text += lead + body;
  });
  return { text, ranges };
}

/**
 * 一次生成全部旧字段，Store 的任何写操作都必须使用该结果，禁止分别修改
 * contentBlocks/text/imageFile/attachments 而制造双真源。
 */
export function projectNoteContent(value: unknown): NoteContentProjection {
  const contentBlocks = normalizeNoteContentBlocks(value);
  const imageBlocks = contentBlocks.filter(
    (block): block is Extract<NoteContentBlock, { type: "image" }> =>
      block.type === "image"
  );
  const imageFiles = [...new Set(imageBlocks.map((block) => block.file))];
  const firstImage = imageFiles[0];
  const firstImageBlock = imageBlocks.find((block) => block.file === firstImage);
  return {
    contentBlocks,
    text: textFromContentBlocks(contentBlocks),
    imageFiles,
    imageFile: firstImage,
    attachments: imageFiles.length > 1 ? imageFiles.slice(1) : undefined,
    imageW: firstImageBlock?.width,
    imageH: firstImageBlock?.height,
  };
}

/**
 * 旧纯文本编辑器的适配器：全文改动折叠为一个 text 块，图片仍按原块顺序
 * 保留；显式传 imageFiles 时以该附件顺序为准，并尽量继承已有图片元数据。
 */
export function replaceNoteTextProjection(
  currentValue: unknown,
  text: string,
  imageFiles?: readonly string[]
): NoteContentBlock[] {
  const current = normalizeNoteContentBlocks(currentValue);
  const currentImages = current.filter(
    (block): block is Extract<NoteContentBlock, { type: "image" }> =>
      block.type === "image"
  );
  const desiredFiles = imageFiles === undefined
    ? currentImages.map((block) => block.file)
    : [...new Set(imageFiles.filter(Boolean))];
  const metadata = new Map<string, Extract<NoteContentBlock, { type: "image" }>>();
  for (const block of currentImages) {
    if (!metadata.has(block.file)) metadata.set(block.file, block);
  }
  const images = desiredFiles.map((file) => metadata.get(file) ?? { type: "image" as const, file });

  if (!text) return images;
  const firstText = current.findIndex((block) => block.type === "text");
  const imagesBeforeText = firstText < 0
    ? 0
    : current.slice(0, firstText).filter((block) => block.type === "image").length;
  const insertAt = Math.min(imagesBeforeText, images.length);
  return [
    ...images.slice(0, insertAt),
    { type: "text", text },
    ...images.slice(insertAt),
  ];
}
