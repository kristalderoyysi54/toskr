package store

import (
	"fmt"
	"slices"
	"strings"
	"time"
)

// 任务 → 苹果「提醒事项」同步的纯逻辑（同 Tauri apple_reminders.rs plan + appleReminders.ts desiredReminders +
// notesStore markAppleReminderSync / importAppleReminders / applyAppleReminderTheirs）。
// 关联键是提醒的 URL toskr://task/<任务 id>，不另存映射表。优先级、完成、响铃以 Toskr 为准；
// 标题、备注、到期按「上次同步的值」三方比较：只有对端改了就回流，两边都改以 Toskr 为准并报冲突。
// 其余回传只有「对端勾了完成」与「在列表里新建（导入为任务）」。不推重复规则（苹果完成重复提醒会顺延）。

const ReminderURLPrefix = "toskr://task/"

// DueParts 是本地日历时刻；只有日期的提醒 H / Mi 为 -1。
type DueParts struct{ Y, M, D, H, Mi int }

func DuePartsOf(t time.Time) *DueParts {
	if t.IsZero() {
		return nil
	}
	return &DueParts{t.Year(), int(t.Month()), t.Day(), t.Hour(), t.Minute()}
}

// Time：只有日期的按 9:00（同 Tauri dueAtFromAppleParts）。
func (d *DueParts) Time() time.Time {
	if d == nil {
		return time.Time{}
	}
	h, mi := d.H, d.Mi
	if h < 0 {
		h = 9
	}
	if mi < 0 {
		mi = 0
	}
	return time.Date(d.Y, time.Month(d.M), d.D, h, mi, 0, 0, time.Local)
}

// DueKey 同 Rust due_key：`y-m-d h:mi`，无到期为 ""。
func DueKey(d *DueParts) string {
	if d == nil {
		return ""
	}
	return fmt.Sprintf("%d-%d-%d %d:%d", d.Y, d.M, d.D, d.H, d.Mi)
}

func DueFromKey(k string) *DueParts {
	var d DueParts
	if _, err := fmt.Sscanf(k, "%d-%d-%d %d:%d", &d.Y, &d.M, &d.D, &d.H, &d.Mi); err != nil {
		return nil
	}
	return &d
}

func sameDue(a, b *DueParts) bool { return DueKey(a) == DueKey(b) }

// DesiredReminder 是一条待同步任务。
type DesiredReminder struct {
	TaskID, Title, Notes string
	Due                  *DueParts
	Priority             int // EKReminder：0 无 / 1 高 / 5 中 / 9 低
	Completed            bool
	Synced               bool    // 曾成功同步过：远端缺失即「对端删除」
	Reopened             bool    // 对端已完成、Toskr 又改回未完成：推「未完成」
	Alarms               []int64 // 相对到期的秒数（负 = 提前），升序
	AdoptItemID          string  // 由对端导入、尚未补写 URL 的提醒 id
	BaseTitle, BaseNotes *string // 三方比较基准；nil = 还没有基准
	BaseDue              *string
}

// RemoteReminder 是列表里的一条提醒。
type RemoteReminder struct {
	ItemID, TaskID, Title, Notes string // TaskID 从 URL 解出，空 = 用户在列表里新建
	Due                          *DueParts
	Priority                     int
	Completed                    bool
	Alarms                       []int64 // 绝对时刻的响铃记为 math.MinInt64
}

type ReminderConflict struct {
	TaskID, Field, Theirs string // Field: title | notes | due（due 的 Theirs 是 DueKey）
}

type ImportedReminder struct {
	ItemID, Title, Notes string
	Due                  *DueParts
	Priority             int
}

type ReminderPlan struct {
	Create          []string
	Update          [][2]string // 远端 item id, 任务 id
	Delete          []string
	CompletedRemote []string
	Missing         []string
	DeletedTasks    []string
	Adopt           [][2]string
	Import          []ImportedReminder
	TitleRemote     map[string]string
	NotesRemote     map[string]string
	DueRemote       map[string]*DueParts // nil 值 = 对端清掉了到期
	Conflicts       []ReminderConflict
}

var priorityEK = map[string]int{"high": 1, "mid": 5, "low": 9, "none": 0}

