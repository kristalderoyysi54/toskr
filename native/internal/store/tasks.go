package store

import (
	"slices"
	"strings"
	"time"
)

// Task 是待办 / 闪念。语义参照 Tauri 版 notesStore.Task。
type Task struct {
	ID          string          `json:"id"`
	Text        string          `json:"text"`
	Status      string          `json:"status"`   // todo | doing | done
	Priority    string          `json:"priority"` // none | low | mid | high
	DueAt       time.Time       `json:"dueAt,omitzero"`
	CreatedAt   time.Time       `json:"createdAt"`
	CompletedAt time.Time       `json:"completedAt,omitzero"`
	RemindedAt  time.Time       `json:"remindedAt,omitzero"`
	Note        string          `json:"note,omitempty"`
	Checklist   []ChecklistItem `json:"checklist,omitempty"`
	Spark       bool            `json:"spark,omitempty"`
	Section     string          `json:"section,omitempty"`
	Recurrence  string          `json:"recurrence,omitempty"` // daily | weekdays | weekly | monthly | yearly
	// 重复的起算与结束（同 Tauri TaskRecurrence.basis / until / count）
	RecurBasis string    `json:"recurBasis,omitempty"` // "" = 按计划日期；completion = 从完成时算起
	RecurUntil time.Time `json:"recurUntil,omitzero"`  // 结束日（含当天）：下一期落在此日之后不再生成
	RecurCount int       `json:"recurCount,omitempty"` // 剩余期数（含本期）；0 = 不限
	// 每周重复的星期几（0 = 周日；空 = 按到期日那天，同 Tauri recurrence.weekdays）
	RecurWeekdays []int `json:"recurWeekdays,omitempty"`
	// 提醒档（分钟，0 = 到期时；nil = 只在到期时，空切片 = 不提醒，同 Tauri reminderOffsets）与已发过的提前档
	ReminderOffsets *[]int `json:"reminderOffsets,omitempty"`
	EarlyReminded   []int  `json:"earlyReminded,omitempty"`
}

// TaskReminderOffsetOptions 同 Tauri TASK_REMINDER_OFFSET_OPTIONS（分钟）。
var TaskReminderOffsetOptions = []int{0, 15, 60, 1440, 4320}

// Offsets：提醒档，缺省只在到期时。
func (t Task) Offsets() []int {
	if t.ReminderOffsets == nil {
		return []int{0}
	}
	return *t.ReminderOffsets
}

type ChecklistItem struct {
	ID   string `json:"id"`
	Text string `json:"text"`
	Done bool   `json:"done"`
}

func (s *Store) Tasks() []Task { s.mu.Lock(); defer s.mu.Unlock(); return slices.Clone(s.tasks) }
func (s *Store) TaskSections() []Section {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.taskSections)
}
func (s *Store) taskIndex(id string) int {
	return slices.IndexFunc(s.tasks, func(t Task) bool { return t.ID == id })
}

func (s *Store) AddTask(t Task) Task {
	t.Text = strings.TrimSpace(t.Text)
	if t.Text == "" {
		return Task{}
	}
	t.ID, t.CreatedAt = newID(), time.Now()
	if t.Status == "" {
		t.Status = "todo"
	}
	if t.Priority == "" {
		t.Priority = "none"
	}
	if t.Section == "" {
		t.Section = TaskInbox
	}
	_ = s.mutate(func() bool { s.tasks = slices.Insert(s.tasks, 0, t); return true })
	return t
}

func (s *Store) UpdateTask(t Task) error {
	return s.mutate(func() bool {
		i := s.taskIndex(t.ID)
		if i < 0 {
			return false
		}
		if !s.tasks[i].DueAt.Equal(t.DueAt) {
			t.RemindedAt, t.EarlyReminded = time.Time{}, nil // 改了到期时间，允许对新时间重新提醒
		}
		s.tasks[i] = t
		return true
	})
}

