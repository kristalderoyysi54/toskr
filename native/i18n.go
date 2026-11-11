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
			return brand(t)
		}
	}
	return brand(s) // 正式版里「Toskr Native」写成「Toskr」
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
	"发送所选 %d 条": "Send %d selected", "发送整卡": "Send Card", "编辑中": "Editing", "图片 %d/%d": "Image %d/%d", "图片打码": "Redact Image", "标注 / 裁剪：加标注或裁剪，完成后替换卡片里的原图（可撤销）": "Annotate / Crop: replaces the card image when done (undoable)", "固定窗口：发送后保持打开": "Pin window: stay open after sending", "发送选中": "Send Selected", "合并所选 %d 条（⌘M）": "Merge %d selected (⌘M)",
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

func init() { // 模板来源 / 试用预览 / AI 模板助手（templates_ai.go）
	for k, v := range map[string]string{
		"内置": "Built-in", "内置·已修改": "Built-in · edited", "自建": "Custom", "AI 创建": "Create with AI", "AI 调整": "Adjust with AI",
		"插入 {内容}": "Insert {内容}", "未插入 {内容} 时，选中内容会追加在模板末尾。": "Without {内容}, the selection is appended to the end.",
		"选中内容会替换 {内容}。": "The selection replaces {内容}.", "试用预览": "Try preview",
		"仅在本地组合文本，不调用 AI 或发送。留空时使用下面的示例。": "Combines text locally only — no AI, nothing is sent. Leave empty to use the sample below.",
		"示例材料": "Sample material", "组合全文": "Combined text", "描述你的想法": "Describe your idea", "继续调整这份建议": "Keep refining this suggestion",
		"请先在“更多功能 → AI 智能”中配置并启用，或直接手动编辑。": "Set up and enable AI in More → AI first, or edit manually.",
		"使用当前 AI · ": "Using current AI · ", "试试：": "Try:", "排查问题": "Debug report", "整理周报": "Weekly report", "润色消息": "Polish message",
		"生成模板建议": "Generate template", "正在生成…": "Generating…", "生成调整建议": "Generate revision", "取消生成": "Cancel",
		"仅提交想法与当前模板；示例材料留在本地。":   "Only your idea and the current template are sent; sample material stays local.",
		"建议已生成，采用到编辑区后可继续修改和预览。": "Suggestion ready — apply it to keep editing and previewing.",
		"采用到编辑区": "Apply to editor", "放弃建议": "Discard",
		"请填写想法，最多 2000 个字符": "Enter an idea, up to 2000 characters", "AI 返回的模板不是合法 JSON，请重试": "AI did not return valid JSON — try again",
		"AI 返回的模板为空或超长，请重试": "AI template is empty or too long — try again", "AI 模板包含重复的 {内容}，请重新生成": "AI template has {内容} more than once — regenerate",
		"AI 返回的模板内容超过 12000 个字符，请重试": "AI template exceeds 12000 characters — try again",
	} {
		if _, ok := en[k]; !ok {
			en[k] = v
		}
	}
}

func init() { // 应用更新（updater.go）
	for k, v := range map[string]string{
		"更新": "Update", "软件更新": "Software update", "发现新版本可用": "A new version is available", "更新内容": "What's new", "常规改进与问题修复。": "General improvements and fixes.", "下载中…": "Downloading…", "立即下载": "Download now", "还没有发布原生版更新，当前即最新": "No native release published yet — you're up to date", "发现新版本 v%s · 点击查看": "New version v%s · click to view", "已更新到 v%s · 重启应用后生效": "Updated to v%s · restart to apply",
		"自动更新失败：": "Auto-update failed: ", "此构建未启用自动更新（开发构建或安装位置不可写）": "Updates are off for this build (dev build or install location not writable)",
		"检查失败：": "Check failed: ", "已是最新版本": "You're up to date", "发现新版本 v%s": "New version v%s", "安装失败：": "Install failed: ",
		"%d%% · 完成后自动重启": "%d%% · restarts when done", "下载并安装": "Download and install", "检查中…": "Checking…", "本次更新内容": "What's new",
		"自动检查更新": "Check for updates automatically", "启动后在后台检查；关闭后只在手动检查时查找": "Checks in the background after launch; when off, only manual checks",
		"自动安装更新": "Install updates automatically", "在后台下载新版，下次启动时生效": "Downloads in the background; applies on next launch",
		"更新日志": "Release notes", "所有版本": "All versions", "链接": "Links", "项目主页": "Homepage", "报告 Bug": "Report a bug", "提 Issue": "Open an issue",
	} {
		if _, ok := en[k]; !ok {
			en[k] = v
		}
	}
}

