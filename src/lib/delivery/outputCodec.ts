import { wrapAsCodeBlock } from "@/lib/format";
import { markdownToPlainText } from "@/lib/markdown";
import type { DeliveryFormat, MarkdownSendMode } from "@/lib/targetProfiles";

/**
 * 最终输出投影：无 Markdown 优先于代码块，确保实际正文与 Draft 记录的
 * format / markdownMode 一致。用户来源与 AI 结果都应经过这一层。
 */
export function applyDeliveryOutputCodec(
  text: string,
  format: DeliveryFormat,
  markdownMode: MarkdownSendMode,
  codeLanguage?: string
): string {
  if (!text) return "";
  if (markdownMode === "strip") return markdownToPlainText(text);
  return format === "code" ? wrapAsCodeBlock(text, codeLanguage) : text;
}
