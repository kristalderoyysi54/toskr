package main

import "github.com/egoist/mygo/ui"

// 列表行 / 卡片上的图标钮（同 Tauri IconButton 的 surface 与 ghost 两种用法），统一四态：
// 静息 → 悬停（描边加深或浅底 + 图标转前景色，删除类转红）→ 按下缩 0.94 → 过渡 100ms。

// floatIconButton：卡面悬浮钮（IconButton surface）：实底不透明，悬停描边 10% → 25%、图标 muted → 前景。
// on = 开关型按下态（置顶等）。返回元素，调用方取 Clicked() 或挂 Menu()。
func floatIconButton(c *ui.Context, k tokens, key, icon, tip string, danger, on bool) ui.Element {
	b := ui.Box(c).Size(22, 22).Radius(8).Center().Key(key).Tooltip(tip).Role(ui.RoleButton).Label(tip).
		Shadow(0, 1, 2, 0, k.floatShadowA).Shadow(0, 6, 16, -4, k.floatShadowB).InsetShadow(0, 1, 0, 0, k.floatInset)
	hov := b.Hovered()
	bg, border, col := k.floatBtn, k.floatBorder, k.muted
	if on {
		bg, col = k.pressed, k.fg
	}
	if hov {
		border, col = k.fg.Alpha(0.25), k.fg
		if danger {
			col = k.danger
		}
	}
	fadeColor(b, "bg", bg, tweenControl)
	b.Border(1, border)
	b.AnimatePose(ui.Pose{Scale: pressScale(b.Pressed(), 0.94)}, tweenControl)
	b.Children(func() { licon(c, icon, 12, col) })
	return b
}

// ghostIconButton：行内透明图标钮（IconButton 默认 / danger tone）：悬停浅底（删除类红色 10%）+ 图标转前景 / 红。
// show = false 时隐形但仍占位（同 reveal="hover-focus"：行悬停才显出），悬停到按钮本身时照样显出。
func ghostIconButton(c *ui.Context, k tokens, key, icon, tip string, box, size float32, danger, show bool) ui.Element {
	b := ui.Box(c).Size(box, box).Radius(6).Center().Key(key).Tooltip(tip).Role(ui.RoleButton).Label(tip)
	hov := b.Hovered()
	bg, col := ui.Transparent, k.muted
	if hov {
		bg, col = k.track, k.fg
		if danger {
			bg, col = k.danger.Alpha(0.1), k.danger
		}
	}
	if !show && !hov {
		b.Opacity(0)
	}
	fadeColor(b, "bg", bg, tweenControl)
	b.AnimatePose(ui.Pose{Scale: pressScale(b.Pressed(), 0.94)}, tweenControl)
	b.Children(func() { licon(c, icon, size, col) })
	return b
}

// hoverLink：文字 / 图标链接型入口的悬停态——浅底 + 文字转前景色，返回该用的前景色。
func hoverLink(b ui.Element, k tokens) ui.Color {
	if b.Hovered() {
		fadeColor(b, "bg", k.track, tweenControl)
		return k.fg
	}
	fadeColor(b, "bg", ui.Transparent, tweenControl)
	return k.muted
}
