package main

import (
	"fmt"
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
	a.drainUpdates()
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
		a.tabs(c, k)
		if len(a.pending) > 0 {
			ui.Column(c).Margin(0, 12, 6, 12).Children(func() { a.preflightBar(c) })
		}
		st := a.store.Settings()
		switch a.page {
		case pageClip:
			a.clipPage(c, k)
		case pageTasks:
			ui.Column(c).Grow(1).Children(func() { a.tasksPage(c) })
		default:
			if st.SecretEnabled {
				if i, ok := a.textTabs(c, k, []string{"笔记", "秘文"}, a.noteSub, nil); ok {
					a.noteSub = i
					a.chosen.Clear()
				}
			} else {
				a.noteSub = 0
			}
			if a.noteSub == 1 {
				ui.Column(c).Grow(1).Children(func() { a.secretsPage(c, k) })
			} else {
				a.notesPage(c, k)
			}
		}
		a.hintsRow(c, k)
		if a.page == pageNotes && a.noteSub == 0 { // 发送输入区只在笔记视图，与 Tauri 一致
			a.composerBar(c, k)
		}
	})
	if a.menuOpen {
		a.panelMenu(c, k)
	}
}

// textTabs 是 Tauri 的二级文字页签（今天 · 任务 · 订阅 / 笔记 · 秘文）：选中加粗 + 22×2 短下划线。
func (a *app) textTabs(c *ui.Context, k tokens, labels []string, sel int, right func()) (int, bool) {
	picked, changed := sel, false
	ui.Row(c).Height(34).Padding(4, 14, 8, 16).AlignItems(ui.Start).Children(func() {
		ui.Row(c).Gap(2).Grow(1).AlignItems(ui.Center).Children(func() {
			for i, label := range labels {
				if i > 0 {
					text(c, "·", 10, 14, 400, k.muted.Alpha(0.45)).Padding(0, 2)
				}
				on := sel == i
				b := ui.Column(c).Height(22).Padding(2, 8, 4, 8).Radius(8).AlignItems(ui.Center).Key("sub-" + label)
				if !on && b.Hovered() {
					b.Background(k.track)
				}
				b.Children(func() {
					w, col := 400, k.muted
					if on {
						w, col = 600, k.fg
					}
					text(c, tr(label), 11, 16, w, col)
					if on {
						ui.Box(c).Absolute().Bottom(0).Left(8).Right(8).Height(2).Radius(1).Background(k.fg.Alpha(0.85))
					}
				})
				if b.Clicked() && !on {
					picked, changed = i, true
				}
			}
		})
		if right != nil {
			ui.Row(c).Children(right)
		}
	})
	return picked, changed
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

// panelMenu 是标题栏 ☰「面板选项」（Tauri PanelOptionsMenu）：当前列表 / 面板 两组，位置与停靠为二级页。
func (a *app) panelMenu(c *ui.Context, k tokens) {
	st := a.store.Settings()
	if ui.Box(c).Absolute().Top(0).Left(0).Right(0).Bottom(0).Clicked() { // 点菜单外关闭
		a.menuOpen, a.placementOpen = false, false
		return
	}
	menu := ui.Column(c).Absolute().Top(40).Right(40).Width(224).Padding(4).Radius(10).Background(k.floatBtn.Alpha(0.95)).Border(1, k.floatBorder).
		Shadow(0, 1, 2, 0, k.floatShadowA).Shadow(0, 6, 16, -4, k.floatShadowB).InsetShadow(0, 1, 0, 0, k.floatInset)
	label := func(s string) { text(c, s, 10, 14, 500, k.muted).Padding(4, 8) }
	sep := func() { ui.Box(c).Height(1).Margin(4, 0).Background(stok(c).inputBorder) }
	item := func(icon, s string, checked, radio bool, trail string, fn func()) {
		row := ui.Row(c).Height(29).Padding(6, 8).Gap(8).Radius(6).AlignItems(ui.Center).Key("pm-" + s)
		if row.Hovered() {
			row.Background(k.track)
		}
		row.Children(func() {
			if icon != "" {
				licon(c, icon, 14, k.fg)
			}
			text(c, s, 12, 17, 400, k.fg).Grow(1).SingleLine()
			switch {
			case trail != "":
				if trail == ">" {
					licon(c, "chevron-right", 14, k.fg)
				} else {
					text(c, trail, 10, 14, 400, k.muted)
				}
			case checked && radio:
				ui.Box(c).Size(14, 14).Center().Children(func() { ui.Box(c).Size(6, 6).Radius(3).Background(k.fg) })
			case checked:
				licon(c, "check", 14, k.fg)
			default:
				ui.Box(c).Size(14, 14)
			}
		})
		if row.Clicked() {
			fn()
		}
	}
	closeMenu := func() { a.menuOpen, a.placementOpen = false, false }
	menu.Children(func() {
		if a.placementOpen {
			item("arrow-left", tr("返回面板选项"), false, false, "", func() { a.placementOpen = false })
			sep()
			place := tr("屏幕右侧")
			if !st.CompanionOff && len(st.Companion) > 0 {
				place = tr("跟随应用 · 右侧")
			} else if st.FreeMove {
				place = tr("自由移动")
			}
			label(fmt.Sprintf(tr("当前位置：%s"), place))
			item("magnet", tr("跟随应用"), !st.CompanionOff, false, "", func() {
				st.CompanionOff = !st.CompanionOff
				_ = a.store.SetSettings(st)
			})
			label(tr("屏幕位置"))
			item("move", tr("自由移动"), st.FreeMove, true, "", func() {
				st.FreeMove = true
				_ = a.store.SetSettings(st)
				closeMenu()
			})
			item("", tr("屏幕右侧"), !st.FreeMove, true, "", func() {
				st.FreeMove = false
				_ = a.store.SetSettings(st)
				closeMenu()
				a.repositionPanel()
			})
			return
		}
		done := 0
		switch {
		case a.page == pageNotes && a.noteSub == 0:
			done = len(a.done)
		case a.page == pageTasks:
			for _, t := range a.tasks {
				if t.Status == "done" {
					done++
				}
			}
		}
		if done > 0 {
			label(tr("当前列表"))
			item("eraser", fmt.Sprintf(tr("清理已完成（%d）"), done), false, false, "⇧⌘⌫", func() {
				closeMenu()
				a.clearAllDone(c)
			})
			sep()
		}
		label(tr("面板"))
		item("pin", tr("保持面板展开"), a.pinned, false, "", func() { a.pinned = !a.pinned; closeMenu() })
		item("move", tr("位置与停靠"), false, false, ">", func() { a.placementOpen = true })
	})
	if c.Shortcut(0, ui.KeyEscape) {
		closeMenu()
	}
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
