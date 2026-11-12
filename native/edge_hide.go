package main

import (
	"os"
	"slices"
	"time"

	"github.com/egoist/mygo"

	"github.com/toskr/native/internal/diag"
	"github.com/toskr/native/internal/macos"
)

// 拖拽入坞 + 贴边自动收起（同 Tauri window.rs evaluate_drag_dock / spawn_edge_hide_supervisor / edge_hide_now）：
// 手动把面板拖到所在屏物理右边界 24pt 内（且右侧没有别的屏）→ 吸平右缘并记下锚点；
// 之后光标离开面板 600ms 就向右滑出、只留 3pt 细条，光标顶到该屏右缘即滑回并取得焦点；
// 失焦 / Esc 收起时也改为滑出。伴随停靠接管定位时不生效；默认出现位置不算入坞。
// 旧设置 EdgeHide 不再门控（同 Tauri runtimeSettings：运行态恒开，是否收起由入坞锚点裁决）。

const (
	edgeGrace     = 600 * time.Millisecond
	edgeTick      = 100 * time.Millisecond
	edgeSlide     = 240 * time.Millisecond
	edgePeek      = 3
	edgeSnap      = 24
	edgeTouchSlop = 24
	dockDebounce  = 400 * time.Millisecond
)

type edgeAnchor struct {
	x, y, w, h int  // 展开位（已吸平右缘）
	line       int  // 该屏物理右边界
	monY, monH int  // 横轴沿屏缘的范围（右缘 = 纵向 y / 高；上下缘 = 横向 x / 宽）
	sidebar    bool // 屏幕边栏模式的锚点（同 Tauri 四缘边栏都是贴边隐藏候选）：切到自由移动 / 伴随停靠即作废
	axis       int  // 贴哪条边：edgeRight / edgeBottom / edgeTop
}

const (
	edgeRight = iota
	edgeBottom
	edgeTop
)

// dockLine：面板 r 的右缘在所在屏物理右边界 edgeSnap 内（含拖出屏外），且越过这条线没有别的屏 → 返回该线。
func dockLine(displays []mygo.Display, r mygo.Rectangle) (line, monY, monH int, ok bool) {
	cy := r.Y + r.Height/2
	at := func(x, y int) *mygo.Display {
		for i := range displays {
			b := displays[i].Bounds
			if x >= b.X && x < b.X+b.Width && y >= b.Y && y < b.Y+b.Height {
				return &displays[i]
			}
		}
		return nil
	}
	d := at(r.X+r.Width/2, cy)
	if d == nil {
		if d = at(r.X+2, cy); d == nil {
			if d = at(r.X+r.Width-2, cy); d == nil {
				return 0, 0, 0, false
			}
		}
	}
	b := d.Bounds
	line = b.X + b.Width
	if r.X+r.Width >= line-edgeSnap && at(line+2, cy) == nil {
		return line, b.Y, b.Height, true
	}
	return 0, 0, 0, false
}

func (e edgeAnchor) inside(cx, cy int) bool { // 主轴外侧延伸到屏缘（含面板与屏缘之间的空隙）
	switch e.axis {
	case edgeBottom:
		return cy >= e.y && cy <= e.line && cx >= e.x && cx <= e.x+e.w
	case edgeTop:
		return cy >= e.line && cy <= e.y+e.h && cx >= e.x && cx <= e.x+e.w
	}
	return cx >= e.x && cx <= e.line && cy >= e.y && cy <= e.y+e.h
}

func (e edgeAnchor) touching(cx, cy int) bool { // 顶到该屏缘任意位置都唤回（同 Tauri Dock 对齐）
	along, cross := cx, cy
	if e.axis != edgeRight {
		along, cross = cy, cx
	}
	return along >= e.line-edgeTouchSlop && along <= e.line+edgeTouchSlop && cross >= e.monY && cross < e.monY+e.monH
}

// hiddenAt：滑出后面板在主轴上的坐标（只留 edgePeek 细条）；shownAt 为展开位。
func (e edgeAnchor) hiddenAt() int {
	switch e.axis {
	case edgeBottom:
		return e.line - edgePeek
	case edgeTop:
		return e.line - e.h + edgePeek
	}
	return e.line - edgePeek
}

