package main

import (
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/plugins/glass"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
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
		a.noteList(c)
		a.composer(c)
		a.footer(c)
	})
}

func (a *app) panelKeys(c *ui.Context) {
	if a.editing != "" {
		return // 编辑框自己处理按键
	}
	if c.Shortcut(ui.Cmd, ui.KeyEnter) {
		a.sendSelected()
	}
	if c.Shortcut(ui.Cmd|ui.Alt, ui.KeyEnter) {
		a.sendQueue()
	}
	if c.Shortcut(ui.Cmd, ui.KeyBackspace) {
		a.deleteSelected(c)
	}
	if c.Shortcut(ui.Cmd, ui.KeyF) {
		a.search.Focus()
	}
	if c.Shortcut(ui.Cmd, ui.KeyP) {
		a.pinned = !a.pinned
	}
	if c.Shortcut(ui.Cmd, ui.Key1) {
		a.switchTab(0)
	}
	if c.Shortcut(ui.Cmd, ui.Key2) {
		a.switchTab(1)
	}
	if c.Shortcut(ui.Cmd, ui.KeyComma) {
		a.openSettings()
	}
	if c.Shortcut(0, ui.KeyEnter) { // 输入框聚焦时由它先处理回车
		a.startEdit()
	}
	if c.Shortcut(0, ui.KeyDown) {
		a.choose(a.selected + 1)
	}
	if c.Shortcut(0, ui.KeyUp) {
		a.choose(a.selected - 1)
	}
	c.OnShortcut(ui.Cmd, ui.KeyQ, mygo.App.Quit)
}

func (a *app) choose(i int) {
	a.selected = max(0, min(i, len(a.notes)-1))
	if len(a.notes) > 0 {
		a.list.ScrollIntoView(a.selected)
	}
}

func (a *app) switchTab(tab int) {
	if a.tab != tab {
		a.tab, a.selected, a.editing = tab, 0, ""
		a.reload()
	}
}

func (a *app) header(c *ui.Context) {
	t := c.Theme()
	bar := ui.Column(c).Padding(8, 10).Gap(8).Radius(14)
	if a.glassOn() {
		bar.Material(a.glassMaterial(0))
	} else {
		bar.Background(t.Surface)
	}
	bar.Children(func() {
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			ui.Text(c, "Toskr").Bold().FontSize(15).Grow(1)
			pin := ui.Icon(c, iconPin).FontSize(15).TextColor(t.TextMuted).Tooltip("钉住：发送后不收起（⌘P）")
			if a.pinned {
				pin.TextColor(t.Accent)
			}
			if pin.Clicked() {
				a.pinned = !a.pinned
			}
			if ui.Icon(c, iconGear).FontSize(15).TextColor(t.TextMuted).Tooltip("设置（⌘,）").Clicked() {
				a.openSettings()
			}
		})
		tab := a.tab
		labels := []string{"笔记 " + itoa(a.counts[0]), "剪贴板 " + itoa(a.counts[1])}
		if ui.Segmented(c, &tab, labels...).Changed() {
			a.switchTab(tab)
		}
		ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
			ui.Icon(c, iconSearch).FontSize(13).TextColor(t.TextMuted)
			if ui.TextInputBase(c, &a.query).Bind(&a.search).Grow(1).Placeholder("搜索（⌘F）").Changed() {
				a.selected = 0
				a.reload()
			}
		})
	})
}

func (a *app) noteList(c *ui.Context) {
	t := c.Theme()
	a.list.Selected = &a.selected
	a.list.Key = func(i int) any { return a.notes[i].ID }
	a.list.Label = func(i int) string { return a.notes[i].Text }
	if a.query == "" {
		a.list.Reorder = a.reorder
	} else {
		a.list.Reorder = nil
	}
	list := ui.List(c, &a.list, len(a.notes), func(i int) { a.card(c, i) }).Grow(1).Children(func() {
		if len(a.notes) == 0 {
			msg := "队列为空\n在任意应用选中文字，双击 ⇧ 收进来"
			if a.tab == 1 {
				msg = "还没有剪贴板记录"
			}
			if a.query != "" {
				msg = "没有匹配的内容"
			}
			ui.Text(c, msg).TextColor(t.TextMuted).Padding(24).Center()
		}
	})
	if list.Submitted() {
		a.startEdit()
	}
}