// CompleteTask 完成 / 取消完成。带重复规则的任务完成时生成下一期（本期去掉规则）。
func (s *Store) CompleteTask(id string, done bool, now time.Time) (next Task, spawned bool) {
	_ = s.mutate(func() bool {
		i := s.taskIndex(id)
		if i < 0 {
			return false
		}
		t := &s.tasks[i]
		if done {
			t.Status, t.CompletedAt = "done", now
			if due, ok := nextDue(*t, now); ok {
				next = *t
				next.ID, next.Status, next.CompletedAt, next.RemindedAt, next.CreatedAt = newID(), "todo", time.Time{}, time.Time{}, now
				next.EarlyReminded = nil
				next.DueAt = due
				if t.RecurCount > 0 {
					next.RecurCount = t.RecurCount - 1
				}
				next.Checklist = slices.Clone(t.Checklist) // 不能与本期共享底层数组
				for k := range next.Checklist {
					next.Checklist[k].Done = false
				}
				t.Recurrence, t.RecurBasis, t.RecurUntil, t.RecurCount = "", "", time.Time{}, 0
				s.tasks = slices.Insert(s.tasks, 0, next)
				spawned = true
			}
		} else {
			t.Status, t.CompletedAt = "todo", time.Time{}
		}
		return true
	})
	return
}

func (s *Store) DeleteTask(id string) (Task, int, bool) {
	var removed Task
	pos, ok := -1, false
	_ = s.mutate(func() bool {
		if pos = s.taskIndex(id); pos < 0 {
			return false
		}
		removed, ok = s.tasks[pos], true
		s.tasks = slices.Delete(s.tasks, pos, pos+1)
		return true
	})
	return removed, pos, ok
}

func (s *Store) RestoreTask(t Task, pos int) error {
	return s.mutate(func() bool {
		if s.taskIndex(t.ID) >= 0 {
			return false
		}
		s.tasks = slices.Insert(s.tasks, min(max(pos, 0), len(s.tasks)), t)
		return true
	})
}

func (s *Store) AddTaskSection(name string) string {
	if name = strings.TrimSpace(name); name == "" {
		return ""
	}
	id := "tsec-" + newID()
	_ = s.mutate(func() bool { s.taskSections = append(s.taskSections, Section{ID: id, Name: name}); return true })
	return id
}

// DueForReminder 返回已到期、未完成、尚未提醒过的任务，并标记已提醒。
func (s *Store) DueForReminder(now time.Time) []Task {
	var due []Task
	_ = s.mutate(func() bool {
		for i := range s.tasks {
			t := &s.tasks[i]
			if t.Status == "done" || t.DueAt.IsZero() {
				continue
			}
			// 同 Tauri taskRemindersDue：到期档用 RemindedAt；提前档只在到期前有效（已逾期不补发「还有 15 分钟」）
			hit := false
			for _, off := range t.Offsets() {
				switch {
				case off == 0:
					if !t.DueAt.After(now) && t.RemindedAt.IsZero() {
						t.RemindedAt, hit = now, true
					}
				case t.DueAt.After(now) && !t.DueAt.Add(-time.Duration(off)*time.Minute).After(now) && !slices.Contains(t.EarlyReminded, off):
					t.EarlyReminded, hit = append(t.EarlyReminded, off), true
				}
			}
			if hit {
				due = append(due, *t)
			}
		}
		return len(due) > 0
	})
	return due
}

// NextOccurrence 按重复规则推进一期；月/年按月末钳制（1/31 → 2/28）。
func NextOccurrence(t time.Time, rule string) time.Time {
	switch rule {
	case "daily":
		return t.AddDate(0, 0, 1)
	case "weekdays":
		n := t.AddDate(0, 0, 1)
		for n.Weekday() == time.Saturday || n.Weekday() == time.Sunday {
			n = n.AddDate(0, 0, 1)
		}
		return n
	case "weekly":
		return t.AddDate(0, 0, 7)
	case "monthly":
		return AddMonthsClamped(t, 1)
	case "yearly":
		return AddMonthsClamped(t, 12)
	}
	return t
}

