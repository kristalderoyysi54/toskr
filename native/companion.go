package main

import (
	"slices"

	"github.com/egoist/mygo"

	"github.com/toskr/native/internal/macos"
)

const panelW, panelMargin = 380, 10 // 与 Tauri 主窗口默认宽 380 一致

// panelBounds：目标是伴随应用（终端 / 编辑器）且能读到其焦点窗口时，面板磁吸到
// 该窗口右缘外侧（放不下则贴在窗口内侧右缘），高度跟随窗口；否则贴光标所在屏右缘全高。
// 对应 Tauri 版 companion 停靠的定位部分；「跟随移动缩放」与贴边隐藏未移植。
func (a *app) panelBounds() mygo.Rectangle {
	d := mygo.Screen.DisplayNearestPoint(mygo.Screen.CursorScreenPoint())
	wa := d.WorkArea
	def := mygo.Rectangle{X: wa.X + wa.Width - panelW - panelMargin, Y: wa.Y + panelMargin, Width: panelW, Height: wa.Height - panelMargin*2}
	if st := a.store.Settings(); a.target.PID == 0 || st.CompanionOff || !slices.Contains(st.Companion, a.target.BundleID) {
		return def
	}
	f, ok := macos.FocusedWindowFrame(a.target.PID)
	if !ok {
		return def
	}
	return dockBeside(f, wa)
}

func dockBeside(f macos.Rect, wa mygo.Rectangle) mygo.Rectangle {
	x := int(f.X+f.W) + 6
	if x+panelW > wa.X+wa.Width-panelMargin {
		x = int(f.X+f.W) - panelW - 6 // 窗口贴满屏宽：放进窗口内侧
	}
	y, h := max(int(f.Y), wa.Y+panelMargin), int(f.H)
	h = min(max(h, 360), wa.Y+wa.Height-panelMargin-y)
	return mygo.Rectangle{X: max(x, wa.X+panelMargin), Y: y, Width: panelW, Height: h}
}
