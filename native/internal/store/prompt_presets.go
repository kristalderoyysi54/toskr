package store

// 内置模板（同 Tauri WORKFLOW_PROMPT_SNIPPETS + LEGACY_PROMPT_SNIPPETS），只用来识别模板来源。
var builtinSnippets = []PromptSnippet{
	{ID: "workflow-requirements", Label: "整理需求", Text: "把以下内容整理为清楚的任务说明，保留目标和约束，列出影响实施的待确认问题。不补造需求，不执行任务。\n\n{内容}", GroupID: GeneralPromptGroup},
	{ID: "workflow-diagnose", Label: "分析问题", Text: "分析以下问题，区分已知事实与推测，给出可能原因和优先验证步骤。证据不足时说明缺什么，先不修改。\n\n{内容}", GroupID: GeneralPromptGroup},
	{ID: "workflow-review-plan", Label: "审查方案", Text: "检查以下方案是否解决目标，指出关键遗漏、风险和不必要的复杂度，给出最小调整建议。没有明确问题就直说。\n\n{内容}", GroupID: GeneralPromptGroup},
	{ID: "review", Label: "代码审查", Text: "请帮我 review 以下代码，指出问题与改进建议：\n\n{内容}", GroupID: GeneralPromptGroup},
	{ID: "translate", Label: "翻译成中文", Text: "请把以下内容翻译成中文：\n\n{内容}", GroupID: GeneralPromptGroup},
	{ID: "summarize", Label: "总结要点", Text: "请总结以下内容的要点：\n\n{内容}", GroupID: GeneralPromptGroup},
	{ID: "explain", Label: "解释内容", Text: "请解释以下内容：\n\n{内容}", GroupID: GeneralPromptGroup},
	{ID: "optimize-prompt", Label: "优化提示词", Text: "请你不要执行接下来的任务。你现在的身份是世界顶级的提示工程专家，请仔细阅读我提供的提示词：\n\n{内容}\n\n并从清晰度、专业度、结构化、模型适应性四个维度进行批判性优化。请仅输出优化后的提示词内容，并用 ``` 包裹起来。", GroupID: GeneralPromptGroup},
}

// SnippetSource 同 Tauri promptSnippetSourceLabel：按当前内容识别预设，返回「内置」「内置·已修改」「自建」。
func SnippetSource(sn PromptSnippet) string {
	for _, p := range builtinSnippets {
		if p.ID == sn.ID {
			if p.Label == sn.Label && p.Text == sn.Text && p.GroupID == sn.GroupID {
				return "内置"
			}
			return "内置·已修改"
		}
	}
	return "自建"
}
