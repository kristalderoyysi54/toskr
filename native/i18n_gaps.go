package main

// 英文界面里漏译的字串（2026-11-12 渲染英文介绍图时发现）：相对时间、剪贴页分段与视图、多选提示、今天页。
// 只补缺：表里已有的不覆盖。
func init() {
	for k, v := range map[string]string{
		"刚刚": "Just now", "%d 分钟前": "%dm ago", "%d 小时前": "%dh ago", "%d 天前": "%dd ago",
		"1 小时内": "Past hour", "今天": "Today", "昨天": "Yesterday", "7 天内": "Past 7 days", "更早": "Earlier",
		"按时间": "By time", "按来源": "By source", "代码": "Code",
		"发送 %d 张": "Send %d", "取消勾选": "Deselect", "记下待办": "Add task",
		"添加今天的任务，回车保存（": "Add a task for today, ⏎ to save (due ", " 到期）…": ")…",
		"记下待办，回车保存…": "Add a task, ⏎ to save…", "往日未完成": "Overdue", "全部顺延": "Postpone all",
	} {
		if _, ok := en[k]; !ok {
			en[k] = v
		}
	}
}
