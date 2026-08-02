import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const LANGS: Record<string, unknown> = {
  bash,
  css,
  go,
  java,
  javascript,
  json,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml,
};

for (const [name, def] of Object.entries(LANGS)) {
  hljs.registerLanguage(name, def as never);
}
hljs.configure({ ignoreUnescapedHTML: true });

/** 代码特征评分：命中若干结构性特征才判定为代码，避免把普通文字误判。 */
export function detectCode(text: string): string | undefined {
  const t = text.trim();
  if (t.length < 12) return undefined;
  // 中文占比高的多为自然语言（代码里的中文通常只在字符串/注释里）
  const cjk = (t.match(/[一-鿿]/g) ?? []).length;
  if (cjk / t.length > 0.25) return undefined;

  let score = 0;
  if (/^#!\/|^\s*(import|from|package|use|using)\s+\S/m.test(t)) score += 2;
  if (/\b(function|const|let|var|def|class|fn|struct|impl|interface|type)\s+\w/.test(t))
    score += 2;
  if (/[{};]\s*$/m.test(t)) score += 1;
  if (/^\s{2,}\S/m.test(t)) score += 1; // 缩进
  if (/=>|::|->|\)\s*\{|\breturn\b/.test(t)) score += 1;
  if (/^\s*(\$|>)\s+\w/m.test(t)) score += 1; // shell 提示符
  if (/^[[{][\s\S]*[\]}]$/.test(t) && /["']\s*:/.test(t)) score += 2; // JSON
  if (/<\/?[a-zA-Z][\w-]*[^>]*>/.test(t)) score += 1; // 标签
  if (score < 3) return undefined;

  // hljs 自动识别语言，置信度过低则标记为通用代码
  const result = hljs.highlightAuto(t, Object.keys(LANGS));
  return result.relevance >= 5 && result.language ? result.language : "plaintext";
}

/** 生成高亮 HTML（已由 hljs 转义，可安全注入）。 */
export function highlightCode(text: string, lang?: string): string {
  try {
    if (lang && lang !== "plaintext" && hljs.getLanguage(lang)) {
      return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
    }
    return hljs.highlightAuto(text, Object.keys(LANGS)).value;
  } catch {
    return text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  }
}

/** 语言标签的简短展示名。 */
export function langLabel(lang?: string): string {
  if (!lang || lang === "plaintext") return "代码";
  return lang === "javascript" ? "js" : lang === "typescript" ? "ts" : lang;
}
