import DOMPurify from "dompurify";
import hljs from "highlight.js";
import { marked } from "marked";

/** 粗看是否像 Markdown（决定预览层默认进渲染视图还是原文视图）。 */
export function looksLikeMarkdown(text: string): boolean {
  return /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```)|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\n]+\)|`[^`\n]+`/.test(
    text
  );
}

marked.setOptions({ gfm: true, breaks: true });

/** Markdown → 安全 HTML（代码块接 highlight.js；本地内容仍必须 sanitize）。 */
export function renderMarkdown(text: string): string {
  const raw = marked.parse(text, { async: false });
  const html = DOMPurify.sanitize(raw, {
    FORBID_TAGS: ["style", "form", "input", "iframe"],
  });
  // 高亮延后到挂载节点上执行成本更高；直接对字符串里的 code 块二次处理
  const container = document.createElement("div");
  container.innerHTML = html;
  container.querySelectorAll("pre code").forEach((block) => {
    hljs.highlightElement(block as HTMLElement);
  });
  return container.innerHTML;
}