func (e edgeAnchor) shownAt() int {
	if e.axis == edgeRight {
		return e.x
	}
	return e.y
}

func (e edgeAnchor) pos(v int) (int, int) { // 主轴坐标 → 面板左上角
	if e.axis == edgeRight {
		return v, e.y
	}
	return e.x, v
}

// panelMovedByUser：OnMove 回调里调用。机器移动（吸平 / 滑动）不算；用户拖动清掉锚点并在停稳 400ms 后评估入坞。
func (a *app) panelMovedByUser() {
	if time.Now().Before(a.edgeMachineUntil) || a.edgeHidden {
		return
	}
	a.holdOpen, a.edgeArmed = false, true // 真实拖动解除快捷键保护（同 Tauri on_user_panel_move）
	if a.edge != nil {
		a.edge = nil
		diag.Push("贴边隐藏: 拖动清除锚点")
	}
	a.dockSeq++
	a.dockPending = true
	seq := a.dockSeq
	time.AfterFunc(dockDebounce, func() {
		a.onMain(func() {
			if a.dockSeq != seq {
				return
			}
			a.dockPending = false
			a.evaluateDragDock()
			if a.dragBlur { // 拖动期间失的焦：落定后再裁决——入坞了交给监督循环（光标离开再滑出），否则按失焦收起
				a.dragBlur = false
				if a.edge == nil && a.panel != nil && !a.panel.IsFocused() {
					a.blurHide()
				}
			}
		})
	})
}

// blurHide：面板失焦的收起裁决（已入坞改为贴边滑出；钉住 / 失焦不收起 / 快捷键保持展开时不动）。
func (a *app) blurHide() {
	if a.dockPending { // 正在拖动 / 刚落定：拖动已清掉锚点，此刻收起会把拖向屏缘的面板整个藏掉——等入坞评估后再裁决
		a.dragBlur = true
		return
	}
	if a.edgeHideNow(false) { // 已入坞：失焦改为贴边滑出（同 Tauri edge_hide_now）
		return
	}
	if !a.pinned && !a.store.Settings().KeepOnBlur && !a.holdOpen { // 快捷键唤出保持展开（同 Tauri shouldHidePanelOnBlur）
		a.hidePanel()
	}
}

func (a *app) evaluateDragDock() {
	if a.panel == nil || !a.panel.IsVisible() || a.docked || a.edgeHidden || a.pinnedFree() {
		return
	}
	b := a.panel.Bounds()
	line, monY, monH, ok := dockLine(mygo.Screen.Displays(), b)
	if !ok {
		diag.Push("贴边隐藏: 拖动落定未贴边 x=%d w=%d", b.X, b.Width)
		return
	}
	x := line - b.Width
	a.edge = &edgeAnchor{x: x, y: b.Y, w: b.Width, h: b.Height, line: line, monY: monY, monH: monH}
	a.edgeArmed, a.edgeAway = true, 0
	if x != b.X {
		a.machineMove(x, b.Y, 0)
		a.rememberPanelFrame()
	}
	diag.Push("贴边隐藏: 拖拽入坞 右缘=%d", line)
}

func (a *app) machineMove(x, y int, extra time.Duration) {
	a.edgeMachineUntil = time.Now().Add(250*time.Millisecond + extra)
	a.panel.SetPosition(x, y)
}

// noEdgeHide：实机自动化测试用（TOSKR_NO_EDGEHIDE=1）——测试代理的指针常在面板外，不让它滑走。
var noEdgeHide = os.Getenv("TOSKR_NO_EDGEHIDE") == "1"

