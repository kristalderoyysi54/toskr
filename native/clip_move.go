package main

import (
	"fmt"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// 剪贴卡「收进笔记」浮钮（同 Tauri MoveToNotesButton）：单击收进收件箱；长按（450ms）或右键弹出「移入笔记分类」挑分组。
// 多选时作用于所选全部剪贴卡（同卡片的多选感知移动）。

const longPressDelay = 450 * time.Millisecond

var lpAfter = func(d time.Duration, f func()) { time.AfterFunc(d, f) } // 测试里同步触发

type longPress struct {
	key   string
	fired bool
	at    ui.Rect
}

// clipMoveTargets：要移动的卡——当前卡在多选里就是整组，否则只有它。
func (a *app) clipMoveTargets(n store.Note) []store.Note {
	if a.chosen.Has(n.ID) && a.chosen.Len() > 1 {
		return a.chosenNotes()
	}
	return []store.Note{n}
}

// moveClipsTo：剪贴卡收进内容页（收件箱或分组）。用户 2026-11-17 定为「收下」语义：复制过去，原卡留在剪贴页带绿色分组小标，见 keepClipsTo。
func (a *app) moveClipsTo(notes []store.Note, section string) {
	a.keepClipsTo(notes, section)
}

func (a *app) noteSectionItems(m *ui.Menu, n store.Note) {
	m.Item(tr("收到哪里")).Disabled(true)
	for _, s := range a.store.Sections() {
		if s.ID == store.SectionClipboard {
			continue
		}
		name := sectionName(s)
		if s.ID == store.SectionInbox {
			name = tr("收件箱")
		}
		if m.Item(name).Chosen() {
			a.moveClipsTo(a.clipMoveTargets(n), s.ID)
		}
	}
}

// clipInboxButton 处理浮钮的单击 / 长按 / 右键。
func (a *app) clipInboxButton(b ui.Element, n store.Note) {
	b.ContextMenu(func(m *ui.Menu) { a.noteSectionItems(m, n) })
	key := n.ID
	at := b.Bounds() // 每帧都取：mygo 只记录上一帧要过位置的元素
	switch {
	case b.Pressed() && a.lp.key != key:
		a.lp = longPress{key: key, at: at}
		lpAfter(longPressDelay, func() {
			a.onMain(func() {
				if a.lp.key == key && !a.lp.fired {
					a.lp.fired, a.clipPick, a.clipPickAt = true, key, a.lp.at
				}
			})
		})
	case !b.Pressed() && a.lp.key == key && !a.lp.fired:
		a.lp = longPress{} // 不到 450ms 就松开：普通单击
	}
	if b.Clicked() {
		if a.lp.key == key && a.lp.fired { // 长按后的松开不算单击
			a.lp = longPress{}
			return
		}
		a.lp = longPress{}
		a.moveClipsTo(a.clipMoveTargets(n), store.SectionInbox)
	}
}

// clipRemindPopover：「提醒我」浮层——输入框直接写时间（「后天下午3点」「3小时后」「周五 10:30」，与任务速记同一套解析），
// 下面实时显示认出的时间；也可以点快捷档。⏎ 确定，Esc 关闭。设提醒同时收进收件箱。
func (a *app) clipRemindPopover(c *ui.Context, k tokens) {
	if a.remindPick == "" {
		return
	}
	n, ok := a.store.Note(a.remindPick)
	if !ok || n.Section != store.SectionClipboard {
		a.remindPick = ""
		return
	}
	now := a.now()
	due := parseQuickTask(a.remindText, now, nil).due
	valid := !due.IsZero() && due.After(now)
	confirm := func(at time.Time) {
		a.remindPick, a.remindText = "", ""
		a.remindClip(n, at)
	}
	var presets []store.DuePreset
	for _, p := range a.store.Settings().Presets() {
		if p.Due(now).After(now) { // 今天 20:00 这类已经过了的不列
			presets = append(presets, p)
		}
	}
	p := stok(c).primary
	white := ui.RGB(255, 255, 255)
	w, h := c.Size()
	at := a.remindAt
	ui.Overlay(c, func() {
		if ui.Box(c).Absolute().Left(0).Top(0).Size(w, h).Key("remind-dim").Clicked() {
			a.remindPick = ""
		}
		pw := min(float32(280), w-16)
		rows := (len(presets) + 2) / 3
		ph := float32(12+20+8+32+6+16+12) + float32(rows)*(26+5)
		x := min(max(8, at.X+at.W-pw), w-pw-8)
		y := at.Y - ph - 6
		if y < 8 {
			y = at.Y + at.H + 6
		}
		pop := floatSurface(ui.Column(c).Absolute().Left(x).Top(y).Width(pw).Padding(12).Gap(6).Radius(rr(12)).Key("remind-pop"), k)
		if pop.OverlayShortcut(0, ui.KeyEscape) {
			a.remindPick = ""
		}
		pop.Children(func() {
			ui.Row(c).Height(20).Gap(5).AlignItems(ui.Center).Children(func() {
				licon(c, "alarm-clock", 13, k.fg)
				text(c, tr("提醒我"), 11, 16, 600, k.fg)
				ui.Box(c).Grow(1)
				text(c, tr("同时收进收件箱"), 10, 14, 400, k.muted)
			})
			in := ui.Row(c).Height(32).FillWidth().Gap(6).Padding(0, 4, 0, 10).Radius(rr(9)).AlignItems(ui.Center).Background(k.track).Border(1, k.inputBorder).Margin(2, 0, 0, 0)
			if valid {
				in.Border(1, p)
			}
			in.Children(func() {
				ui.TextInputBase(c, &a.remindText).Grow(1).Font(fontSans).FontSize(12).Focus().
					Placeholder(tr("后天下午3点、3小时后、周五 10:30")).OnTextKey(func(key ui.TextKey) bool {
					switch key.Key {
					case ui.KeyEnter:
						if d := parseQuickTask(key.Text(), a.now(), nil).due; !d.IsZero() && d.After(a.now()) {
							confirm(d)
						}
						return true
					case ui.KeyEscape:
						a.remindPick = ""
						return true
					}
					return false
				})
				ok := ui.Row(c).Height(24).Padding(0, 8).Radius(rr(7)).AlignItems(ui.Center).Shrink(0).Key("remind-ok").Role(ui.RoleButton).Label(tr("设提醒"))
				if valid {
					ok.Background(p)
				} else {
					ok.Background(k.fg.Alpha(0.08))
				}
				ok.Children(func() {
					col := k.muted
					if valid {
						col = white
					}
					text(c, "⏎", 11, 14, 600, col)
				})
				if ok.Clicked() && valid {
					confirm(due)
				}
			})
			// 认出的时间（或为什么不能设）
			ui.Row(c).Height(16).Gap(4).Padding(0, 2).AlignItems(ui.Center).Key("remind-preview").Children(func() {
				switch {
				case strings.TrimSpace(a.remindText) == "":
					text(c, tr("输入时间，或点下面的快捷档"), 10.5, 15, 400, k.muted)
				case due.IsZero():
					licon(c, "circle-question-mark", 11, k.amberText)
					text(c, tr("认不出时间，换个说法试试"), 10.5, 15, 400, k.amberText)
				case !due.After(now):
					licon(c, "circle-alert", 11, k.amberText)
					text(c, tr("这个时间已经过了"), 10.5, 15, 400, k.amberText)
				default:
					licon(c, "check", 11, p)
					text(c, dueLabel(due, now), 10.5, 15, 500, p)
				}
			})
			for r := 0; r*3 < len(presets); r++ {
				ui.Row(c).FillWidth().Gap(5).Children(func() {
					for i := r * 3; i < min(len(presets), r*3+3); i++ {
						pr := presets[i]
						b := ui.Row(c).Height(26).Grow(1).Basis(0).Padding(0, 6).Radius(rr(8)).AlignItems(ui.Center).Justify(ui.Center).
							Background(k.card).Border(1, k.inputBorder).Key("rp-" + pr.ID).Role(ui.RoleButton).Label(presetLabel(pr))
						if b.Hovered() {
							b.Border(1, p.Alpha(0.6))
						}
						b.Children(func() { text(c, presetLabel(pr), 10.5, 15, 500, k.fg).SingleLine().Shrink(1) })
						if b.Clicked() {
							confirm(pr.Due(now))
						}
					}
					for range r*3 + 3 - min(len(presets), r*3+3) {
						ui.Box(c).Grow(1).Basis(0)
					}
				})
			}
		})
	})
}

// dueLabel：提醒时间的读法——今天 / 明天 / 后天 / 周几（7 天内）/ 月日，后跟时分。
func dueLabel(t, now time.Time) string {
	day := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	d := int(time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, t.Location()).Sub(day).Hours() / 24)
	hm := t.Format("15:04")
	switch {
	case d == 0:
		return tr("今天 ") + hm
	case d == 1:
		return tr("明天 ") + hm
	case d == 2:
		return tr("后天 ") + hm
	case d > 0 && d < 7:
		return tr("周") + weekdayLabel(int(t.Weekday())) + " " + hm
	}
	return fmt.Sprintf(tr("%d 月 %d 日 "), t.Month(), t.Day()) + hm
}

