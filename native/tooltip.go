package main

import "github.com/egoist/mygo/ui"

// 库自带控件（提示气泡、弹层、按钮）不认识主题：共用代码一律走这里的入口，由当前主题决定要不要自绘。

// buildCtx 是正在构建的那一帧的上下文（tok 每次取设计变量时记下），给拿不到 c 的助手函数挂提示用；只在主线程构建期间读写。
var buildCtx *ui.Context

// tipOf 给元素挂提示气泡，代替直接调 Element.Tooltip：主题不接管时用库的外观。
func tipOf(c *ui.Context, e ui.Element, s string) ui.Element {
	if theme().Tooltip(c, e, s) {
		return e
	}
	return e.Tooltip(s)
}

// rr：圆角档位。Tauri 的圆角都从 --radius 派生（sm 0.6 / md 0.8 / lg 1 / xl 1.4 / 2xl 1.8 …），默认 --radius 是 10px；
// 主题可以整体缩放（styleTheme.RadiusScale），所有用档位的元素一起变。
// 凡是档位值的圆角都经它换算；整圆 / 胶囊（rounded-full）与写死的像素值不经过它。
func rr(v float32) float32 { return v * theme().RadiusScale() }

// popoverOf 代替 ui.Popover：主题不接管时用库的面板外观。
func popoverOf(c *ui.Context, anchor ui.Element, open *bool, fn func()) ui.Element {
	if p, ok := theme().Popover(c, anchor, open, fn); ok {
		return p
	}
	return ui.Popover(c, anchor, open, fn)
}

// sheetBg：盖住整窗的浮层（新手导览、迁移向导、预检对话框等）的底色：默认取库主题的窗口底色。
func sheetBg(c *ui.Context) ui.Color {
	if bg, ok := theme().SheetBg(); ok {
		return bg
	}
	return c.Theme().Background
}

// btnOf 代替 ui.Button：主题不接管时用库的按钮。
func btnOf(c *ui.Context, label string) ui.Element {
	if b, ok := theme().Button(c, label); ok {
		return b
	}
	return ui.Button(c, label)
}

// scrolledOf：滚动区；主题可以在旁边挂自绘滚动条。build 里建 ui.Scroll 并 TrackScroll(s)。
func scrolledOf(c *ui.Context, k tokens, s *ui.ScrollState, build func()) {
	if !k.th.Scrolled(c, s, build) {
		build()
	}
}