func (a *app) card(c *ui.Context, i int) {
	t := c.Theme()
	n := a.notes[i]
	selected := i == a.selected
	box := ui.Column(c).Padding(10, 12).Gap(6).Radius(12).Key(n.ID)
	switch {
	case selected:
		box.Background(t.Accent.Alpha(0.18)).Border(1, t.Accent.Alpha(0.55))
	case a.glassOn():
		box.Material(a.glassMaterial(0.5))
	default:
		box.Background(t.Surface)
	}
	box.ContextMenu(func(m *ui.Menu) {
		a.selected = i
		if m.Item("发送到 " + targetName(a.target.Name)).Chosen() {
			a.sendSelected()
		}
		if m.Item("编辑").Chosen() {
			a.startEdit()
		}
		if m.Item("复制").Chosen() {
			a.copySelected(c)
		}
		if n.Section == store.SectionClipboard {
			if m.Item("转为笔记").Chosen() {
				_ = a.store.MoveTo(n.ID, store.SectionInbox)
			}
			if m.Item("保留").Checked(n.Kept).Chosen() {
				_ = a.store.SetKept(n.ID, !n.Kept)
			}
		}
		m.Separator()
		if m.Item("删除").Chosen() {
			a.deleteSelected(c)
		}
	})
	box.Children(func() {
		if a.editing == n.ID {
			ui.TextArea(c, &a.editText).Lines(2, 12).Focus().OnTextKey(func(k ui.TextKey) bool {
				switch {
				case k.Key == ui.KeyEnter && k.Mods == ui.Cmd:
					a.commitEdit()
					return true
				case k.Key == ui.KeyEscape:
					a.editing = ""
					return true
				}
				return false
			})
			ui.Text(c, "⌘↵ 保存   esc 取消").FontSize(10).TextColor(t.TextMuted)
			return
		}
		body := ui.Text(c, n.Text).MaxLines(4).Wrap()
		if !n.SentAt.IsZero() {
			body.TextColor(t.TextMuted)
		}
		ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
			meta := ago(n.CreatedAt, time.Now())
			if n.SourceApp != "" {
				meta = n.SourceApp + " · " + meta
			}
			ui.Text(c, meta).FontSize(10).TextColor(t.TextMuted).SingleLine().Grow(1)
			if n.Kept {
				ui.Badge(c, "保留")
			}
			if !n.SentAt.IsZero() {
				ui.Icon(c, iconCheck).FontSize(11).TextColor(t.Success).Tooltip("已发送")
			}
			if selected {
				if ui.Icon(c, iconCopy).FontSize(12).TextColor(t.TextMuted).Tooltip("复制").Clicked() {
					a.copySelected(c)
				}
				if ui.Icon(c, iconSend).FontSize(12).TextColor(t.Accent).Tooltip("发送（⌘↵）").Clicked() {
					a.sendSelected()
				}
			}
		})
	})
	if box.Clicked() {
		a.selected = i
	}
	if box.DoubleClicked() {
		a.selected = i
		a.startEdit()
	}
}

func (a *app) composer(c *ui.Context) {
	t := c.Theme()
	box := ui.Column(c).Padding(8, 10).Radius(12)
	if a.glassOn() {
		box.Material(a.glassMaterial(0))
	} else {
		box.Background(t.Surface)
	}
	box.Children(func() {
		ui.TextArea(c, &a.draft).Bind(&a.draftIn).Lines(1, 6).Placeholder("写一条笔记，↵ 加入队列（⇧↵ 换行）").
			OnTextKey(func(k ui.TextKey) bool {
				if k.Key == ui.KeyEnter && k.Mods == 0 {
					a.draft = k.Text()
					a.addDraft()
					k.SetText(a.draft)
					return true
				}
				return false
			})
	})
}

func (a *app) footer(c *ui.Context) {
	t := c.Theme()
	ui.Row(c).Padding(0, 4).Gap(8).AlignItems(ui.Center).Children(func() {
		ui.Text(c, "发送到 "+targetName(a.target.Name)).FontSize(10).TextColor(t.TextMuted).SingleLine().Grow(1)
		ui.Text(c, "⌘↵ 发送  ⌥⌘↵ 全部  ⌘⌫ 删除").FontSize(10).TextColor(t.TextMuted)
	})
}

func targetName(name string) string {
	if name == "" {
		return "（未知应用）"
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