func init() { // 上手教程图形化（onboarding_visual.go）
	for k, v := range map[string]string{
		"不会自动按回车": "Never presses Enter", "不回车": "No Enter", "允许辅助功能": "Allow Accessibility", "系统设置": "Settings", "辅助功能": "Accessibility", "打开 Toskr": "Turn on Toskr",
		"快捷键准备中": "Preparing shortcut", "按一下空格": "Press Space once", "空格": "Space", "就绪": "Ready", "允许输入监控": "Allow Input Monitoring", "输入监控": "Input Monitoring",
		"收进示例": "Capture the sample", "空白文档": "Blank doc", "粘贴": "Paste", "全选": "Select all", "连按两次": "Double-tap", "复制示例": "Copy sample",
		"选粘贴位置": "Choose where to paste", "点文档": "Click doc", "识别": "Detect", "确认": "Confirm", "未识别": "Not detected", "检查并粘贴": "Check & paste",
		"替换邮箱": "Mask email", "看正文": "Review", "安全粘贴": "Safe paste", "教程标记": "Tutorial tag", "自动清理": "Auto cleanup", "点圆圈": "Click circle",
		"或按 X": "or press X", "一起发送": "Send together", "发送": "Send", "合成一次": "One paste", "勾选多张": "Check several", "一起发": "Send all",
		"复制回复": "Copy reply", "完成：收回时自动还原": "Done: restored on capture", "收集": "Collect", "合并发送": "Merge & send", "自动脱敏": "Auto-mask",
	} {
		if _, ok := en[k]; !ok {
			en[k] = v
		}
	}
}

func init() { // 设置 → 更多功能子页签 / 权限页（settings_features.go）、分组拖动排序
	for k, v := range map[string]string{
		"拖动调整分组顺序 · 点击折叠/展开 · 双击重命名": "Drag to reorder · Click to collapse/expand · Double-click to rename",
		"使用概览": "Overview", "关于": "About", "诊断": "Diagnostics",
		"功能开关": "Features", "AI 智能": "AI", "到期提醒": "Due reminders", "日历与提醒事项": "Calendar & Reminders", "消息监听": "Message watch", "实验": "Beta",
		"开启后，主面板会出现对应入口。":   "Turned-on features show up in the main panel.",
		"可设置监听应用、接入方式和收集规则": "Set the app to watch, how to connect and what to collect",
		"可管理共享密钥和默认格式":      "Manage shared keys and the default format", "可设置新账单的默认提醒": "Set default reminders for new bills",
		"苹果日历与提醒事项": "Apple Calendar & Reminders", "在「提醒」页显示日历日程，把任务同步到 iPhone 的提醒事项": "Show calendar events in Reminders and sync tasks to Reminders on iPhone",
		"已开启：%s": "On: %s", "日历": "Calendar", "提醒事项": "Reminders", "未开启": "Off",
		"全部授权": "Allow all", "全部授权（%d 项）": "Allow all (%d)", "按顺序逐项请求；需要在系统设置里手动打开的项会停下，打开后回到这里再点一次继续": "Asks one by one; stops at items you must turn on in System Settings — come back and click again to continue",
		"已在系统设置里允许？重启 Toskr 后生效": "Allowed in System Settings? Restart Toskr to apply", "键盘监听：": "Keyboard tap: ", "重启 Toskr": "Restart Toskr",
		"已授权": "Allowed", "✓ 都已就绪": "✓ All set", "授权后需重启 Toskr 才生效": "Restart Toskr to apply the new permissions", "还有 %d 项需要授权": "%d more to allow",
		"系统权限": "System permissions", "屏幕录制": "Screen Recording", "重置授权": "Reset",
		"读取你选中的文字（双击触发键捕获），并把内容粘贴回目标应用。":  "Reads the text you select (double-tap capture) and pastes content back into the target app.",
		"识别双击触发键等全局快捷操作；只判断按键时机，不记录输入内容。": "Detects global gestures like the double-tap; only key timing is checked, nothing you type is recorded.",
		"区域截图、长截屏和图内识别需要读取屏幕画面；画面只在本机处理。": "Screenshots, scrolling capture and image text recognition read the screen; images stay on this Mac.",
		"在「提醒」页显示日历日程，只读。":                "Shows calendar events in Reminders, read-only.", "把任务同步到「提醒事项」，在 iPhone 上也能看到。": "Syncs tasks to Reminders so you can see them on iPhone.",
		"Toskr 在这台 Mac 上需要的系统权限。点「授权」会弹出系统授权框或打开对应的系统设置页，在那里允许 Toskr 即可；每一项都可以随时在系统设置里更改，内容只留在你的电脑上。": "System permissions Toskr needs on this Mac. “Allow” shows the system prompt or opens the matching System Settings page — allow Toskr there. You can change each one any time; your content stays on your Mac.",
		"%s · 拖动调整分组顺序 · 点击折叠/展开（吸顶时回到组首） · 双击重命名":                                                    "%s · Drag to reorder · Click to collapse/expand (scrolls to start when pinned) · Double-click to rename",
	} {
		if _, ok := en[k]; !ok {
			en[k] = v
		}
	}
}

