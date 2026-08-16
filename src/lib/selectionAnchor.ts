/**
 * textarea 选区起点的 textarea 内可视坐标（镜像层测量）。
 * textarea 没有原生 API 拿选区矩形：复制排版相关样式到隐藏镜像 div，
 * 在选区起点插 marker 读它的偏移，再扣掉 textarea 自身滚动量。
 */
const MIRROR_STYLE_PROPS = [
  "box-sizing",
  "width",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "letter-spacing",
  "line-height",
  "text-transform",
  "text-indent",
  "tab-size",
] as const;

export function textareaSelectionAnchor(
  textarea: HTMLTextAreaElement,
  selection: { start: number; end: number }
): { left: number; top: number; bottom: number } | null {
  const style = window.getComputedStyle(textarea);
  const mirror = document.createElement("div");
  for (const prop of MIRROR_STYLE_PROPS) {
    mirror.style.setProperty(prop, style.getPropertyValue(prop));
  }
  mirror.style.position = "absolute";
  mirror.style.top = "0";
  mirror.style.left = "-99999px";
  mirror.style.visibility = "hidden";
  // 与 textarea 换行规则一致（softwrap + 长词断行）
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  mirror.textContent = textarea.value.slice(0, selection.start);
  const marker = document.createElement("span");
  marker.textContent =
    textarea.value.slice(selection.start, selection.start + 1) || "​";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const top = marker.offsetTop;
  const left = marker.offsetLeft;
  const lineHeight =
    marker.offsetHeight || Number.parseFloat(style.lineHeight) || 16;
  mirror.remove();
  if (!Number.isFinite(top) || !Number.isFinite(left)) return null;
  return {
    left: left - textarea.scrollLeft,
    top: top - textarea.scrollTop,
    bottom: top + lineHeight - textarea.scrollTop,
  };
}
