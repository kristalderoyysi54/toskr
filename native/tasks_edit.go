package main

import (
	"slices"
	"strconv"
	"strings"
	"time"

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
	a.taskOpen, a.taskTitle, a.taskNote, a.ckDraft, a.taskDue, a.taskEnd = t.ID, t.Text, t.Note, "", "", ""
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

// parseDue：自然语言（「明天下午3点」「下周一 9:00」）或 2006-01-02 15:04 / 01-02 15:04。
func parseDue(input string, now time.Time) (time.Time, bool) {
	input = strings.TrimSpace(input)
	if input == "" {
		return time.Time{}, false
	}
	if d := store.ParseQuickTask(input+" x", now).DueAt; !d.IsZero() {
		return d, true
	}
	for _, layout := range []string{"2006-01-02 15:04", "2006-01-02", "01-02 15:04", "1/2 15:04"} {
		if d, err := time.ParseInLocation(layout, input, now.Location()); err == nil {
			if d.Year() == 0 {
				d = d.AddDate(now.Year(), 0, 0)
			}
			if layout == "2006-01-02" {
				d = d.Add(9 * time.Hour)
			}
			return d, true
		}
	}
	return time.Time{}, false
}

// taskSchedule：展开态的「到期」自定义输入与重复的起算 / 结束（同 Tauri TaskRow 到期与重复面板）。
func (a *app) taskSchedule(c *ui.Context, k tokens, t store.Task) {
	now := a.now()
	field := func(label string, body func()) {
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			text(c, label, 11, 16, 400, k.muted).Width(36)
			body()
		})
	}
	field(tr("到期"), func() {
		cur := tr("未设置")
		if !t.DueAt.IsZero() {
			cur = dueBadge(t.DueAt, now)
		}
		text(c, cur, 11, 16, 500, k.fg)
		ui.TextInputBase(c, &a.taskDue).Grow(1).Basis(0).Font(fontSans).FontSize(11).TextColor(k.fg).
			Placeholder(tr("如：明天下午3点、2026-11-20 15:00，回车设定")).Label(tr("修改到期时间")).
			OnTextKey(func(key ui.TextKey) bool {
				if key.Key != ui.KeyEnter {
					return false
				}
				if d, ok := parseDue(key.Text(), now); ok {
					if cur, ok := a.taskByID(t.ID); ok {
						cur.DueAt, cur.RemindedAt = d, time.Time{}
						_ = a.store.UpdateTask(cur)
					}
					a.taskDue = ""
				} else {
					a.showHUD("warn", tr("没看懂这个时间"))
				}
				return true
			})
		if !t.DueAt.IsZero() && footLink(c, k, tr("清除到期"), "due-clear-"+t.ID) {
			t.DueAt = time.Time{}
			_ = a.store.UpdateTask(t)
		}
	})
	if t.Recurrence == "" {
		return
	}
	field(tr("重复"), func() {
		text(c, tr(recurLabels[max(0, slices.Index(recurNames, t.Recurrence))]), 11, 16, 500, k.fg)
		basis := tr("按计划日期")
		if t.RecurBasis == "completion" {
			basis = tr("从完成时算起")
		}
		ui.PopoverMenuButton(c, basis, func(m *ui.Menu) {
			for _, o := range []opt{{"", "按计划日期"}, {"completion", "从完成时算起"}} {
				if m.Item(tr(o.label)).Checked(t.RecurBasis == o.v).Chosen() {
					t.RecurBasis = o.v
					_ = a.store.UpdateTask(t)
				}
			}
		})
	})
	field(tr("结束"), func() {
		end := tr("永不")
		switch {
		case !t.RecurUntil.IsZero():
			end = tr("到某天")
		case t.RecurCount > 0:
			end = tr("共几次")
		}
		ui.PopoverMenuButton(c, end, func(m *ui.Menu) {
			if m.Item(tr("永不")).Checked(t.RecurUntil.IsZero() && t.RecurCount == 0).Chosen() {
				t.RecurUntil, t.RecurCount = time.Time{}, 0
				_ = a.store.UpdateTask(t)
			}
			if m.Item(tr("到某天")).Checked(!t.RecurUntil.IsZero()).Chosen() {
				t.RecurUntil, t.RecurCount = t.DueAt.AddDate(0, 1, 0), 0
				_ = a.store.UpdateTask(t)
				a.taskEnd = t.RecurUntil.Format("2006-01-02")
			}
			if m.Item(tr("共几次")).Checked(t.RecurCount > 0).Chosen() {
				t.RecurUntil, t.RecurCount = time.Time{}, 5
				_ = a.store.UpdateTask(t)
				a.taskEnd = "5"
			}
		})
		switch {
		case !t.RecurUntil.IsZero():
			if a.taskEnd == "" {
				a.taskEnd = t.RecurUntil.Format("2006-01-02")
			}
			ui.TextInputBase(c, &a.taskEnd).Width(96).Font(fontSans).FontSize(11).TextColor(k.fg).Label(tr("重复结束日期")).
				OnTextKey(func(key ui.TextKey) bool {
					if key.Key != ui.KeyEnter {
						return false
					}
					if d, err := time.ParseInLocation("2006-01-02", strings.TrimSpace(key.Text()), now.Location()); err == nil {
						t.RecurUntil = d
						_ = a.store.UpdateTask(t)
					} else {
						a.showHUD("warn", tr("日期格式：2026-12-31"))
					}
					return true
				})
		case t.RecurCount > 0:
			text(c, tr("还剩"), 11, 16, 400, k.muted)
			if a.taskEnd == "" {
				a.taskEnd = itoa(t.RecurCount)
			}
			ui.TextInputBase(c, &a.taskEnd).Width(36).Font(fontSans).FontSize(11).TextColor(k.fg).Label(tr("剩余重复次数（含本期）")).
				OnTextKey(func(key ui.TextKey) bool {
					if key.Key != ui.KeyEnter {
						return false
					}
					if n, err := strconv.Atoi(strings.TrimSpace(key.Text())); err == nil && n > 0 && n < 1000 {
						t.RecurCount = n
						_ = a.store.UpdateTask(t)
					}
					return true
				})
			text(c, tr("次（含本期）"), 11, 16, 400, k.muted)
		}
	})
}