func init() { // 设置 → 粘贴与隐私：粘贴规则主从布局 / 隐私保护（settings_paste.go）
	for k, v := range map[string]string{
		"粘贴规则": "Paste rules", "隐私保护": "Privacy", "提示词模板": "Prompt templates", "管理应用粘贴规则": "Per-app paste rules",
		"设置内容怎样粘贴、粘贴后是否回车；每个应用可以单独设置。": "How content is pasted and whether Return is pressed; each app can have its own rule.",
		"共享方案与高级管理": "Shared profiles & advanced", "名称、应用绑定、排序与默认方案": "Names, app bindings, order and default profile", "%d 个方案": "%d profiles",
		"多段粘贴": "Multi-part paste", "搜索应用": "Search apps", "搜索应用或方案": "Search apps or profiles",
		"默认规则": "Default rule", "未单独设置的应用": "Apps without their own rule", "使用默认规则": "Uses default rule", "重复绑定": "Duplicate binding",
		"选择一个应用，为它设置粘贴规则。": "Pick an app to set its paste rule.", "没有匹配的应用": "No matching apps", "选择应用…": "Choose App…",
		"未绑定应用使用这套默认规则": "Apps without a rule use this default", "设置此应用以后的粘贴行为": "How pasting into this app works from now on",
		"尚未单独设置，当前使用默认规则": "No rule of its own yet; uses the default rule", "共 %d 个应用使用此方案": "%d apps use this profile",
		"仅此应用": "This app only", "共享方案": "Shared profile",
		"默认规则固定为不自动回车、敏感内容逐项处理；绑定此方案的应用会一起更新格式和面板。": "The default rule never presses Return and reviews sensitive items one by one; apps bound to this profile update format and panel too.",
		"修改会同时影响上方全部应用，以及未单独设置应用的默认格式和面板。":          "Changes apply to all apps above and to the default format and panel of apps without their own rule.",
		"修改会同时影响上方全部应用。": "Changes apply to all apps above.", "这套规则仅用于当前应用。": "This rule is used only by this app.",
		"修改时为当前应用建立独立规则，其他应用保持原设置。":         "Changing it creates a rule just for this app; other apps keep theirs.",
		"此应用有重复绑定，请在下方「共享方案与高级管理」里只保留一个方案。": "This app is bound to several profiles; keep only one under “Shared profiles & advanced” below.",
		"逐项明确选择替换或保留原文，不会自动全部替换。":           "Choose replace or keep for each item; nothing is replaced automatically.",
		"全局隐私检查已关闭，这项规则暂不生效；开启后使用所选策略。":     "Privacy check is off, so this has no effect until it is turned on.",
		"普通提示项保留原文时，发送前需要确认。":               "Keeping the original of a flagged item asks for confirmation before sending.",
		"普通提示项允许保留原文；高风险原文仍需二次确认。":          "Flagged items may keep their original; high-risk originals still need a second confirmation.",
		"默认规则始终只粘贴，不自动回车。":                  "The default rule only pastes and never presses Return.",
		"输出格式": "Output format", "回车策略": "Return key", "敏感处理": "Sensitive content", "完成后面板": "Panel after sending",
		"粘贴成功后收起或保持打开；钉住时始终打开。": "Hide or keep the panel after pasting; it stays open while pinned.", "收起面板": "Hide panel", "保持打开": "Keep open",
		"自动按回车：内容会直接提交或执行，只适合明确可信的目标。": "Auto Return submits or runs the content right away; use it only for trusted targets.",
		"改动即时生效": "Changes apply immediately", "恢复默认": "Restore default", "%s 已恢复默认规则": "%s now uses the default rule",
		"保持内容自然排版并保留 Markdown 标记。": "Keeps the layout and Markdown marks as they are.", "发送时去除 Markdown 标记；智能预检会先展示结果。": "Removes Markdown marks when sending; the preflight shows the result first.",
		"用代码围栏包裹文本，适合开发工具与终端记录。": "Wraps text in a code fence, for developer tools and terminals.",
		"只完成粘贴，由你在目标应用中检查后提交。":   "Only pastes; you review and submit in the target app.", "发送前询问；确认后才会在粘贴后模拟回车。": "Asks first; presses Return after pasting only once you confirm.",
		"内容会直接提交或执行，只适合明确可信的目标。":    "Content is submitted or run right away; only for trusted targets.",
		"发送前在本机检查敏感内容，原始卡片不会被改写。":   "Checks for sensitive content on this Mac before sending; the original cards are not changed.",
		"本机规则可能漏检，发送前仍可在预检中核对最终内容。": "Local rules can miss things; you can still review the final content in the preflight.",
		"按粘贴规则": "Per paste rules", "可逆化名": "Reversible aliases", "%d 条": "%d", "+ 添加": "+ Add", "捕获回复时自动还原": "Restore when capturing replies",
		"试一试替换效果": "Try it out", "取消": "Cancel",
		"词典加密保存在本机；导出的完整备份中为明文。删除条目后，它的占位符编号不再复用。": "The dictionary is encrypted on this Mac and exported in plain text in full backups. Deleted entries' placeholder numbers are never reused.",
	} {
		if _, ok := en[k]; !ok {
			en[k] = v
		}
	}
}

