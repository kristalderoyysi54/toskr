package main

import (
	"strings"
	"sync/atomic"
)

// 界面语言：中文为源语言，英文按源串查表，缺词回退中文。对应 Tauri 版 i18n（zh/en）。
var langEN atomic.Bool

// setLanguage：system 按系统首选语言判断（zh* 用中文，其余英文）。
func setLanguage(setting string, preferred []string) {
	switch setting {
	case "zh":
		langEN.Store(false)
	case "en":
		langEN.Store(true)
	default:
		langEN.Store(len(preferred) > 0 && !strings.HasPrefix(strings.ToLower(preferred[0]), "zh"))
	}
}

func tr(s string) string {
	if langEN.Load() {
		if t, ok := en[s]; ok {
			return t
		}
	}
	return s
}

var en = map[string]string{
	"剪贴": "Clip", "笔记": "Notes", "未识别目标": "No target", "可发送": "Ready", "此分组为空": "Empty section", "还没有内容": "Nothing here yet", "连按两次 ⇧ 捕获选中文本，也可以在下方直接记下": "Double-tap ⇧ to capture selected text, or jot something down below", "没有匹配「%s」的卡片": "No cards match “%s”", "已选 %d 项": "%d selected", " %d 项": " (%d)", "合并笔记 ×%d": "Merge %d notes", "点击重命名": "Click to rename", "发送到对话（双击卡片同效）": "Send to chat (or double-click the card)", "打开页面（Space）": "Open page (Space)", "添加文字备注": "Add caption", "编辑文字备注": "Edit caption", "内容无变化": "No change", "已处理草稿 · ": "Draft processed · ",
	"选卡片": "Select", "长按 ⌥ Option": "Hold ⌥ Option", "搜索": "Search", "命令": "Commands", "全部快捷键": "All shortcuts", "添加笔记或提示词…": "Add a note or prompt…",
	"来自 ": "From ", "文本": "Text", "图片": "Image", "清理已完成": "Clear done", "订阅账单": "Subscriptions", "设置": "Settings",
	"队列": "Queue", "任务": "Tasks", "账单": "Bills", "秘文": "Vault",
	"捕获选中文本 / 呼出面板": "Capture selection / show panel", "切换顶部页签（⌃Tab 循环）": "Switch tabs (⌃Tab cycles)",
	"移动焦点卡片": "Move focused card", "全文预览（预览中 ↑↓ 切换）": "Full preview (↑↓ to switch while previewing)",
	"编辑（预览内 ⌘⏎ 保存）": "Edit (⌘⏎ saves in preview)", "勾选 / 取消勾选": "Select / deselect",
	"置顶剪贴卡 / 设笔记为常用": "Pin clip / favorite note", "标记完成 / 取消完成": "Mark done / not done", "双击卡片": "Double-click card",
	"直发该卡（剪贴页优先添加进打开的编辑器）":     "Send that card (on Clipboard, adds to the open editor first)",
	"详情窗切换选词模式（词/段点选，可发送选中片段）": "Toggle word-pick mode in detail window (pick words/paragraphs, send selection)",
	"全选可见卡片": "Select all visible cards", "发送勾选到对话": "Send selected to chat",
	"快发第 N 张卡（按住 ⌘ 看角标）": "Quick-send card N (hold ⌘ to see badges)",
	"复制勾选（多条转编号列表）":      "Copy selected (multiple become a numbered list)", "删除焦点卡片": "Delete focused card",
	"清理当前页已完成（笔记/任务）": "Clear done items on this page (notes/tasks)", "撤销上一步操作": "Undo last action",
	"命令面板（动作 / 搜索卡片与任务）": "Command palette (actions / search cards and tasks)",
	"逐层退出（预览→搜索→选择→面板）":  "Back out step by step (preview → search → selection → panel)",
	"面板内快捷键": "Panel Shortcuts", "%d 项 · 面板里长按 ⌥ 也能速查": "%d items · hold ⌥ in the panel to view", "快捷键": "Shortcuts",
	"收件箱": "Inbox", "剪贴板": "Clipboard", "截图": "Screenshot",
	"钉住：发送后不收起（⌘P）": "Pin: keep open after sending (⌘P)", "设置（⌘,）": "Settings (⌘,)",
	"搜索（⌘F）": "Search (⌘F)", "新建分组": "New section", "分组名": "Section name",
	"发送后保留（不标记完成）": "Keep after sending", "左移": "Move left", "右移": "Move right",
	"删除分组（笔记移回收件箱）":            "Delete section (notes go to Inbox)",
	"队列为空\n在任意应用选中文字，双击 ⇧ 收进来": "Queue is empty\nSelect text in any app and double-tap ⇧",
	"还没有剪贴板记录":                 "No clipboard history yet", "没有匹配的内容": "No matches",
	"已完成 ": "Done ", "清理": "Clear", "恢复为未完成": "Mark as not done",
	"标记完成（⌘D）": "Mark done (⌘D)", "保留": "Keep", "已发送": "Sent", "复制": "Copy",
	"发送（⌘↵）": "Send (⌘↵)", "发送到 ": "Send to ", "编辑": "Edit", "在详情窗打开": "Open in window",
	"移动到": "Move to", "识别文字": "Recognize text", "钉到屏幕": "Pin to screen", "删除": "Delete",
	"发送所选 %d 条": "Send %d selected", "合并所选 %d 条（⌘M）": "Merge %d selected (⌘M)",
	"⌘↵ 保存   esc 取消": "⌘↵ save   esc cancel", "（图片缺失）": "(image missing)",
	"写一条笔记，↵ 加入队列（⇧↵ 换行）":  "Write a note, ↵ to queue (⇧↵ newline)",
	"⌘↵ 发送  ⌥⌘↵ 全部  ⌘M 合并": "⌘↵ send  ⌥⌘↵ all  ⌘M merge", "（未知应用）": "(unknown app)",
	"发送内容含敏感信息：": "Sensitive content found: ", "遮罩后发送": "Redact & send", "仍然发送": "Send anyway", "取消": "Cancel",
	"已加入队列 · ": "Queued · ", "已存在，移到顶部": "Already queued, moved to top",
	"没有发送目标：先切到要粘贴的应用再唤出面板": "No target: switch to the app to paste into, then open the panel",
	"已发送 %d 条到 %s":        "Sent %d to %s",
	"明天下午3点 交周报 !!  ↵ 添加": "e.g. 明天下午3点 report !!  ↵ add", "待办 %d": "%d open", "显示已完成": "Show done",
	"优先级": "Priority", "重复": "Repeat", "到期": "Due", "无": "None", "低": "Low", "中": "Medium", "高": "High",
	"不重复": "Never", "每天": "Daily", "工作日": "Weekdays", "每周": "Weekly", "每月": "Monthly", "每年": "Yearly",
	"一小时后": "In an hour", "今晚 20:00": "Tonight 20:00", "明天 9:00": "Tomorrow 9:00", "下周一 9:00": "Next Monday 9:00", "清除": "Clear",
	"转为笔记发送": "Send as note", "已删除任务": "Task deleted", "撤销": "Undo", "已生成下一期：": "Next occurrence: ",
	"今天 ": "Today ", "明天 ": "Tomorrow ", "已过期 %d 天": "%d days overdue",
	"订阅月均": "Monthly subscriptions", "本月已付": "Paid this month", "新增账单": "Add bill",
	"订阅": "Subscription", "信用卡": "Credit card", "金额": "Amount", "下次到期": "Next due", "保存": "Save",
	"周": "week", "月": "month", "季": "quarter", "年": "year", "订阅 · 每": "Subscription · every ", "信用卡还款": "Card payment",
	"记一笔付款并推进到下期": "Record payment, advance to next period", "暂停": "Pause", "恢复": "Resume",
	"逾期 %d 天": "%d days overdue", "今天到期": "Due today", "%d 天后": "in %d days",
	"保存秘文": "Save secret", "还没有秘文": "No secrets yet", "显现 15 秒": "Reveal for 15 s",
	"口令封装": "Passphrase seal", "封装": "Seal", "解开": "Open", "生成密文": "Seal text", "解开密文": "Open text", "复制结果": "Copy result", "已复制": "Copied",
	"截图已加入队列": "Screenshot queued", "没有识别到文字": "No text found",
	"任务到期": "Task due", "账单提醒": "Bill reminder", "完成": " done",
	"润色": "Polish", "精简": "Shorten", "翻译为英文": "Translate to English", "翻译为中文": "Translate to Chinese", "写成提示词": "Rewrite as prompt",
	"命令面板": "Command palette", "输入命令，或搜索卡片、任务…": "Type a command, or search cards and tasks…", "没有匹配的命令或卡片": "No matching commands or cards",
	"动作": "Actions", "卡片": "Cards", "发送勾选的 %d 张卡到对话": "Send %d checked cards to chat", "检查后发送勾选的卡…": "Check, then send checked cards…",
	"发送焦点卡片到对话": "Send focused card to chat", "检查后发送焦点卡片…": "Check, then send focused card…", "搜索当前页": "Search this page",
	"切到内容页": "Go to Content", "切到剪贴页": "Go to Clipboard", "切到提醒页": "Go to Reminders", "最近发送记录": "Recent sends", "（无文字）": "(No text)",
	"切换到%s；双击返回列表起点；拖动可调整顺序": "Switch to %s; double-click to return to the top; drag to reorder",
	"在「%s」中添加内容":             "Add to \"%s\"", "新笔记": "New note",
	"处理新增草稿": "Process draft", "处理当前草稿": "Process current draft", "去首尾空白": "Trim whitespace", "去空行": "Remove blank lines", "转大写": "Uppercase", "转小写": "Lowercase", "JSON 格式化": "Format JSON", "URL 解码": "URL-decode", "去 Markdown 标记": "Strip Markdown", "转大窗编辑": "Edit in a larger window", "处理失败：": "Failed: ",
	"清除到期时间": "Clear due date", "已清除 %d 个任务的到期时间": "Cleared due dates of %d tasks", "剪贴板历史未开启": "Clipboard history is off", "%d 张图片未能保存": "%d images could not be saved", "开启后，复制过的文字、链接和图片会自动收集到这里": "Once on, copied text, links and images are collected here", "只存在本机，加密保存，不上传": "Stored only on this Mac, encrypted, never uploaded", "自动忽略密码管理器和标记为隐藏的内容": "Password managers and concealed content are ignored", "超过 %d 天自动清理，固定 ★ 的保留": "Cleared after %d days; pinned ★ items are kept", "开启剪贴板历史": "Turn on clipboard history", "调整规则": "Adjust rules", "⚠️ 需要辅助功能权限（点击设置）": "⚠️ Accessibility permission needed (click to fix)", "⚠️ 需要输入监控权限（点击设置）": "⚠️ Input Monitoring permission needed (click to fix)",
	"苹果日历": "Apple Calendar", "显示苹果日历日程": "Show Apple Calendar events", "日程": "Events", "扣款": "Charges", "全天": "All day", "（无标题）": "(No title)",
	"在「今天」时间轴里显示；只读，不会改动日历里的日程。点日程可在「日历」App 中打开。": "Shown on the Today timeline. Read-only: events are never changed. Click an event to open it in Calendar.",
	"未获得日历访问权限": "No calendar access", "在「系统设置 → 隐私与安全性 → 日历」里允许 Toskr Native 完整访问": "Allow full access for Toskr Native in System Settings → Privacy & Security → Calendars",
	"授权": "Allow", "显示的日历": "Calendars shown", "点一下切换显示": "Click to toggle", "在「日历」中打开": "Open in Calendar",
	"卡片右键菜单": "Card context menu", "各区显隐与顺序": "Items and order", "区内上移": "Move up", "区内下移": "Move down",
	"「一级菜单」两区直接显示在右键菜单里，「整理」「转换与导出」各是一个二级菜单；各项只能在本区内开关和排序。剪贴卡的「移入笔记分组」显示在一级。合并、回复关联与删除始终显示。": "The two top-level sections appear directly in the context menu; Organize and Convert & export are submenus. Items can be toggled and reordered only within their section. For clipboard cards, Move to notes group appears at the top level. Merge, reply links and Delete are always shown.",
	"一级菜单 · 发送": "Top level · Send", "一级菜单 · 常用": "Top level · Common", "整理": "Organize", "转换与导出": "Convert & export",
	"预览 / 打开链接": "Preview / open link", "复制内容": "Copy content", "复制为列表": "Copy as list", "导出笔记包": "Export note bundle",
	"设为常用 / 固定": "Favorite / pin", "移动到分组": "Move to group", "移入笔记分组": "Move to notes group", "检查后发送": "Check before sending",
	"确认获取链接预览…": "Fetch Link Preview…", "确认获取链接预览": "Fetch Link Preview?", "仅本次允许": "Allow Once", "已更新链接预览": "Link preview updated",
	"未获取预览（取消、网络失败或地址受限）": "No preview (canceled, network error, or restricted address)",
	"%d 小时后": "In %d h", "%d 分钟后": "In %d min", "今天 %s": "Today %s", "明天 %s": "Tomorrow %s", "下个%s %s": "Next %s %s",
	"没有快捷档，去设置添加…": "No presets; add some in Settings…", "到期快捷档": "Due presets", "到期提醒快捷档": "Due date presets",
	"任务「到期」菜单和消息「提醒我」里的快捷选项，按此顺序显示。": "Quick options in the task Due menu and message Remind me menu, in this order.",
	"已删除快捷档「%s」": "Deleted preset “%s”", "没有快捷档，菜单里只剩自定义日期时间。": "No presets; menus only offer a custom date and time.",
	"添加档位": "Add preset", "恢复默认": "Restore defaults", "共 %d 档": "%d presets", "已恢复默认快捷档": "Default presets restored", "输入无效": "Invalid input",
	"多久后": "In…", "今天": "Today", "明天": "Tomorrow", "下个周几": "Next weekday", "分钟": "min", "小时": "h",
	"时间格式应为 时:分，如 9:30": "Use hour:minute, e.g. 9:30", "复制正文": "Copy text", "已添加到正在编辑的卡片": "Added to the card being edited", "清除到期": "Clear due date",
	"本次将访问 %s 获取标题和图标，允许此地址访问内网。不会发送应用中的其他内容；授权不覆盖其他内网地址的重定向。": "Toskr will visit %s once to fetch its title and icon, allowing this local-network address. Nothing else from the app is sent, and redirects to other local-network addresses are not covered.",
}

func init() { // 横栏布局（hbar.go）
	for k, v := range map[string]string{
		"屏幕右侧": "Right of screen", "屏幕底部": "Bottom of screen", "屏幕顶部": "Top of screen", "屏幕位置": "Screen position",
		"添加笔记": "Add note", "收起输入": "Hide input", "没有未完成的笔记卡片": "No open note cards", "没有已完成的卡片": "No completed cards",
		"没有进行中的任务": "No tasks in progress", "剪贴板历史未开启": "Clipboard history is off",
	} {
		if _, ok := en[k]; !ok {
			en[k] = v
		}
	}
}
