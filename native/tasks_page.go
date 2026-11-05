package main

import (
	"fmt"
	"slices"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

var (
	priorityNames  = []string{"none", "low", "mid", "high"}
	priorityLabels = []string{"无", "低", "中", "高"}
	recurNames     = []string{"", "daily", "weekdays", "weekly", "monthly", "yearly"}
	recurLabels    = []string{"不重复", "每天", "工作日", "每周", "每月", "每年"}
)

// visibleTasks：未完成在前（有到期的按到期时间，其余保持插入顺序），已完成按完成时间倒序。
func visibleTasks(all []store.Task, showDone bool) []store.Task {
	var open, done []store.Task
	for _, t := range all {
		if t.Status == "done" {
			done = append(done, t)
		} else {
			open = append(open, t)
		}
	}
	slices.SortStableFunc(open, func(x, y store.Task) int {
		switch {
		case x.DueAt.IsZero() && y.DueAt.IsZero():
			return 0
		case x.DueAt.IsZero():
			return 1
		case y.DueAt.IsZero():
			return -1
		}
		return x.DueAt.Compare(y.DueAt)
	})
	if !showDone {
		return open
	}
	slices.SortStableFunc(done, func(x, y store.Task) int { return y.CompletedAt.Compare(x.CompletedAt) })
	return append(open, done...)
}

func (a *app) addTaskDraft() {
	if a.taskDraft == "" {
		return
	}
	t := store.ParseQuickTask(a.taskDraft, time.Now())
	if t.Text == "" {
		return
	}
	a.store.AddTask(t)
	a.taskDraft = ""
}

func (a *app) tasksPage(c *ui.Context) {
	t := c.Theme()
	shown := visibleTasks(a.tasks, a.showDoneT)
	openCount := 0
	for _, x := range a.tasks {
		if x.Status != "done" {
			openCount++
		}
	}
	box := a.surface(c, ui.Column(c).Padding(8, 10).Radius(12), 0)
	box.Children(func() {
		ui.TextInput(c, &a.taskDraft).Bind(&a.taskIn).Placeholder(tr("明天下午3点 交周报 !!  ↵ 添加")).OnTextKey(func(k ui.TextKey) bool {
			if k.Key == ui.KeyEnter && k.Mods == 0 {
				a.taskDraft = k.Text()
				a.addTaskDraft()
				k.SetText(a.taskDraft)
				return true
			}
			return false
		})
	})
	ui.Row(c).Padding(0, 4).Gap(8).AlignItems(ui.Center).Children(func() {
		ui.Text(c, fmt.Sprintf(tr("待办 %d"), openCount)).FontSize(12).TextColor(t.TextMuted).Grow(1)
		ui.Text(c, tr("显示已完成")).FontSize(12).TextColor(t.TextMuted)
		ui.Switch(c, &a.showDoneT)
	})
	a.taskList.Selected = &a.taskSel
	a.taskList.Key = func(i int) any { return shown[i].ID }
	a.taskList.Label = func(i int) string { return shown[i].Text }
	ui.List(c, &a.taskList, len(shown), func(i int) { a.taskRow(c, shown[i]) }).Grow(1).Children(func() {
		if len(shown) == 0 {
			ui.Text(c, tr("没有待办\n支持「今天/明天/后天」「上午/下午 N点」与 ! / !! / !!! 优先级")).TextColor(t.TextMuted).Padding(24).Center()
		}
	})
}

func (a *app) taskRow(c *ui.Context, task store.Task) {
	t := c.Theme()
	done := task.Status == "done"
	row := a.surface(c, ui.Row(c).Padding(8, 10).Gap(10).Radius(10).AlignItems(ui.Center).Key(task.ID), 0.5)
	row.ContextMenu(func(m *ui.Menu) {
		m.Submenu(tr("优先级"), func(sm *ui.Menu) {
			for i, p := range priorityNames {
				if sm.Item(tr(priorityLabels[i])).Radio(task.Priority == p).Chosen() {
					task.Priority = p
					_ = a.store.UpdateTask(task)
				}
			}
		})
		m.Submenu(tr("重复"), func(sm *ui.Menu) {
			for i, r := range recurNames {
				if sm.Item(tr(recurLabels[i])).Radio(task.Recurrence == r).Chosen() {
					task.Recurrence = r
					_ = a.store.UpdateTask(task)
				}
			}
		})
		m.Submenu(tr("到期"), func(sm *ui.Menu) {
			now := time.Now()
			base := time.Date(now.Year(), now.Month(), now.Day(), 9, 0, 0, 0, now.Location())
			for _, o := range []struct {
				label string
				at    time.Time
			}{{"一小时后", now.Add(time.Hour).Truncate(time.Minute)}, {"今晚 20:00", base.Add(11 * time.Hour)}, {"明天 9:00", base.AddDate(0, 0, 1)}, {"下周一 9:00", nextMonday(base)}, {"清除", time.Time{}}} {
				if sm.Item(tr(o.label)).Chosen() {
					task.DueAt = o.at
					_ = a.store.UpdateTask(task)
				}
			}
		})
		if m.Item(tr("闪念（Spark）")).Checked(task.Spark).Chosen() {
			task.Spark = !task.Spark
			_ = a.store.UpdateTask(task)
		}
		if m.Item(tr("转为笔记发送")).Chosen() {
			_, _, _ = a.store.Add(store.Note{Section: store.SectionInbox, Text: task.Text})
			a.switchPage(pageQueue)
		}
		m.Separator()
		if m.Item(tr("删除")).Chosen() {
			if removed, pos, ok := a.store.DeleteTask(task.ID); ok {
				c.ToastAction(tr("已删除任务"), tr("撤销"), func() { _ = a.store.RestoreTask(removed, pos) })
			}
		}
	})
	row.Children(func() {
		icon, color := iconCircle, t.TextMuted
		if done {
			icon, color = iconDone, t.Success
		}
		if ui.Icon(c, icon).FontSize(16).TextColor(color).Clicked() {
			if next, spawned := a.store.CompleteTask(task.ID, !done, time.Now()); spawned {
				c.Toast(tr("已生成下一期：") + dueLabel(next.DueAt, time.Now()))
			}
		}
		ui.Column(c).Gap(2).Grow(1).Children(func() {
			title := ui.Text(c, task.Text).Wrap().MaxLines(3)
			if done {
				title.TextColor(t.TextMuted).Strikethrough()
			}
			var meta []string
			if !task.DueAt.IsZero() {
				meta = append(meta, dueLabel(task.DueAt, time.Now()))
			}
			if task.Recurrence != "" {
				meta = append(meta, tr(recurLabels[slices.Index(recurNames, task.Recurrence)]))
			}
			if len(task.Checklist) > 0 {
				n := 0
				for _, it := range task.Checklist {
					if it.Done {
						n++
					}
				}
				meta = append(meta, fmt.Sprintf("☑ %d/%d", n, len(task.Checklist)))
			}
			if len(meta) > 0 {
				mt := ui.Text(c, joinMeta(meta)).FontSize(10).TextColor(t.TextMuted)
				if !done && !task.DueAt.IsZero() && task.DueAt.Before(time.Now()) {
					mt.TextColor(t.Danger)
				}
			}
		})
		if task.Spark {
			ui.Text(c, "✦").TextColor(t.Warning).Tooltip(tr("闪念"))
		}
		switch task.Priority {
		case "high":
			ui.Text(c, "!!!").Bold().TextColor(t.Danger)
		case "mid":
			ui.Text(c, "!!").Bold().TextColor(t.Warning)
		case "low":
			ui.Text(c, "!").Bold().TextColor(t.Accent)
		}
	})
}

func nextMonday(base time.Time) time.Time {
	d := (8 - int(base.Weekday())) % 7
	if d == 0 {
		d = 7
	}
	return base.AddDate(0, 0, d)
}

func joinMeta(parts []string) string {
	out := ""
	for i, p := range parts {
		if i > 0 {
			out += " · "
		}
		out += p
	}
	return out
}

// dueLabel：今天 15:00 / 明天 9:00 / 11月8日 9:00 / 已过期 2 天。
func dueLabel(due, now time.Time) string {
	day := func(t time.Time) time.Time { return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, t.Location()) }
	diff := int(day(due).Sub(day(now)).Hours() / 24)
	hm := due.Format("15:04")
	switch {
	case diff < 0:
		return fmt.Sprintf(tr("已过期 %d 天"), -diff)
	case diff == 0:
		return tr("今天 ") + hm
	case diff == 1:
		return tr("明天 ") + hm
	}
	return fmt.Sprintf("%d/%d %s", due.Month(), due.Day(), hm)
}
