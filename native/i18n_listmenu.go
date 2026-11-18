package main

// 标题栏 ☰ 菜单分节、常用区拖动、分组文件夹、减弱动态效果的英文（2026-11-18）。只补缺：表里已有的不覆盖。
func init() {
	for k, v := range map[string]string{
		"视图": "View", "整理": "Tidy", "列表与面板选项": "List & panel options", "全部展开": "Expand all", "全部折叠": "Collapse all",
		"常用": "Favorites", "设为常用": "Add to Favorites", "已设为常用": "Added to Favorites", "%d 条已设为常用": "%d added to Favorites",
		"已取消常用": "Removed from Favorites",
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
