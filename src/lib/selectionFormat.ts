export type TextSelection = Readonly<{ start: number; end: number }>;

export type InlineSelectionFormat = "bold" | "italic";
export type BlockSelectionFormat =
  | "paragraph"
  | "heading1"
  | "heading2"
  | "heading3"
  | "numbered-list"
  | "bullet-list"
  | "todo-list"
  | "code-block";

export type SelectionEdit = Readonly<{
  text: string;
  selection: TextSelection;
}>;

function normalizedSelection(text: string, selection: TextSelection): TextSelection {
  const start = Math.max(0, Math.min(selection.start, selection.end, text.length));
  const end = Math.max(start, Math.min(Math.max(selection.start, selection.end), text.length));
  return { start, end };
}

function starRunBefore(text: string, offset: number): number {
  let count = 0;
  for (let i = offset - 1; i >= 0 && text[i] === "*"; i -= 1) count += 1;
  return count;
}

function starRunAfter(text: string, offset: number): number {
  let count = 0;
  for (let i = offset; i < text.length && text[i] === "*"; i += 1) count += 1;
  return count;
}

function starRunAtStart(text: string): number {
  return starRunAfter(text, 0);
}

function starRunAtEnd(text: string): number {
  return starRunBefore(text, text.length);
}

function runHasFormat(run: number, format: InlineSelectionFormat): boolean {
  return format === "bold" ? run >= 2 : run % 2 === 1;
}

/** 整个链接标题被选中时，把 [标题](地址) 当作行内格式的透明外壳。 */
function inlineEnvelope(text: string, selection: TextSelection): TextSelection {
  if (text[selection.start - 1] !== "[" || text.slice(selection.end, selection.end + 2) !== "](") {
    return selection;
  }
  const linkEnd = text.indexOf(")", selection.end + 2);
  return linkEnd < 0
    ? selection
    : { start: selection.start - 1, end: linkEnd + 1 };
}

/** 当前选区是否已被对应 Markdown 星号包裹；兼容 ***粗斜体***。 */
export function hasInlineFormat(
  text: string,
  selection: TextSelection,
  format: InlineSelectionFormat
): boolean {
  const { start, end } = normalizedSelection(text, selection);
  if (start === end) return false;
  const selected = text.slice(start, end);
  const envelope = inlineEnvelope(text, { start, end });
  const internal =
    runHasFormat(starRunAtStart(selected), format) &&
    runHasFormat(starRunAtEnd(selected), format);
  const external =
    runHasFormat(starRunBefore(text, envelope.start), format) &&
    runHasFormat(starRunAfter(text, envelope.end), format);
  return internal || external;
}

/** 加粗/斜体切换；返回的新选区始终保留在原正文上，不选中 Markdown 标记。 */
export function toggleInlineFormat(
  text: string,
  selection: TextSelection,
  format: InlineSelectionFormat
): SelectionEdit {
  const { start, end } = normalizedSelection(text, selection);
  if (start === end) return { text, selection: { start, end } };

  const marker = format === "bold" ? "**" : "*";
  const removeCount = marker.length;
  const selected = text.slice(start, end);
  const envelope = inlineEnvelope(text, { start, end });
  const internal =
    runHasFormat(starRunAtStart(selected), format) &&
    runHasFormat(starRunAtEnd(selected), format);
  if (internal && selected.length > removeCount * 2) {
    const inner = selected.slice(removeCount, -removeCount);
    return {
      text: text.slice(0, start) + inner + text.slice(end),
      selection: { start, end: start + inner.length },
    };
  }

  const external =
    runHasFormat(starRunBefore(text, envelope.start), format) &&
    runHasFormat(starRunAfter(text, envelope.end), format);
  if (external) {
    return {
      text:
        text.slice(0, envelope.start - removeCount) +
        text.slice(envelope.start, envelope.end) +
        text.slice(envelope.end + removeCount),
      selection: { start: start - removeCount, end: end - removeCount },
    };
  }

  return {
    text:
      text.slice(0, envelope.start) +
      marker +
      text.slice(envelope.start, envelope.end) +
      marker +
      text.slice(envelope.end),
    selection: { start: start + marker.length, end: end + marker.length },
  };
}