func init() { // 配色方案名与说明（schemes.go / settings.go schemeHint；同 Tauri en/settings.ts）
	for k, v := range map[string]string{
		"琉璃": "Glass", "纸墨": "Paper", "抹茶": "Matcha", "樱粉": "Sakura", "雾蓝": "Fog",
		"固定浅色、整窗不透明；切回琉璃恢复原主题与毛玻璃": "Always light and opaque. Switch back to Glass to restore your theme and translucency",
		"固定浅色；切回琉璃恢复深浅色设置":         "Always light. Switch back to Glass to restore your light/dark setting",
	} {
		if _, ok := en[k]; !ok {
			en[k] = v
		}
	}
}

func init() { // 粘贴规则：模板排序 / 输出预览 / 当前目标与规则检查（settings_paste_extra.go；同 Tauri en 词条）
	for k, v := range map[string]string{
		"# 项目更新": "# Project update", "- **完成**：修复发送": "- **Done**: fixed sending", "- [查看文档](https://example.com)": "- [Read the docs](https://example.com)",
		"暂无提示词": "No prompts", "、": ", ", "模板排序": "Template order", "「其他模板」里优先显示": "Shown first in “Other templates”",
		"已删除的提示词组 · 请选择替代项": "Deleted prompt group · pick another", "提示词组": "Prompt group",
		"%s · %d 条 · %s": "%s · %d · %s", "%d 条提示词 · %s": "%d prompts · %s",
		"只影响「其他模板」的顺序，不会自动套用模板。": "Only changes the order of “Other templates”; never applies a template automatically.",
		"输出预览": "Output preview", "用示例内容预览输出格式，不做隐私处理，也不会真实粘贴或回车。": "Previews the output format with sample text — no privacy processing, nothing is pasted, Enter is never pressed.",
		"测试内容（可编辑，最多 4000 字符）": "Sample text (editable, up to 4,000 characters)", "输出方式预览测试内容": "Output preview sample text",
		"格式预览 · %s": "Preview · %s", "（空内容不会发送）": "(Empty content isn’t sent)", "%s格式预览结果": "%s preview result",
		"当前目标与规则检查": "Current target & rule check", "看看现在会粘贴到哪里、用哪套规则": "See where content would paste and which rule applies",
		"尚未识别": "Not detected", "可粘贴": "Ready to paste", "应用已退出": "App has quit", "当前粘贴目标": "Current paste target",
		"调整粘贴规则": "Adjust paste rule", "请先点目标应用的输入框，再唤出 Toskr。位置未确认前不会粘贴。": "Click the input field in the target app first, then open Toskr. Nothing is pasted until the position is confirmed.",
		"使用方案：%s": "Profile: %s", "规则来源：%s": "Rule source: %s", "其他模板优先显示「%s」组；不会自动套用模板。": "“Other templates” lists the “%s” group first; templates are never applied automatically.",
		"检查规则": "Check rule", "重新识别目标": "Re-detect target", "尚未识别粘贴目标": "Paste target not detected",
		"已识别目标应用，输入位置未确认": "Target app detected; input position not confirmed", "请重新选择目标输入框": "Select the target input field again",
		"规则已重新计算：%s · %s。未执行粘贴或回车。": "Rule recalculated: %s · %s. Nothing was pasted and Enter wasn’t pressed.",
	} {
		if _, ok := en[k]; !ok {
			en[k] = v
		}
	}
}