// edgeTickOnce：监督循环一拍（主线程）。
func (a *app) edgeTickOnce() {
	e := a.edge
	if e == nil || a.panel == nil || !a.panel.IsVisible() || a.panelHiding || noEdgeHide {
		a.edgeAway = 0
		return
	}
	if a.docked || e.sidebar && a.store.Settings().FreeMove { // 伴随接管 / 边栏改成自由移动：滑回并作废边栏锚点
		if a.edgeHidden {
			a.edgeSlideTo(false)
		}
		if !a.docked {
			a.edge = nil
		}
		a.edgeAway = 0
		return
	}
	if a.pinnedFree() { // 保持展开 + 自由移动：不贴边隐藏（隐藏中立即滑回）
		if a.edgeHidden {
			a.edgeSlideTo(false)
		}
		a.edgeAway = 0
		return
	}
	cur := mygo.Screen.CursorScreenPoint()
	if a.edgeHidden {
		if e.touching(cur.X, cur.Y) {
			a.edgeSlideTo(false)
			a.panel.Show()
			a.panel.Focus() // 触边唤回是主动动作：前置并取焦点（同 Tauri set_focus）
		}
		a.edgeAway = 0
		return
	}
	if !a.edgeArmed || e.inside(cur.X, cur.Y) || a.menuOpen { // 原生右键菜单是模态跟踪，期间主线程不跑这一拍
		a.edgeAway = 0
		return
	}
	a.edgeAway += edgeTick
	if a.edgeAway >= edgeGrace {
		a.edgeAway = 0
		a.edgeSlideTo(true)
	}
}

// edgeSlideTo 滑出（hidden=true，只留 3pt 细条）或滑回展开位，240ms easeOut。
func (a *app) edgeSlideTo(hidden bool) {
	e := a.edge
	if e == nil || a.edgeHidden == hidden {
		return
	}
	a.edgeHidden = hidden
	b := a.panel.Bounds()
	from, to := b.X, e.shownAt()
	if e.axis != edgeRight {
		from = b.Y
	}
	if hidden {
		to = e.hiddenAt()
		a.saveDraftState()
		a.remaskAll()
	}
	diag.Push("贴边隐藏: %s", map[bool]string{true: "滑出", false: "滑回"}[hidden])
	a.edgeMachineUntil = time.Now().Add(edgeSlide + 150*time.Millisecond)
	a.edgeAnimSeq++
	seq, start := a.edgeAnimSeq, time.Now()
	var step func()
	step = func() {
		if a.edgeAnimSeq != seq {
			return
		}
		t := min(float64(time.Since(start))/float64(edgeSlide), 1)
		ease := 1 - (1-t)*(1-t)*(1-t)
		// 每帧续期「机器移动」窗口：主线程忙时动画会拖过开头给的 390ms，尾帧的 OnMove 会被当成用户拖动而清掉锚点，
		// 之后一次失焦就把面板整个收起（症状：触边唤回几次后面板消失）
		a.edgeMachineUntil = time.Now().Add(150 * time.Millisecond)
		a.panel.SetPosition(e.pos(from + int(float64(to-from)*ease)))
		if t < 1 {
			time.AfterFunc(8*time.Millisecond, func() { mygo.RunOnMain(step) })
		}
	}
	step()
}

// edgeHideNow：失焦 / Esc 的收起入口。有入坞锚点就滑出代替真正隐藏（explicit=Esc 越过图钉），返回是否已接管。
func (a *app) edgeHideNow(explicit bool) bool {
	if explicit { // Esc 解除快捷键保护（同 Tauri set_panel_auto_hide_armed "Esc"）
		a.edgeArmed, a.holdOpen = true, false
	}
	if a.edge == nil || a.docked || a.edgeHidden || !a.edgeArmed {
		return false
	}
	if !explicit && a.pinned || a.pinnedFree() {
		return false
	}
	a.edgeSlideTo(true)
	if explicit && a.target.PID != 0 {
		a.sys.Activate(a.target.PID)
	}
	return true
}

