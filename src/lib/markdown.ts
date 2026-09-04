import DOMPurify from "dompurify";
import hljs from "highlight.js";
import { marked, type Token, type Tokens } from "marked";

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

/** Markdown → 安全 HTML（代码块接 highlight.js；本地内容仍必须 sanitize）。 */
export function renderMarkdown(text: string): string {
  const raw = marked.parse(text, { async: false });
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
  // GFM 核对清单：checkbox input → 样式化 span（data-task-index 与原文里
  // 第 N 个任务项对应，供点选切换）；其余 input 一律移除（原文内嵌 HTML）
  let taskIndex = 0;
  container.querySelectorAll("input").forEach((input) => {
    const item = input.closest("li");
    if (input.type === "checkbox" && item) {
      item.classList.add("md-task-item");
      if (input.checked) item.classList.add("md-task-done");
      const box = document.createElement("span");
      box.className = "md-task-checkbox";
      box.setAttribute("role", "checkbox");
      box.setAttribute("aria-checked", input.checked ? "true" : "false");
      box.setAttribute("data-task-index", String(taskIndex++));
      if (input.checked) box.setAttribute("data-checked", "true");
      input.replaceWith(box);
    } else {
      input.remove();
    }
  });
  return container.innerHTML;
}

const TASK_LINE_PATTERN = /^([\t ]*(?:[-+*]|\d+[.)])[\t ]+\[)([ xX])(\])/;

/**
 * 切换原文中第 index 个核对清单项的勾选态（与渲染层 data-task-index 对齐）。
 * 找不到对应项返回 null（渲染与原文可能因内嵌 HTML 等罕见情况错位）。
 */
export function toggleTaskListItem(text: string, index: number): string | null {
  const lines = text.split("\n");
  let seen = 0;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) inFence = !inFence;
    if (inFence) continue;
    const match = TASK_LINE_PATTERN.exec(lines[i]);
    if (!match) continue;
    if (seen === index) {
      const next = match[2] === " " ? "x" : " ";
      lines[i] = lines[i].replace(TASK_LINE_PATTERN, `$1${next}$3`);
      return lines.join("\n");
    }
    seen += 1;
  }
  return null;
}
