export type RichClipboardBlock =
  | { type: "text"; text: string }
  | { type: "imageRef"; index: number; alt?: string };

export interface ParsedRichClipboard {
  text: string;
  blocks: RichClipboardBlock[];
  imageSources: string[];
  omittedImageCount: number;
  /** 解析阶段被丢弃图片源的 scheme 标签（与 omittedImageCount 逐条对应），诊断用。 */
  omittedSchemes: string[];
}

export interface RichClipboardInput {
  html?: string | null;
  plainText?: string | null;
  sourceUrl?: string | null;
}

type ParsedTag = {
  name: string;
  closing: boolean;
  selfClosing: boolean;
  attributes: Map<string, string>;
};

const IGNORED_SUBTREES = new Set([
  "head",
  "noscript",
  "script",
  "style",
  "svg",
  "template",
]);

const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "dd",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "ul",
]);

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  emsp: " ",
  ensp: " ",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
  thinsp: " ",
};

/**
 * 将剪贴板 HTML 变成无行为的图文块描述。这里只扫描字符串：不挂 DOM、
 * 不执行脚本、不加载资源；图片字节解析与下载由 Native 层在后续显式完成。
 */
export function parseRichClipboard(input: RichClipboardInput): ParsedRichClipboard {
  const html = input.html ?? "";
  const imageSources: string[] = [];
  const imageIndexes = new Map<string, number>();
  const blocks: RichClipboardBlock[] = [];
  const ignoredStack: string[] = [];
  const omittedSchemes: string[] = [];
  const baseUrl = validHttpUrl(input.sourceUrl ?? "");

  let omittedImageCount = 0;
  let pendingText = "";
  let tableDepth = 0;
  let tableHasRow = false;
  let tableCellCount = 0;
  let tableCellDepth = 0;

  const append = (value: string) => {
    pendingText += value;
  };

  const appendBreak = () => {
    pendingText = appendSeparator(pendingText, "\n");
  };

  const appendTab = () => {
    pendingText = appendSeparator(pendingText, "\t");
  };

  const appendVisibleText = (raw: string) => {
    if (tableDepth > 0 && tableCellDepth === 0) return;
    const text = decodeHtmlEntities(raw).replace(/[\s\u00a0]+/gu, " ");
    if (text) append(text);
  };

  const flushTextBlock = () => {
    const text = normalizeText(pendingText);
    pendingText = "";
    if (!text) return;
    const previous = blocks.at(-1);
    if (previous?.type === "text") {
      previous.text = normalizeText(`${previous.text}\n${text}`);
    } else {
      blocks.push({ type: "text", text });
    }
  };

  const appendImage = (source: string, alt: string | undefined) => {
    let index = imageIndexes.get(source);
    if (index === undefined) {
      index = imageSources.length;
      imageSources.push(source);
      imageIndexes.set(source, index);
    }
    flushTextBlock();
    blocks.push({
      type: "imageRef",
      index,
      ...(alt ? { alt } : {}),
    });
  };

  scanHtml(html, {
    text(raw) {
      if (ignoredStack.length === 0) appendVisibleText(raw);
    },
    tag(tag) {
      const ignored = ignoredStack.at(-1);
      if (ignored) {
        if (tag.closing && tag.name === ignored) ignoredStack.pop();
        else if (!tag.closing && !tag.selfClosing && tag.name === ignored)
          ignoredStack.push(tag.name);
        return;
      }

      if (!tag.closing && IGNORED_SUBTREES.has(tag.name)) {
        if (!tag.selfClosing) ignoredStack.push(tag.name);
        return;
      }

      if (tag.name === "table") {
        if (tag.closing) {
          tableDepth = Math.max(0, tableDepth - 1);
          if (tableDepth === 0) {
            tableCellDepth = 0;
            appendBreak();
          }
        } else {
          if (tableDepth === 0) {
            appendBreak();
            tableHasRow = false;
            tableCellCount = 0;
            tableCellDepth = 0;
          }
          tableDepth += 1;
        }
        return;
      }

      if (tableDepth > 0) {
        if (tag.name === "tr") {
          if (tag.closing) return;
          if (tableHasRow) appendBreak();
          tableHasRow = true;
          tableCellCount = 0;
          tableCellDepth = 0;
          return;
        }
        if (tag.name === "td" || tag.name === "th") {
          if (tag.closing) {
            tableCellDepth = Math.max(0, tableCellDepth - 1);
          } else {
            if (tableCellCount > 0) appendTab();
            tableCellCount += 1;
            tableCellDepth += 1;
          }
          return;
        }
        if (tag.name === "br" || BLOCK_TAGS.has(tag.name)) {
          if (tableCellDepth > 0) append(" ");
          return;
        }
      }

      if (!tag.closing && tag.name === "img") {
        const source = normalizeImageSource(tag.attributes.get("src") ?? "", baseUrl);
        if (!source.ok) {
          omittedImageCount += 1;
          omittedSchemes.push(source.scheme);
          return;
        }
        const alt = normalizeInlineText(tag.attributes.get("alt") ?? "") || undefined;
        appendImage(source.source, alt);
        return;
      }

      if (tag.name === "br" || BLOCK_TAGS.has(tag.name)) appendBreak();
    },
  });

  flushTextBlock();
  const htmlText = textProjection(blocks);
  const fallbackText = normalizeText(input.plainText ?? "") || htmlText;

  if (imageSources.length === 0) {
    return {
      text: fallbackText,
      blocks: fallbackText ? [{ type: "text", text: fallbackText }] : [],
      imageSources,
      omittedImageCount,
      omittedSchemes,
    };
  }

  if (!htmlText && fallbackText) {
    blocks.unshift({ type: "text", text: fallbackText });
  }

  return {
    text: textProjection(blocks),
    blocks,
    imageSources,
    omittedImageCount,
    omittedSchemes,
  };
}