// NextOccurrenceDays：每周重复且选了星期几时，推进到下一个选中的星期几（同 Tauri weekly weekdays）。
func NextOccurrenceDays(t time.Time, rule string, weekdays []int) time.Time {
	if rule != "weekly" || len(weekdays) == 0 {
		return NextOccurrence(t, rule)
	}
	for i := 1; i <= 7; i++ {
		n := t.AddDate(0, 0, i)
		if slices.Contains(weekdays, int(n.Weekday())) {
			return n
		}
	}
	return t.AddDate(0, 0, 7)
}

// AddMonthsClamped 加月并把日钳制到目标月最后一天。
func AddMonthsClamped(t time.Time, months int) time.Time {
	y, m, d := t.Date()
	first := time.Date(y, m+time.Month(months), 1, t.Hour(), t.Minute(), t.Second(), 0, t.Location())
	last := first.AddDate(0, 1, -1).Day()
	return first.AddDate(0, 0, min(d, last)-1)
}

// ParseQuickTask 解析快速输入里的中文时间与优先级：「明天下午3点 交周报 !!」。
func ParseQuickTask(input string, now time.Time) Task {
	t := Task{Priority: "none"}
	text := strings.TrimSpace(input)
	for _, p := range []struct{ mark, level string }{{"!!!", "high"}, {"!!", "mid"}, {"!", "low"}} {
		if strings.HasSuffix(text, " "+p.mark) || strings.HasSuffix(text, p.mark) && len(text) > len(p.mark) {
			t.Priority = p.level
			text = strings.TrimSpace(strings.TrimSuffix(text, p.mark))
			break
		}
	}
	day := time.Time{}
	base := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	for _, w := range []struct {
		word string
		add  int
	}{{"今天", 0}, {"明天", 1}, {"后天", 2}} {
		if strings.HasPrefix(text, w.word) {
			day = base.AddDate(0, 0, w.add)
			text = strings.TrimSpace(strings.TrimPrefix(text, w.word))
			break
		}
	}
	hour := -1
	for _, part := range []struct {
		word string
		off  int
	}{{"上午", 0}, {"早上", 0}, {"中午", 12}, {"下午", 12}, {"晚上", 12}} {
		if strings.HasPrefix(text, part.word) {
			text = strings.TrimPrefix(text, part.word)
			if i := strings.Index(text, "点"); i > 0 && i <= 2 {
				if h, ok := atoiSmall(text[:i]); ok {
					hour = h
					if part.off == 12 && h < 12 {
						hour = h + 12
					}
					text = strings.TrimSpace(text[i+len("点"):])
				}
			}
			break
		}
	}
	if !day.IsZero() || hour >= 0 {
		if day.IsZero() {
			day = base
		}
		if hour < 0 {
			hour = 9
		}
		t.DueAt = day.Add(time.Duration(hour) * time.Hour)
	}
	t.Text = text
	return t
}

func atoiSmall(s string) (int, bool) {
	n := 0
	if s == "" {
		return 0, false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return 0, false
		}
		n = n*10 + int(r-'0')
	}
	return n, n <= 23
}

// UpdateTaskSection 改任务分组（名称 / 折叠）。
func (s *Store) UpdateTaskSection(sec Section) error {
	return s.mutate(func() bool {
		i := slices.IndexFunc(s.taskSections, func(x Section) bool { return x.ID == sec.ID })
		if i < 0 || strings.TrimSpace(sec.Name) == "" {
			return false
		}
		s.taskSections[i] = sec
		return true
	})
}

// MoveTaskSection 上移 / 下移任务分组。
func (s *Store) MoveTaskSection(id string, delta int) error {
	return s.mutate(func() bool {
		i := slices.IndexFunc(s.taskSections, func(x Section) bool { return x.ID == id })
		j := i + delta
		if i < 0 || j < 0 || j >= len(s.taskSections) {
			return false
		}
		s.taskSections[i], s.taskSections[j] = s.taskSections[j], s.taskSections[i]
		return true
	})
}