// clipPickPopover：「收到哪里」浮层（底栏「收下」旁的小箭头、浮钮长按都弹它；窗口级，挂在触发处上方）。
// 主操作是收件箱（主题色整条），下面是分组（数字键 1–9，建议分组带角标）。键盘：⏎ 收件箱 · 数字键分组 · Esc 关闭。
func (a *app) clipPickPopover(c *ui.Context, k tokens) {
	if a.clipPick == "" {
		return
	}
	n, ok := a.store.Note(a.clipPick)
	if !ok || n.Section != store.SectionClipboard {
		a.clipPick = ""
		return
	}
	p := stok(c).primary
	white := ui.RGB(255, 255, 255)
	w, h := c.Size()
	at := a.clipPickAt
	secs := a.fileTargets()
	sug, hasSug := a.suggestFile(n)
	keep := func(section string) { a.keepClipsTo(a.clipMoveTargets(n), section) }
	ui.Overlay(c, func() {
		if ui.Box(c).Absolute().Left(0).Top(0).Size(w, h).Key("clip-pick-dim").Clicked() {
			a.clipPick = ""
		}
		pw := min(float32(300), w-16)
		rows := (len(secs) + 2) / 3
		ph := float32(12 + 20 + 6 + 30 + 6 + 12)
		if rows > 0 {
			ph += float32(rows)*28 + float32(rows-1)*5 + 6
		}
		x := min(max(8, at.X+at.W-pw), w-pw-8)
		y := at.Y - ph - 6
		if y < 8 {
			y = at.Y + at.H + 6
		}
		pop := floatSurface(ui.Column(c).Absolute().Left(x).Top(y).Width(pw).Padding(12).Gap(6).Radius(rr(12)).Key("clip-pick"), k)
		switch { // 托盘开着时无论焦点在哪都收得到
		case pop.OverlayShortcut(0, ui.KeyEnter):
			keep(store.SectionInbox)
		default:
			for i, s := range secs {
				if pop.OverlayShortcut(0, digitKeys[i]) {
					keep(s.ID)
				}
			}
		}
		pop.Children(func() {
			ui.Row(c).Height(20).Gap(5).AlignItems(ui.Center).Children(func() {
				text(c, tr("收到哪里"), 11, 16, 600, k.fg)
				ui.Box(c).Grow(1)
				kbdHint(c, "⏎", k.muted)
				text(c, tr("收件箱"), 10, 14, 400, k.muted)
				if len(secs) > 0 {
					kbdHint(c, fileKeyHint(len(secs)), k.muted)
					text(c, tr("分组"), 10, 14, 400, k.muted)
				}
				kbdHint(c, "Esc", k.muted)
			})
			main := ui.Row(c).Height(30).FillWidth().Gap(6).Padding(0, 10).Radius(rr(9)).AlignItems(ui.Center).Background(p).Key("cp-inbox").Role(ui.RoleButton).Label(tr("收进收件箱"))
			if main.Hovered() {
				main.Background(p.Mix(white, 0.08))
			}
			main.AnimatePose(ui.Pose{Scale: pressScale(main.Pressed(), 0.98)}, tweenControl)
			main.Children(func() {
				licon(c, "inbox", 13, white)
				text(c, tr("收件箱"), 12, 16, 600, white)
				text(c, tr("稍后再归类"), 10.5, 15, 400, white.Alpha(0.75)).SingleLine().Shrink(1)
				ui.Box(c).Grow(1)
				kbdHint(c, "⏎", white)
			})
			if main.Clicked() {
				keep(store.SectionInbox)
			}
			if len(secs) == 0 {
				text(c, tr("还没有分组：在内容页点 + 新建"), 10.5, 15, 400, k.muted)
				return
			}
			for r := 0; r*3 < len(secs); r++ {
				ui.Row(c).FillWidth().Gap(5).Children(func() {
					for i := r * 3; i < min(len(secs), r*3+3); i++ {
						s := secs[i]
						isSug := hasSug && sug.section == s.ID
						b := ui.Row(c).Height(28).Grow(1).Basis(0).Gap(5).Padding(0, 6).Radius(rr(8)).AlignItems(ui.Center).Justify(ui.Center).
							Background(k.card).Border(1, k.inputBorder).Key("cp-" + s.ID).Role(ui.RoleButton).Label(tr("收到 ") + sectionName(s))
						col := k.fg
						switch {
						case isSug: // 建议分组：主题色描边 + 浅底 + 角标
							b.Border(1, p).Background(p.Alpha(0.12))
							col = p
						case b.Hovered():
							b.Border(1, p.Alpha(0.6))
						}
						if isSug {
							tipOf(c, b, tr("建议：")+sug.why)
						}
						b.Children(func() {
							text(c, itoa(i+1), 9.5, 13, 500, k.muted).Font(fontMono).Shrink(0)
							text(c, sectionName(s), 11, 15, 500, col).SingleLine().Shrink(1)
							if isSug {
								text(c, tr("建议"), 8.5, 12, 600, white).Padding(0, 3).Radius(4).Background(p).Shrink(0)
							}
						})
						if b.Clicked() {
							keep(s.ID)
						}
					}
					for range r*3 + 3 - min(len(secs), r*3+3) { // 末行不满 3 个：补空位，按钮宽度与上一行一致
						ui.Box(c).Grow(1).Basis(0)
					}
				})
			}
		})
	})
}

