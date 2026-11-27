package main

// 标题栏 ☰ 菜单分节、常用区拖动、分组文件夹、减弱动态效果的英文（2026-11-18）。只补缺：表里已有的不覆盖。
func init() {
	for k, v := range map[string]string{
		"视图": "View", "整理": "Tidy", "列表与面板选项": "List & panel options", "全部展开": "Expand all", "全部折叠": "Collapse all",
		"常用": "Favorites", "设为常用": "Add to Favorites", "已设为常用": "Added to Favorites", "%d 条已设为常用": "%d added to Favorites",
		"已取消常用": "Removed from Favorites",
		"整批操作":  "Bulk actions", "全部归到（%d 条）": "File all (%d)", "全部标为完成": "Mark all done", "全部删除": "Delete all", "全部删除（%d 条）…": "Delete all (%d)…", "删除收件箱里的 %d 条？": "Delete %d inbox items?", "已完成的条目不受影响。": "Completed items are not affected.",
		"已清空收件箱 · 删除 %d 条": "Inbox cleared · %d deleted", "收件箱 %d 条已标为完成": "%d inbox items marked done",
		"细": "Thin", "中": "Medium", "粗": "Thick", "颗粒：小": "Grain: small", "颗粒：中": "Grain: medium", "颗粒：大": "Grain: large",
		"红": "Red", "黄": "Yellow", "绿": "Green", "蓝": "Blue", "白": "White", "黑": "Black",
		"直线": "Line", "矩形": "Rectangle", "椭圆": "Ellipse", "箭头": "Arrow", "画笔": "Pen", "文字": "Text", "马赛克": "Mosaic", "聚光灯": "Spotlight", "序号": "Number", "批注": "Callout", "裁剪": "Crop",
		"圆角与阴影": "Corner & shadow", "圆角": "Corner radius", "阴影": "Shadow", "阴影浓淡": "Shadow opacity",
		"撤销 ⌘Z": "Undo ⌘Z", "重做 ⇧⌘Z": "Redo ⇧⌘Z", "长截屏": "Scrolling capture", "图内翻译": "Translate image", "取消翻译": "Remove translation",
		"钉在屏幕上": "Pin to screen", "打码编辑": "Redact", "发送到当前目标": "Send to target", "另存为…": "Save as…",
		"取消 Esc": "Cancel Esc", "关闭 Esc": "Close Esc", "完成 ⏎ · 长按选分组": "Done ⏎ · Hold for group",
		"更新钉图 ⏎ · 长按选分组": "Update pin ⏎ · Hold for group", "替换原图 ⏎ · 长按选分组": "Replace image ⏎ · Hold for group", "替换草稿图 ⏎": "Replace draft ⏎",
		"放弃长截屏": "Cancel capture", "完成长截屏": "Finish capture",
		"%s · 已发送 %d 次 · 点一下发送，拖动换位置": "%s · sent %d times · click to send, drag to reorder",
		"展开分组": "Expand group", "折叠分组": "Collapse group",
		"归到「%s」": "File to “%s”", "%d 条有建议分组": "%d with a suggested group",
		"收起收件箱": "Collapse Inbox", "展开收件箱": "Expand Inbox", "收件箱：还没归类的内容。把卡拖到这里放回收件箱": "Inbox: items not filed yet. Drop a card here to send it back",
		"%d 条 · %s": "%d · %s", "归入": "File", "把这 %d 条归到「%s」（可撤销）": "File these %d to “%s” (undoable)",
		"减弱动态效果": "Reduce motion", "关闭滑动、缩放、弹簧等过渡，界面变化直接到位": "Turn off slide, zoom and spring transitions; changes apply instantly",
	} {
		if _, ok := en[k]; !ok {
			en[k] = v
		}
	}
}
