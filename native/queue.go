package main

import (
	"fmt"
	"net/url"
	"os/exec"
	"slices"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// queueKeys：笔记 / 剪贴页的卡片快捷键（同 Tauri）：⌘⏎ 发送勾选、⌘1-9 快发第 N 张、⌘C 复制为列表、⌘A 全选、
// ↑↓ 移动焦点、←→ 移动并单选、Space 预览（链接卡开网页）、x 勾选、d 完成、p 置顶 / 常用、Enter 编辑、⌘⌫ 删除焦点卡。
func (a *app) queueKeys(c *ui.Context) {
	if a.editing != "" || a.titleEditID != "" || a.tagEditID != "" || a.quickOpen {
		return // 输入框 / 方案快速切换浮层自己处理按键
	}
	if c.Shortcut(ui.Cmd, ui.KeyEnter) {
		a.sendSelected()
	}
	if c.Shortcut(ui.Cmd|ui.Alt, ui.KeyEnter) {
		a.sendQueue()
	}
	for i, key := range []ui.Key{ui.Key1, ui.Key2, ui.Key3, ui.Key4, ui.Key5, ui.Key6, ui.Key7, ui.Key8, ui.Key9} {
		if c.Shortcut(ui.Cmd, key) && i < len(a.notes) { // Paste 式快发
			a.send([]store.Note{a.notes[i]})
		}
	}
	if c.Shortcut(ui.Cmd, ui.KeyM) {
		a.mergeChosen(c)
	}
	if c.Shortcut(ui.Cmd, ui.KeyC) {
		a.copyChosenAsList()
	}
	if c.Shortcut(ui.Cmd, ui.KeyA) {
		for _, n := range a.notes {
			a.chosen.Add(n.ID)
		}
	}
	if c.Shortcut(ui.Cmd|ui.Alt, ui.KeyRight) {
		a.stepSection(1)
	}
	if c.Shortcut(ui.Cmd|ui.Alt, ui.KeyLeft) {
		a.stepSection(-1)
	}
	if c.Shortcut(0, ui.KeyDown) {
		if a.focusList {
			a.focusAt(a.selected + 1)
		} else {
			a.focusAt(0) // 尚无焦点：落到第一张（同 Tauri idx=-1 → navIds[0]）
		}
	}
	if c.Shortcut(0, ui.KeyUp) {
		if a.focusList {
			a.focusAt(a.selected - 1)
		} else {
			a.focusAt(0)
		}
	}
	for _, step := range []struct {
		key ui.Key
		d   int
	}{{ui.KeyLeft, -1}, {ui.KeyRight, 1}} {
		if c.Shortcut(0, step.key) && len(a.notes) > 0 {
			next := a.selected + step.d
			if !a.focusList {
				next = 0
			}
			a.focusAt(next)
			a.chosen.Clear() // 左右导航即单选（⌘⏎ 可直发）
			a.chosen.Add(a.notes[a.selected].ID)
		}
	}
	cur, ok := a.current()
	if !ok || !a.focusList {
		return
	}
	if c.Shortcut(0, ui.KeySpace) {
		if link := noteLink(cur); cur.Kind == "link" && link != "" {
			_ = exec.Command("/usr/bin/open", link).Start()
		} else {
			a.openDetail(cur)
		}
	}
	if c.Shortcut(0, ui.KeyX) {
		if a.chosen.Has(cur.ID) {
			a.chosen.Remove(cur.ID)
		} else {
			a.chosen.Add(cur.ID)
		}
	}
	if c.Shortcut(0, ui.KeyD) {
		_ = a.store.SetDone(cur.ID, !cur.Done)
		if cur.Done {
			a.showHUD("ok", tr("已取消完成"))
		} else {
			a.showHUD("ok", tr("已标记完成"))
		}
	}
	if c.Shortcut(0, ui.KeyP) {
		_ = a.store.SetKept(cur.ID, !cur.Kept)
		clip := cur.Section == store.SectionClipboard
		switch {
		case cur.Kept && clip:
			a.showHUD("ok", tr("已取消置顶"))
		case cur.Kept:
			a.showHUD("ok", tr("已取消常用"))
		case clip:
			a.showHUD("ok", tr("已置顶"))
		default:
			a.showHUD("ok", tr("已设为常用"))
		}
	}
	if c.Shortcut(0, ui.KeyEnter) { // 输入框聚焦时由它先处理回车
		a.startEdit()
	}
	if c.Shortcut(ui.Cmd, ui.KeyBackspace) {
		if r, pos, ok := a.store.Delete(cur.ID); ok {
			a.chosen.Remove(cur.ID)
			a.showHUDUndo("ok", fmt.Sprintf(tr("已删除 %d 条"), 1), func() { _ = a.store.Restore(r, pos) })
		}
	}
}

// focusAt：键盘焦点移到第 i 张（夹在范围内）。
func (a *app) focusAt(i int) {
	if len(a.notes) == 0 {
		return
	}
	a.focusList = true
	a.choose(i)
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
	r, _ := a.resolution()
	var texts []string
	for _, n := range a.pending {
		if n.Kind != "image" {
			texts = append(texts, n.Text)
		}
	}
	tone := t.Warning
	if len(a.findings) == 0 { // 检查后发送：没有敏感项，只确认内容
		tone = t.Accent
	}
	ui.Column(c).Padding(10, 12).Gap(8).Radius(12).Background(tone.Alpha(0.12)).Border(1, tone.Alpha(0.45)).Key("preflight").Children(func() {
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			if len(a.findings) == 0 {
				ui.Text(c, fmt.Sprintf(tr("发送前检查：发往 %s · %s"), a.target.Name, profileName(r.Profile))).FontSize(12).Wrap().Grow(1)
				return
			}
			ui.Icon(c, iconWarn).FontSize(14).TextColor(t.Warning)
			ui.Text(c, tr("发送内容含敏感信息：")+strings.Join(parts, "、")).FontSize(12).Wrap().Grow(1)
		})
		if len(texts) > 0 { // 将要发送的原样内容（已套模板与输出格式）
			ui.Text(c, clipRunes(composePayload(texts, a.pendingTmpl, r.Profile.OutputMode()), 400)).FontSize(11).Font(fontMono).Wrap().MaxLines(8).
				Padding(6, 8).Radius(8).Background(t.Background.Alpha(0.6))
		}
		if len(a.findings) == 0 {
			ui.Row(c).Gap(6).Children(func() {
				if ui.Button(c, tr("发送")).Clicked() {
					a.confirmPending(false)
				}
				if ui.Button(c, tr("取消")).Clicked() {
					a.pending, a.findings, a.rawArm, a.pendingTmpl = nil, nil, false, ""
				}
			})
			return
		}
		ui.Row(c).Gap(6).Children(func() {
			if ui.Button(c, tr("遮罩后发送")).Clicked() {
				a.confirmPending(true)
			}
			// 方案「要求逐项处理」：保留原文要再点一次确认；其余策略一次即可。保留原文时不回车
			raw := tr("仍然发送")
			if r.Profile.PrivacyPolicy == "requireRedaction" {
				raw = tr("保留原文…")
				if a.rawArm {
					raw = fmt.Sprintf(tr("确认保留 %d 项原文"), len(a.findings))
				}
			}
			if ui.Button(c, raw).Clicked() {
				if r.Profile.PrivacyPolicy == "requireRedaction" && !a.rawArm {
					a.rawArm = true
				} else {
					a.confirmPending(false)
				}
			}
			if ui.Button(c, tr("取消")).Clicked() {
				a.pending, a.findings, a.rawArm, a.pendingTmpl = nil, nil, false, ""
			}
		})
	})
}