/** 把选区包装成 Markdown 链接；已选中链接或链接标题时只替换地址。 */
export function applyMarkdownLink(
  text: string,
  selection: TextSelection,
  rawHref: string
): SelectionEdit {
  const { start, end } = normalizedSelection(text, selection);
  const href = rawHref.trim();
  const selected = text.slice(start, end);
  if (!href || !selected.trim() || selected.includes("\n")) {
    return { text, selection: { start, end } };
  }

  const wholeLink = /^\[([^\]\n]+)\]\(([^)\n]+)\)$/.exec(selected);
  if (wholeLink) {
    const label = wholeLink[1];
    const replacement = `[${label}](${href})`;
    return {
      text: text.slice(0, start) + replacement + text.slice(end),
      selection: { start: start + 1, end: start + 1 + label.length },
    };
  }

  if (text[start - 1] === "[" && text.slice(end, end + 2) === "](") {
    const linkEnd = text.indexOf(")", end + 2);
    if (linkEnd >= 0) {
      return {
        text: text.slice(0, end + 2) + href + text.slice(linkEnd),
        selection: { start, end },
      };
    }
  }

  const replacement = `[${selected}](${href})`;
  return {
    text: text.slice(0, start) + replacement + text.slice(end),
    selection: { start: start + 1, end: end + 1 },
  };
}

/** 选区已位于 Markdown 链接时提取当前地址，供链接编辑框回填。 */
export function markdownHrefAtSelection(
  text: string,
  selection: TextSelection
): string | undefined {
  const { start, end } = normalizedSelection(text, selection);
  const selected = text.slice(start, end);
  const wholeLink = /^\[[^\]\n]+\]\(([^)\n]+)\)$/.exec(selected);
  if (wholeLink) return wholeLink[1];
  if (text[start - 1] !== "[" || text.slice(end, end + 2) !== "](") return undefined;
  const linkEnd = text.indexOf(")", end + 2);
  return linkEnd < 0 ? undefined : text.slice(end + 2, linkEnd);
}

function selectedLineRange(text: string, selection: TextSelection): TextSelection {
  const { start, end } = normalizedSelection(text, selection);
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  if (end > start && text[end - 1] === "\n") {
    return { start: lineStart, end: end - 1 };
  }
  const nextBreak = text.indexOf("\n", end);
  return { start: lineStart, end: nextBreak < 0 ? text.length : nextBreak };
}

type FencedCodeBlock = Readonly<{
  start: number;
  end: number;
  contentStart: number;
  contentEnd: number;
}>;

/** 找出包围当前整行选区的 Markdown 围栏；关闭围栏必须与打开字符一致且等长或更长。 */
function fencedCodeBlockAt(
  text: string,
  selection: TextSelection
): FencedCodeBlock | null {
  const range = selectedLineRange(text, selection);
  let open:
    | { start: number; lineEnd: number; marker: "`" | "~"; length: number }
    | null = null;

  for (let lineStart = 0; lineStart <= text.length; ) {
    const nextBreak = text.indexOf("\n", lineStart);
    const lineEnd = nextBreak < 0 ? text.length : nextBreak;
    const line = text.slice(lineStart, lineEnd);
    const match = /^[\t ]{0,3}(`{3,}|~{3,})(.*)$/.exec(line);

    if (!open && match) {
      open = {
        start: lineStart,
        lineEnd,
        marker: match[1][0] as "`" | "~",
        length: match[1].length,
      };
    } else if (open && match) {
      const marker = match[1][0] as "`" | "~";
      const closes =
        marker === open.marker &&
        match[1].length >= open.length &&
        !match[2].trim();
      if (closes) {
        const contentStart = Math.min(text.length, open.lineEnd + 1);
        const contentEnd = Math.max(contentStart, lineStart - 1);
        const block = {
          start: open.start,
          end: lineEnd,
          contentStart,
          contentEnd,
        };
        const insideContent =
          range.start >= block.contentStart && range.end <= block.contentEnd;
        const coversBlock =
          range.start <= block.start && range.end >= block.end;
        if (insideContent || coversBlock) return block;
        open = null;
      }
    }

    if (nextBreak < 0) break;
    lineStart = nextBreak + 1;
  }
  return null;
}

