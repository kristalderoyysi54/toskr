/** 将多条文本格式化为编号列表："1. 内容A\n2. 内容B" */
export function formatAsNumberedList(texts: string[]): string {
  return texts.map((text, index) => `${index + 1}. ${text}`).join("\n");
}

/** 发送到对话的文本：单条保持原文，多条转编号列表。 */
export function buildSendText(texts: string[]): string {
  if (texts.length === 1) return texts[0];
  return formatAsNumberedList(texts);
}

/** 合并多条笔记为一条（空行分隔）。 */
export function mergeTexts(texts: string[]): string {
  return texts.join("\n\n");
}

/** 包裹为 Markdown 代码块（发送格式选项）。 */
export function wrapAsCodeBlock(text: string, lang?: string): string {
  const tag = lang && lang !== "plaintext" ? lang : "";
  return `\`\`\`${tag}\n${text}\n\`\`\``;
}

/** HUD 预览：取首行、按字符截断。 */
export function previewOf(text: string): string {
  const firstLine = text.split("\n", 1)[0] ?? "";
  const chars = [...firstLine];
  let preview = chars.slice(0, 24).join("");
  if (chars.length > 24 || text.includes("\n")) preview += "…";
  return preview;
}

/** 发送预览：截断到 maxLines 行，附总字数。 */
export function sendPreview(text: string, maxLines = 10): string {
  const lines = text.split("\n");
  const shown = lines.slice(0, maxLines).join("\n");
  const suffix = lines.length > maxLines ? `\n…（共 ${lines.length} 行）` : "";
  return `${shown}${suffix}`;
}
