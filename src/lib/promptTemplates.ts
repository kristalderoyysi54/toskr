import type { PromptSnippet } from "@/lib/targetProfiles";

export const WORKFLOW_PROMPT_SNIPPET_IDS = [
  "workflow-requirements",
  "workflow-diagnose",
  "workflow-review-plan",
] as const;

const workflowSnippetIds = new Set<string>(WORKFLOW_PROMPT_SNIPPET_IDS);

/** 缺省沿用内置常用模板；显式 true/false 保存用户的替换选择。 */
export function isCommonPromptSnippet(snippet: PromptSnippet): boolean {
  return snippet.isCommon ?? workflowSnippetIds.has(snippet.id);
}

/** 交换常用与其他模板的位置，只改变常用标记，保留两份模板。 */
export function replaceCommonPromptSnippet(
  snippets: PromptSnippet[],
  currentId: string,
  replacementId: string
): PromptSnippet[] {
  if (currentId === replacementId) return snippets;
  const currentIndex = snippets.findIndex((snippet) => snippet.id === currentId);
  const replacementIndex = snippets.findIndex((snippet) => snippet.id === replacementId);
  if (currentIndex < 0 || replacementIndex < 0 ||
    !isCommonPromptSnippet(snippets[currentIndex]) ||
    isCommonPromptSnippet(snippets[replacementIndex])) return snippets;
  const next = [...snippets];
  next[currentIndex] = { ...snippets[replacementIndex], isCommon: true };
  next[replacementIndex] = { ...snippets[currentIndex], isCommon: false };
  return next;
}

export const WORKFLOW_PROMPT_SNIPPETS: PromptSnippet[] = [
  {
    id: WORKFLOW_PROMPT_SNIPPET_IDS[0],
    label: "整理需求",
    text: "把以下内容整理为清楚的任务说明，保留目标和约束，列出影响实施的待确认问题。不补造需求，不执行任务。\n\n{内容}",
    groupId: "general",
  },
  {
    id: WORKFLOW_PROMPT_SNIPPET_IDS[1],
    label: "分析问题",
    text: "分析以下问题，区分已知事实与推测，给出可能原因和优先验证步骤。证据不足时说明缺什么，先不修改。\n\n{内容}",
    groupId: "general",
  },
  {
    id: WORKFLOW_PROMPT_SNIPPET_IDS[2],
    label: "审查方案",
    text: "检查以下方案是否解决目标，指出关键遗漏、风险和不必要的复杂度，给出最小调整建议。没有明确问题就直说。\n\n{内容}",
    groupId: "general",
  },
];

export const DEFAULT_PROMPT_SNIPPETS: PromptSnippet[] = WORKFLOW_PROMPT_SNIPPETS;

/** 仅用于一次性识别未修改的旧预设，不作为安装默认值。 */
const LEGACY_PROMPT_SNIPPETS: PromptSnippet[] = [
  {
    id: "review",
    label: "代码审查",
    text: "请帮我 review 以下代码，指出问题与改进建议：\n\n{内容}",
    groupId: "general",
  },
  {
    id: "translate",
    label: "翻译成中文",
    text: "请把以下内容翻译成中文：\n\n{内容}",
    groupId: "general",
  },
  {
    id: "summarize",
    label: "总结要点",
    text: "请总结以下内容的要点：\n\n{内容}",
    groupId: "general",
  },
  {
    id: "explain",
    label: "解释内容",
    text: "请解释以下内容：\n\n{内容}",
    groupId: "general",
  },
  {
    id: "optimize-prompt",
    label: "优化提示词",
    text: "请你不要执行接下来的任务。你现在的身份是世界顶级的提示工程专家，请仔细阅读我提供的提示词：\n\n{内容}\n\n并从清晰度、专业度、结构化、模型适应性四个维度进行批判性优化。请仅输出优化后的提示词内容，并用 ``` 包裹起来。",
    groupId: "general",
  },
];

export function isUnmodifiedLegacyPromptSnippet(snippet: PromptSnippet): boolean {
  return LEGACY_PROMPT_SNIPPETS.some((legacy) =>
    snippet.id === legacy.id && snippet.label === legacy.label &&
    snippet.text === legacy.text && snippet.groupId === legacy.groupId
  );
}

/** 根据当前内容识别预设，不推测用户是否导入过模板。 */
export function promptSnippetSourceLabel(
  snippet: PromptSnippet
): "内置" | "内置·已修改" | "自建" {
  const preset = [...WORKFLOW_PROMPT_SNIPPETS, ...LEGACY_PROMPT_SNIPPETS]
    .find((item) => item.id === snippet.id);
  if (!preset) return "自建";
  return snippet.label === preset.label && snippet.text === preset.text &&
    snippet.groupId === preset.groupId
    ? "内置"
    : "内置·已修改";
}