function textProjection(blocks: readonly RichClipboardBlock[]): string {
  return normalizeText(
    blocks
      .filter((block): block is Extract<RichClipboardBlock, { type: "text" }> =>
        block.type === "text"
      )
      .map((block) => block.text)
      .join("\n")
  );
}

function scanHtml(
  html: string,
  visitor: { text: (value: string) => void; tag: (tag: ParsedTag) => void }
) {
  let cursor = 0;
  while (cursor < html.length) {
    const open = html.indexOf("<", cursor);
    if (open < 0) {
      visitor.text(html.slice(cursor));
      return;
    }
    if (open > cursor) visitor.text(html.slice(cursor, open));

    if (html.startsWith("<!--", open)) {
      const commentEnd = html.indexOf("-->", open + 4);
      cursor = commentEnd < 0 ? html.length : commentEnd + 3;
      continue;
    }

    const close = findTagEnd(html, open + 1);
    if (close < 0) {
      visitor.text(html.slice(open));
      return;
    }
    const tag = parseTag(html.slice(open + 1, close));
    if (tag) visitor.tag(tag);
    cursor = close + 1;
  }
}

function findTagEnd(html: string, from: number): number {
  let quote = "";
  for (let index = from; index < html.length; index += 1) {
    const char = html[index];
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return index;
    }
  }
  return -1;
}

function parseTag(source: string): ParsedTag | null {
  let cursor = 0;
  while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
  if (source[cursor] === "!" || source[cursor] === "?") return null;

  const closing = source[cursor] === "/";
  if (closing) cursor += 1;
  while (/\s/u.test(source[cursor] ?? "")) cursor += 1;

  const nameStart = cursor;
  while (/[A-Za-z0-9:-]/u.test(source[cursor] ?? "")) cursor += 1;
  if (cursor === nameStart) return null;

  const name = source.slice(nameStart, cursor).toLowerCase();
  const selfClosing = /\/\s*$/u.test(source);
  const attributeSource = selfClosing
    ? source.slice(cursor).replace(/\/\s*$/u, "")
    : source.slice(cursor);
  return {
    name,
    closing,
    selfClosing,
    attributes: closing ? new Map() : parseAttributes(attributeSource),
  };
}