// edgeOnShow：面板被重新唤出时——隐藏态直接回到展开位；按记住的位置摆放时若正好贴着屏缘就恢复锚点（用户拖过才算）。
func (a *app) edgeOnShow() {
	a.edgeArmed, a.edgeAway = !a.holdOpen, 0
	if a.edgeHidden && a.edge != nil {
		a.edgeAnimSeq++
		a.edgeHidden = false
		x, y := a.edge.pos(a.edge.shownAt())
		a.machineMove(x, y, 0)
		return
	}
	st := a.store.Settings()
	if !st.FreeMove && !a.docked { // 屏幕边栏：每次唤出按当前所在屏重新锚定（同 Tauri show_panel right_sidebar 分支）
		b := a.panel.Bounds()
		if d, ok := displayAt(mygo.Screen.Displays(), b.X+b.Width/2, b.Y+b.Height/2); ok {
			db := d.Bounds
			e := edgeAnchor{x: b.X, y: b.Y, w: b.Width, h: b.Height, line: db.X + db.Width, monY: db.Y, monH: db.Height, sidebar: true}
			switch barEdge(st) {
			case "bottom":
				e.axis, e.line, e.monY, e.monH = edgeBottom, db.Y+db.Height, db.X, db.Width
			case "top":
				e.axis, e.line, e.monY, e.monH = edgeTop, db.Y, db.X, db.Width
			}
			a.edge = &e
		}
		return
	}
	if a.edge != nil && a.edge.sidebar {
		a.edge = nil
	}
	if a.edge == nil && st.FreeMove && (st.PanelX != 0 || st.PanelY != 0) && !a.docked {
		b := a.panel.Bounds()
		if line, monY, monH, ok := dockLine(mygo.Screen.Displays(), b); ok {
			a.edge = &edgeAnchor{x: line - b.Width, y: b.Y, w: b.Width, h: b.Height, line: line, monY: monY, monH: monH}
		}
	}
}

// startEdgeSupervisor：常驻轮询（100ms），在主线程走一拍（RunOnMain 不触发重绘）。
func (a *app) startEdgeSupervisor() {
	go func() {
		for range time.Tick(edgeTick) {
			mygo.RunOnMain(func() {
				a.observeFront()
				a.edgeTickOnce()
			})
		}
	}()
}

// observeFront 同 Tauri focus.rs 激活观察 + target.rs observe_front：记下最近一次处于前台的外部应用（不是 Toskr 自己），
// 并让发送目标跟着它走（面板钉住 / 常开时切到别的应用，目标条与发送都换过去）。
// 磁吸目标锁：伴随停靠中前台短暂切到伴随列表外的应用（截图工具等）不换目标。
func (a *app) observeFront() {
	f, ok := a.sys.Frontmost()
	if !ok || f.PID == 0 || f.PID == a.sys.SelfPID() || f.PID == a.lastFront.PID {
		return
	}
	a.lastFront = f
	diag.Push("外部前台 → %s pid=%d", f.BundleID, f.PID)
	if f.BundleID == "" || f.PID == a.target.PID {
		return // 无身份的浮层不当目标（同 Tauri observe_unavailable 保留旧目标）
	}
	st := a.store.Settings()
	if a.docked && slices.Contains(st.Companion, a.target.BundleID) && !slices.Contains(st.Companion, f.BundleID) {
		diag.Push("磁吸目标锁: 忽略瞬时前台切换，发送目标保持 %s", a.target.BundleID)
		return
	}
	a.target, a.targetStarted = f, macos.ProcessStartMs(f.PID)
	diag.Push("发送目标跟随前台 → %s", f.BundleID)
	if a.panel != nil && a.panel.IsVisible() {
		a.panel.Invalidate() // 目标条换应用
	}
}

func displayAt(displays []mygo.Display, x, y int) (mygo.Display, bool) {
	for _, d := range displays {
		b := d.Bounds
		if x >= b.X && x < b.X+b.Width && y >= b.Y && y < b.Y+b.Height {
			return d, true
		}
	}
	return mygo.Display{}, false
}

// pinnedFree：「保持面板展开」且屏幕位置为自由移动——用户 2026-11-10 指定此时不入坞、不贴边隐藏（含 Esc）。
// 有意偏离 Tauri（原版钉住只豁免失焦收起，入坞后光标离开仍滑出）。屏幕右侧 / 底部边栏照常贴边隐藏。
func (a *app) pinnedFree() bool { return a.pinned && a.store.Settings().FreeMove }
