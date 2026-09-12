import DOMPurify from "dompurify";
import hljs from "highlight.js";
import { marked, Renderer, type Token, type Tokens } from "marked";

export { looksLikeMarkdown } from "@/lib/markdownDetection";

function inlinePlainText(tokens: readonly Token[]): string {
  return tokens.map((token) => {
    switch (token.type) {
      case "text": {
        const value = token as Tokens.Text;
        return value.tokens?.length
          ? inlinePlainText(value.tokens)
          : value.text;
      }
      case "escape":
      case "codespan":
        return (token as Tokens.Escape | Tokens.Codespan).text;
      case "strong":
      case "em":
      case "del": {
        const value = token as Tokens.Strong | Tokens.Em | Tokens.Del;
        return inlinePlainText(value.tokens);
      }
      case "link": {
        const value = token as Tokens.Link;
        const label = inlinePlainText(value.tokens).trim();
        const href = value.href.trim();
        if (
          !href ||
          value.raw === label ||
          href === label ||
          href === `mailto:${label}`
        ) {
          return label || href;
        }
        return label ? `${label}（${href}）` : href;
      }
      case "image": {
        const value = token as Tokens.Image;
        const label = inlinePlainText(value.tokens).trim() || "图片";
        const href = value.href.trim();
        return href ? `图片：${label}（${href}）` : `图片：${label}`;
      }
      case "br":
        return "\n";
      case "html":
        return stripHtmlMarkup((token as Tokens.HTML).text);
      default: {
        const value = token as Tokens.Generic;
        return value.tokens?.length
          ? inlinePlainText(value.tokens)
          : typeof value.text === "string" ? value.text : "";
      }
    }
  }).join("");
}

function stripHtmlMarkup(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:address|article|blockquote|div|h[1-6]|li|p|section)>/gi, "\n")
    .replace(/<[^>]*>/g, "");
}

function listPlainText(token: Tokens.List, depth: number): string {
  const start = typeof token.start === "number" ? token.start : 1;
  return token.items.map((item, index) => {
    const nested = item.tokens.filter(
      (child): child is Tokens.List => child.type === "list"
    );
    const body = blocksPlainText(
      item.tokens.filter((child) => child.type !== "list" && child.type !== "checkbox"),
      depth
    ).trim();
    const checkbox = item.task ? `${item.checked ? "☒" : "☐"} ` : "";
    const marker = token.ordered ? `${start + index}. ` : "• ";
    const indent = "  ".repeat(depth);
    const continuation = `${indent}  `;
    const line = `${indent}${marker}${checkbox}${body.replace(/\n/g, `\n${continuation}`)}`.trimEnd();
    const children = nested.map((child) => listPlainText(child, depth + 1)).join("\n");
    return children ? `${line}\n${children}` : line;
  }).join("\n");
}

function blockPlainText(token: Token, depth: number): string {
  switch (token.type) {
    case "space":
    case "def":
    case "hr":
      return "";
    case "heading":
    case "paragraph": {
      const value = token as Tokens.Heading | Tokens.Paragraph;
      return inlinePlainText(value.tokens);
    }
    case "text": {
      const value = token as Tokens.Text;
      return value.tokens?.length
        ? inlinePlainText(value.tokens)
        : value.text;
    }
    case "blockquote":
      return blocksPlainText((token as Tokens.Blockquote).tokens, depth);
    case "code":
      return (token as Tokens.Code).text;
    case "list":
      return listPlainText(token as Tokens.List, depth);
    case "table": {
      const value = token as Tokens.Table;
      return [value.header, ...value.rows]
        .map((row) => row.map((cell) => inlinePlainText(cell.tokens)).join("\t"))
        .join("\n");
    }
    case "html":
      return stripHtmlMarkup((token as Tokens.HTML).text);
    default: {
      const value = token as Tokens.Generic;
      return value.tokens?.length
        ? inlinePlainText(value.tokens)
        : typeof value.text === "string" ? value.text : "";
    }
  }
}