function parseAttributes(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  let cursor = 0;

  while (cursor < source.length) {
    while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
    if (cursor >= source.length || source[cursor] === "/") break;

    const nameStart = cursor;
    while (cursor < source.length && !/[\s=/]/u.test(source[cursor])) cursor += 1;
    const name = source.slice(nameStart, cursor).toLowerCase();
    if (!name) {
      cursor += 1;
      continue;
    }

    while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
    let value = "";
    if (source[cursor] === "=") {
      cursor += 1;
      while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
      const quote = source[cursor];
      if (quote === '"' || quote === "'") {
        cursor += 1;
        const valueStart = cursor;
        while (cursor < source.length && source[cursor] !== quote) cursor += 1;
        value = source.slice(valueStart, cursor);
        if (source[cursor] === quote) cursor += 1;
      } else {
        const valueStart = cursor;
        while (cursor < source.length && !/\s/u.test(source[cursor])) cursor += 1;
        value = source.slice(valueStart, cursor);
      }
    }
    if (!attributes.has(name)) attributes.set(name, decodeHtmlEntities(value));
  }

  return attributes;
}

type NormalizedImageSource =
  | { ok: true; source: string }
  | { ok: false; scheme: string };

function normalizeImageSource(
  value: string,
  baseUrl: URL | null
): NormalizedImageSource {
  const source = value.trim();
  if (!source) return { ok: false, scheme: "empty" };

  const data = /^data:image\/(png|jpe?g|gif|webp|bmp);base64,(.*)$/isu.exec(source);
  if (data) {
    const payload = data[2].replace(/\s+/gu, "");
    if (!payload || !/^[A-Za-z0-9+/]*={0,2}$/u.test(payload)) {
      return { ok: false, scheme: "data" };
    }
    return {
      ok: true,
      source: `data:image/${data[1].toLowerCase()};base64,${payload}`,
    };
  }
  if (/^data:/iu.test(source)) {
    const mime = /^data:([^;,]*)/iu.exec(source)?.[1].toLowerCase() ?? "";
    return { ok: false, scheme: mime ? `data:${mime}` : "data" };
  }

  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch {
    if (!baseUrl) return { ok: false, scheme: "relative" };
    try {
      parsed = new URL(source, baseUrl);
    } catch {
      return { ok: false, scheme: "relative" };
    }
  }

  // IM/本地应用复制的 HTML 常引用自身缓存文件；解析层放行，
  // 读取策略（网页来源拒绝、缓存根白名单、解码闸门）由 Native 层把守。
  if (parsed.protocol === "file:") {
    if (parsed.hostname && parsed.hostname !== "localhost") {
      return { ok: false, scheme: "file-host" };
    }
    const path = safeDecodeURIComponent(parsed.pathname).toLowerCase();
    if (path.endsWith(".svg") || path.endsWith(".svgz")) {
      return { ok: false, scheme: "svg" };
    }
    return { ok: true, source: parsed.href };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, scheme: parsed.protocol.replace(/:$/u, "") };
  }

  const path = safeDecodeURIComponent(parsed.pathname).toLowerCase();
  if (path.endsWith(".svg") || path.endsWith(".svgz")) {
    return { ok: false, scheme: "svg" };
  }
  return { ok: true, source: parsed.href };
}

function validHttpUrl(value: string): URL | null {
  if (!value.trim()) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeInlineText(value: string): string {
  return value.replace(/[\s\u00a0]+/gu, " ").trim();
}

function normalizeText(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/\u00a0/gu, " ")
    .replace(/[^\S\n\t]+/gu, " ")
    .replace(/ *\t */gu, "\t")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function appendSeparator(value: string, separator: "\n" | "\t"): string {
  const trimmed = value.replace(/ +$/u, "");
  if (separator === "\n" && trimmed.endsWith("\n")) return trimmed;
  return `${trimmed}${separator}`;
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#(?:x[0-9a-f]+|[0-9]+)|[a-z]+);/giu, (entity, body: string) => {
    if (body[0] !== "#") return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
    const hex = body[1]?.toLowerCase() === "x";
    const number = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (!Number.isFinite(number) || number <= 0 || number > 0x10ffff) return "�";
    if (number >= 0xd800 && number <= 0xdfff) return "�";
    return String.fromCodePoint(number);
  });
}
