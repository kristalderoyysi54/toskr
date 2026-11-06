package main

import (
	"fmt"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/diag"
	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// 「定位原会话」（同 Tauri locate_source_conversation + locate_highlight.rs）：先把来源 IM 切到前台，
// 再经辅助功能在会话列表里找到该群并滚到可见，盖一个呼吸描边框（圆角 10、2pt amber、16% 底色）约 2 秒。
// 只读：不打开会话、不改已读。

const locatePad = 3

var ( // 测试替换
	locateConversation = macos.LocateConversation
	locateRunning      = macos.RunningPIDs
	locateActivate     = macos.Activate
)

func (a *app) locateMessage(m store.Message) {
	bundle := m.SourceBundle
	name := cmpOr(m.SourceApp, "IM")
	if bundle == "" {
		if p := a.store.Settings().IMProfile; p != nil {
			bundle, name = p.BundleID, cmpOr(m.SourceApp, p.AppName)
		}
	}
	if bundle == "" {
		a.showHUD("warn", tr("不知道这条消息来自哪个应用，先在设置里选择监听目标"))
		return
	}
	pids := locateRunning(bundle)
	if len(pids) == 0 {
		a.showHUD("warn", fmt.Sprintf(tr("%s 当前未运行"), name))
		return
	}
	conv := cmpOr(m.ConversationName, m.ConversationID)
	locateActivate(pids[0])
	go func() {
		time.Sleep(150 * time.Millisecond) // 等窗口到前台、列表完成布局
		started := time.Now()
		rect, res := locateConversation(pids[0], conv)
		diag.Push("IM 定位 结果=%d 耗时=%dms", res, time.Since(started).Milliseconds())
		a.panelUpdate(func() {
			switch res {
			case macos.LocateRow:
				a.showLocateHighlight(rect)
			case macos.LocateNotInList:
				a.showHUD("warn", fmt.Sprintf(tr("%s会话列表里没找到该群（列表可能处于搜索或过滤状态）"), name))
			default:
				a.showHUD("warn", fmt.Sprintf(tr("未能识别%s的会话列表（请确认主窗口已打开）"), name))
			}
		})
	}()
}

func (a *app) showLocateHighlight(r macos.Rect) {
	a.locateGen++
	gen := a.locateGen
	b := mygo.Rectangle{X: int(r.X) - locatePad, Y: int(r.Y) - locatePad, Width: int(r.W) + 2*locatePad, Height: int(r.H) + 2*locatePad}
	if a.locateWin == nil {
		if a.panel == nil {
			return // 视图测试
		}
		a.locateWin = mygo.NewWindow(mygo.WindowOptions{
			Title: "Toskr Locate", Panel: true, Frameless: true, Transparent: true, AlwaysOnTop: true, DisableResize: true, Hidden: true,
			X: b.X, Y: b.Y, Width: b.Width, Height: b.Height,
			Content: ui.View(a.locateView),
		})
		a.locateWin.SetIgnoreMouseEvents(true)
		a.locateWin.SetVisibleOnAllWorkspaces(true)
	}
	a.locateWin.SetBounds(b)
	a.locateWin.Invalidate()
	a.locateWin.ShowInactive()
	go func() {
		time.Sleep(2 * time.Second)
		a.locateWin.Update(func() {
			if a.locateGen == gen {
				a.locateWin.Hide()
			}
		})
	}()
}

func (a *app) locateView(c *ui.Context) {
	c.Root().Background(ui.Transparent)
	col := oklch(0.666, 0.179, 58.318, 1) // amber-600
	if c.Theme().Dark {
		col = oklch(0.828, 0.189, 84.429, 1) // amber-400
	}
	box := ui.Box(c).Fill().Radius(10).Border(2, col).Background(col.Alpha(0.16))
	if !c.Preferences().ReduceMotion { // 1.1s 透明度呼吸；减少动态效果时常亮
		box.Opacity(0.55 + 0.45*box.Loop("breathe", 1100*time.Millisecond, ui.Bounce(easeMInOut)))
	}
}
