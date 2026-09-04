/** 轻量 Markdown 特征判断；保持在独立模块，避免类型归一化引入渲染依赖。 */
export function looksLikeMarkdown(text: string): boolean {
  return /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```)|\*\*[^*\n]+\*\*|(?:^|[^*])\*(?![*\s])(?:[^*\n]*\S)?\*(?!\*)|\[[^\]\n]+\]\([^)\n]+\)|`[^`\n]+`/.test(
    text
  );
}
