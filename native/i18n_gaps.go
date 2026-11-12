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
		"这个键不能用作全局快捷键，请换一个": "This key can't be a global shortcut — try another", "排序": "Sort", "手动": "Manual", "发送最多": "Most sent", "最近发送": "Recently sent", "排序：": "Sort: ",
		"清零发送次数（%d）": "Reset send count (%d)", "已清零发送次数": "Send count reset",
		"%s 已被系统「%s」占用，请换一个":                          "%s is taken by the system shortcut “%s” — try another",
		"%s 是各应用通用的快捷键，设成全局会让它在所有应用里失效，请加上 ⇧ / ⌥ / ⌃": "%s is a standard app shortcut; making it global breaks it in every app — add ⇧ / ⌥ / ⌃",
		"截屏": "Save picture of screen", "将屏幕截图拷贝到剪贴板": "Copy picture of screen", "截取所选区域": "Save picture of selected area",
		"将所选区域拷贝到剪贴板": "Copy picture of selected area", "截屏和录制选项": "Screenshot and recording options", "聚焦搜索": "Spotlight",
		"访达搜索窗口": "Finder search window", "选择上一个输入法": "Select previous input source", "选择下一个输入法": "Select next input source",
		"调度中心": "Mission Control", "应用程序窗口": "Application windows", "向左移动一个空间": "Move left a space", "向右移动一个空间": "Move right a space",
		"显示桌面": "Show Desktop", "打开 / 关闭程序坞自动隐藏": "Turn Dock hiding on/off", "显示帮助菜单": "Show Help menu",
		"切换到下一个窗口": "Move focus to next window", "锁定屏幕": "Lock Screen", "键盘快捷键": "Keyboard Shortcuts",
	} {
		if _, ok := en[k]; !ok {
			en[k] = v
		}
	}
}
