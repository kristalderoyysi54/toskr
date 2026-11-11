package main

import (
	"slices"
	"sync/atomic"
	"time"

	"github.com/egoist/mygo"

	"github.com/toskr/native/internal/diag"
	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// 伴随跟随（同 Tauri start_companion_tracker）：面板显示且「跟随应用」开着时，每 60ms 读一次吸附目标的焦点窗口，
// 位置 / 尺寸变了就把面板挪过去——拖动、缩放、换屏都跟着走。规则同原版：
//   - 前台切到伴随列表里的另一个应用 → 换吸附目标；切到列表外的应用 / 桌面 → 不追，面板原地保持；
//   - 目标没有可吸附的窗口（小于 480×300 的对话框、最小化、已退出）→ 解除吸附、恢复置顶设置，继续观望；
//   - 新建立吸附 → 取消置顶（与目标同层级）、清掉贴边隐藏锚点；目标应用被激活 → 面板一起浮到前面（不抢焦点）。
// AX 读窗口在后台 goroutine（目标应用卡住时 AX 会阻塞，不能放主线程），挪窗口回到主线程。

const (
	companionTick                = 60 * time.Millisecond
	minTargetW, minTargetH       = 480, 300 // 同 Tauri MIN_TARGET_W / H：更小的窗口（对话框等）不吸附
	companionTrackOff      int32 = 0
)

type companionTracker struct {
	pid       atomic.Int32 // 当前吸附目标（0 = 不跟踪）；主线程写，后台读
	attached  bool         // 跟踪器已建立吸附（取消置顶、清贴边锚点做过了）
	lastFrame macos.Rect
	lastFront int32
	running   atomic.Bool
}

// startCompanionTracker：常驻后台轮询；不跟踪时只读一个原子量，几乎零开销。
func (a *app) startCompanionTracker() {
	if !a.comp.running.CompareAndSwap(false, true) {
		return
	}
	go func() {
		for range time.Tick(companionTick) {
			pid := a.comp.pid.Load()
			if pid == companionTrackOff {
				continue
			}
			front, _ := a.sys.Frontmost()
			frame, ok := macos.FocusedWindowFrame(pid)
			ok = ok && frame.W >= minTargetW && frame.H >= minTargetH
			mygo.RunOnMain(func() { a.companionApply(pid, front, frame, ok) })
		}
	}()
}

// syncCompanionTracking：按当前状态决定跟不跟（唤出面板、改「跟随应用」后调用）。目标在伴随列表里就跟它；
// 不在列表里则保持现状（同原版：切到列表外的应用不追，也不放弃原吸附目标）。
func (a *app) syncCompanionTracking() {
	st := a.store.Settings()
	if a.panel == nil || !a.panel.IsVisible() || st.CompanionOff {
		a.stopCompanionTracking()
		return
	}
	if a.target.PID != 0 && slices.Contains(st.Companion, a.target.BundleID) && a.comp.pid.Load() != int32(a.target.PID) {
		a.comp.pid.Store(int32(a.target.PID))
		a.comp.lastFrame = macos.Rect{}
	}
}

// stopCompanionTracking：停止跟踪并解除接管（docked 同时是贴边隐藏与拖拽入坞的否决门，不能留着 true）。
func (a *app) stopCompanionTracking() {
	a.comp.pid.Store(companionTrackOff)
	a.comp.lastFrame, a.comp.attached = macos.Rect{}, false
	if a.docked {
		a.docked = false
		if a.panel != nil {
			a.panel.SetAlwaysOnTop(!a.store.Settings().PanelNotOnTop)
		}
	}
}

// companionApply：主线程上处理一拍轮询结果。
func (a *app) companionApply(pid int32, front macos.FrontApp, frame macos.Rect, ok bool) {
	if a.comp.pid.Load() != pid || a.panel == nil || !a.panel.IsVisible() || a.panelHiding {
		return
	}
	st := a.store.Settings()
	if st.CompanionOff {
		a.stopCompanionTracking()
		return
	}
	if next := companionSwitch(pid, front, int32(a.sys.SelfPID()), st.Companion); next != pid {
		a.comp.pid.Store(next) // 换到列表里的另一个应用：下一拍按它吸附
		a.comp.lastFrame = macos.Rect{}
		return
	}
	if !ok { // 目标没有可吸附窗口：原地不动，恢复自由拖动与置顶设置
		if a.comp.attached || a.docked {
			a.docked, a.comp.attached = false, false
			a.panel.SetAlwaysOnTop(!st.PanelNotOnTop)
			diag.Push("伴随: 目标不可用，恢复自由拖动")
		}
		a.comp.lastFrame = macos.Rect{}
		a.comp.lastFront = int32(front.PID)
		return
	}
	newly := !a.comp.attached
	rise := int32(front.PID) == pid && a.comp.lastFront != pid
	a.comp.lastFront = int32(front.PID)
	if newly {
		a.docked, a.comp.attached = true, true
		a.panel.SetAlwaysOnTop(false) // 与目标同层级：切走时被别的窗口正常盖住
		if a.edgeHidden {
			a.edgeSlideTo(false)
		}
		a.edge, a.edgeAway = nil, 0 // 伴随与贴边隐藏互斥
		diag.Push("伴随: 吸附 pid=%d", pid)
	}
	if rise && !newly {
		a.panel.ShowInactive() // 目标应用被激活：面板一起浮到前面，不抢焦点
	}
	if !newly && frame == a.comp.lastFrame {
		return
	}
	a.comp.lastFrame = frame
	d := mygo.Screen.DisplayNearestPoint(mygo.Point{X: int(frame.X + frame.W/2), Y: int(frame.Y + frame.H/2)})
	w, _ := panelSize(st)
	r := dockBeside(frame, d.WorkArea, w, st.SidebarEdge == "left", st.Gap())
	if r == a.panel.Bounds() {
		return
	}
	a.placed = r
	a.edgeMachineUntil = time.Now().Add(250 * time.Millisecond) // 机器移动：不当成用户拖动
	a.panel.SetBounds(r)
}

// companionTarget：当前发送目标在伴随列表里（唤出时按它吸附）。
func (a *app) companionTarget(st store.Settings) bool {
	return a.target.PID != 0 && !st.CompanionOff && slices.Contains(st.Companion, a.target.BundleID)
}

// companionSwitch：前台是伴随列表里的另一个应用（不是自己）→ 换成它；否则保持 cur（切到列表外的应用不追）。
func companionSwitch(cur int32, front macos.FrontApp, self int32, list []string) int32 {
	if fp := int32(front.PID); fp != 0 && fp != self && fp != cur && slices.Contains(list, front.BundleID) {
		return fp
	}
	return cur
}
