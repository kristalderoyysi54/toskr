package main

import (
	"math"
	"strings"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
)

// 应用内确认窗：替代系统警告框（mygo.Dialog.Message），所有「要用户点头才继续」的确认都走 confirmAsk。
// - 随当前主题与明暗渲染（主题推钮、蚀刻框、直角窗）；
// - Esc、⌘W、关窗一律算取消——系统警告框认不出中文「取消」，Esc 曾落到第 0 个按钮（删除 / 发送原文）；
// - 危险操作只认 ⌘⏎ 或点按钮，单按 ⏎ 不确认，防误触；普通确认 ⏎ 即可。
// 源码检查 TestNoRawMessageDialogs 禁止再直接弹带按钮的系统警告框。

type confirmFact struct {
	label, value string
	tags         []string // 有 tags 时显示为一组胶囊，不显示 value
}

type confirmSpec struct {
	icon        string // lucide 图标名
	danger      bool   // 危险操作：图标与确认钮用危险色，⏎ 不确认
	title, body string
	facts       []confirmFact
	note        string // 底部补充说明（小字）
	ok          string // 确认按钮文字
}

// String：确认窗上全部文字（测试断言用）。
func (s confirmSpec) String() string {
	parts := []string{s.title, s.body}
	for _, f := range s.facts {
		parts = append(parts, f.label+"："+f.value+strings.Join(f.tags, "、"))
	}
	return strings.Join(append(parts, s.note, s.ok), "\n")
}

const confirmW = 400

type confirmWin struct {
	spec   confirmSpec
	win    *mygo.Window
	answer func(bool)
	h      int
	wa     mygo.Rectangle
}

func (cw *confirmWin) finish(ok bool) {
	if cw.answer == nil {
		return
	}
	f := cw.answer
	cw.answer = nil
	f(ok)
	if w := cw.win; w != nil {
		cw.win = nil
		mygo.RunOnMain(w.Destroy) // 不在构建帧里销毁自己的窗口
	}
}

// confirmAsk 弹确认窗并阻塞到用户选择，返回是否确认。只能在后台 goroutine 里调（主线程上会死锁）。
var confirmAsk = func(s confirmSpec) bool {
	ch := make(chan bool, 1)
	mygo.RunOnMain(func() { openConfirm(s, func(ok bool) { ch <- ok }) })
	return <-ch
}

func openConfirm(s confirmSpec, answer func(bool)) {
	cw := &confirmWin{spec: s, answer: answer, wa: mygo.Rectangle{Width: 1440, Height: 900}}
	p := mygo.Screen.CursorScreenPoint() // 落在用户正在看的那块屏
	if d, ok := displayNear(mygo.Screen.Displays(), p.X, p.Y); ok {
		cw.wa = d.WorkArea
	}
	glass := ""
	if liveApp != nil {
		glass = liveApp.store.Settings().Glass
	}
	h := 200 // 首帧量出内容高度后改为实际高度
	win := mygo.NewWindow(mygo.WindowOptions{
		Title: s.title, Width: confirmW, Height: h, UseContentSize: true,
		X: cw.wa.X + (cw.wa.Width-confirmW)/2, Y: cw.wa.Y + (cw.wa.Height-h)/3,
		AlwaysOnTop: true, DisableResize: true, DisableMinimize: true, DisableMaximize: true, DisableFullScreen: true,
		TitleBarStyle: mygo.TitleBarHidden, HideWindowButtons: true,
		Vibrancy: vibrancyFor(glass), Transparent: true,
		Content: ui.View(func(c *ui.Context) { confirmView(c, cw) }),
	})
	if theme().SquareWindows() {
		macos.MakeSquare(win.NativeHandle())
	}
	win.SetVisibleOnAllWorkspaces(true)
	win.OnClose(func(*mygo.CloseEvent) { cw.win = nil; cw.finish(false) })
	cw.win = win
	win.Show()
	win.Focus()
}

func confirmView(c *ui.Context, cw *confirmWin) {
	k, s := tok(c), cw.spec
	c.Root().Background(ui.Transparent)
	switch {
	case c.Shortcut(0, ui.KeyEscape):
		cw.finish(false)
		return
	case c.Shortcut(ui.Cmd, ui.KeyEnter), !s.danger && c.Shortcut(0, ui.KeyEnter):
		cw.finish(true)
		return
	}
	tone := stok(c).primary
	if s.danger {
		tone = k.danger
	}
	root := ui.Column(c).Width(confirmW).Padding(20, 20, 16, 20).Gap(14).Background(k.window).
		Role(ui.RoleDialog).Label(s.title).Key("confirm")
	root.Children(func() {
		ui.Row(c).Gap(12).AlignItems(ui.Start).Children(func() {
			ui.Box(c).Size(34, 34).Radius(rr(10)).Background(tone.Alpha(0.12)).Center().Children(func() { licon(c, s.icon, 17, tone) })
			ui.Column(c).Grow(1).Basis(0).Gap(4).Padding(1, 0, 0, 0).Children(func() {
				text(c, s.title, 14, 20, 600, k.fg).Wrap()
				if s.body != "" {
					text(c, s.body, 12, 18, 400, k.muted).Wrap()
				}
			})
		})
		if len(s.facts) > 0 {
			confirmFacts(c, k, s.facts, tone)
		}
		if s.note != "" {
			ui.Row(c).Gap(6).AlignItems(ui.Start).Children(func() {
				licon(c, "info", 12, k.muted).Margin(2, 0, 0, 0)
				text(c, s.note, 11, 16, 400, k.muted).Wrap().Grow(1).Basis(0)
			})
		}
		ui.Row(c).Gap(8).AlignItems(ui.Center).Padding(4, 0, 0, 0).Children(func() {
			ui.Box(c).Grow(1)
			if confirmButton(c, k, "cf-cancel", tr("取消"), "esc", false, tone) {
				cw.finish(false)
			}
			hint := "⏎"
			if s.danger {
				hint = "⌘⏎"
			}
			if confirmButton(c, k, "cf-ok", s.ok, hint, true, tone) {
				cw.finish(true)
			}
		})
	})
	// 窗口高度跟随内容（mygo 的 FitContent 不管原生视图）：量上一帧，变了就改窗口并要一帧收敛
	if h := int(math.Ceil(float64(root.Bounds().H))); h > 0 && h != cw.h {
		cw.h = h
		if w := cw.win; w != nil {
			wa := cw.wa
			mygo.RunOnMain(func() {
				w.SetContentSize(confirmW, h)
				w.SetPosition(wa.X+(wa.Width-confirmW)/2, wa.Y+(wa.Height-h)/3)
			})
		}
		c.Invalidate()
	}
}

