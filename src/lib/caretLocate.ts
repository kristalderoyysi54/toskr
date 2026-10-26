import { textareaSelectionAnchor } from "@/lib/selectionAnchor";
import { resolveSourceSelection, type TextSelection } from "@/lib/selectionFormat";

/** DOM 位置 → root 内纯文本偏移（与 Range.toString 同口径：只数 Text 节点）。 */
export function domTextOffset(root: Node, node: Node, offset: number): number {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(node, offset);
  return range.toString().length;
}

/** root 内纯文本偏移 → 折叠 Range；越界取末尾。 */
export function rangeAtTextOffset(root: Node, offset: number): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let last: Text | null = null;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    last = node;
    if (remaining <= node.data.length) {
      const range = document.createRange();
      range.setStart(node, remaining);
      range.collapse(true);
      return range;
    }
    remaining -= node.data.length;
  }
  if (!last) return null;
  const range = document.createRange();
  range.setStart(last, last.data.length);
  range.collapse(true);
  return range;
}

/**
 * 把 from 文本里的光标偏移映射到 to 文本（渲染文本 ⇄ 源文本两个方向通用）：
 * 取光标前（不行再取后）一小段文本去 to 里找，窗口由长到短——长片段定位唯一，
 * 短片段兜住 Markdown 标记打断的情形。
 */
export function mapCaretBetweenTexts(from: string, to: string, offset: number): number | null {
  if (from === to) return Math.min(offset, to.length);
  for (const size of [24, 8, 2]) {
    const before = resolveSourceSelection(to, from, {
      start: Math.max(0, offset - size),
      end: offset,
    });
    if (before) return before.end;
    const after = resolveSourceSelection(to, from, {
      start: offset,
      end: Math.min(from.length, offset + size),
    });
    if (after) return after.start;
  }
  return null;
}

/**
 * 把 textarea 选区滚到可见中央：先滚 textarea 自身，再滚外层滚动容器
 * （setSelectionRange 两者都不会滚）。返回选区首行的视口坐标，供高亮定位。
 */
export function revealTextareaSelection(
  textarea: HTMLTextAreaElement,
  selection: TextSelection,
  scroller: HTMLElement | null
): { top: number; bottom: number } | null {
  const inner = textareaSelectionAnchor(textarea, selection);
  if (!inner) return null;
  textarea.scrollTop += inner.top - textarea.clientHeight / 2;
  const anchor = textareaSelectionAnchor(textarea, selection);
  if (!anchor) return null;
  if (scroller) {
    const lineTop = textarea.getBoundingClientRect().top + anchor.top;
    const box = scroller.getBoundingClientRect();
    scroller.scrollTop += lineTop - box.top - scroller.clientHeight / 2;
  }
  const top = textarea.getBoundingClientRect().top + anchor.top;
  return { top, bottom: top + (anchor.bottom - anchor.top) };
}
