package main

import (
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

func (a *app) queueKeys(c *ui.Context) {
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
	if c.Shortcut(ui.Cmd, ui.KeyM) {
		a.mergeChosen(c)
	}
	if c.Shortcut(ui.Cmd, ui.KeyD) {
		a.toggleDone()
	}
	if c.Shortcut(ui.Cmd|ui.Alt, ui.KeyRight) {
		a.stepSection(1)
	}
	if c.Shortcut(ui.Cmd|ui.Alt, ui.KeyLeft) {
		a.stepSection(-1)
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
}

func (a *app) choose(i int) {
	a.selected = max(0, min(i, len(a.notes)-1))
	if len(a.notes) > 0 {
		a.list.ScrollIntoView(a.selected)
	}
}

func (a *app) switchSection(id string) {
	if a.section != id {
		a.section, a.selected, a.editing = id, 0, ""
		a.chosen.Clear()
		a.reload()
	}
}

func (a *app) stepSection(d int) {
	secs := a.store.Sections()
	i := slices.IndexFunc(secs, func(s store.Section) bool { return s.ID == a.section })
	a.switchSection(secs[(i+d+len(secs))%len(secs)].ID)
}

func (a *app) toggleDone() {
	for _, n := range a.chosenNotes() {
		_ = a.store.SetDone(n.ID, !n.Done)
	}
	a.chosen.Clear()
}

func sectionName(s store.Section) string {
	switch s.ID {
	case store.SectionInbox:
		return tr("收件箱")
	case store.SectionClipboard:
		return tr("剪贴板")
	}
	return s.Name
}

func (a *app) queuePage(c *ui.Context) {
	t := c.Theme()
	ui.Row(c).Gap(6).Padding(0, 4).AlignItems(ui.Center).Children(func() {
		ui.Icon(c, iconSearch).FontSize(13).TextColor(t.TextMuted)
		if ui.TextInputBase(c, &a.query).Bind(&a.search).Grow(1).Placeholder(tr("搜索（⌘F）")).Changed() {
			a.selected = 0
			a.reload()
		}
	})
	a.sectionChips(c)
	if len(a.pending) > 0 {
		a.preflightBar(c)
	}
	a.noteList(c)
	if len(a.done) > 0 {
		a.doneFold(c)
	}
	a.composer(c)
	a.footer(c)
}

func (a *app) sectionChips(c *ui.Context) {
	t := c.Theme()
	secs := a.store.Sections()
	ui.ScrollHorizontal(c).Scrollbars(false).Children(func() {
		ui.Row(c).Gap(6).Padding(0, 2).AlignItems(ui.Center).Children(func() {
			for i, s := range secs {
				label := sectionName(s) + " " + itoa(a.counts[s.ID])
				chip := ui.Text(c, label).FontSize(12).Padding(4, 10).Radius(99).SingleLine().Key("sec-" + s.ID)
				if s.ID == a.section {
					chip.Background(t.Accent.Alpha(0.2)).TextColor(t.Accent).Bold()
				} else {
					a.surface(c, chip, 0.4)
				}
				chip.ContextMenu(func(m *ui.Menu) {
					if m.Item(tr("发送后保留（不标记完成）")).Checked(s.KeepAfterSend).Chosen() {
						s.KeepAfterSend = !s.KeepAfterSend
						_ = a.store.UpdateSection(s)
					}
					if i > 0 && m.Item(tr("左移")).Chosen() {
						_ = a.store.MoveSection(s.ID, -1)
					}
					if i < len(secs)-1 && m.Item(tr("右移")).Chosen() {
						_ = a.store.MoveSection(s.ID, 1)
					}
					if !store.IsSystemSection(s.ID) {
						m.Separator()
						if m.Item(tr("删除分组（笔记移回收件箱）")).Chosen() {
							a.store.DeleteSection(s.ID)
						}
					}
				})
				if chip.Clicked() {
					a.switchSection(s.ID)
				}
			}
			if a.newSecOn {
				ui.TextInput(c, &a.newSec).Width(110).Focus().Placeholder(tr("分组名")).OnTextKey(func(k ui.TextKey) bool {
					switch k.Key {
					case ui.KeyEnter:
						if id := a.store.AddSection(k.Text()); id != "" {
							a.section = id
						}
						a.newSecOn, a.newSec = false, ""
						return true
					case ui.KeyEscape:
						a.newSecOn, a.newSec = false, ""
						return true
					}
					return false
				})
			} else if ui.Icon(c, iconPlus).FontSize(13).TextColor(t.TextMuted).Padding(4).Tooltip(tr("新建分组")).Clicked() {
				a.newSecOn = true
			}
		})
	})
}

func (a *app) preflightBar(c *ui.Context) {
	t := c.Theme()
	kinds := map[string]int{}
	var order []string
	for _, f := range a.findings {
		if kinds[f.Kind] == 0 {
			order = append(order, f.Kind)
		}
		kinds[f.Kind]++
	}
	var parts []string
	for _, k := range order {
		parts = append(parts, fmt.Sprintf("%s ×%d", k, kinds[k]))
	}
	ui.Column(c).Padding(10, 12).Gap(8).Radius(12).Background(t.Warning.Alpha(0.16)).Border(1, t.Warning.Alpha(0.5)).Children(func() {
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			ui.Icon(c, iconWarn).FontSize(14).TextColor(t.Warning)
			ui.Text(c, tr("发送内容含敏感信息：")+strings.Join(parts, "、")).FontSize(12).Wrap().Grow(1)
		})
		ui.Row(c).Gap(6).Children(func() {
			if ui.Button(c, tr("遮罩后发送")).Clicked() {
				a.confirmPending(true)
			}
			if ui.Button(c, tr("仍然发送")).Clicked() {
				a.confirmPending(false)
			}
			if ui.Button(c, tr("取消")).Clicked() {
				a.pending, a.findings = nil, nil
			}
		})
	})
}

