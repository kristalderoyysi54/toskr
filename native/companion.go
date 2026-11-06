package main

import (
	"slices"

	"github.com/egoist/mygo"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

const panelW, panelMargin = 380, 10 // 与 Tauri 主窗口默认宽 380 一致

const (
	panelMinW, panelMaxW = 320, 720 // 拖拽调宽范围
	panelMinH            = 360
)

// panelSize：记住的宽（夹在范围内）与高（0 = 铺满可用高度）。
func panelSize(st store.Settings) (int, int) {
	w := panelW
	if st.PanelWidth > 0 {
		w = min(max(st.PanelWidth, panelMinW), panelMaxW)
	}
	return w, st.PanelHeight
}

// panelBounds：目标是伴随应用（终端 / 编辑器）且能读到其焦点窗口时，面板磁吸到该窗口一侧（默认右侧，放不下则贴内侧），
// 高度跟随窗口；自由移动时回到上次拖到的位置；否则贴光标所在屏右缘。宽度与高度用记住的值（同 Tauri）。
func (a *app) panelBounds() mygo.Rectangle {
	st := a.store.Settings()
	d := mygo.Screen.DisplayNearestPoint(mygo.Screen.CursorScreenPoint())
	wa := d.WorkArea
	w, h := panelSize(st)
	fullH := wa.Height - panelMargin*2
	if h <= 0 || h > fullH {
		h = fullH
	}
	h = max(h, min(panelMinH, fullH))
	def := mygo.Rectangle{X: wa.X + wa.Width - w - panelMargin, Y: wa.Y + panelMargin, Width: w, Height: h}
	if st.FreeMove && (st.PanelX != 0 || st.PanelY != 0) {
		r := mygo.Rectangle{X: st.PanelX, Y: st.PanelY, Width: w, Height: h}
		if onSomeScreen(r) {
			return r
		}
	}
	if a.target.PID == 0 || st.CompanionOff || !slices.Contains(st.Companion, a.target.BundleID) {
		return def
	}
	f, ok := macos.FocusedWindowFrame(a.target.PID)
	if !ok {
		return def
	}
	return dockBeside(f, wa, w, st.SidebarEdge == "left", st.Gap())
}

// onSomeScreen：矩形左上角落在某块屏的可用区内（换屏 / 拔显示器后不把面板放到屏外）。
func onSomeScreen(r mygo.Rectangle) bool {
	for _, d := range mygo.Screen.Displays() {
		wa := d.WorkArea
		if r.X >= wa.X-r.Width/2 && r.X < wa.X+wa.Width-40 && r.Y >= wa.Y-10 && r.Y < wa.Y+wa.Height-40 {
			return true
		}
	}
	return false
}

// gap：与窗口的间隙（Tauri companionGap）。
func dockBeside(f macos.Rect, wa mygo.Rectangle, w int, left bool, gap int) mygo.Rectangle {
	x := int(f.X+f.W) + gap
	if left {
		x = int(f.X) - w - gap
		if x < wa.X+panelMargin {
			x = int(f.X) + gap // 左边放不下：放进窗口内侧
		}
	} else if x+w > wa.X+wa.Width-panelMargin {
		x = int(f.X+f.W) - w - gap // 窗口贴满屏宽：放进窗口内侧
	}
	y, h := max(int(f.Y), wa.Y+panelMargin), int(f.H)
	h = min(max(h, panelMinH), wa.Y+wa.Height-panelMargin-y)
	return mygo.Rectangle{X: max(x, wa.X+panelMargin), Y: y, Width: w, Height: h}
}

// rememberPanelFrame：用户拖动 / 拉伸面板后记住宽、高（与铺满高度相同则记为自动）与自由移动位置。
func (a *app) rememberPanelFrame() {
	if a.panel == nil || !a.panel.IsVisible() {
		return
	}
	b := a.panel.Bounds()
	if b == a.placed {
		return
	}
	st := a.store.Settings()
	d := mygo.Screen.DisplayNearestPoint(mygo.Point{X: b.X + b.Width/2, Y: b.Y + b.Height/2})
	fullH := d.WorkArea.Height - panelMargin*2
	w, h := min(max(b.Width, panelMinW), panelMaxW), b.Height
	if h >= fullH-2 {
		h = 0
	}
	next := st
	next.PanelWidth, next.PanelHeight = w, h
	if w == panelW {
		next.PanelWidth = 0
	}
	if st.FreeMove {
		next.PanelX, next.PanelY = b.X, b.Y
	}
	if next.PanelWidth != st.PanelWidth || next.PanelHeight != st.PanelHeight || next.PanelX != st.PanelX || next.PanelY != st.PanelY {
		_ = a.store.SetSettings(next)
	}
}

func (a *app) placePanel() {
	a.placed = a.panelBounds()
	a.panel.SetBounds(a.placed)
}
