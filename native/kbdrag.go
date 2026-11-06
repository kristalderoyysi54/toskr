package main

import (
	"slices"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// 键盘拖拽排序（同 Tauri NoteCard 拖拽把手 + dnd-kit KeyboardSensor，QA#9）：Tab 聚焦卡片左缘把手，
// Space 拾起，↑↓ 移动（到组首 / 组尾再按会跨进相邻分组），Space / ↩ 放下，Esc 取消并回到原位。

type kbDrag struct {
	id, sec string // 拾起的卡与原分组
	pos     int    // 原分组内位置（不含自己）
}

// cardGrip：卡片左缘的键盘拖拽把手，平时隐形，聚焦或拾起时显现。
func (a *app) cardGrip(c *ui.Context, k tokens, n store.Note, top float32) {
	if n.Done || a.page != pageNotes || a.query != "" {
		return
	}
	label := tr("拖拽调整位置和分组（Space 拾起，方向键移动）")
	g := ui.Box(c).Absolute().Left(4).Top(top).Size(20, 22).Radius(6).Center().Focusable().Role(ui.RoleButton).Label(label).Key("grip-" + n.ID)
	lifted := a.kbd.id == n.ID
	if g.Focused() || lifted {
		a.gripFocus = n.ID
		g.Background(k.floatBtn).Border(1, k.fg.Alpha(0.1)).Tooltip(label)
		g.Children(func() { licon(c, "grip-vertical", 14, k.muted) })
		if lifted {
			g.Border(2, stok(c).primary)
		}
	} else {
		g.Opacity(0).PassThrough()
		if a.gripFocus == n.ID {
			a.gripFocus = ""
		}
	}
}

// kbDragKeys 在 panelKeys 最前面处理：拾起后独占 ↑↓ Space ↩ Esc。返回 true 表示本帧按键已消费。
func (a *app) kbDragKeys(c *ui.Context) bool {
	if a.kbd.id == "" {
		if a.gripFocus != "" && c.Shortcut(0, ui.KeySpace) {
			a.kbPickUp(a.gripFocus)
			return true
		}
		return false
	}
	switch {
	case c.Shortcut(0, ui.KeyUp):
		a.kbMove(-1)
	case c.Shortcut(0, ui.KeyDown):
		a.kbMove(1)
	case c.Shortcut(0, ui.KeySpace), c.Shortcut(0, ui.KeyEnter):
		a.kbd = kbDrag{}
		a.showHUD("ok", tr("已放下"))
	case c.Shortcut(0, ui.KeyEscape):
		_ = a.store.MoveToAt(a.kbd.id, a.kbd.sec, a.kbd.pos)
		a.kbd = kbDrag{}
		a.reload()
		a.showHUD("info", tr("已取消移动"))
	default:
		return false
	}
	return true
}

func (a *app) kbPickUp(id string) {
	n, ok := a.store.Note(id)
	if !ok {
		return
	}
	a.kbd = kbDrag{id: id, sec: n.Section, pos: posWithout(a.store.Section(n.Section), id, id)}
	a.showHUD("info", tr("已拾起：↑↓ 移动，Space 放下，Esc 取消"))
}

// posWithout：在去掉 id 的分组列表里，before 所在的位置（before 不在时为末尾）。
func posWithout(list []store.Note, id, before string) int {
	i := 0
	for _, n := range list {
		if n.ID == id {
			continue
		}
		if n.ID == before {
			return i
		}
		i++
	}
	return i
}

// kbMove 把拾起的卡上移 / 下移一位；到组边界时跨进相邻分组（上移进上一组末尾，下移进下一组开头）。
func (a *app) kbMove(dir int) {
	id := a.kbd.id
	gs := a.groups()
	gi, p := -1, -1
	for i, g := range gs {
		if j := slices.IndexFunc(g.open, func(n store.Note) bool { return n.ID == id }); j >= 0 {
			gi, p = i, j
		}
	}
	if gi < 0 {
		return
	}
	g := gs[gi]
	list := a.store.Section(g.sec.ID)
	switch {
	case dir < 0 && p > 0:
		_ = a.store.MoveToAt(id, g.sec.ID, posWithout(list, id, g.open[p-1].ID))
	case dir > 0 && p < len(g.open)-1:
		next := ""
		if p+2 < len(g.open) {
			next = g.open[p+2].ID
		} else if len(g.done) > 0 {
			next = g.done[0].ID
		}
		_ = a.store.MoveToAt(id, g.sec.ID, posWithout(list, id, next))
	case dir < 0 && gi > 0:
		prev := gs[gi-1]
		next := ""
		if len(prev.done) > 0 {
			next = prev.done[0].ID
		}
		_ = a.store.MoveToAt(id, prev.sec.ID, posWithout(a.store.Section(prev.sec.ID), id, next))
		a.expandSection(prev.sec)
	case dir > 0 && gi < len(gs)-1:
		nx := gs[gi+1]
		_ = a.store.MoveToAt(id, nx.sec.ID, 0)
		a.expandSection(nx.sec)
	default:
		return
	}
	a.reload()
}

func (a *app) expandSection(s store.Section) {
	if s.Collapsed {
		s.Collapsed = false
		_ = a.store.UpdateSection(s)
	}
}