func (a *app) noteList(c *ui.Context) {
	t := c.Theme()
	a.list.Selected = &a.selected
	a.list.Selection = &a.chosen
	a.list.Key = func(i int) any { return a.notes[i].ID }
	a.list.Label = func(i int) string { return a.notes[i].Text }
	if a.query == "" {
		a.list.Reorder = a.reorder
	} else {
		a.list.Reorder = nil
	}
	list := ui.List(c, &a.list, len(a.notes), func(i int) { a.card(c, i) }).Grow(1).Children(func() {
		if len(a.notes) == 0 {
			msg := tr("队列为空\n在任意应用选中文字，双击 ⇧ 收进来")
			if a.section == store.SectionClipboard {
				msg = tr("还没有剪贴板记录")
			}
			if a.query != "" {
				msg = tr("没有匹配的内容")
			}
			ui.Text(c, msg).TextColor(t.TextMuted).Padding(24).Center()
		}
	})
	if list.Submitted() {
		a.startEdit()
	}
}

func (a *app) doneFold(c *ui.Context) {
	t := c.Theme()
	ui.Column(c).Gap(4).Children(func() {
		ui.Row(c).Padding(2, 6).Gap(8).AlignItems(ui.Center).Children(func() {
			arrow := "▸ "
			if a.showDone {
				arrow = "▾ "
			}
			if ui.Text(c, arrow+tr("已完成 ")+itoa(len(a.done))).FontSize(12).TextColor(t.TextMuted).Grow(1).Clicked() {
				a.showDone = !a.showDone
			}
			if ui.Text(c, tr("清理")).FontSize(12).TextColor(t.Accent).Clicked() {
				a.clearDone(c)
			}
		})
		if !a.showDone {
			return
		}
		ui.Scroll(c).MaxHeight(160).Children(func() {
			ui.Column(c).Gap(4).Children(func() {
				for _, n := range a.done {
					ui.Row(c).Padding(4, 8).Gap(8).AlignItems(ui.Center).Key("done-" + n.ID).Children(func() {
						if ui.Icon(c, iconDone).FontSize(13).TextColor(t.Success).Tooltip(tr("恢复为未完成")).Clicked() {
							_ = a.store.SetDone(n.ID, false)
						}
						ui.Text(c, preview(n.Text, 40)).FontSize(12).TextColor(t.TextMuted).Strikethrough().SingleLine().Grow(1)
					})
				}
			})
		})
	})
}

