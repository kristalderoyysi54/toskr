package main

import (
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

func init() { // 测试不碰 EventKit，且同步执行
	calStatus = func() string { return "notDetermined" }
	calEvents = func(int64, int64) []macos.CalendarEvent { return nil }
	calList = func() []macos.CalendarInfo { return nil }
	calRequest = func() string { return "denied" }
	calAsync = func(f func()) { f() }
}

// 苹果日历：开启后请求授权并拉今天的日程；全天日程在轴顶，其余与任务按时刻混排；隐藏的日历不显示；统计格多出「日程」。
func TestTodayCalendarEvents(t *testing.T) {
	a, tt := testApp(t)
	now := time.Date(2026, 11, 6, 13, 0, 0, 0, time.Local)
	a.clock = func() time.Time { return now }
	day := dayStart(now)
	asked := false
	oldS, oldE, oldR, oldL := calStatus, calEvents, calRequest, calList
	defer func() { calStatus, calEvents, calRequest, calList = oldS, oldE, oldR, oldL }()
	status := "notDetermined"
	calStatus = func() string { return status }
	calRequest = func() string { asked, status = true, "granted"; return status }
	calList = func() []macos.CalendarInfo {
		return []macos.CalendarInfo{{ID: "work", Title: "工作日历"}, {ID: "home", Title: "家庭"}}
	}
	calEvents = func(int64, int64) []macos.CalendarEvent {
		at := func(h int) int64 { return day.Add(time.Duration(h) * time.Hour).UnixMilli() }
		return []macos.CalendarEvent{
			{ID: "a", Title: "全天会议", AllDay: true, StartMs: at(0), EndMs: at(24), CalendarID: "work", CalendarTitle: "工作日历"},
			{ID: "b", Title: "下午评审", StartMs: at(15), EndMs: at(16), CalendarID: "work", CalendarTitle: "工作日历", Location: "3 楼"},
			{ID: "c", Title: "接孩子", StartMs: at(17), EndMs: at(18), CalendarID: "home"},
		}
	}
	a.setCalendarEnabled(true)
	if !asked || len(a.calEvents) != 3 || !a.store.Settings().CalendarOn {
		t.Fatalf("开启应请求授权并拉日程 asked=%v n=%d", asked, len(a.calEvents))
	}
	a.store.AddTask(store.Task{Text: "写周报", DueAt: day.Add(15 * time.Hour)})
	a.switchPage(pageTasks)
	a.reload()
	tt.Frame()
	for _, s := range []string{"全天", "全天会议", "下午评审", "15:00–16:00 · 工作日历 · 3 楼", "写周报", "接孩子", "日程"} {
		if !tt.HasText(s) {
			t.Fatalf("缺 %q：%v", s, tt.Texts())
		}
	}
	ev, _ := tt.Find("下午评审")
	task, _ := tt.Find("写周报")
	if !(ev.Y < task.Y) {
		t.Fatal("同刻日程排在任务前")
	}
	cur := a.store.Settings()
	cur.CalendarHidden = []string{"home"}
	_ = a.store.SetSettings(cur)
	tt.Frame()
	if tt.HasText("接孩子") {
		t.Fatal("隐藏的日历不显示")
	}

	a.openSettingsState()
	set := ui.NewTester(a.settingsView, 1040, 4000)
	_ = set.Click("更多功能")
	set.Frame()
	set.Frame()
	if !set.HasText("显示苹果日历日程") || !set.HasText("工作日历") || !set.HasText("家庭") {
		t.Fatalf("设置应列出日历 %v", set.Texts())
	}
	_ = set.Click("工作日历")
	set.Frame()
	if h := a.store.Settings().CalendarHidden; len(h) != 2 {
		t.Fatalf("点日历切换显示 %v", h)
	}
}
