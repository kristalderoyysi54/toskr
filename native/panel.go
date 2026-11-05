package main

import (
	"github.com/egoist/mygo"
	"github.com/egoist/mygo/plugins/glass"
	"github.com/egoist/mygo/ui"
)

// glassOn 报告设置里是否启用窗内玻璃（任务/账单/秘文页卡片的 glass 插件材质）。
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

// panelView 与 Tauri 主面板同构：标题栏 → 目标条 → 页签 → 内容 → 快捷键提示 → 输入区。
// 面板底色是 Tauri 叠在模糊材质上的半透明色；材质本身换成原生模糊 / 液态玻璃。
func (a *app) panelView(c *ui.Context) {
	registerFonts()
	k := tok(c)
	if c.Vibrancy() {
		c.Root().Background(k.window)
	} else {
		c.Root().Background(k.window) // 无系统材质时（无头渲染）同色叠在白底上，与浏览器参照一致
	}
	a.panelKeys(c)

	ui.Column(c).Fill().Radius(14).Children(func() {
		a.mainHeader(c, k)
		if a.searchOpen {
			a.searchRow(c, k)
		}
		a.targetBar(c, k)
		if a.page <= pageTasks {
			a.tabs(c, k)
		} else {
			a.subpageBar(c, k)
		}
		if len(a.pending) > 0 {
			ui.Column(c).Margin(0, 12, 6, 12).Children(func() { a.preflightBar(c) })
		}
		switch a.page {
		case pageClip:
			a.clipPage(c, k)
		case pageTasks:
			ui.Column(c).Grow(1).Padding(0, 10).Gap(8).Children(func() { a.tasksPage(c) })
		case pageBills:
			ui.Column(c).Grow(1).Padding(0, 10).Gap(8).Children(func() { a.billsPage(c) })
		case pageSecrets:
			ui.Column(c).Grow(1).Padding(0, 10).Gap(8).Children(func() { a.secretsPage(c) })
		default:
			a.notesPage(c, k)
		}
		a.hintsRow(c, k)
		a.composerBar(c, k)
	})
	if a.menuOpen {
		a.moreMenu(c, k)
	}
}

func (a *app) searchRow(c *ui.Context, k tokens) {
	ui.Row(c).Height(30).Margin(0, 12, 6, 12).Padding(0, 10).Gap(6).Radius(10).Background(k.track).AlignItems(ui.Center).Children(func() {
		licon(c, "search", 12, k.muted)
		if ui.TextInputBase(c, &a.query).Bind(&a.search).Grow(1).Font(fontSans).FontSize(12).Placeholder(tr("搜索（⌘F）")).Focus().Changed() {
			a.selected = 0
			a.reload()
		}
	})
}

// subpageBar 是账单 / 秘文页顶部的返回条。
func (a *app) subpageBar(c *ui.Context, k tokens) {
	title := tr("账单")
	if a.page == pageSecrets {
		title = tr("秘文")
	}
	ui.Row(c).Height(30).Margin(6, 12, 6, 12).Gap(6).AlignItems(ui.Center).Children(func() {
		if a.iconButton(c, k, "arrow-left", 22, 14, tr("返回笔记")) {
			a.switchPage(pageNotes)
		}
		text(c, title, 13, 18, 600, k.fg)
	})
}

// moreMenu 是标题栏「更多」按钮的下拉（窗内自绘，与 Tauri 的 HTML 菜单同为窗内浮层）。
func (a *app) moreMenu(c *ui.Context, k tokens) {
	ui.Column(c).Absolute().Top(40).Right(16).Width(168).Padding(4).Radius(10).Background(k.floatBtn).Border(1, k.floatBorder).
		Shadow(0, 6, 16, -4, k.floatShadowB).Children(func() {
		for _, it := range []struct {
			icon, label string
			fn          func()
		}{
			{"wallet", "订阅账单", func() { a.switchPage(pageBills) }},
			{"lock", "秘文", func() { a.switchPage(pageSecrets) }},
			{"folder-plus", "新建分组", func() { a.switchPage(pageNotes); a.newSecOn = true }},
			{"camera", "截图", a.screenshot},
			{"settings-2", "设置", a.openSettings},
		} {
			row := ui.Row(c).Height(28).Padding(0, 8).Gap(8).Radius(6).AlignItems(ui.Center)
			if row.Hovered() {
				row.Background(k.track)
			}
			row.Children(func() {
				licon(c, it.icon, 14, k.muted)
				text(c, tr(it.label), 12, 17, 400, k.fg)
			})
			if row.Clicked() {
				a.menuOpen = false
				it.fn()
			}
		}
	})
	if c.Shortcut(0, ui.KeyEscape) {
		a.menuOpen = false
	}
}

func (a *app) clipPage(c *ui.Context, k tokens) {
	ui.Scroll(c).Grow(1).Scrollbars(false).Children(func() {
		ui.Column(c).Padding(4, 10, 8, 10).Gap(4).Children(func() {
			if len(a.notes) == 0 {
				ui.Column(c).Padding(64, 24, 40, 24).Gap(8).AlignItems(ui.Center).Children(func() {
					licon(c, "clipboard-list", 24, k.muted.Alpha(0.5))
					text(c, tr("还没有剪贴板记录"), 13, 18, 500, k.muted)
					text(c, tr("复制任意文字、链接或图片试试，会自动出现在这里。"), 11, 16.5, 400, k.muted).TextAlign(ui.Center).Wrap()
				})
				return
			}
			for _, n := range a.notes {
				a.noteCard(c, k, n)
			}
		})
	})
}

func (a *app) panelKeys(c *ui.Context) {
	for i, key := range []ui.Key{ui.Key1, ui.Key2, ui.Key3} {
		if c.Shortcut(ui.Cmd, key) {
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
	if a.page == pageNotes || a.page == pageClip {
		a.queueKeys(c)
	}
}

func (a *app) switchPage(p int) {
	if a.page != p {
		a.page, a.editing, a.selected = p, "", 0
		a.chosen.Clear()
		a.reload()
	}
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
