package main

import (
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
	if a.chosen.Has(n.ID) {
		return a.chosenNotes()
	}
	return []store.Note{n}
}

func (a *app) moveClipsTo(notes []store.Note, section string) {
	for _, x := range notes {
		_ = a.store.MoveToAt(x.ID, section, 0)
	}
	a.chosen.Clear()
	a.reload()
	name := tr("收件箱")
	for _, s := range a.store.Sections() {
		if s.ID == section && section != store.SectionInbox {
			name = sectionName(s)
		}
	}
	if len(notes) == 1 {
		a.showHUD("ok", tr("已移入「")+name+"」")
	} else {
		a.showHUD("ok", tr("已移入「")+name+"」 "+itoa(len(notes))+tr(" 条"))
	}
}

func (a *app) noteSectionItems(m *ui.Menu, n store.Note) {
	m.Item(tr("移入笔记分类")).Disabled(true)
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

// clipPickPopover：长按弹出的分组选择浮层（窗口级，挂在按钮上方）。
func (a *app) clipPickPopover(c *ui.Context, k tokens) {
	if a.clipPick == "" {
		return
	}
	n, ok := a.store.Note(a.clipPick)
	if !ok || n.Section != store.SectionClipboard {
		a.clipPick = ""
		return
	}
	w, h := c.Size()
	at := a.clipPickAt
	ui.Overlay(c, func() {
		if ui.Box(c).Absolute().Left(0).Top(0).Size(w, h).Key("clip-pick-dim").Clicked() {
			a.clipPick = ""
		}
		var secs []store.Section
		for _, s := range a.store.Sections() {
			if s.ID != store.SectionClipboard {
				secs = append(secs, s)
			}
		}
		pw := float32(208)
		ph := float32(28 + 30*len(secs))
		x := min(max(8, at.X+at.W-pw), w-pw-8)
		y := at.Y - ph - 6
		if y < 8 {
			y = at.Y + at.H + 6
		}
		floatSurface(ui.Column(c).Absolute().Left(x).Top(y).Width(pw).Padding(4).Radius(10).Key("clip-pick"), k).Children(func() {
			text(c, tr("移入笔记分类"), 11, 16, 500, k.muted).Padding(4, 8)
			for _, s := range secs {
				name := sectionName(s)
				if s.ID == store.SectionInbox {
					name = tr("收件箱")
				}
				row := ui.Row(c).Height(28).Padding(0, 8).Radius(6).AlignItems(ui.Center).Key("cp-" + s.ID).Role(ui.RoleButton).Label(tr("移入 ") + name)
				col := hoverLink(row, k)
				row.Children(func() { text(c, name, 12, 17, 400, col).SingleLine() })
				if row.Clicked() {
					a.clipPick = ""
					a.moveClipsTo(a.clipMoveTargets(n), s.ID)
				}
			}
		})
	})
}