// confirmFacts：关键信息表（用途 / 地址 / 命中类别）；长值单行截断，悬停看全文。
func confirmFacts(c *ui.Context, k tokens, facts []confirmFact, tone ui.Color) {
	box := ui.Column(c).Padding(10, 12).Gap(8).Radius(rr(10)).Key("cf-facts")
	if !k.th.Etched(box) {
		box.Background(k.track)
	}
	box.Children(func() {
		for _, f := range facts {
			ui.Row(c).Gap(10).AlignItems(ui.Start).Children(func() {
				text(c, f.label, 11, 20, 500, k.muted).SingleLine().Width(56)
				if len(f.tags) > 0 {
					ui.Row(c).Wrap().Gap(4).Grow(1).Basis(0).Children(func() {
						for _, t := range f.tags {
							ui.Row(c).Height(20).Padding(0, 7).Radius(10).AlignItems(ui.Center).Background(tone.Alpha(0.1)).
								Children(func() { text(c, t, 11, 14, 500, tone).SingleLine() })
						}
					})
					return
				}
				tipOf(c, text(c, f.value, 12, 20, 500, k.fg).SingleLine().Grow(1).Basis(0), f.value)
			})
		}
	})
}

// confirmButton：主操作实底（危险色 / 主色），取消为普通按钮；按钮里带键位提示。主题有推钮就用主题的。
func confirmButton(c *ui.Context, k tokens, key, label, hint string, primary bool, tone ui.Color) bool {
	st := stok(c)
	b := ui.Row(c).Height(30).Padding(0, 12).Gap(8).Radius(rr(8)).AlignItems(ui.Center).Shrink(0).
		Key(key).Role(ui.RoleButton).Label(label)
	if fg, w, ok := k.th.PushButton(b); ok {
		if primary {
			fg, w = tone, 600
		}
		b.Children(func() {
			text(c, label, 12, 17, w, fg).SingleLine()
			text(c, hint, 10, 14, 500, k.muted).SingleLine()
		})
		return b.Clicked()
	}
	fg, hintCol, w := st.btnFg, k.muted, 500
	if primary {
		bg := tone
		if b.Hovered() {
			bg = tone.Alpha(0.88)
		}
		fadeColor(b, "bg", bg, tweenControl)
		fg, hintCol, w = colWhite, colWhite.Alpha(0.7), 600
	} else { // 次操作：浅槽底 + 细边，深浅色都比主操作低一级（设置窗的按钮在深色下是亮底，会与主操作抢眼）
		bg := k.track
		if b.Hovered() {
			bg = k.hoverBg.Over(k.track)
		}
		fg = k.fg
		b.Border(1, k.inputBorder)
		fadeColor(b, "bg", bg, tweenControl)
	}
	b.AnimatePose(ui.Pose{Y: pressY(b.Pressed())}, tweenControl)
	b.Children(func() {
		text(c, label, 12, 17, w, fg).SingleLine()
		text(c, hint, 10, 14, 500, hintCol).SingleLine()
	})
	return b.Clicked()
}

func init() {
	for k, v := range map[string]string{
		"删除 AI 密钥？": "Delete AI key?", "删除后 AI 功能会停止，且 Toskr 无法恢复原密钥。": "AI features stop, and Toskr can't recover the key.",
		"从钥匙串删除": "Delete from Keychain", "位置": "Location", "macOS 钥匙串": "macOS Keychain",
		"清除使用统计？": "Clear usage stats?", "最近发送记录、卡片、任务和附件不会改变。": "Recent sends, cards, tasks and attachments stay as they are.",
		"获取链接预览？": "Fetch link preview?", "地址": "Address", "仅本次允许": "Allow once",
		"访问该地址获取标题和图标，本次允许它访问内网。":       "Visits this address for its title and icon, allowing local network access this once.",
		"不会发送应用中的其他内容；授权不覆盖其他内网地址的重定向。": "Nothing else from the app is sent. Redirects to other local addresses aren't covered.",
		"删除剪贴板历史记录？": "Delete clipboard history?", "已固定（★）的记录不会被删除。": "Pinned (★) items are kept.",
		"删除后可在主面板的提示气泡中撤销一次。": "You can undo once from the bubble on the main panel.",
		"用途": "Purpose", "AI 服务": "AI service", "原文包含": "Contains", "内容": "Content", "截图选区": "Screenshot selection",
	} {
		if _, ok := en[k]; !ok {
			en[k] = v
		}
	}
}
