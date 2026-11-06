package main

import (
	"slices"
	"strings"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// 任务行内编辑（同 Tauri TaskRow 展开态）：点标题展开，标题可改（↵ / Esc 收起并保存），下方备注与检查列表
// （圆圈勾选、行内改字、清空即删、悬停删除、「添加检查项…」回车连续添加）。状态点三态循环：待办 → 进行中 → 完成。

func taskStatusLabel(s string) string {
	switch s {
	case "doing":
		return tr("进行中")
	case "done":
		return tr("已完成")
	}
	return tr("待办")
}

func (a *app) setTaskStatus(t store.Task, status string) {
	switch {
	case status == "done" && t.Status != "done":
		if next, spawned := a.store.CompleteTask(t.ID, true, a.now()); spawned {
			a.showHUD("ok", tr("已生成下一期：")+dueBadge(next.DueAt, a.now()))
		}
	case t.Status == "done" && status != "done":
		a.store.CompleteTask(t.ID, false, a.now())
		if status == "doing" {
			if cur, ok := a.taskByID(t.ID); ok {
				cur.Status = "doing"
				_ = a.store.UpdateTask(cur)
			}
		}
	default:
		t.Status = status
		_ = a.store.UpdateTask(t)
	}
}

func (a *app) cycleTaskStatus(t store.Task) {
	next := map[string]string{"todo": "doing", "doing": "done", "done": "todo"}[t.Status]
	if next == "" {
		next = "doing"
	}
	a.setTaskStatus(t, next)
}

func (a *app) taskByID(id string) (store.Task, bool) {
	ts := a.store.Tasks()
	i := slices.IndexFunc(ts, func(t store.Task) bool { return t.ID == id })
	if i < 0 {
		return store.Task{}, false
	}
	return ts[i], true
}

// taskAsNote：任务按「标题 + 备注 + 检查列表」组成发送内容。
func taskAsNote(t store.Task) store.Note {
	parts := []string{t.Text}
	if strings.TrimSpace(t.Note) != "" {
		parts = append(parts, t.Note)
	}
	var ck []string
	for _, it := range t.Checklist {
		mark := "[ ]"
		if it.Done {
			mark = "[x]"
		}
		ck = append(ck, "- "+mark+" "+it.Text)
	}
	if len(ck) > 0 {
		parts = append(parts, strings.Join(ck, "\n"))
	}
	return store.Note{ID: "task:" + t.ID, Text: strings.Join(parts, "\n\n")}
}

func (a *app) openTaskEdit(t store.Task) {
	if a.taskOpen != "" && a.taskOpen != t.ID {
		a.commitTaskEdit()
	}
	a.taskOpen, a.taskTitle, a.taskNote, a.ckDraft = t.ID, t.Text, t.Note, ""
	a.taskCk = map[string]*string{}
	for _, it := range t.Checklist {
		txt := it.Text
		a.taskCk[it.ID] = &txt
	}
}

// commitTaskEdit 把展开态的标题 / 备注 / 检查项文字写回（标题清空则保留原标题，检查项清空即删除）。
func (a *app) commitTaskEdit() {
	t, ok := a.taskByID(a.taskOpen)
	if !ok {
		return
	}
	if v := strings.TrimSpace(a.taskTitle); v != "" {
		t.Text = v
	}
	t.Note = strings.TrimRight(a.taskNote, " \n")
	var ck []store.ChecklistItem
	for _, it := range t.Checklist {
		if p := a.taskCk[it.ID]; p != nil {
			it.Text = strings.TrimSpace(*p)
		}
		if it.Text != "" {
			ck = append(ck, it)
		}
	}
	t.Checklist = ck
	_ = a.store.UpdateTask(t)
}

func (a *app) updateChecklist(id string, fn func(ck []store.ChecklistItem) []store.ChecklistItem) {
	if t, ok := a.taskByID(id); ok {
		t.Checklist = fn(slices.Clone(t.Checklist))
		_ = a.store.UpdateTask(t)
	}
}

func (a *app) taskEditor(c *ui.Context, k tokens, t store.Task) {
	ui.Column(c).Margin(4, 0, 2, 32).Gap(6).Key("task-edit-" + t.ID).Children(func() {
		ui.TextAreaBase(c, &a.taskNote).Lines(1, 8).Font(fontSans).FontSize(12).TextColor(k.muted).Placeholder(tr("备注")).Label(tr("备注")).
			OnTextKey(func(key ui.TextKey) bool {
				if key.Key == ui.KeyEscape {
					a.commitTaskEdit()
					a.taskOpen = ""
					return true
				}
				return false
			})
		for _, it := range t.Checklist {
			it := it
			p := a.taskCk[it.ID]
			if p == nil {
				txt := it.Text
				p = &txt
				a.taskCk[it.ID] = p
			}
			row := ui.Row(c).Gap(6).AlignItems(ui.Center).Key("ck-" + it.ID)
			hovered := row.Hovered()
			row.Children(func() {
				icon, col, label := "circle", k.muted.Alpha(0.5), tr("勾选")
				if it.Done {
					icon, col, label = "circle-check", k.ok, tr("取消勾选")
				}
				b := ui.Box(c).Size(14, 14).Role(ui.RoleButton).Label(label).Children(func() { licon(c, icon, 14, col) })
				if b.Clicked() {
					a.updateChecklist(t.ID, func(ck []store.ChecklistItem) []store.ChecklistItem {
						for i := range ck {
							if ck[i].ID == it.ID {
								ck[i].Done = !ck[i].Done
							}
						}
						return ck
					})
				}
				in := ui.TextInputBase(c, p).Grow(1).Basis(0).Font(fontSans).FontSize(12).TextColor(k.fg).Label(it.Text).
					OnTextKey(func(key ui.TextKey) bool {
						if key.Key == ui.KeyEnter {
							a.commitTaskEdit()
							return true
						}
						return false
					})
				if it.Done {
					in.TextColor(k.muted).Opacity(0.6)
				}
				del := ui.Box(c).Size(16, 16).Radius(6).Center().Role(ui.RoleButton).Label(tr("删除检查项"))
				if !hovered {
					del.Opacity(0)
				}
				del.Children(func() { licon(c, "x", 10, k.danger) })
				if del.Clicked() {
					delete(a.taskCk, it.ID)
					a.updateChecklist(t.ID, func(ck []store.ChecklistItem) []store.ChecklistItem {
						return slices.DeleteFunc(ck, func(x store.ChecklistItem) bool { return x.ID == it.ID })
					})
				}
			})
		}
		ui.Row(c).Gap(6).AlignItems(ui.Center).Key("ck-add-" + t.ID).Children(func() { // 定 key：上方插入检查项后输入框保持焦点，可连续添加
			licon(c, "plus", 14, k.muted.Alpha(0.6))
			ui.TextInputBase(c, &a.ckDraft).Grow(1).Basis(0).Font(fontSans).FontSize(12).TextColor(k.fg).Placeholder(tr("添加检查项…")).Label(tr("添加检查项…")).
				OnTextKey(func(key ui.TextKey) bool {
					if key.Key == ui.KeyEnter {
						if v := strings.TrimSpace(key.Text()); v != "" {
							it := store.NewChecklistItem(v)
							a.updateChecklist(t.ID, func(ck []store.ChecklistItem) []store.ChecklistItem { return append(ck, it) })
							txt := it.Text
							a.taskCk[it.ID] = &txt
						}
						a.ckDraft = ""
						return true
					}
					return false
				})
		})
		a.taskSchedule(c, k, t)
	})
}

// taskSchedule：展开态常显到期入口（同 Tauri DueControl alwaysVisible）；重复与结束条件都在到期弹层里。
func (a *app) taskSchedule(c *ui.Context, k tokens, t store.Task) {
	now := a.now()
	ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
		text(c, tr("到期"), 11, 16, 400, k.muted).Width(36)
		a.dueTrigger(c, k, t, now, true)
		if t.Recurrence != "" {
			licon(c, "repeat", 12, k.repeatIcon)
			text(c, tr(recurLabels[max(0, slices.Index(recurNames, t.Recurrence))]), 11, 16, 400, k.muted)
		}
	})
}
