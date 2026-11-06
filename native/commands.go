package main

import (
	"fmt"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// ⌘K 命令面板（同 Tauri CommandPalette / commandItems.ts）：无查询词只给动作；有查询词时动作按文字过滤，
// 再附卡片 / 任务命中（各最多 6 条）。↑↓ 移动、↵ 执行、Esc 或再按 ⌘K 关闭。

type cmdItem struct {
	id, group, label, hint, shortcut string
	run                              func()
}

const cmdMaxHits = 6

func (a *app) commandItems(raw string) []cmdItem {
	q := strings.ToLower(strings.TrimSpace(raw))
	onList := a.page == pageClip || a.page == pageNotes && a.noteSub == 0
	var acts []cmdItem
	if cur, ok := a.current(); onList && a.chosen.Len() > 0 {
		n := a.chosen.Len()
		acts = append(acts,
			cmdItem{id: "send-checked", group: "动作", label: fmt.Sprintf(tr("发送勾选的 %d 张卡到对话"), n), shortcut: "⌘⏎", run: a.sendSelected},
			cmdItem{id: "preflight-checked", group: "动作", label: tr("检查后发送勾选的卡…"), run: func() { a.checkSend(a.chosenNotes()) }})
	} else if onList && ok && a.focusList {
		acts = append(acts,
			cmdItem{id: "send-focused", group: "动作", label: tr("发送焦点卡片到对话"), shortcut: "⌘⏎", run: func() { a.send([]store.Note{cur}) }},
			cmdItem{id: "preflight-focused", group: "动作", label: tr("检查后发送焦点卡片…"), run: func() { a.checkSend([]store.Note{cur}) }})
	}
	acts = append(acts,
		cmdItem{id: "search", group: "动作", label: tr("搜索当前页"), shortcut: "⌘F", run: func() {
			if a.page != pageTasks {
				a.searchOpen = true
				a.search.Focus()
			}
		}},
		cmdItem{id: "page-notes", group: "动作", label: tr("切到内容页"), shortcut: "⌘←→", run: func() { a.switchPage(pageNotes) }},
		cmdItem{id: "page-clipboard", group: "动作", label: tr("切到剪贴页"), run: func() { a.switchPage(pageClip) }},
		cmdItem{id: "page-tasks", group: "动作", label: tr("切到提醒页"), run: func() { a.switchPage(pageTasks) }},
		cmdItem{id: "add-section", group: "动作", label: tr("新建分组"), run: func() {
			a.switchPage(pageNotes)
			a.noteSub, a.newSecOn, a.newSec = 0, true, ""
		}},
		cmdItem{id: "recent", group: "动作", label: tr("最近发送记录"), run: func() { a.drawerOpen = true }},
		cmdItem{id: "settings", group: "动作", label: tr("打开设置"), shortcut: "⌘,", run: a.openSettings},
	)
	if q == "" {
		return acts
	}
	var out []cmdItem
	for _, it := range acts {
		if strings.Contains(strings.ToLower(it.label), q) {
			out = append(out, it)
		}
	}
	hits := 0
	for _, n := range a.store.Notes() {
		if hits >= cmdMaxHits {
			break
		}
		if n.Kind == "secret" || n.Section == "secret" {
			continue
		}
		label := cmdNoteLabel(n)
		if !strings.Contains(strings.ToLower(label), q) && !strings.Contains(strings.ToLower(n.Text), q) {
			continue
		}
		hits++
		hint := tr("笔记")
		if n.Section == store.SectionClipboard {
			hint = tr("剪贴")
		}
		out = append(out, cmdItem{id: "note:" + n.ID, group: "卡片", label: label, hint: hint, run: func() { a.focusNote(n) }})
	}
	hits = 0
	for _, t := range a.store.Tasks() {
		if hits >= cmdMaxHits {
			break
		}
		if !strings.Contains(strings.ToLower(t.Text), q) {
			continue
		}
		hits++
		hint := tr("任务")
		if t.Status == "done" {
			hint = tr("已完成")
		}
		out = append(out, cmdItem{id: "task:" + t.ID, group: "任务", label: firstLine(t.Text), hint: hint, run: func() {
			a.switchPage(pageTasks)
			a.openTaskEdit(t)
		}})
	}
	return out
}

func cmdNoteLabel(n store.Note) string {
	if l := firstLine(n.Title); l != "" {
		return l
	}
	if l := firstLine(n.Text); l != "" {
		return l
	}
	if n.URL != "" {
		return n.URL
	}
	return tr("（无文字）")
}

// focusNote 切到卡片所在页并把键盘焦点放上去（清搜索；所在分组折叠则展开）。
func (a *app) focusNote(n store.Note) {
	page := pageNotes
	if n.Section == store.SectionClipboard {
		page = pageClip
	}
	a.switchPage(page)
	a.noteSub, a.searchOpen, a.query = 0, false, ""
	a.reload()
	if _, ok := a.noteIdx[n.ID]; !ok {
		for _, s := range a.store.Sections() {
			if s.ID == n.Section && s.Collapsed {
				s.Collapsed = false
				_ = a.store.UpdateSection(s)
			}
		}
		a.reload()
	}
	if i, ok := a.noteIdx[n.ID]; ok {
		a.focusAt(i)
	}
}

// commandPalette 画命令面板浮层（遮罩点一下关闭）。
func (a *app) commandPalette(c *ui.Context, k tokens) {
	if !a.cmdOpen {
		return
	}
	items := a.commandItems(a.cmdQuery)
	a.cmdCursor = max(0, min(a.cmdCursor, len(items)-1))
	runAt := func(i int) {
		if i >= 0 && i < len(items) {
			a.cmdOpen = false
			items[i].run()
		}
	}
	scrim := ui.Box(c).Absolute().Top(0).Left(0).Right(0).Bottom(0).Background(ui.RGBA(0, 0, 0, 0.15)).Key("cmd-scrim")
	if k.dark {
		scrim.Background(ui.RGBA(0, 0, 0, 0.35))
	}
	if scrim.Clicked() {
		a.cmdOpen = false
	}
	_, vh := c.Size()
	fade := ui.ElementTransition{Duration: 120 * time.Millisecond, Ease: easeTw, Enter: &ui.Motion{Y: -4}}
	floatSurface(ui.Column(c).Absolute().Left(12).Right(12).Top(56).MaxHeight(vh*0.7).Padding(6).Radius(12), k).
		Key("cmd-palette").Transition(fade).Label(tr("命令面板")).Children(func() {
		ui.Row(c).Height(30).Padding(0, 8).Gap(8).AlignItems(ui.Center).BorderWidth(0, 0, 1, 0).BorderColor(k.bandLine).Children(func() {
			licon(c, "command", 14, k.muted)
			prev := a.cmdQuery
			ui.TextInputBase(c, &a.cmdQuery).Grow(1).Font(fontSans).FontSize(13).FixedLineHeight(18).TextColor(k.fg).
				Placeholder(tr("输入命令，或搜索卡片、任务…")).Focus().OnTextKey(func(key ui.TextKey) bool {
				switch key.Key {
				case ui.KeyEscape:
					a.cmdOpen = false
				case ui.KeyDown, ui.KeyUp:
					if n := len(items); n > 0 {
						d := 1
						if key.Key == ui.KeyUp {
							d = -1
						}
						a.cmdCursor = (a.cmdCursor + d + n) % n
					}
				case ui.KeyEnter:
					runAt(a.cmdCursor)
				case ui.KeyK:
					if key.Mods == ui.Cmd {
						a.cmdOpen = false
						return true
					}
					return false
				default:
					return false
				}
				return true
			})
			if a.cmdQuery != prev {
				a.cmdCursor = 0
			}
			keycap(c, k, "Esc", 0)
		})
		ui.Scroll(c).Grow(1).Shrink(1).Scrollbars(false).Children(func() {
			ui.Column(c).Padding(4, 0).Children(func() {
				if len(items) == 0 {
					text(c, tr("没有匹配的命令或卡片"), 11, 16, 400, k.muted).Padding(12, 8).TextAlign(ui.Center)
				}
				last := ""
				for i, it := range items {
					if it.group != last {
						last = it.group
						text(c, tr(it.group), 10, 14, 500, k.muted).Padding(6, 8, 2, 8)
					}
					row := ui.Row(c).Height(26).Padding(0, 8).Gap(8).Radius(6).AlignItems(ui.Center).Key("cmd-" + it.id).Role(ui.RoleButton).Label(it.label)
					if row.Hovered() {
						a.cmdCursor = i
					}
					fg := k.fg
					if i == a.cmdCursor {
						row.Background(k.pressed)
					}
					row.Children(func() {
						text(c, it.label, 12, 18, 400, fg).SingleLine().Grow(1).Basis(0)
						if it.hint != "" {
							text(c, it.hint, 10, 14, 400, k.muted)
						}
						if it.shortcut != "" {
							keycap(c, k, it.shortcut, 0)
						}
					})
					if row.Clicked() {
						runAt(i)
					}
				}
			})
		})
	})
}
