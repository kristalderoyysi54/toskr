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
	task    bool   // 任务行（原位用 next：原来排在它后面的任务）
	next    string
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
		a.kbMoveAny(-1)
	case c.Shortcut(0, ui.KeyDown):
		a.kbMoveAny(1)
	case c.Shortcut(0, ui.KeySpace), c.Shortcut(0, ui.KeyEnter):
		a.kbd = kbDrag{}
		a.showHUD("ok", tr("已放下"))
	case c.Shortcut(0, ui.KeyEscape):
		if a.kbd.task {
			_ = a.store.MoveTask(a.kbd.id, a.kbd.sec, a.kbd.next)
		} else {
			_ = a.store.MoveToAt(a.kbd.id, a.kbd.sec, a.kbd.pos)
		}
		a.kbd = kbDrag{}
		a.reload()
		a.showHUD("info", tr("已取消移动"))
	default:
		return false
	}
	return true
}

func (a *app) kbPickUp(id string) {
	if a.page == pageTasks {
		a.kbPickUpTask(id)
		return
	}
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

func (a *app) kbMoveAny(dir int) {
	if a.kbd.task {
		a.kbMoveTask(dir)
		return
	}
	a.kbMove(dir)
}

// taskGrip：任务行左缘的键盘拖拽把手（分组视图里未完成、未到期的普通任务）。
func (a *app) taskGrip(c *ui.Context, k tokens, t store.Task) {
	if a.page != pageTasks || a.taskSub != 1 || t.Status == "done" || t.Spark || (!t.DueAt.IsZero() && !t.DueAt.After(a.now())) {
		return
	}
	label := tr("拖拽调整位置和分组（Space 拾起，方向键移动）")
	g := ui.Box(c).Absolute().Left(2).Top(8).Size(18, 22).Radius(6).Center().Focusable().Role(ui.RoleButton).Label(label).Key("tgrip-" + t.ID)
	lifted := a.kbd.id == t.ID
	if g.Focused() || lifted {
		a.gripFocus = t.ID
		g.Background(k.floatBtn).Border(1, k.fg.Alpha(0.1)).Tooltip(label)
		g.Children(func() { licon(c, "grip-vertical", 13, k.muted) })
		if lifted {
			g.Border(2, stok(c).primary)
		}
	} else {
		g.Opacity(0).PassThrough()
		if a.gripFocus == t.ID {
			a.gripFocus = ""
		}
	}
}

func (a *app) kbPickUpTask(id string) {
	all := a.store.Tasks()
	i := slices.IndexFunc(all, func(t store.Task) bool { return t.ID == id })
	if i < 0 {
		return
	}
	next := ""
	for _, t := range all[i+1:] {
		if t.Section == all[i].Section {
			next = t.ID
			break
		}
	}
	a.kbd = kbDrag{id: id, sec: all[i].Section, task: true, next: next}
	a.showHUD("info", tr("已拾起：↑↓ 移动，Space 放下，Esc 取消"))
}

// kbMoveTask：分组视图里上移 / 下移一位，到组边界跨进相邻分组。
func (a *app) kbMoveTask(dir int) {
	id := a.kbd.id
	gs := bucketTasks(a.store.Tasks(), a.store.TaskSections(), a.now()).groups
	gi, p := -1, -1
	for i, g := range gs {
		if j := slices.IndexFunc(g.tasks, func(t store.Task) bool { return t.ID == id }); j >= 0 {
			gi, p = i, j
		}
	}
	if gi < 0 {
		return
	}
	g := gs[gi]
	expand := func(s store.Section) {
		if s.Collapsed {
			s.Collapsed = false
			_ = a.store.UpdateTaskSection(s)
		}
	}
	switch {
	case dir < 0 && p > 0:
		_ = a.store.MoveTask(id, g.sec.ID, g.tasks[p-1].ID)
	case dir > 0 && p < len(g.tasks)-1:
		before := ""
		if p+2 < len(g.tasks) {
			before = g.tasks[p+2].ID
		}
		_ = a.store.MoveTask(id, g.sec.ID, before)
	case dir < 0 && gi > 0:
		_ = a.store.MoveTask(id, gs[gi-1].sec.ID, "")
		expand(gs[gi-1].sec)
	case dir > 0 && gi < len(gs)-1:
		nx := gs[gi+1]
		before := ""
		if len(nx.tasks) > 0 {
			before = nx.tasks[0].ID
		}
		_ = a.store.MoveTask(id, nx.sec.ID, before)
		expand(nx.sec)
	default:
		return
	}
	a.reload()
}