function blocksPlainText(tokens: readonly Token[], depth = 0): string {
  return tokens
    .map((token) => blockPlainText(token, depth).trimEnd())
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Markdown → 可直接粘贴的纯文本。只删除表示层语法，并用普通字符保留列表、
 * 任务状态、链接地址与表格结构；不依赖 DOM，可在发送纯构建器里安全复用。
 */
export function markdownToPlainText(text: string): string {
  if (!text) return "";
  return blocksPlainText(marked.lexer(text))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

marked.setOptions({ gfm: true, breaks: true });

/** 同一次词法解析同时决定哪些 checkbox 可交互以及它们在原文中的位置。 */
export function parseMarkdownTasks(text: string) {
  const offsets: number[] = [];
  let normalized = "";
  for (let i = 0; i < text.length; i++) {
    offsets.push(i);
    normalized += text[i] === "\r" ? "\n" : text[i];
    if (text[i] === "\r" && text[i + 1] === "\n") i++;
  }
  const tokens = marked.lexer(normalized);
  const positions: number[] = [];
  const indices = new Map<Tokens.Checkbox, number>();

  // marked 在引用/列表内移除每行的前缀。按行尾映射回父源码，不猜测代码围栏。
  // 遇到无法无损映射的语法时保留渲染、关闭该区域的修改，避免改错原文。
  function childOffsets(raw: string, sourceOffsets: number[], child: string): number[] | null {
    const lines = raw.split("\n");
    const childLines = child.split("\n");
    while (lines.length > childLines.length && lines.at(-1) === "") lines.pop();
    if (lines.length !== childLines.length) return null;
    const result: number[] = [];
    let start = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].endsWith(childLines[i])) return null;
      const prefix = lines[i].length - childLines[i].length;
      for (let at = start + prefix; at < start + lines[i].length; at++) {
        result.push(sourceOffsets[at]);
      }
      if (i < lines.length - 1) result.push(sourceOffsets[start + lines[i].length]);
      start += lines[i].length + 1;
    }
    return result;
  }

  function visit(items: readonly Token[], source: string, sourceOffsets: number[]) {
    let cursor = 0;
    for (const token of items) {
      // 松散任务列表的首段 raw 含 marked 补回的 checkbox，item.text 不含它。
      const firstInline = token.type === "paragraph" ? (token as Tokens.Paragraph).tokens[0] : undefined;
      const raw = firstInline?.type === "checkbox" && token.raw.startsWith(firstInline.raw)
        ? token.raw.slice(firstInline.raw.length)
        : token.raw;
      const start = source.indexOf(raw, cursor);
      if (start < 0) continue;
      cursor = start + raw.length;
      const mapped = sourceOffsets.slice(start, cursor);
      if (token.type === "blockquote") {
        const quote = token as Tokens.Blockquote;
        const child = childOffsets(token.raw, mapped, quote.text);
        if (child) visit(quote.tokens, quote.text, child);
      } else if (token.type === "list") {
        visit((token as Tokens.List).items, token.raw, mapped);
      } else if (token.type === "list_item") {
        const item = token as Tokens.ListItem;
        const match = /^[ \t]*(?:[-+*]|\d+[.)])[ \t]+\[([ xX])\]/.exec(item.raw);
        const first = item.tokens[0];
        const checkbox = first?.type === "checkbox"
          ? first as Tokens.Checkbox
          : first?.type === "paragraph"
            ? (first as Tokens.Paragraph).tokens.find((child): child is Tokens.Checkbox => child.type === "checkbox")
            : undefined;
        if (item.task && checkbox && match) {
          indices.set(checkbox, positions.length);
          positions.push(mapped[match[0].length - 2]);
        }
        const child = childOffsets(item.raw, mapped, item.text);
        if (child) visit(item.tokens.filter((entry) => entry.type !== "checkbox"), item.text, child);
      }
    }
  }
  visit(tokens, normalized, offsets);
  return { tokens, positions, indices };
}

/** Markdown → 安全 HTML（代码块接 highlight.js；本地内容仍必须 sanitize）。 */
export function renderMarkdown(text: string): string {
  const { tokens, indices } = parseMarkdownTasks(text);
  const renderer = new Renderer();
  // 原始 HTML 可能自带 input；只有本次 renderer 生成的 checkbox 能成为任务控件。
  const taskMarker = globalThis.crypto.randomUUID();
  renderer.checkbox = (token) => {
    const index = indices.get(token);
    return `<input type="checkbox" disabled${token.checked ? " checked" : ""} data-task-marker="${taskMarker}:${index ?? -1}">`;
  };
  const raw = marked.parser(tokens, { renderer });
  // input 先放行给 GFM 核对清单，随后统一转为样式化 span 并清除其余 input
  const html = DOMPurify.sanitize(raw, {
    FORBID_TAGS: ["style", "form", "iframe"],
  });
  // 高亮延后到挂载节点上执行成本更高；直接对字符串里的 code 块二次处理
  const container = document.createElement("div");
  container.innerHTML = html;
  container.querySelectorAll("pre code").forEach((block) => {
    hljs.highlightElement(block as HTMLElement);
  });
  container.querySelectorAll("[data-task-index]").forEach((node) => node.removeAttribute("data-task-index"));
  // GFM 核对清单：checkbox input → 样式化 span（data-task-index 与原文里
  // 第 N 个任务项对应，供点选切换）；其余 input 一律移除（原文内嵌 HTML）
  container.querySelectorAll("input").forEach((input) => {
    const item = input.closest("li");
    const marker = input.getAttribute("data-task-marker");
    if (input.type === "checkbox" && item && marker?.startsWith(`${taskMarker}:`)) {
      item.classList.add("md-task-item");
      if (input.checked) item.classList.add("md-task-done");
      const box = document.createElement("span");
      box.className = "md-task-checkbox";
      box.setAttribute("role", "checkbox");
      box.setAttribute("aria-checked", input.checked ? "true" : "false");
      const index = Number(marker.slice(taskMarker.length + 1));
      if (index >= 0) box.setAttribute("data-task-index", String(index));
      if (input.checked) box.setAttribute("data-checked", "true");
      input.replaceWith(box);
    } else {
      input.remove();
    }
  });
  return container.innerHTML;
}

/** 只修改解析器确认的勾选字符，保留其余原文（包括 CRLF）。 */
export function toggleTaskListItem(text: string, index: number): string | null {
  if (!Number.isInteger(index) || index < 0) return null;
  const position = parseMarkdownTasks(text).positions[index];
  if (position === undefined) return null;
  return text.slice(0, position) + (text[position] === " " ? "x" : " ") + text.slice(position + 1);
}