func init() { // 详情窗光标处插入 / 拖进详情编辑器（insert_card.go / detail_drop.go）
	for k, v := range map[string]string{
		"已替换选中内容": "Replaced the selection",
		"添加到打开的卡片光标处（双击卡片同效）":     "Add at the open card's cursor (or double-click the card)",
		"添加到打开的卡片光标处（有选中文字则替换）":   "Add at the open card's cursor (replaces selected text)",
		"直发该卡（详情窗开着时剪贴卡添加到它的光标处）": "Send the card (clips go to the open card's cursor while a detail window is open)",
	} {
		if _, ok := en[k]; !ok {
			en[k] = v
		}
	}
}

func init() { // 拖出预览 / 拖进详情（drag_preview.go）
	for k, v := range map[string]string{
		"%d 张": "%d cards",
		"拖出原文（不脱敏，目标由拖放位置决定）；拖进详情窗插在落点": "Drag out the original text (not redacted); drop into a detail window to insert at that spot",
	} {
		if _, ok := en[k]; !ok {
			en[k] = v
		}
	}
}

func init() { // 选择应用面板（internal/macos/apppicker.go）
	for k, v := range map[string]string{"选择": "Choose", "读不到这个应用的标识，换一个试试": "Couldn't read this app's identifier; try another one"} {
		if _, ok := en[k]; !ok {
			en[k] = v
		}
	}
}