function codeFenceFor(text: string): string {
  let longest = 0;
  for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

function stripSupportedBlockPrefix(line: string): { indent: string; body: string } {
  const indent = line.match(/^[\t ]*/)?.[0] ?? "";
  const body = line
    .slice(indent.length)
    // 核对清单前缀要整体剥（先于裸列表符，否则只剥掉 "-" 留下 "[ ]"）
    .replace(/^(?:#{1,6}|[-+*][\t ]+\[[ xX]\]|[-+*]|\d+[.)])[\t ]+/, "");
  return { indent, body };
}

/** 选区涉及的整行切换为正文/标题/列表/代码块，空行原样保留。 */
export function applyBlockFormat(
  text: string,
  selection: TextSelection,
  format: BlockSelectionFormat
): SelectionEdit {
  const existingCodeBlock = fencedCodeBlockAt(text, selection);
  if (format === "code-block") {
    if (existingCodeBlock) {
      return { text, selection: normalizedSelection(text, selection) };
    }
    const range = selectedLineRange(text, selection);
    const content = text.slice(range.start, range.end);
    const fence = codeFenceFor(content);
    const replacement = `${fence}\n${content}\n${fence}`;
    const contentStart = range.start + fence.length + 1;
    return {
      text: text.slice(0, range.start) + replacement + text.slice(range.end),
      selection: { start: contentStart, end: contentStart + content.length },
    };
  }

  let source = text;
  let sourceSelection = selection;
  if (existingCodeBlock) {
    const selectedRange = selectedLineRange(text, selection);
    const selectsContent =
      selectedRange.start === existingCodeBlock.contentStart &&
      selectedRange.end === existingCodeBlock.contentEnd;
    const selectsWholeBlock =
      selectedRange.start === existingCodeBlock.start &&
      selectedRange.end === existingCodeBlock.end;
    // 只在整段代码都被选中时转换，避免改动未选择的代码行。
    if (!selectsContent && !selectsWholeBlock) {
      return { text, selection: normalizedSelection(text, selection) };
    }
    const content = text.slice(
      existingCodeBlock.contentStart,
      existingCodeBlock.contentEnd
    );
    source =
      text.slice(0, existingCodeBlock.start) +
      content +
      text.slice(existingCodeBlock.end);
    sourceSelection = {
      start: existingCodeBlock.start,
      end: existingCodeBlock.start + content.length,
    };
  }

  const range = selectedLineRange(source, sourceSelection);
  const lines = source.slice(range.start, range.end).split("\n");
  let number = 0;
  const replacement = lines
    .map((line) => {
      if (!line.trim()) return line;
      const { indent, body } = stripSupportedBlockPrefix(line);
      if (format === "paragraph") return indent + body;
      if (format === "heading1") return `${indent}# ${body}`;
      if (format === "heading2") return `${indent}## ${body}`;
      if (format === "heading3") return `${indent}### ${body}`;
      if (format === "bullet-list") return `${indent}- ${body}`;
      if (format === "todo-list") return `${indent}- [ ] ${body}`;
      number += 1;
      return `${indent}${number}. ${body}`;
    })
    .join("\n");

  return {
    text: source.slice(0, range.start) + replacement + source.slice(range.end),
    selection: { start: range.start, end: range.start + replacement.length },
  };
}

/** 工具条“文本”按钮展示当前选区首个非空块的格式。 */
export function blockFormatAt(
  text: string,
  selection: TextSelection
): BlockSelectionFormat {
  if (fencedCodeBlockAt(text, selection)) return "code-block";
  const range = selectedLineRange(text, selection);
  const line = text
    .slice(range.start, range.end)
    .split("\n")
    .find((item) => item.trim());
  if (!line) return "paragraph";
  const body = line.trimStart();
  if (/^#\s/.test(body)) return "heading1";
  if (/^##\s/.test(body)) return "heading2";
  if (/^###\s/.test(body)) return "heading3";
  if (/^\d+[.)]\s/.test(body)) return "numbered-list";
  if (/^[-+*]\s+\[[ xX]\]\s/.test(body)) return "todo-list";
  if (/^[-+*]\s/.test(body)) return "bullet-list";
  return "paragraph";
}

/**
 * 把 Markdown 渲染态的 DOM 选区映射回原文。常见单词/短句可精确命中；
 * 重复文本按可见位置比例选最近一处，跨块且渲染后换行不同则安全返回 null。
 */
export function resolveSourceSelection(
  source: string,
  visibleText: string,
  visibleSelection: TextSelection
): TextSelection | null {
  const visible = normalizedSelection(visibleText, visibleSelection);
  let needle = visibleText.slice(visible.start, visible.end);
  let visibleStart = visible.start;
  if (!needle.trim()) return null;
  if (source === visibleText) return visible;

  if (!source.includes(needle)) {
    const leading = needle.length - needle.trimStart().length;
    needle = needle.trim();
    visibleStart += leading;
  }
  if (!needle || !source.includes(needle)) return null;

  const visibleSpan = Math.max(1, visibleText.length - needle.length);
  const sourceSpan = Math.max(0, source.length - needle.length);
  const expected = (visibleStart / visibleSpan) * sourceSpan;
  let start = source.indexOf(needle);
  for (let at = source.indexOf(needle, start + 1); at >= 0; at = source.indexOf(needle, at + 1)) {
    if (Math.abs(at - expected) < Math.abs(start - expected)) start = at;
  }
  return { start, end: start + needle.length };
}
