/**
 * 文本快速处理（右键「文本处理 ▸」）：纯函数变换，就地更新卡片文本。
 * 失败（如 JSON 解析）抛错，由调用方 tip warn，不改动原卡。
 */

import { markdownToPlainText } from "@/lib/markdown";
import type { SelectionEdit, TextSelection } from "@/lib/selectionFormat";

export interface TextOp {
  id: string;
  label: string;
  apply: (text: string) => string;
}

export const TEXT_OPS: TextOp[] = [
  { id: "trim", label: "去首尾空白", apply: (t) => t.trim() },
  {
    id: "strip-blank-lines",
    label: "去空行",
    apply: (t) =>
      t
        .split("\n")
        .filter((line) => line.trim() !== "")
        .join("\n"),
  },
  { id: "upper", label: "转大写", apply: (t) => t.toUpperCase() },
  { id: "lower", label: "转小写", apply: (t) => t.toLowerCase() },
  {
    id: "json-pretty",
    label: "JSON 格式化",
    apply: (t) => JSON.stringify(JSON.parse(t), null, 2),
  },
  {
    id: "url-decode",
    label: "URL 解码",
    apply: (t) => decodeURIComponent(t),
  },
  { id: "strip-md", label: "去 Markdown 标记", apply: markdownToPlainText },
];

/**
 * 选区适配器：文本操作只接收纯字符串，这里统一负责截取、替换并把新选区
 * 留在处理后的片段上。卡片右键、详情编辑和选词因此共享同一组操作语义。
 */
export function applyTextOpToSelection(
  text: string,
  selection: TextSelection,
  textOp: TextOp
): SelectionEdit {
  const start = Math.max(0, Math.min(selection.start, selection.end, text.length));
  const end = Math.max(
    start,
    Math.min(Math.max(selection.start, selection.end), text.length)
  );
  const replacement = textOp.apply(text.slice(start, end));
  return {
    text: text.slice(0, start) + replacement + text.slice(end),
    selection: { start, end: start + replacement.length },
  };
}