func init() { // 文本处理扩充（textops.go）
	for k, v := range map[string]string{
		"Base64 编码": "Base64-encode", "Base64 解码": "Base64-decode", "时间戳 ↔ 日期": "Timestamp ↔ date", "行去重": "Remove duplicate lines",
		"行排序": "Sort lines", "全角转半角": "Full-width → half-width", "半角转全角": "Half-width → full-width", "中英文之间加空格": "Space between CJK and Latin",
		"提取全部链接": "Extract all links", "解码结果不是文本": "Decoded data is not text", "不是有效的 Base64": "Not valid Base64",
		"不是时间戳或日期": "Not a timestamp or date", "没有找到链接": "No links found",
	} {
		en[k] = v
	}
}

func init() { // 命令面板扩充（commands.go sharedActions / settingsJumps）
	for k, v := range map[string]string{
		"在设置里搜索「%s」": "Search settings for “%s”", "恢复剪贴板收集": "Resume clipboard collection", "已恢复剪贴板收集": "Clipboard collection resumed",
		"已暂停剪贴板收集": "Clipboard collection paused", "关闭隐身模式": "Turn off stealth mode", "开启隐身模式（不弹捕获提示）": "Turn on stealth mode (no capture bubbles)",
		"已关闭隐身模式": "Stealth mode off", "切换为舒适列表": "Switch to comfortable list", "切换为紧凑列表": "Switch to compact list",
		"主题：跟随系统": "Theme: system", "主题：浅色": "Theme: light", "主题：深色": "Theme: dark", "取消保持面板展开": "Stop keeping panel open",
		"快捷键速查表": "Shortcut cheat sheet",
	} {
		if _, ok := en[k]; !ok {
			en[k] = v
		}
	}
}

func init() { // 粘贴规则应用列表：未安装的预置终端（settings_paste.go）
	en["另有 %d 个未安装的终端"] = "%d more terminals not installed"
}

func init() { // 剪贴卡页脚按类型显示（image_import.go clipFootMeta）
	if _, ok := en["%d 行"]; !ok {
		en["%d 行"] = "%d lines"
	}
}

func init() { // 键位提示随状态变化 + 整行开关（mainpanel.go keyHints / panel.go 面板菜单）
	for k, v := range map[string]string{"底部键位提示": "Key hints at the bottom", "合并": "Merge", "保存": "Save", "取消": "Cancel", "收起": "Collapse", "完成": "Done", "删除": "Delete"} {
		if _, ok := en[k]; !ok {
			en[k] = v
		}
	}
}

func init() { // 捕获气泡来源图标（hud.go）
	en["来源应用"] = "Source app"
}

func init() { // 空状态（mainpanel.go emptyQueue / emptySection）
	for k, v := range map[string]string{
		"连按两次 %s": "Double-tap %s", "选中文字，连按两次 %s": "Select text, then double-tap %s", "在任何应用里都可以": "Works in any app",
		"把剪贴板内容收成第一张卡": "Turn clipboard into the first card", "剪贴板里没有文字": "No text on the clipboard", "把卡片拖到这里": "Drag cards here",
		"捕获的内容会存到这里": "Captures are saved here", "捕获的内容将存入「%s」": "Captures will be saved to “%s”", "保存失败：": "Save failed: ",
	} {
		if _, ok := en[k]; !ok {
			en[k] = v
		}
	}
}

func init() { // 菜单栏图标状态（tray_icon.go）
	for k, v := range map[string]string{
		"权限需要处理": "Permission needs attention", "有逾期任务": "Overdue tasks", "已暂停剪贴板收集": "Clipboard collection paused", "隐身模式": "Stealth mode",
		"菜单栏显示下一个到期": "Show next due time in menu bar",
		"图标旁显示今天下一个任务的到期时间；图标本身会标出暂停、隐身、逾期与权限状态": "Shows today's next task due time beside the icon; the icon itself marks paused, stealth, overdue and permission states",
	} {
		if _, ok := en[k]; !ok {
			en[k] = v
		}
	}
}

func init() { // 速记本地解析（tasks_quick.go）
	for k, v := range map[string]string{"点一下不采用，保留原文": "Click to ignore and keep the words", "点一下重新采用": "Click to use again", "已加到 %s": "Added for %s"} {
		if _, ok := en[k]; !ok {
			en[k] = v
		}
	}
}