// enterAskBar：方案为「每次发送前确认」时，粘贴前问一次是否按回车。
func (a *app) enterAskBar(c *ui.Context) {
	t := c.Theme()
	ui.Column(c).Padding(10, 12).Gap(8).Radius(12).Background(t.Accent.Alpha(0.08)).Border(1, t.Accent.Alpha(0.3)).Key("enter-ask").Children(func() {
		ui.Text(c, fmt.Sprintf(tr("粘贴到 %s 后按回车发送？"), a.target.Name)).FontSize(12).Wrap()
		ui.Row(c).Gap(6).Children(func() {
			notes, tmpl := a.enterAsk, a.enterTmpl
			if ui.Button(c, tr("粘贴并回车")).Clicked() {
				a.enterAsk = nil
				a.deliver(notes, true, tmpl)
			}
			if ui.Button(c, tr("仅粘贴")).Clicked() {
				a.enterAsk = nil
				a.deliver(notes, false, tmpl)
			}
			if ui.Button(c, tr("取消")).Clicked() {
				a.enterAsk = nil
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
	isClip := n.Section == store.SectionClipboard
	isImage := n.Kind == "image" || len(n.MediaFiles()) > 0
	if multi {
		if m.Item(fmt.Sprintf(tr("发送所选 %d 条"), a.chosen.Len())).Chosen() {
			a.sendSelected()
		}
		if m.Item(fmt.Sprintf(tr("合并所选 %d 条（⌘M）"), a.chosen.Len())).Chosen() {
			a.mergeChosen(c)
		}
		if m.Item(fmt.Sprintf(tr("复制原文为列表（不脱敏） %d 项"), a.chosen.Len())).Chosen() {
			a.copyChosenAsList()
		}
	} else {
		if link := noteLink(n); link != "" && m.Item(tr("打开链接")).Chosen() {
			_ = exec.Command("/usr/bin/open", link).Start()
		}
		if n.Kind == "link" && n.URL != "" && m.Item(tr("确认获取链接预览…")).Chosen() {
			a.confirmFetchLink(n)
		}
		if m.Item(tr("预览")).Chosen() {
			a.openDetail(n)
		}
		send := tr("发送到对话")
		if isClip {
			send = tr("发送 / 添加")
		}
		if m.Item(send).Chosen() {
			a.sendSelected()
		}
		if m.Item(tr("检查后发送…")).Chosen() {
			a.checkSend(a.chosenNotes())
		}
		if !isImage {
			a.templateMenu(m, tr("用模板发送"), a.chosenNotes)
		}
		if !isImage && m.Item(tr("编辑")).Chosen() {
			a.startEdit()
		}
		if m.Item(tr("复制原文（不脱敏）")).Chosen() {
			a.copySelected(c)
		}
	}
	if n.Kind == "image" && !multi {
		m.Separator()
		if m.Item(tr("识别文字 (OCR)")).Chosen() {
			a.ocrNote(n)
		}
		if m.Item(tr("钉到屏幕")).Chosen() {
			a.pinImage(n)
		}
		if m.Item(tr("标注…")).Chosen() {
			a.annotateNote(n)
		}
		if m.Item(tr("图片打码…")).Chosen() {
			a.openRedactor(n)
		}
	}
	m.Separator()
	done := tr("标记完成")
	if n.Done {
		done = tr("取消完成")
	}
	if m.Item(done).Chosen() {
		a.toggleDone()
	}
	if !multi {
		keep := tr("设为常用 · 发送后保留")
		switch {
		case isClip && n.Kept:
			keep = tr("取消固定")
		case isClip:
			keep = tr("固定 · 不被清理")
		case n.Kept:
			keep = tr("取消常用")
		}
		if m.Item(keep).Chosen() {
			_ = a.store.SetKept(n.ID, !n.Kept)
		}
		blur := tr("模糊内容")
		if n.Blur {
			blur = tr("取消模糊")
		}
		if m.Item(blur).Chosen() {
			_ = a.store.SetBlur(n.ID, !n.Blur)
		}
		if m.Item(tr("重命名…")).Chosen() {
			a.titleEditID, a.titleText = n.ID, n.Title
		}
		m.Submenu(tr("标签"), func(sm *ui.Menu) {
			for _, t := range a.store.AllTags() {
				if sm.Item(t).Checked(slices.Contains(n.Tags, t)).Chosen() {
					tags := slices.Clone(n.Tags)
					if slices.Contains(tags, t) {
						tags = slices.DeleteFunc(tags, func(x string) bool { return x == t })
					} else if len(tags) < 8 {
						tags = append(tags, t)
					}
					_ = a.store.SetTags(n.ID, tags)
				}
			}
			sm.Separator()
			if sm.Item(tr("新标签…")).Chosen() {
				a.tagEditID, a.tagText = n.ID, ""
			}
		})
		if !isImage {
			if m.Item(tr("AI 转任务")).Chosen() {
				a.noteToTaskAI(n)
			}
		}
		if n.Kind != "image" && m.Item(tr("AI 起标题")).Chosen() {
			a.suggestTitle(n)
		}
		if !isImage && m.Item(tr("转为任务")).Chosen() {
			a.convertToTask(n, "", nil, tr("已转为任务"))
		}
		a.replyMenu(m, n)
	}
	if !isClip && n.Kind != "secret" && m.Item(tr("导出笔记包…")).Chosen() {
		a.exportNotes(a.chosenNotes())
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

// noteLink：链接卡的 URL，或正文本身就是一个 http(s) 链接。
func noteLink(n store.Note) string {
	raw := n.URL
	if raw == "" {
		raw = strings.TrimSpace(n.Text)
	}
	if strings.ContainsAny(raw, " \n") {
		return ""
	}
	if u, err := url.Parse(raw); err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != "" {
		return u.String()
	}
	return ""
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
