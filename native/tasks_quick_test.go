package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

func TestParseQuickTask(t *testing.T) {
	now := time.Date(2026, 11, 10, 10, 0, 0, 0, time.Local) // 周二
	at := func(d, h, m int) time.Time { return time.Date(2026, 11, d, h, m, 0, 0, time.Local) }
	secs := []store.Section{{ID: store.TaskInbox, Name: "收集箱"}, {ID: "s1", Name: "工作"}}
	for _, c := range []struct {
		in, title string
		due       time.Time
		rec, pri  string
		sec       string
	}{
		{"明天下午3点 交周报 !!", "交周报", at(11, 15, 0), "", "mid", ""},
		{"交周报", "交周报", time.Time{}, "", "", ""},
		{"今晚8点 给妈妈打电话", "给妈妈打电话", at(10, 20, 0), "", "", ""},
		{"后天 体检", "体检", at(12, 9, 0), "", "", ""},
		{"下午3点半开会", "开会", at(10, 15, 30), "", "", ""},
		{"9点 站会", "站会", at(11, 9, 0), "", "", ""}, // 今天 9 点已过 → 明天
		{"周五 交报告!!!", "交报告", at(13, 9, 0), "", "high", ""},
		{"下周一10点 评审", "评审", at(16, 10, 0), "", "", ""},
		{"每周一10点交周报 放工作组", "交周报", at(16, 10, 0), "weekly", "", "s1"},
		{"每天晚上9点 复盘", "复盘", at(10, 21, 0), "daily", "", ""},
		{"每个工作日 打卡", "打卡", time.Time{}, "weekdays", "", ""},
		{"30分钟后 喝水", "喝水", at(10, 10, 30), "", "", ""},
		{"两小时后取快递！", "取快递", at(10, 12, 0), "", "low", ""},
		{"3天后 续费域名", "续费域名", at(13, 9, 0), "", "", ""},
		{"11月20日 14:30 牙医", "牙医", at(20, 14, 30), "", "", ""},
		{"15号 还信用卡", "还信用卡", at(15, 9, 0), "", "", ""},
		{"明天上午 写周报 #工作", "写周报", at(11, 9, 0), "", "", "s1"},
		{"整理 #不存在的组", "整理 #不存在的组", time.Time{}, "", "", ""},
		{"十点半 喝咖啡", "喝咖啡", at(10, 10, 30), "", "", ""},
	} {
		p := parseQuickTask(c.in, now, secs)
		if p.title != c.title || !p.due.Equal(c.due) || p.recurrence != c.rec || p.priority != c.pri || p.section != c.sec {
			t.Errorf("%q → 标题 %q 到期 %s 重复 %q 优先级 %q 分组 %q；应为 %q %s %q %q %q", c.in, p.title, p.due.Format("01-02 15:04"), p.recurrence, p.priority, p.section,
				c.title, c.due.Format("01-02 15:04"), c.rec, c.pri, c.sec)
		}
	}
}

// 点掉某片后保留原词、不采用该项；整句都是时间词时原文入库；闪念模式不解析。
func TestQuickTaskChipsOff(t *testing.T) {
	a, tt := testApp(t)
	now := time.Date(2026, 11, 10, 10, 0, 0, 0, time.Local)
	a.clock = func() time.Time { return now }
	a.switchPage(pageTasks)
	a.taskSub = 1
	a.taskDraft = "明天 讨论明天的计划 !"
	tt.Frame()
	if err := tt.Click("优先级 低"); err != nil {
		t.Fatalf("%v %v", err, tt.Texts())
	}
	tt.Frame()
	if !a.taskQuickOff["pri"] {
		t.Fatal("应点掉优先级片")
	}
	a.addTaskDraft()
	got := a.store.Tasks()[0]
	if got.Text != "讨论明天的计划 !" || got.Priority == "low" || got.DueAt.Day() != 11 || a.taskQuickOff != nil || a.taskDraft != "" {
		t.Fatalf("%+v off=%v", got, a.taskQuickOff)
	}
	a.taskDraft = "明天下午3点"
	a.addTaskDraft()
	if got := a.store.Tasks()[0]; got.Text != "明天下午3点" || !got.DueAt.IsZero() {
		t.Fatalf("整句都是时间词应原文入库 %+v", got)
	}
	a.sparkMode = true
	a.taskDraft = "明天试试新配色"
	tt.Frame()
	if _, ok := a.quickDraft(); ok {
		t.Fatal("闪念模式不出片")
	}
	a.addTaskDraft()
	if got := a.store.Tasks()[0]; got.Text != "明天试试新配色" || !got.Spark || !got.DueAt.IsZero() {
		t.Fatalf("闪念原文入库 %+v", got)
	}
}

func TestQuickChipsShot(t *testing.T) {
	dir := os.Getenv("TOSKR_SHOT_DIR")
	if dir == "" {
		t.Skip("set TOSKR_SHOT_DIR")
	}
	for _, dark := range []bool{false, true} {
		a, _ := testApp(t)
		a.store.AddTaskSection("工作")
		a.switchPage(pageTasks)
		a.taskSub = 1
		a.taskDraft = "每周一下午3点 交周报 放工作组 !!!"
		a.taskQuickOff = map[string]bool{"pri": true}
		v := ui.NewTester(a.panelView, 320, 420)
		v.SetDark(dark)
		v.Frame()
		v.Frame()
		save(t, filepath.Join(dir, "quick-chips-"+map[bool]string{false: "light", true: "dark"}[dark]+".png"), v.Image())
	}
}