// DesiredReminders：闪念不同步；对端删过的不再同步；已完成的只同步「之前推过的」。recreate 里的是本会话
// 删了对端提醒的任务——撤销删除后要重建，而不是被判成「对端删除」。
func DesiredReminders(tasks []Task, recreate map[string]bool, alarm bool) []DesiredReminder {
	var out []DesiredReminder
	for _, t := range tasks {
		if t.Spark || t.AppleSyncOff {
			continue
		}
		synced := t.AppleSyncedID == t.ID && !recreate[t.ID]
		done := t.Status == "done"
		if done && !synced {
			continue
		}
		d := DesiredReminder{TaskID: t.ID, Title: cmpOr(strings.TrimSpace(t.Text), "未命名任务"), Notes: strings.TrimSpace(t.Note),
			Due: DuePartsOf(t.DueAt), Priority: priorityEK[t.Priority], Completed: done, Synced: synced,
			Reopened: synced && !done && t.AppleDone, AdoptItemID: t.AppleImportItemID}
		if alarm && !t.DueAt.IsZero() {
			for _, m := range t.Offsets() {
				if v := int64(-m * 60); !slices.Contains(d.Alarms, v) {
					d.Alarms = append(d.Alarms, v)
				}
			}
			slices.Sort(d.Alarms)
		}
		if synced {
			d.BaseTitle, d.BaseNotes, d.BaseDue = t.AppleTitle, t.AppleNotes, t.AppleDue
		}
		out = append(out, d)
	}
	return out
}

func cmpOr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// merge3：只有对端改了 → (对端, true, false)；两边各改 → 冲突；其余无事。
func merge3(base, ours, theirs string) (next string, changed, conflict bool) {
	switch {
	case theirs == base || theirs == ours:
		return "", false, false
	case ours == base:
		return theirs, true, false
	}
	return theirs, false, true
}

func differs(w DesiredReminder, h RemoteReminder) bool {
	return w.Title != h.Title || w.Notes != strings.TrimSpace(h.Notes) || !sameDue(w.Due, h.Due) ||
		w.Priority != h.Priority || w.Completed != h.Completed || !slices.Equal(w.Alarms, h.Alarms)
}

// PlanReminders 对账（同 Rust plan）：带 URL 的按任务 id 对齐；没有 URL 的是用户在列表里新建的——
// 已导入（任务带 AdoptItemID）的认领，其余未完成的导入为任务。一条都没下发时不删任何对端提醒。
func PlanReminders(desired []DesiredReminder, remote []RemoteReminder) ReminderPlan {
	out := ReminderPlan{TitleRemote: map[string]string{}, NotesRemote: map[string]string{}, DueRemote: map[string]*DueParts{}}
	byTask := map[string]RemoteReminder{}
	var order []string
	untagged := map[string]RemoteReminder{}
	for _, it := range remote {
		if it.TaskID == "" {
			untagged[it.ItemID] = it
			continue
		}
		if _, dup := byTask[it.TaskID]; dup {
			if len(desired) > 0 {
				out.Delete = append(out.Delete, it.ItemID)
			}
			continue
		}
		byTask[it.TaskID] = it
		order = append(order, it.TaskID)
	}
	wanted := map[string]bool{}
	for _, w := range desired {
		wanted[w.TaskID] = true
		have, ok := byTask[w.TaskID]
		eff := w
		if ok && w.BaseTitle != nil {
			theirs := strings.TrimSpace(have.Title)
			if theirs != "" {
				if v, ch, cf := merge3(*w.BaseTitle, w.Title, theirs); ch {
					out.TitleRemote[w.TaskID], eff.Title = v, v
				} else if cf {
					out.Conflicts = append(out.Conflicts, ReminderConflict{w.TaskID, "title", v})
				}
			}
		}
		if ok && w.BaseNotes != nil {
			if v, ch, cf := merge3(strings.TrimSpace(*w.BaseNotes), w.Notes, strings.TrimSpace(have.Notes)); ch {
				out.NotesRemote[w.TaskID], eff.Notes = v, v
			} else if cf {
				out.Conflicts = append(out.Conflicts, ReminderConflict{w.TaskID, "notes", v})
			}
		}
		if ok && w.BaseDue != nil {
			if v, ch, cf := merge3(*w.BaseDue, DueKey(w.Due), DueKey(have.Due)); ch {
				out.DueRemote[w.TaskID], eff.Due = have.Due, have.Due
			} else if cf {
				out.Conflicts = append(out.Conflicts, ReminderConflict{w.TaskID, "due", v})
			}
		}
		switch {
		case ok && have.Completed && !w.Completed && !w.Reopened:
			out.CompletedRemote = append(out.CompletedRemote, w.TaskID)
		case ok:
			if differs(eff, have) {
				out.Update = append(out.Update, [2]string{have.ItemID, w.TaskID})
			}
		case w.AdoptItemID != "" && untagged[w.AdoptItemID].ItemID != "":
			delete(untagged, w.AdoptItemID)
			out.Adopt = append(out.Adopt, [2]string{w.AdoptItemID, w.TaskID})
		case w.Synced:
			out.Missing = append(out.Missing, w.TaskID)
		case !w.Completed:
			out.Create = append(out.Create, w.TaskID)
		}
	}
	var fresh []RemoteReminder
	for _, it := range untagged { // 已完成的、空标题的手建提醒不导入
		if !it.Completed && strings.TrimSpace(it.Title) != "" {
			fresh = append(fresh, it)
		}
	}
	slices.SortFunc(fresh, func(a, b RemoteReminder) int { return strings.Compare(a.ItemID, b.ItemID) })
	for _, it := range fresh {
		out.Import = append(out.Import, ImportedReminder{ItemID: it.ItemID, Title: strings.TrimSpace(it.Title), Notes: strings.TrimSpace(it.Notes), Due: it.Due, Priority: it.Priority})
	}
	if len(desired) > 0 {
		for _, id := range order {
			if !wanted[id] {
				out.Delete = append(out.Delete, byTask[id].ItemID)
				out.DeletedTasks = append(out.DeletedTasks, id)
			}
		}
	}
	return out
}

