package main

// 收下 / 收件箱归类 / 常用栏 / 逐条整理的英文（2026-11-17）。只补缺：表里已有的不覆盖。
func init() {
	for k, v := range map[string]string{
		"你的规则：%s 的%s": "Your rule: %s %s", "%s 的%s大多归在这里": "Most %[2]s from %[1]s goes here", "这个应用": "this app",
		"图片": "Images", "链接": "Links", "代码": "Code", "文字": "text", "内容": "content",
		"已经收下过了": "Already kept", "已收进收件箱": "Kept in Inbox", "已收到「%s」": "Kept in “%s”",
		"%s 提醒": "Reminder at %s", " · 已收进收件箱": " · kept in Inbox",
		"已归到「%s」": "Filed to “%s”", "已按建议归好 %d 条": "Filed %d as suggested",
		" · 以后 %s 的%s建议归到这里": " · %s %s will be suggested here from now on",
		"还没有规则":              "No rules yet", "在收件箱里归类几次后会自动出现": "Rules appear after you file similar items a few times",
		"（分组已删除）": "(group deleted)", "%s 的%s → %s": "%s %s → %s", "已删除归类规则": "Rule deleted",
		"收到哪里": "Keep to", "分组": "Group", "收进收件箱": "Keep in Inbox", "稍后再归类": "file later",
		"还没有分组：在内容页点 + 新建": "No groups yet — add one with + on the Notes page",
		"收到 ": "Keep to ", "建议：": "Suggested: ", "建议": "Suggested", "已收下：": "Kept: ", "在内容页查看": "Show in Notes",
		"收下": "Keep", "收进收件箱，剪贴页里这条会保留": "Keep in Inbox; it stays in Clipboard too",
		"选分组收下（⏎ 收件箱 · 数字键分组）": "Pick a group (⏎ Inbox · number keys for groups)",
		"设提醒（同时收进收件箱）":         "Remind me (also keeps it in Inbox)", "提醒我": "Remind me",
		"收下（长按选择分类）": "Keep (hold to pick a group)",
		"常用":         "Favorites", "发送：": "Send: ", "点一下发送；右键更多": "Click to send; right-click for more",
		"在列表中查看": "Show in list", "%d 次": "%d×", "按建议归好 %d 条": "File %d as suggested",
		"把有建议分组的都归过去（可撤销）": "File everything that has a suggestion (undoable)",
		"逐条整理": "Triage", "一条一条看，按数字键归类": "Go one by one; file with number keys", "归到 ": "File to ",
		"收件箱整理完了": "Inbox is clear", "第 %d / %d 条": "%d of %d", "归类": "File", "按建议": "Suggested",
		"跳过": "Skip", "空格": "Space", "结束整理": "End triage", "结束": "Done",
		"收件箱归类规则": "Inbox filing rules",
		"同一应用的同类内容归到同一分组满 3 次，会自动记成规则；收件箱里按规则给出的建议显示为实线。": "After you file the same kind of item from one app to the same group 3 times, it becomes a rule. Rule-based suggestions in the Inbox have a solid outline.",
		"超期记录自动清理，置顶和已收下的除外":                              "Older items are removed automatically, except pinned and kept ones",
	} {
		if _, ok := en[k]; !ok {
			en[k] = v
		}
	}
}