func (a *app) card(c *ui.Context, i int) {
	t := c.Theme()
	n := a.notes[i]
	selected := i == a.selected || a.chosen.Has(n.ID)
	box := ui.Column(c).Padding(10, 12).Gap(6).Radius(12).Key(n.ID)
	if selected {
		box.Background(t.Accent.Alpha(0.18)).Border(1, t.Accent.Alpha(0.55))
	} else {
		a.surface(c, box, 0.5)
	}
	box.ContextMenu(func(m *ui.Menu) { a.cardMenu(c, m, i, n) })
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
			ui.Text(c, tr("⌘↵ 保存   esc 取消")).FontSize(10).TextColor(t.TextMuted)
			return
		}
		if n.Kind == "image" {
			if img := a.thumb(n.ImageFile); img != nil {
				w, h := ui.ImageSize(img)
				dw := min(w, 300)
				ui.Image(c, img).Size(dw, h*dw/max(w, 1)).Radius(8)
			} else {
				ui.Text(c, tr("（图片缺失）")).TextColor(t.Danger)
			}
			if n.Text != "" {
				ui.Text(c, n.Text).MaxLines(3).Wrap().FontSize(12).TextColor(t.TextMuted)
			}
		} else {
			body := ui.Text(c, n.Text).MaxLines(4).Wrap()
			if !n.SentAt.IsZero() {
				body.TextColor(t.TextMuted)
			}
		}
		ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
			if ui.Icon(c, iconCircle).FontSize(12).TextColor(t.TextMuted).Tooltip(tr("标记完成（⌘D）")).Clicked() {
				_ = a.store.SetDone(n.ID, true)
			}
			meta := ago(n.CreatedAt, time.Now())
			if n.SourceApp != "" {
				meta = n.SourceApp + " · " + meta
			}
			ui.Text(c, meta).FontSize(10).TextColor(t.TextMuted).SingleLine().Grow(1)
			if a.aiBusy == n.ID {
				ui.Spinner(c).Size(12, 12)
			}
			if n.Kept {
				ui.Badge(c, tr("保留"))
			}
			if !n.SentAt.IsZero() {
				ui.Icon(c, iconCheck).FontSize(11).TextColor(t.Success).Tooltip(tr("已发送"))
			}
			if i == a.selected {
				if ui.Icon(c, iconCopy).FontSize(12).TextColor(t.TextMuted).Tooltip(tr("复制")).Clicked() {
					a.copySelected(c)
				}
				if ui.Icon(c, iconSend).FontSize(12).TextColor(t.Accent).Tooltip(tr("发送（⌘↵）")).Clicked() {
					a.sendSelected()
				}
			}
		})
	})
	// 单击 / ⌘点击 / ⇧点击选择与双击编辑都交给 List（Selection + Submitted），卡片自身不接点击
}

func (a *app) cardMenu(c *ui.Context, m *ui.Menu, i int, n store.Note) {
	if a.chosen.Len() <= 1 {
		a.selected = i
	}
	multi := a.chosen.Len() > 1
	if multi {
		if m.Item(fmt.Sprintf(tr("发送所选 %d 条"), a.chosen.Len())).Chosen() {
			a.sendSelected()
		}
		if m.Item(fmt.Sprintf(tr("合并所选 %d 条（⌘M）"), a.chosen.Len())).Chosen() {
			a.mergeChosen(c)
		}
	} else {
		if m.Item(tr("发送到 ") + targetName(a.target.Name)).Chosen() {
			a.sendSelected()
		}
		if n.Kind != "image" && m.Item(tr("编辑")).Chosen() {
			a.startEdit()
		}
		if m.Item(tr("在详情窗打开")).Chosen() {
			a.openDetail(n)
		}
		if m.Item(tr("复制")).Chosen() {
			a.copySelected(c)
		}
	}
	m.Submenu(tr("移动到"), func(sm *ui.Menu) {
		for _, s := range a.store.Sections() {
			if s.ID != n.Section && sm.Item(sectionName(s)).Chosen() {
				for _, x := range a.chosenNotes() {
					_ = a.store.MoveToAt(x.ID, s.ID, 0)
				}
				a.chosen.Clear()
			}
		}
	})
	if m.Item(tr("标记完成（⌘D）")).Chosen() {
		a.toggleDone()
	}
	if n.Section == store.SectionClipboard && !multi {
		if m.Item(tr("保留")).Checked(n.Kept).Chosen() {
			_ = a.store.SetKept(n.ID, !n.Kept)
		}
	}
	if n.Kind == "image" && !multi {
		m.Separator()
		if m.Item(tr("识别文字")).Chosen() {
			a.ocrNote(n)
		}
		if m.Item(tr("钉到屏幕")).Chosen() {
			a.pinImage(n)
		}
	}
	if n.Kind != "image" && !multi {
		m.Submenu("AI", func(sm *ui.Menu) {
			for _, act := range aiActions {
				if sm.Item(tr(act.label)).Chosen() {
					a.runAI(n, act)
				}
			}
		})
	}
	m.Separator()
	if m.Item(tr("删除")).Chosen() {
		a.deleteSelected(c)
	}
}

func (a *app) composer(c *ui.Context) {
	box := a.surface(c, ui.Column(c).Padding(8, 10).Radius(12), 0)
	box.Children(func() {
		ui.TextArea(c, &a.draft).Bind(&a.draftIn).Lines(1, 6).Placeholder(tr("写一条笔记，↵ 加入队列（⇧↵ 换行）")).
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
		ui.Text(c, tr("发送到 ")+targetName(a.target.Name)).FontSize(10).TextColor(t.TextMuted).SingleLine().Grow(1)
		ui.Text(c, tr("⌘↵ 发送  ⌥⌘↵ 全部  ⌘M 合并")).FontSize(10).TextColor(t.TextMuted)
	})
}