// Effective 返回写到对端的最终内容（回流的标题 / 备注 / 到期按对端算，不拿 Toskr 旧值覆盖回去）。
func (p ReminderPlan) Effective(w DesiredReminder) DesiredReminder {
	if v, ok := p.TitleRemote[w.TaskID]; ok {
		w.Title = v
	}
	if v, ok := p.NotesRemote[w.TaskID]; ok {
		w.Notes = v
	}
	if v, ok := p.DueRemote[w.TaskID]; ok {
		w.Due = v
	}
	return w
}

// ReminderReceipt 是一轮成功同步后写回任务的结果（同 Tauri markAppleReminderSync 的入参）。
type ReminderReceipt struct {
	Created, Missing, Done, Open, Adopted []string
	Titles, Notes, Dues                   map[string]string // 下一轮的基准
	Plan                                  ReminderPlan
}

// Receipt 由下发列表与计划算出回执。
func (p ReminderPlan) Receipt(desired []DesiredReminder) ReminderReceipt {
	r := ReminderReceipt{Created: p.Create, Missing: p.Missing, Titles: map[string]string{}, Notes: map[string]string{}, Dues: map[string]string{}, Plan: p}
	backflow, missing := map[string]bool{}, map[string]bool{}
	for _, id := range p.CompletedRemote {
		backflow[id] = true
	}
	for _, id := range p.Missing {
		missing[id] = true
	}
	for _, a := range p.Adopt {
		r.Adopted = append(r.Adopted, a[1])
	}
	for _, w := range desired {
		if w.Completed {
			r.Done = append(r.Done, w.TaskID)
		} else if !backflow[w.TaskID] {
			r.Open = append(r.Open, w.TaskID)
		}
		if missing[w.TaskID] {
			continue
		}
		e := p.Effective(w)
		r.Titles[w.TaskID], r.Notes[w.TaskID], r.Dues[w.TaskID] = e.Title, e.Notes, DueKey(e.Due)
	}
	return r
}

