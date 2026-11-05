package main

import (
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/diag"
)

const hudW, hudH = 280, 56

// showHUD 在光标所在屏右上角弹出提示气泡（不抢焦点、点击穿透），约 1.8s 收起；
// 新提示顶掉旧的。kind: added / duplicate / sent / warn / info。主线程调用。
// 隐身模式下只显示 warn（发送失败等必须知道的事）。
func (a *app) showHUD(kind, text string) {
	if kind != "warn" && a.store.Settings().Stealth {
		diag.Push("隐身: 静默气泡 kind=%s", kind)
		return
	}
	a.showHUDForce(kind, text)
}

func (a *app) showHUDForce(kind, text string) {
	a.hudKind, a.hudText = kind, text
	a.hudGen++
	gen := a.hudGen
	if a.hud == nil {
		return // 无窗口（视图测试）
	}
	d := mygo.Screen.DisplayNearestPoint(mygo.Screen.CursorScreenPoint())
	a.hud.SetPosition(d.WorkArea.X+d.WorkArea.Width-hudW-16, d.WorkArea.Y+16)
	a.hud.Invalidate()
	a.hud.ShowInactive()
	hold := 1800 * time.Millisecond
	if kind == "warn" {
		hold = 4 * time.Second
	}
	time.AfterFunc(hold, func() {
		a.hud.Update(func() {
			if a.hudGen == gen {
				a.hud.Hide()
			}
		})
	})
}

func (a *app) hudView(c *ui.Context) {
	t := c.Theme()
	c.Root().Background(ui.Transparent)
	icon, color := iconCheck, t.Success
	switch a.hudKind {
	case "warn":
		icon, color = iconWarn, t.Warning
	case "duplicate", "info":
		icon, color = iconCopy, t.TextMuted
	case "sent":
		icon, color = iconSend, t.Accent
	}
	box := ui.Row(c).Fill().Padding(10, 14).Gap(10).AlignItems(ui.Center).Radius(16)
	if a.glassOn() {
		box.Material(a.glassMaterial(0))
	} else {
		box.Background(t.Surface)
	}
	box.Children(func() {
		ui.Icon(c, icon).FontSize(16).TextColor(color)
		ui.Text(c, a.hudText).MaxLines(2).Wrap().Grow(1)
	})
}

func (a *app) createHUD() {
	a.hud = mygo.NewWindow(mygo.WindowOptions{
		Title: "Toskr HUD", Panel: true, Hidden: true, Frameless: true, Transparent: true,
		Vibrancy: vibrancyFor(a.store.Settings().Glass), CornerRadius: 16,
		Width: hudW, Height: hudH, DisableResize: true, AlwaysOnTop: true,
		Content: ui.View(a.hudView),
	})
	a.hud.SetIgnoreMouseEvents(true)
	a.hud.SetVisibleOnAllWorkspaces(true)
}

func vibrancyFor(glassSetting string) mygo.Vibrancy {
	switch glassSetting {
	case "clear":
		return mygo.VibrancyGlassClear
	case "none":
		return mygo.VibrancyNone
	}
	return mygo.VibrancyGlass
}
