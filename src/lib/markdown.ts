import DOMPurify from "dompurify";
import hljs from "highlight.js";
import { marked } from "marked";

/** 粗看是否像 Markdown（决定预览层默认进渲染视图还是原文视图）。 */
export function looksLikeMarkdown(text: string): boolean {
  return /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```)|\*\*[^*\n]+\*\*|(?:^|[^*])\*(?![*\s])(?:[^*\n]*\S)?\*(?!\*)|\[[^\]\n]+\]\([^)\n]+\)|`[^`\n]+`/.test(
    text
  );
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
