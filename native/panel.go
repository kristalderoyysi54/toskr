package main

import (
	"github.com/egoist/mygo"
	"github.com/egoist/mygo/plugins/glass"
	"github.com/egoist/mygo/ui"
)

// glassOn 报告设置里是否启用窗内玻璃（卡片 / 工具条的 glass 插件材质）。
func (a *app) glassOn() bool { return a.store.Settings().Glass != "none" }

func (a *app) glassMaterial(clarity float32) glass.Glass {
	g := glass.Glass{Clarity: clarity}
	if a.store.Settings().Glass == "clear" {
		g.Style = glass.Clear
	}
	return g
}

// surface 给块元素上玻璃材质或普通底色。
func (a *app) surface(c *ui.Context, e ui.Element, clarity float32) ui.Element {
	if a.glassOn() {
		return e.Material(a.glassMaterial(clarity))
	}
	return e.Background(c.Theme().Surface)
}

func (a *app) panelView(c *ui.Context) {
	t := c.Theme()
	if c.Vibrancy() {
		c.Root().Background(ui.Transparent)
	} else {
		c.Root().Background(t.Background)
	}
	a.panelKeys(c)

	ui.Column(c).Fill().Padding(10).Gap(8).Children(func() {
		a.header(c)
		switch a.page {
		case pageTasks:
			a.tasksPage(c)
		case pageBills:
			a.billsPage(c)
		case pageSecrets:
			a.secretsPage(c)
		default:
			a.queuePage(c)
		}
	})
}

func (a *app) panelKeys(c *ui.Context) {
	for i, k := range []ui.Key{ui.Key1, ui.Key2, ui.Key3, ui.Key4} {
		if c.Shortcut(ui.Cmd, k) {
			a.switchPage(i)
		}
	}
	if c.Shortcut(ui.Cmd, ui.KeyP) {
		a.pinned = !a.pinned
	}
	if c.Shortcut(ui.Cmd, ui.KeyComma) {
		a.openSettings()
	}
	c.OnShortcut(ui.Cmd, ui.KeyQ, mygo.App.Quit)
	if a.page == pageQueue {
		a.queueKeys(c)
	}
}

func (a *app) switchPage(p int) {
	if a.page != p {
		a.page, a.editing = p, ""
		a.reload()
	}
}

func (a *app) header(c *ui.Context) {
	t := c.Theme()
	bar := a.surface(c, ui.Column(c).Padding(8, 10).Gap(8).Radius(14), 0)
	bar.Children(func() {
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			ui.Text(c, "Toskr").Bold().FontSize(15).Grow(1)
			if ui.Icon(c, iconCamera).FontSize(15).TextColor(t.TextMuted).Tooltip(tr("截图") + "（" + keyLabel(a.store.Settings().ScreenshotKey) + "）").Clicked() {
				a.screenshot()
			}
			pin := ui.Icon(c, iconPin).FontSize(15).TextColor(t.TextMuted).Tooltip(tr("钉住：发送后不收起（⌘P）"))
			if a.pinned {
				pin.TextColor(t.Accent)
			}
			if pin.Clicked() {
				a.pinned = !a.pinned
			}
			if ui.Icon(c, iconGear).FontSize(15).TextColor(t.TextMuted).Tooltip(tr("设置（⌘,）")).Clicked() {
				a.openSettings()
			}
		})
		page := a.page
		if ui.Segmented(c, &page, tr("队列"), tr("任务"), tr("账单"), tr("秘文")).Changed() {
			a.switchPage(page)
		}
	})
}

func targetName(name string) string {
	if name == "" {
		return tr("（未知应用）")
	}
	return name
}

func itoa(n int) string {
	if n > 999 {
		return "999+"
	}
	b := []byte{}
	if n == 0 {
		return "0"
	}
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}
