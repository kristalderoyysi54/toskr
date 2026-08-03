/**
 * 文本快速处理（右键「文本处理 ▸」）：纯函数变换，就地更新卡片文本。
 * 失败（如 JSON 解析）抛错，由调用方 tip warn，不改动原卡。
 */

export interface TextOp {
  id: string;
  label: string;
  apply: (text: string) => string;
}

/** 去 Markdown 标记：剥常见行内与块级记号，保留正文与结构缩进。 */
function stripMarkdown(text: string): string {
  return (
    text
      // 代码围栏行整行去掉（保留围栏内内容）
      .replace(/^```[^\n]*$/gm, "")
      // 标题/引用/列表前缀
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^>\s?/gm, "")
      .replace(/^(\s*)[-*+]\s+/gm, "$1")
      .replace(/^(\s*)\d+\.\s+/gm, "$1")
      // 行内记号：链接 → 文字，加粗/斜体/行内代码/删除线
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/(\*\*|__)(.*?)\1/g, "$2")
      .replace(/(\*|_)(?=\S)(.*?)(?<=\S)\1/g, "$2")
      .replace(/~~(.*?)~~/g, "$1")
      .replace(/`([^`]*)`/g, "$1")
      .trim()
  );
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
  { id: "strip-md", label: "去 Markdown 标记", apply: stripMarkdown },
];
