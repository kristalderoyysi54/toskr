import { api } from "@/lib/tauri";

/**
 * 决定一次 <a> 点击的去向：http/https 返回可外开的 URL，其余（相对路径、
 * 锚点、mailto 等）返回 null 表示吞掉。协议必须看原始 href——浏览器补全的
 * 绝对 URL 会把相对路径伪装成 http(s)。
 */
export function resolveExternalLink(rawHref: string): string | null {
  const href = rawHref.trim();
  return /^https?:\/\//i.test(href) ? href : null;
}

/**
 * 文档级拦截所有 <a> 点击：WebView 绝不就地导航（否则 SPA 被外部网页替换、
 * 详情窗无法关闭），http/https 转交系统默认浏览器（与 Rust open_url 同口径）。
 * 应用 UI 自身不用 <a> 标签，故可全局兜底。
 */
export function installExternalLinkInterceptor() {
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a[href]");
      if (!anchor) return;
      event.preventDefault();
      const url = resolveExternalLink(anchor.getAttribute("href") ?? "");
      if (url) void api.openUrl(url);
    },
    { capture: true }
  );
}
