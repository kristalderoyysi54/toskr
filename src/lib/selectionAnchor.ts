/**
 * textarea 选区起点的 textarea 内可视坐标（镜像层测量）。
 * textarea 没有原生 API 拿选区矩形：复制排版相关样式到隐藏镜像 div，
 * 在选区起点插 marker 读它的偏移，再扣掉 textarea 自身滚动量。
 */
const MIRROR_STYLE_PROPS = [
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "letter-spacing",
  "line-height",
  "text-transform",
  "text-indent",
  "tab-size",
  // 换行规则整组照抄：镜像换行点必须与 textarea 逐字一致
  "white-space",
  "word-break",
  "line-break",
  "overflow-wrap",
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
  // 排版宽度必须取内容盒：clientWidth 已扣掉边框和滚动条占位（全局
  // ::-webkit-scrollbar 细滚动条是占位式的）。按 computed width 排版时
  // 镜像每行多容纳几个像素，软换行点逐行错开，长文本命中定位会框错行
  mirror.style.boxSizing = "border-box";
  mirror.style.border = "0";
  mirror.style.width = `${textarea.clientWidth}px`;
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