// DeleteTaskSection 删除任务分组（收集箱不可删），其中任务移回收集箱。返回撤销用的函数。
func (s *Store) DeleteTaskSection(id string) (undo func(), ok bool) {
	var sec Section
	var pos int
	var moved []string
	_ = s.mutate(func() bool {
		pos = slices.IndexFunc(s.taskSections, func(x Section) bool { return x.ID == id })
		if pos < 0 || id == TaskInbox {
			return false
		}
		sec = s.taskSections[pos]
		s.taskSections = slices.Delete(s.taskSections, pos, pos+1)
		for i := range s.tasks {
			if s.tasks[i].Section == id {
				s.tasks[i].Section = TaskInbox
				moved = append(moved, s.tasks[i].ID)
			}
		}
		ok = true
		return true
	})
	if !ok {
		return nil, false
	}
	return func() {
		_ = s.mutate(func() bool {
			s.taskSections = slices.Insert(s.taskSections, min(pos, len(s.taskSections)), sec)
			for i := range s.tasks {
				if slices.Contains(moved, s.tasks[i].ID) {
					s.tasks[i].Section = id
				}
			}
			return true
		})
	}, true
}

// NewChecklistItem 生成检查项。
func NewChecklistItem(text string) ChecklistItem {
	return ChecklistItem{ID: "ck-" + newID(), Text: strings.TrimSpace(text)}
}

// MoveTask 把任务移到 beforeID 之前（beforeID 为空则放到 section 末尾），并归入对应分组。
func (s *Store) MoveTask(id, section, beforeID string) error {
	return s.mutate(func() bool {
		i := s.taskIndex(id)
		if i < 0 || id == beforeID {
			return false
		}
		t := s.tasks[i]
		s.tasks = slices.Delete(s.tasks, i, i+1)
		at := len(s.tasks)
		if j := s.taskIndex(beforeID); beforeID != "" && j >= 0 {
			at, section = j, s.tasks[j].Section
		} else {
			for k := len(s.tasks) - 1; k >= 0; k-- {
				if s.tasks[k].Section == section {
					at = k + 1
					break
				}
			}
		}
		t.Section = section
		s.tasks = slices.Insert(s.tasks, at, t)
		return true
	})
}

// nextDue：完成本期后下一期的到期时间。从完成时算起的保留原到期的时刻；超过结束日或剩余 1 期时不再生成。
func nextDue(t Task, completed time.Time) (time.Time, bool) {
	if t.Recurrence == "" || t.DueAt.IsZero() || t.RecurCount == 1 {
		return time.Time{}, false
	}
	base := t.DueAt
	if t.RecurBasis == "completion" {
		base = time.Date(completed.Year(), completed.Month(), completed.Day(), t.DueAt.Hour(), t.DueAt.Minute(), 0, 0, t.DueAt.Location())
	}
	due := NextOccurrenceDays(base, t.Recurrence, t.RecurWeekdays)
	if !t.RecurUntil.IsZero() {
		y, m, d := t.RecurUntil.Date()
		if due.After(time.Date(y, m, d, 23, 59, 59, 0, due.Location())) {
			return time.Time{}, false
		}
	}
	return due, true
}

// SnoozeTasks 稍后提醒（同 Tauri snoozeTasks）：到期改到 now+minutes，清掉已提醒标记，返回新的到期时刻。
func (s *Store) SnoozeTasks(ids []string, minutes int, now time.Time) time.Time {
	at := now.Add(time.Duration(max(1, minutes)) * time.Minute)
	_ = s.mutate(func() bool {
		changed := false
		for i := range s.tasks {
			if slices.Contains(ids, s.tasks[i].ID) {
				s.tasks[i].DueAt, s.tasks[i].RemindedAt, changed = at, time.Time{}, true
			}
		}
		return changed
	})
	return at
}