func init() { // 订阅页洞察（bill_insights.go）
	for k, v := range map[string]string{
		"折合每年 %s": "%s per year", "未来 30 天": "Next 30 days", "%d 笔，合计 %s": "%d charges, %s total", "还剩 %d 天": " in %d days", "就在今天": " today",
		"%s 首次扣款%s": "%s: first charge%s", "到期自动扣 %s": "Charges %s automatically", "下一期起": "From next period", "%d月起": "Since month %d",
		"%s 涨价了": "%s went up", "%s %s 变 %s": "%s %s to %s", "查看": "View", "较上月 +%s": "+%s vs last month", "较上月 −%s": "−%s vs last month",
	} {
		if _, ok := en[k]; !ok {
			en[k] = v
		}
	}
}

func init() { // 详情窗查找 / 大纲 / 进度（detail_find.go）
	for k, v := range map[string]string{
		"文内查找": "Find in card", "在这张卡里查找": "Find in this card", "查找内容": "Find text", "无结果": "No results", "上一个（⇧⏎）": "Previous (⇧⏎)",
		"下一个（⏎）": "Next (⏎)", "关闭查找（Esc）": "Close find (Esc)", "大纲": "Outline", "跳到：": "Jump to: ", "阅读进度": "Reading progress",
	} {
		if _, ok := en[k]; !ok {
			en[k] = v
		}
	}
}

func init() { // AI 流式核对与自定义动作（ai_review.go / ai_settings.go）
	for k, v := range map[string]string{
		"AI 没有改动内容": "AI made no changes", "已采纳 · ": "Applied · ", "生成中，已 %d 秒": "Generating, %d s", "全文结果，不逐段比对": "Full result, no per-block diff",
		"%d 处改动，已处理 %d 处": "%d changes, %d handled", "%d 处改动": "%d changes", "等待 AI 返回…": "Waiting for AI…", "原文": "Original", "结果": "Result",
		"采纳": "Accept", "还原": "Revert", "已采纳": "Accepted", "已还原": "Reverted", "（这一段已删除）": "(this block was removed)", "撤回": "Undo", "停止": "Stop",
		"另存为新卡": "Save as new card", "全部还原": "Discard all", "全部采纳 ⌘⏎": "Accept all ⌘⏎", "替换原文 ⌘⏎": "Replace original ⌘⏎", "应用 ⌘⏎": "Apply ⌘⏎",
		"润色 / 精简 / 翻译 / 写成提示词；结果在详情窗里边生成边显示，逐段采纳后写回原卡": "Polish / shorten / translate / turn into a prompt; results stream into the detail window and are applied block by block",
		"自定义动作": "Custom actions", "AI 处理选中内容…": "AI is processing the selection…", "选中的内容已变化，没有替换": "The selection changed; nothing was replaced",
		"已处理选中内容 · ": "Selection processed · ", "自定义动作的指令": "Instruction for the custom action", "名称加一句指令，出现在卡片右键 AI 菜单和详情窗「处理」里": "A name plus one instruction; shown in the card AI menu and the detail window's Process menu",
		"名称和指令都要填": "Name and instruction are both required", "名称最多 12 个字": "Name: 12 characters max", "指令最多 400 个字": "Instruction: 400 characters max",
		"最多 12 个自定义动作": "Up to 12 custom actions", "已有同名动作": "An action with this name already exists", "已删除自定义动作": "Custom action deleted",
		"名称，如「改成邮件」": "Name, e.g. “As email”", "指令，如「把下面的文字改写成礼貌的工作邮件」": "Instruction, e.g. “Rewrite the text below as a polite work email”", "添加": "Add",
	} {
		if _, ok := en[k]; !ok {
			en[k] = v
		}
	}
}

