package main

import (
	"fmt"
	"net/url"
	"os/exec"
	"slices"
	"strings"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// queueKeys：笔记 / 剪贴页的卡片快捷键（同 Tauri）：⌘⏎ 发送勾选、⌘1-9 快发第 N 张、⌘C 复制为列表、⌘A 全选、
// ↑↓ 移动焦点、←→ 移动并单选、Space 预览（链接卡开网页）、x 勾选、d 完成、p 置顶 / 常用、Enter 编辑、⌘⌫ 删除焦点卡。
func (a *app) queueKeys(c *ui.Context) {
	if a.titleEditID != "" || a.tagEditID != "" || a.quickOpen {
		return // 输入框 / 方案快速切换浮层自己处理按键
	}
	if c.Shortcut(ui.Cmd, ui.KeyEnter) {
		if len(a.pending) > 0 { // 预检开着：⌘⏎ 提交预检（同 Tauri PreflightComposer），不重新发起
			a.pfSubmit()
		} else {
			a.sendSelected()
		}
	}
	if c.Shortcut(ui.Cmd|ui.Alt, ui.KeyEnter) {
		a.sendQueue()
	}
	for i, key := range []ui.Key{ui.Key1, ui.Key2, ui.Key3, ui.Key4, ui.Key5, ui.Key6, ui.Key7, ui.Key8, ui.Key9} {
		if c.Shortcut(ui.Cmd, key) && i < len(a.notes) { // Paste 式快发
			a.sendFromList([]store.Note{a.notes[i]})
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
	peeking := a.peekOn && len(a.peekFiles) > 1 // 悬停窥视多图时 ← / → 换张，不动列表选择
	for _, step := range []struct {
		key ui.Key
		d   int
	}{{ui.KeyLeft, -1}, {ui.KeyRight, 1}} {
		if peeking && c.Shortcut(0, step.key) {
			a.peekStep(step.d)
			continue
		}
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
		} else if a.detailWin != nil && a.detailWin.IsVisible() && a.detail.id == cur.ID {
			a.detailWin.Hide() // 同 Tauri toggleNoteDetail：同一张卡再按 Space 收起详情窗
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
		a.section, a.selected = id, 0
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
		_, vh := c.Size()
		ui.Scroll(c).MaxHeight(max(240, vh*0.6)).Children(func() { a.preflightBar(c) })
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
			} else if tipOf(c, ui.Icon(c, iconPlus).FontSize(13).TextColor(t.TextMuted).Padding(4), tr("新建分组")).Clicked() {
				a.newSecOn = true
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
			if btnOf(c, tr("粘贴并回车")).Clicked() {
				a.enterAsk = nil
				a.deliver(notes, true, tmpl)
			}
			if btnOf(c, tr("仅粘贴")).Clicked() {
				a.enterAsk = nil
				a.deliver(notes, false, tmpl)
			}
			if btnOf(c, tr("取消")).Clicked() {
				a.cancelEnterAsk()
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
						if tipOf(c, ui.Icon(c, iconDone).FontSize(13).TextColor(t.Success), tr("恢复为未完成")).Clicked() {
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
		if n.Kind == "image" {
			if img := a.thumb(n.ImageFile); img != nil {
				w, h := ui.ImageSize(img)
				dw := min(w, 300)
				ui.Image(c, img).Size(dw, h*dw/max(w, 1)).Radius(rr(8))
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
			if tipOf(c, ui.Icon(c, iconCircle).FontSize(12).TextColor(t.TextMuted), tr("标记完成（⌘D）")).Clicked() {
				_ = a.store.SetDone(n.ID, true)
			}
			meta := ago(n.CreatedAt, time.Now())
			if n.SourceApp != "" {
				meta = n.SourceApp + " · " + meta
			}
			ui.Text(c, meta).FontSize(10).TextColor(t.TextMuted).SingleLine().Grow(1)
			if a.aiBusy == n.ID {
				ui.Spinner(c).Size(12, 12)
				if a.aiCancel != nil {
					if ghostIconButton(c, tok(c), "ai-cancel-"+n.ID, "x", tr("取消 AI 请求"), 18, 11, false, true).Clicked() {
						a.cancelAI()
					}
				}
			}
			if n.Kept {
				ui.Badge(c, tr("保留"))
			}
			if !n.SentAt.IsZero() {
				tipOf(c, ui.Icon(c, iconCheck).FontSize(11).TextColor(t.Success), tr("已发送"))
			}
			if i == a.selected {
				if tipOf(c, ui.Icon(c, iconCopy).FontSize(12).TextColor(t.TextMuted), tr("复制")).Clicked() {
					a.copySelected(c)
				}
				if tipOf(c, ui.Icon(c, iconSend).FontSize(12).TextColor(t.Accent), tr("发送（⌘↵）")).Clicked() {
					a.sendSelected()
				}
			}
		})
	})
	// 单击 / ⌘点击 / ⇧点击选择与双击编辑都交给 List（Selection + Submitted），卡片自身不接点击
}

func (a *app) cardMenu(c *ui.Context, m *ui.Menu, i int, n store.Note) {
	// 同 Tauri NoteCard：被右键的卡本身在勾选集合里（≥2）才走批量；否则只作用于这一张，勾选集合保持不动
	multi := a.chosen.Len() > 1 && a.chosen.Has(n.ID)
	if !multi {
		a.selected = i
		a.menuTarget = &n
		defer func() { a.menuTarget = nil }()
	}
	isClip := n.Section == store.SectionClipboard
	isImage := n.Kind == "image" || len(n.MediaFiles()) > 0
	// 骨架同 Tauri（方案 A）：多选先给合并与移动 → 发送区 → 常用区 → 整理 / 转换与导出二级菜单 → 回复关联 → 删除；
	// 发送、常用、整理、转换各区的显隐与顺序来自设置「卡片右键菜单」。
	parts := store.PartitionMenu(a.store.Settings().ContextMenu, isClip)
	if multi { // 同 Tauri：多选菜单顶部标「已选 N 项」
		m.Item(fmt.Sprintf(tr("已选 %d 项"), a.chosen.Len())).Disabled(true)
	}
	mergeN := a.chosen.Len()
	if !a.chosen.Has(n.ID) {
		mergeN++
	}
	if mergeN >= 2 {
		// 合并用「勾选 ∪ 当前卡」（同 Tauri NoteCard mergeIds）
		if m.Item(fmt.Sprintf(tr("合并笔记 ×%d"), mergeN)).Chosen() {
			a.withChosenPlus(n, func() { a.mergeChosen(c) })
		}
	}
	if multi {
		if slices.Contains(parts["main"], "move") || slices.Contains(parts["organize"], "move") {
			a.menuEntry(c, m, "move", n, multi, isClip, isImage)
		}
		m.Separator()
	}
	section := func(m *ui.Menu, ids []string) {
		for _, id := range ids {
			if !(multi && id == "move") { // 多选时已提到合并之后
				a.menuEntry(c, m, id, n, multi, isClip, isImage)
			}
		}
	}
	section(m, parts["send"])
	m.Separator()
	section(m, parts["main"])
	if files := n.MediaFiles(); len(files) > 0 && !multi { // 原生版图片工具（Tauri 在预览窗里）：一张直接作用，多张（多图 / 图文卡）选哪一张
		m.Separator()
		tool := func(label string, do func(string)) {
			if len(files) == 1 {
				if m.Item(label).Chosen() {
					do(files[0])
				}
				return
			}
			m.Submenu(label, func(sm *ui.Menu) {
				for i, f := range files {
					label := fmt.Sprintf(tr("图片 %d"), i+1)
					if alt := n.AltOf(f); alt != "" {
						label += " · " + clipRunes(alt, 16)
					}
					if sm.Item(label).Chosen() {
						do(f)
					}
				}
			})
		}
		tool(tr("钉到屏幕"), a.pinImageFile)
		tool(tr("标注…"), func(f string) { a.annotateFile(n, f) })
		tool(tr("图片打码…"), func(f string) { redactFileFn(a, n, f) })
	}
	m.Separator()
	if len(parts["organize"]) > 0 {
		m.Submenu(tr("整理"), func(sm *ui.Menu) { section(sm, parts["organize"]) })
	}
	aiPolish := n.Kind != "image" && !multi
	if len(parts["convert"]) > 0 || aiPolish {
		m.Submenu(tr("转换与导出"), func(sm *ui.Menu) {
			section(sm, parts["convert"])
			if aiPolish {
				sm.Submenu("AI", func(am *ui.Menu) {
					for _, act := range a.allAIActions() {
						if am.Item(tr(act.label)).Chosen() {
							a.runAI(n, act)
						}
					}
				})
			}
		})
	}
	if !multi {
		a.replyMenu(m, n)
	}
	if !multi && n.SendCount > 0 { // 一阵子集中用过的卡在「发送最多」里一直靠前：手动降下去
		if m.Item(fmt.Sprintf(tr("清零发送次数（%d）"), n.SendCount)).Chosen() {
			id := n.ID
			if prev, err := a.store.SetSendCount(id, 0); err == nil {
				a.showHUDUndo("ok", tr("已清零发送次数"), func() { _, _ = a.store.SetSendCount(id, prev) })
			}
		}
	}
	m.Separator()
	del := tr("删除")
	if multi {
		del += fmt.Sprintf(tr(" %d 项"), a.chosen.Len())
	}
	if m.Item(del).Chosen() {
		a.deleteSelected(c)
	}
}

// withChosenPlus：临时把 n 并进勾选集合执行 fn（合并、复制列表用「勾选 ∪ 当前卡」）。
func (a *app) withChosenPlus(n store.Note, fn func()) {
	saved := a.menuTarget
	a.menuTarget = nil
	added := !a.chosen.Has(n.ID)
	if added {
		a.chosen.Add(n.ID)
	}
	fn()
	if added {
		a.chosen.Remove(n.ID)
	}
	a.menuTarget = saved
}

// menuEntry 渲染一项可配置的右键菜单（同 Tauri NoteCard renderMenuItem）；卡片类型不适用时不出。
func (a *app) menuEntry(c *ui.Context, m *ui.Menu, id string, n store.Note, multi, isClip, isImage bool) {
	count := ""
	if multi {
		count = fmt.Sprintf(tr(" %d 项"), a.chosen.Len())
	}
	single := !multi
	switch id {
	case "preview":
		if !single {
			return
		}
		if link := noteLink(n); link != "" {
			if m.Item(tr("打开链接")).Chosen() {
				_ = exec.Command("/usr/bin/open", link).Start()
			}
			if n.Kind == "link" && n.URL != "" && m.Item(tr("确认获取链接预览…")).Chosen() {
				a.confirmFetchLink(n)
			}
			return
		}
		if n.Kind == "image" && n.ImageFile != "" {
			return // 图片卡不出预览（Space / 双击是主入口，同 Tauri）
		}
		if m.Item(tr("预览")).Chosen() {
			a.openDetail(n)
		}
	case "send":
		label := tr("发送到对话")
		if isClip {
			label = tr("发送 / 添加")
		}
		if m.Item(label + count).Chosen() {
			a.sendSelected()
		}
	case "send-preflight":
		if m.Item(tr("检查后发送…") + count).Chosen() {
			a.checkSend(a.chosenNotes())
		}
	case "send-template":
		a.templateMenu(m, tr("用模板发送"), a.chosenNotes)
	case "copy": // 同 Tauri：多选时仍在，作用于被右键的这张
		if m.Item(tr("复制原文（不脱敏）")).Chosen() {
			if !a.copyNoteMedia(n) {
				mygo.Clipboard.WriteText(n.Text)
				a.showHUD("ok", tr("已复制"))
			}
		}
	case "copy-list":
		plus := a.chosen.Len()
		if !a.chosen.Has(n.ID) {
			plus++
		}
		lc := ""
		if plus > 1 {
			lc = fmt.Sprintf(tr(" %d 项"), plus)
		}
		if m.Item(tr("复制原文为列表（不脱敏）") + lc).Chosen() {
			a.withChosenPlus(n, a.copyChosenAsList)
		}
	case "export":
		if !isClip && n.Kind != "secret" && m.Item(tr("导出笔记包…")+count).Chosen() {
			a.exportNotes(a.chosenNotes())
		}
	case "edit":
		if single && n.Kind != "image" && m.Item(tr("编辑")).Chosen() { // 同 Tauri：纯图片卡右键不给「编辑」（2026-08-27）；图文组合卡照常可编辑
			a.startEdit()
		}
	case "ocr":
		if single && n.Kind == "image" && n.ImageFile != "" && m.Item(tr("识别文字 (OCR)")).Chosen() {
			a.ocrNote(n)
		}
	case "done":
		label := tr("标记完成")
		if n.Done {
			label = tr("取消完成")
		}
		if m.Item(label).Chosen() { // 同 Tauri toggleDone(note.id)：只切这一张
			_ = a.store.SetDone(n.ID, !n.Done)
		}
	case "keep":
		label := tr("设为常用 · 发送后保留")
		switch {
		case isClip && n.Kept:
			label = tr("取消固定")
		case isClip:
			label = tr("固定 · 不被清理")
		case n.Kept:
			label = tr("取消常用")
		}
		if m.Item(label).Chosen() {
			_ = a.store.SetKept(n.ID, !n.Kept)
		}
	case "blur":
		label := tr("模糊内容")
		if n.Blur {
			label = tr("取消模糊")
		}
		if m.Item(label).Chosen() {
			_ = a.store.SetBlur(n.ID, !n.Blur)
		}
	case "rename":
		if single && m.Item(tr("重命名…")).Chosen() {
			a.titleEditID, a.titleText = n.ID, n.Title
		}
	case "tags":
		full := len(n.Tags) >= 8 // 同 Tauri：满 8 个后未选的标签与「新标签…」置灰
		m.Submenu(tr("标签"), func(sm *ui.Menu) {
			for _, t := range a.store.AllTags() {
				on := slices.Contains(n.Tags, t)
				if sm.Item(t).Checked(on).Disabled(full && !on).Chosen() {
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
			if sm.Item(tr("新标签…")).Disabled(full).Chosen() {
				a.tagEditID, a.tagText = n.ID, ""
			}
		})
	case "to-task":
		if !isImage && m.Item(tr("转为任务")).Chosen() {
			a.convertToTask(n, "", nil, tr("已转为任务"))
		}
	case "ai-to-task":
		if !isImage && m.Item(tr("AI 转任务")).Chosen() {
			a.noteToTaskAI(n)
		}
	case "ai-title":
		if single && n.Kind != "image" && m.Item(tr("AI 起标题")).Chosen() {
			a.suggestTitle(n)
		}
	case "move":
		label := tr("移动到")
		if isClip {
			label = tr("移入笔记分组")
		}
		m.Submenu(label, func(sm *ui.Menu) {
			for _, s := range a.store.Sections() {
				if isClip && s.ID != store.SectionClipboard && sm.Item(sectionName(s)).Chosen() {
					a.moveClipsTo(a.clipMoveTargets(n), s.ID)
					continue
				}
				if !isClip && s.ID != n.Section && s.ID != store.SectionClipboard && sm.Item(sectionName(s)).Chosen() {
					for _, x := range a.chosenNotes() {
						_ = a.store.MoveToAt(x.ID, s.ID, 0)
					}
					a.chosen.Clear()
				}
			}
		})
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
