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
	"剪贴": "Clip", "笔记": "Notes", "未识别目标": "No target", "可发送": "Ready", "此分组为空": "Empty section",
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
}