func init() { // 今天页时间块与专注（today_blocks.go）
	for k, v := range map[string]string{
		"今天 %d / %d 完成": "Today %d / %d done", "%d 项逾期": "%d overdue", "%d 笔扣款": "%d charges", "%d 个日程": "%d events", "今天的时间轴": "Today's timeline",
		"空档 %d 分钟": "%d min free", "点击在「日历」中打开": "Click to open in Calendar", "专注中": "Focusing", "开始专注": "Start focus", "结束专注": "End focus",
		"拖动改时长": "Drag to change duration", "已排到 %s": "Scheduled at %s", "已清除时长": "Duration cleared", "时长 %s": "Duration %s", "%d 小时 %d 分钟": "%d h %d min",
		"时长": "Duration", "清除时长": "Clear duration", "未排期": "Unscheduled", "拖到时间轴上排时间": "Drag onto the timeline to schedule",
		"还有 %d 项，在「任务」里查看": "%d more in Tasks", "专注时间到 · %s": "Focus time is up · %s", "专注": "Focus", "专注中，剩 %d 分钟": "Focusing, %d min left",
		"已完成 · %s": "Done · %s", "延后": "Later", "结束": "End", "专注 %d 分": "Focus %d m",
	} {
		if _, ok := en[k]; !ok {
			en[k] = v
		}
	}
}

func init() { // 截图识别文字：选行 / 二维码 / 表格（shot_pick.go）
	for k, v := range map[string]string{
		"识别出的文字行": "Recognized text lines", "在选区里点选或拖框，只取其中几行": "Click or drag in the selection to take only some lines", "已选 %d / %d 行": "%d of %d lines selected",
		"二维码内容": "QR code content", "打开链接": "Open link", "复制内容": "Copy content", "复制为表格": "Copy as table",
	} {
		if _, ok := en[k]; !ok {
			en[k] = v
		}
	}
}

func init() { // 同时发到多个应用与回复对比（fanout.go）
	for k, v := range map[string]string{
		"没有发到任何应用": "Nothing was sent to any app", "已发到 %s": "Sent to %s", "只发到了 %s（共选了 %d 个）": "Only sent to %s (%d selected)", "已停止；之前已发到 %s": "Stopped; already sent to %s",
		"同时发到": "Send to several", "同时发到…": "Send to several…", "已选 %d / %d": "%d / %d selected", "至少选 2 个应用": "Pick at least 2 apps", "发到 %d 个应用": "Send to %d apps",
		"已收为 %s 的回复 · 已有 %d 家，右键可对比": "Saved as %s's reply · %d so far, right-click to compare", "已收为 %s 的回复": "Saved as %s's reply",
		"至少收到两家的回复才能对比": "Need replies from at least two apps to compare", "对比回复": "Compare replies", "对比回复 · %d 个应用": "Compare replies · %d apps",
		"返回这张卡": "Back to this card", "%d 字": "%d chars", "浅底：不是每家都说到的内容；灰字：各家一致": "Tinted: not said by every app; grey: all agree",
		"对比各应用的回复（%d 家）": "Compare replies across apps (%d)",
	} {
		if _, ok := en[k]; !ok {
			en[k] = v
		}
	}
}

func init() { // 正式版接续旧版数据（legacy_adopt.go）
	en["已升级到新版，数据都在（%d 条内容）"] = "Upgraded. Your data is all here (%d items)"
}

func init() { // 旧版数据没接上时的横幅与提示（legacy_adopt.go）
	for k, v := range map[string]string{
		"已升级到新版；有 %d 项内容没能原样带过来，旧版数据仍完整保留（详见 设置 → 诊断）": "Upgraded; %d items could not be carried over as-is. Your old data is kept intact (see Settings → Diagnostics)",
		"还是没接上：": "Still not connected: ", "旧版的数据还没显示出来": "Your data from the previous version isn't showing yet",
		"数据没有丢，仍完整保存在原处。原因：": "Nothing is lost; it is still stored where it was. Reason: ", "重试": "Retry",
		"旧版的数据文件读不出来（详情见 设置 → 诊断）": "The previous version's data file can't be read (details in Settings → Diagnostics)",
	} {
		if _, ok := en[k]; !ok {
			en[k] = v
		}
	}
}