var digitKeys = []ui.Key{ui.Key1, ui.Key2, ui.Key3, ui.Key4, ui.Key5, ui.Key6, ui.Key7, ui.Key8, ui.Key9}

// kbdHint：键帽样式的按键提示（等宽小字 + 细边）。
func kbdHint(c *ui.Context, s string, col ui.Color) {
	text(c, s, 9.5, 13, 500, col).Font(fontMono).Padding(0, 4).Radius(4).Border(1, col.Alpha(0.45)).Shrink(0)
}

// clipKeepLinks：剪贴卡底栏右端常驻「收下 ˅ / 提醒」（主题色文字链接）；收下后换成绿色分组小标，点它跳到内容页里的那一条。
func (a *app) clipKeepLinks(c *ui.Context, k tokens, n store.Note) {
	p := stok(c).primary
	if sec := a.store.SavedSection(n); sec != "" {
		pill := tipOf(c, ui.Row(c).Height(16).Gap(3).Padding(0, 7, 0, 5).Radius(999).AlignItems(ui.Center).Background(k.ok.Alpha(0.14)).Shrink(0).
			Key("saved-"+n.ID).Role(ui.RoleButton).Label(tr("已收下：")+a.sectionLabel(sec)), tr("在内容页查看"))
		pill.Children(func() {
			licon(c, "check", 10, k.ok)
			text(c, a.sectionLabel(sec), 10, 14, 500, k.ok).SingleLine()
		})
		if pill.Clicked() {
			if copy, ok := a.store.Note(n.SavedTo); ok {
				a.focusNote(copy)
			}
		}
		return
	}
	link := func(key, label, tip string) ui.Element {
		b := tipOf(c, ui.Row(c).Height(16).Padding(0, 1).Radius(4).AlignItems(ui.Center).Shrink(0).Key(key+n.ID).Role(ui.RoleButton).Label(label), tip)
		col := p
		if b.Hovered() {
			col = p.Mix(k.fg, 0.25)
		}
		b.Children(func() { text(c, label, 10.5, 14, 500, col).SingleLine() })
		return b
	}
	ui.Row(c).Gap(8).AlignItems(ui.Center).Shrink(0).Margin(0, 0, 0, 4).Children(func() {
		ui.Row(c).Gap(1).AlignItems(ui.Center).Children(func() {
			if link("keep-", tr("收下"), tr("收进收件箱，剪贴页里这条会保留")).Clicked() {
				a.keepClipsTo(a.clipMoveTargets(n), store.SectionInbox)
			}
			open := a.clipPick == n.ID
			caret := tipOf(c, ui.Box(c).Size(14, 14).Radius(4).Center().Key("keepto-"+n.ID).Role(ui.RoleButton).Label(tr("收到哪里")), tr("选分组收下（⏎ 收件箱 · 数字键分组）"))
			if open || caret.Hovered() {
				caret.Background(p.Alpha(0.12))
			}
			caret.Children(func() {
				name := "chevron-down"
				if open {
					name = "chevron-up"
				}
				licon(c, name, 11, p)
			})
			if caret.Clicked() {
				if open {
					a.clipPick = ""
				} else {
					a.remindPick = ""
					a.clipPick, a.clipPickAt = n.ID, caret.Bounds()
				}
			}
		})
		if r := link("remind-", tr("提醒"), tr("设提醒（同时收进收件箱）")); r.Clicked() {
			if a.remindPick == n.ID {
				a.remindPick = ""
			} else {
				a.clipPick = ""
				a.remindPick, a.remindAt, a.remindText = n.ID, r.Bounds(), ""
			}
		}
	})
}

// deleteSelfOrChosen 同 Tauri deleteSelfOrChecked：当前卡在多选里就删整组，提示「已删除 n 条」，可撤销。
func (a *app) deleteSelfOrChosen(n store.Note) {
	targets := a.clipMoveTargets(n)
	ids := make([]string, len(targets))
	for i, x := range targets {
		ids[i] = x.ID
		a.chosen.Remove(x.ID)
	}
	a.deleteNotesUndo(ids, fmt.Sprintf(tr("已删除 %d 条"), len(ids)))
}
