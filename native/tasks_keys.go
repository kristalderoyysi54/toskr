package main

import (
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// 任务页键盘（同 Tauri App.tsx onKeyDown 的 tasks 分支）：↑↓ 在可见任务间移动焦点；Space / x 切完成（二态，
// 与点状态圈的三态循环是刻意差异）；Enter 展开编辑；⌘⌫ 删除（可撤销）并把焦点挪到相邻任务。

// taskNavIDs：与列表同序的可见任务（折叠的分组 / 智能区不算）。
func (a *app) taskNavIDs(now time.Time) []string {
	b := bucketTasks(a.tasks, a.store.TaskSections(), now)
	var ids []string
	add := func(ts []store.Task) {
		for _, t := range ts {
			ids = append(ids, t.ID)
		}
	}
	if a.bandOpen["overdue"] {
		add(b.overdue)
	}
	if a.bandOpen["spark"] {
		add(b.sparks)
	}
	for _, g := range b.groups {
		if !g.sec.Collapsed {
			add(g.tasks)
		}
	}
	if a.bandOpen["done"] {
		add(b.done)
	}
	return ids
}

func (a *app) taskKeys(c *ui.Context) {
	if a.taskSub != 1 || a.taskOpen != "" || a.taskSecRename != "" || a.taskAIDraft != nil || a.taskQuickFocused {
		return
	}
	ids := a.taskNavIDs(a.now())
	idx := -1
	for i, id := range ids {
		if id == a.taskFocus {
			idx = i
		}
	}
	if len(ids) == 0 {
		return
	}
	if c.Shortcut(0, ui.KeyDown) {
		a.taskFocus = ids[min(idx+1, len(ids)-1)]
	}
	if c.Shortcut(0, ui.KeyUp) {
		a.taskFocus = ids[max(idx-1, 0)]
	}
	t, ok := a.taskByID(a.taskFocus) // 刚完成的任务可能已收进折叠的「已完成」，焦点仍在它上（同 Tauri focusedId）
	if !ok {
		return
	}
	if c.Shortcut(0, ui.KeySpace) || c.Shortcut(0, ui.KeyX) {
		if t.Status == "done" {
			a.setTaskStatus(t, "todo")
		} else {
			a.setTaskStatus(t, "done")
		}
	}
	if c.Shortcut(0, ui.KeyEnter) {
		a.openTaskEdit(t)
	}
	if c.Shortcut(ui.Cmd, ui.KeyBackspace) {
		next := ""
		if idx+1 < len(ids) {
			next = ids[idx+1]
		} else if idx > 0 {
			next = ids[idx-1]
		}
		if removed, pos, ok := a.store.DeleteTask(t.ID); ok {
			a.showHUDUndo("ok", tr("已删除 1 个任务"), func() { _ = a.store.RestoreTask(removed, pos) })
		}
		a.taskFocus = next
	}
}
