package main

import (
	"slices"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

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
	top := min(max(st.PanelTop, 0), max(fullH-panelMinH, 0)) // 顶部位置（拖上缘调，双击复位）
	if h <= 0 || h > fullH-top {
		h = fullH - top
	}
	h = max(h, min(panelMinH, fullH))
	def := mygo.Rectangle{X: wa.X + wa.Width - w - panelMargin, Y: wa.Y + panelMargin + top, Width: w, Height: h}
	a.docked = false
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
	a.docked = true
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
	next := panelFrameSettings(st, b, d.WorkArea, a.docked)
	if next.PanelWidth != st.PanelWidth || next.PanelHeight != st.PanelHeight || next.PanelX != st.PanelX || next.PanelY != st.PanelY || next.PanelTop != st.PanelTop {
		_ = a.store.SetSettings(next)
	}
}

func (a *app) placePanel() {
	a.placed = a.panelBounds()
	a.panel.SetBounds(a.placed)
}

// panelFrameSettings：由面板实际位置推出要记住的宽、高、顶部下移量（贴屏右缘时）与自由移动位置。
// 高度到底（铺满剩余高度）记为自动；伴随停靠时位置跟随别人的窗口，不改顶部下移量。
func panelFrameSettings(st store.Settings, b, wa mygo.Rectangle, docked bool) store.Settings {
	fullH := wa.Height - panelMargin*2
	next := st
	next.PanelWidth = min(max(b.Width, panelMinW), panelMaxW)
	if next.PanelWidth == panelW {
		next.PanelWidth = 0
	}
	top := st.PanelTop
	switch {
	case st.FreeMove:
		next.PanelX, next.PanelY = b.X, b.Y
	case !docked:
		top = min(max(b.Y-(wa.Y+panelMargin), 0), max(fullH-panelMinH, 0))
		next.PanelTop = top
	}
	next.PanelHeight = b.Height
	if b.Height >= fullH-top-2 {
		next.PanelHeight = 0
	}
	return next
}

// resetPanelVertical 同 Tauri resetVertical：顶部回到贴顶、高度回到自动铺满。
func (a *app) resetPanelVertical() {
	st := a.store.Settings()
	st.PanelTop, st.PanelHeight = 0, 0
	_ = a.store.SetSettings(st)
	if a.panel != nil {
		a.placePanel()
	}
	a.showHUD("ok", tr("已复位自动高度"))
}

// toggleDensity：卡片舒适 ⇄ 紧凑（Platinum 收起框，同 Tauri PlatinumBox shade）。
func (a *app) toggleDensity() {
	st := a.store.Settings()
	if st.CardDensity == "compact" {
		st.CardDensity = "comfortable"
	} else {
		st.CardDensity = "compact"
	}
	_ = a.store.SetSettings(st)
}

type vDrag struct {
	edge   string
	from   mygo.Point
	bounds mygo.Rectangle
}

// panelVHandles 同 Tauri 上 / 下缘高度把手：拖动调整顶部位置或高度，双击复位自动高度。
func (a *app) panelVHandles(c *ui.Context, k tokens) {
	for _, edge := range []string{"top", "bottom"} {
		label := tr("拖拽调整顶部位置 · 双击复位自动高度")
		if edge == "bottom" {
			label = tr("拖拽调整高度 · 双击复位自动高度")
		}
		h := ui.Box(c).Absolute().Left(16).Right(16).Height(6).Key("vh-" + edge).Cursor(ui.CursorResizeRow).Tooltip(label).Label(label)
		if edge == "top" {
			h.Top(0)
		} else {
			h.Bottom(0)
		}
		if h.Hovered() || a.vdrag.edge == edge {
			h.Background(c.Theme().Accent.Alpha(0.25))
		}
		if h.DoubleClicked() {
			a.vdrag = vDrag{}
			a.resetPanelVertical()
			continue
		}
		if a.panel == nil {
			continue
		}
		switch {
		case h.Pressed() && a.vdrag.edge == "":
			a.vdrag = vDrag{edge: edge, from: mygo.Screen.CursorScreenPoint(), bounds: a.panel.Bounds()}
		case h.Pressed() && a.vdrag.edge == edge:
			p := mygo.Screen.CursorScreenPoint()
			r := a.vdrag.bounds
			dy := p.Y - a.vdrag.from.Y
			if edge == "top" {
				dy = min(dy, r.Height-panelMinH)
				r.Y, r.Height = r.Y+dy, r.Height-dy
			} else {
				r.Height = max(r.Height+dy, panelMinH)
			}
			if r != a.panel.Bounds() {
				a.panel.SetBounds(r)
			}
			c.Invalidate()
		case !h.Pressed() && a.vdrag.edge == edge:
			a.vdrag = vDrag{}
			a.rememberPanelFrame()
		}
	}
}