// MarkReminderSync 写回一轮同步结果；稳态下无变化不写（免得任务一变又触发下一轮）。返回是否改了任务。
func (s *Store) MarkReminderSync(r ReminderReceipt) bool {
	set := func(list []string) map[string]bool {
		m := map[string]bool{}
		for _, x := range list {
			m[x] = true
		}
		return m
	}
	made, gone, closed, opened, claimed := set(r.Created), set(r.Missing), set(r.Done), set(r.Open), set(r.Adopted)
	changed := false
	_ = s.mutate(func() bool {
		for i := range s.tasks {
			t := &s.tasks[i]
			before := fmt.Sprintf("%+v", *t)
			if made[t.ID] && t.AppleSyncedID != t.ID {
				t.AppleSyncedID, t.AppleSyncOff = t.ID, false
			}
			switch {
			case gone[t.ID] && !t.AppleSyncOff:
				t.AppleSyncedID, t.AppleSyncOff, t.AppleDone = "", true, false
			case closed[t.ID] && !t.AppleDone:
				t.AppleDone = true
			case opened[t.ID] && t.AppleDone:
				t.AppleDone = false
			}
			if claimed[t.ID] {
				t.AppleImportItemID = ""
			}
			if v, ok := r.Plan.TitleRemote[t.ID]; ok {
				t.Text = v
			}
			if v, ok := r.Plan.NotesRemote[t.ID]; ok {
				t.Note = v
			}
			if d, ok := r.Plan.DueRemote[t.ID]; ok {
				if at := d.Time(); !at.Equal(t.DueAt) {
					t.DueAt, t.RemindedAt, t.EarlyReminded = at, time.Time{}, nil
				}
			}
			if !t.AppleSyncOff {
				if v, ok := r.Titles[t.ID]; ok && (t.AppleTitle == nil || *t.AppleTitle != v) {
					t.AppleTitle = &v
				}
				if v, ok := r.Notes[t.ID]; ok && (t.AppleNotes == nil || *t.AppleNotes != v) {
					t.AppleNotes = &v
				}
				if v, ok := r.Dues[t.ID]; ok && (t.AppleDue == nil || *t.AppleDue != v) {
					t.AppleDue = &v
				}
			}
			if fmt.Sprintf("%+v", *t) != before {
				changed = true
			}
		}
		return changed
	})
	return changed
}

// ImportReminders 把列表里新建的提醒导入为任务（已导入过的跳过），返回新建数。
func (s *Store) ImportReminders(items []ImportedReminder, section string) int {
	n := 0
	_ = s.mutate(func() bool {
		known := map[string]bool{}
		for _, t := range s.tasks {
			if t.AppleImportItemID != "" {
				known[t.AppleImportItemID] = true
			}
		}
		if section == "" || !slices.ContainsFunc(s.taskSections, func(x Section) bool { return x.ID == section }) {
			section = TaskInbox
		}
		now := time.Now()
		var fresh []Task
		for _, it := range items {
			if known[it.ItemID] || strings.TrimSpace(it.Title) == "" {
				continue
			}
			pri := "low"
			switch {
			case it.Priority == 0:
				pri = "none"
			case it.Priority < 5:
				pri = "high"
			case it.Priority == 5:
				pri = "mid"
			}
			id := newID()
			title, notes, due := strings.TrimSpace(it.Title), strings.TrimSpace(it.Notes), DueKey(it.Due)
			fresh = append(fresh, Task{ID: id, Text: title, Status: "todo", Priority: pri, DueAt: it.Due.Time(), CreatedAt: now,
				Note: notes, Section: section, AppleSyncedID: id, AppleImportItemID: it.ItemID, AppleTitle: &title, AppleNotes: &notes, AppleDue: &due})
		}
		n = len(fresh)
		s.tasks = append(fresh, s.tasks...)
		return n > 0
	})
	return n
}

// ApplyReminderTheirs：冲突气泡「撤销」——把被 Toskr 覆盖的提醒事项版本写回任务（下一轮随之推回对端）。
func (s *Store) ApplyReminderTheirs(conflicts []ReminderConflict) {
	_ = s.mutate(func() bool {
		for _, c := range conflicts {
			i := s.taskIndex(c.TaskID)
			if i < 0 {
				continue
			}
			t := &s.tasks[i]
			switch c.Field {
			case "title":
				if v := strings.TrimSpace(c.Theirs); v != "" {
					t.Text = v
				}
			case "notes":
				t.Note = strings.TrimSpace(c.Theirs)
			case "due":
				t.DueAt, t.RemindedAt, t.EarlyReminded = DueFromKey(c.Theirs).Time(), time.Time{}, nil
			}
		}
		return len(conflicts) > 0
	})
}
