package store

import (
	"testing"
	"time"
)

func sp(s string) *string { return &s }

func TestPlanRemindersCreateUpdateDelete(t *testing.T) {
	due := &DueParts{2026, 11, 7, 9, 30}
	desired := []DesiredReminder{
		{TaskID: "a", Title: "新任务", Due: due},
		{TaskID: "b", Title: "改过标题", Synced: true, BaseTitle: sp("旧标题"), BaseNotes: sp(""), BaseDue: sp("")},
		{TaskID: "c", Title: "对端删了", Synced: true},
		{TaskID: "d", Title: "对端完成", Synced: true},
	}
	remote := []RemoteReminder{
		{ItemID: "r-b", TaskID: "b", Title: "旧标题"},
		{ItemID: "r-d", TaskID: "d", Title: "对端完成", Completed: true},
		{ItemID: "r-x", TaskID: "x", Title: "Toskr 里删了"},
		{ItemID: "r-new", Title: "手机上新建"},
		{ItemID: "r-done", Title: "手机上已完成的", Completed: true},
	}
	p := PlanReminders(desired, remote)
	if len(p.Create) != 1 || p.Create[0] != "a" {
		t.Fatal("create", p.Create)
	}
	if len(p.Update) != 1 || p.Update[0] != [2]string{"r-b", "b"} {
		t.Fatal("Toskr 改了标题、对端没改：推更新", p.Update)
	}
	if len(p.Missing) != 1 || p.Missing[0] != "c" || len(p.CompletedRemote) != 1 || p.CompletedRemote[0] != "d" {
		t.Fatal(p.Missing, p.CompletedRemote)
	}
	if len(p.Delete) != 1 || p.Delete[0] != "r-x" || p.DeletedTasks[0] != "x" {
		t.Fatal("Toskr 删了的任务删对端", p.Delete)
	}
	if len(p.Import) != 1 || p.Import[0].ItemID != "r-new" {
		t.Fatal("只导入未完成的手建提醒", p.Import)
	}
	if q := PlanReminders(nil, remote); len(q.Delete) != 0 {
		t.Fatal("一条都没下发时不删对端")
	}
}

func TestPlanRemindersThreeWay(t *testing.T) {
	base := []DesiredReminder{{TaskID: "t", Title: "开会", Notes: "", Synced: true, BaseTitle: sp("开会"), BaseNotes: sp(""), BaseDue: sp("")}}
	// 只有对端改了标题和到期 → 回流，且不再推更新
	p := PlanReminders(base, []RemoteReminder{{ItemID: "r", TaskID: "t", Title: "开周会", Due: &DueParts{2026, 11, 8, -1, -1}}})
	if p.TitleRemote["t"] != "开周会" || DueKey(p.DueRemote["t"]) != "2026-11-8 -1:-1" || len(p.Update) != 0 {
		t.Fatalf("%+v", p)
	}
	// 两边都改 → 冲突，以 Toskr 为准推回去
	both := base
	both[0].Title = "开例会"
	p = PlanReminders(both, []RemoteReminder{{ItemID: "r", TaskID: "t", Title: "开周会"}})
	if len(p.Conflicts) != 1 || p.Conflicts[0].Theirs != "开周会" || len(p.Update) != 1 {
		t.Fatalf("%+v", p)
	}
}

func TestReminderSyncRoundTrip(t *testing.T) {
	s, _ := OpenDir(t.TempDir(), key)
	task := s.AddTask(Task{Text: "交周报", Priority: "high", DueAt: time.Date(2026, 11, 7, 10, 0, 0, 0, time.Local)})
	s.AddTask(Task{Text: "闪念", Spark: true})
	d := DesiredReminders(s.Tasks(), nil, true)
	if len(d) != 1 || d[0].Priority != 1 || len(d[0].Alarms) != 1 || d[0].Alarms[0] != 0 {
		t.Fatalf("闪念不同步、高优先级=1、默认到期时响铃：%+v", d)
	}
	p := PlanReminders(d, nil)
	if !s.MarkReminderSync(p.Receipt(d)) {
		t.Fatal("首轮应写下关联与基准")
	}
	got, _ := s.taskByIDForTest(task.ID)
	if got.AppleSyncedID != task.ID || got.AppleTitle == nil || *got.AppleTitle != "交周报" || *got.AppleDue != "2026-11-7 10:0" {
		t.Fatalf("%+v", got)
	}
	d = DesiredReminders(s.Tasks(), nil, true)
	remote := []RemoteReminder{{ItemID: "r1", TaskID: task.ID, Title: "交周报", Due: DuePartsOf(task.DueAt), Priority: 1, Alarms: []int64{0}}}
	p = PlanReminders(d, remote)
	if len(p.Update)+len(p.Create) != 0 || s.MarkReminderSync(p.Receipt(d)) {
		t.Fatal("稳态下无动作、不写任务", p)
	}
	if n := s.ImportReminders([]ImportedReminder{{ItemID: "phone-1", Title: "买牛奶", Priority: 5}}, ""); n != 1 {
		t.Fatal(n)
	}
	if n := s.ImportReminders([]ImportedReminder{{ItemID: "phone-1", Title: "买牛奶"}}, ""); n != 0 {
		t.Fatal("同一条不重复导入")
	}
	s.ApplyReminderTheirs([]ReminderConflict{{TaskID: task.ID, Field: "title", Theirs: "交月报"}})
	if got, _ := s.taskByIDForTest(task.ID); got.Text != "交月报" {
		t.Fatal(got.Text)
	}
}

func (s *Store) taskByIDForTest(id string) (Task, bool) {
	for _, t := range s.Tasks() {
		if t.ID == id {
			return t, true
		}
	}
	return Task{}, false
}
