package main

import (
	"testing"
	"time"

	"github.com/toskr/native/internal/ai"
	"github.com/toskr/native/internal/store"
)

// 速记 ✨：点亮 AI 模式（与 💡 互斥）→ 回车交给 AI → 预览可改 → 回车确认入库；AI 失败按原文建任务。
func TestTaskQuickAddAI(t *testing.T) {
	a, tt := testApp(t)
	on := true
	st := a.store.Settings()
	st.AIEnabled = &on
	_ = a.store.SetSettings(st)
	now := time.Date(2026, 11, 6, 10, 0, 0, 0, time.Local)
	a.clock = func() time.Time { return now }
	work := a.store.AddTaskSection("工作")
	old := aiJSON
	t.Cleanup(func() { aiJSON = old })
	aiJSON = func(_ ai.Config, system, user string, v any) error {
		r := v.(*parsedTask)
		r.Title = "交周报"
		r.Due = &struct {
			MinutesFromNow *float64 `json:"minutesFromNow"`
			Date           string   `json:"date"`
			Time           string   `json:"time"`
		}{Date: "2026-11-09", Time: "10:00"}
		r.Priority = "mid"
		r.Recurrence = &struct {
			Freq string `json:"freq"`
		}{"weekly"}
		sec := "工作"
		r.Section = &sec
		r.Checklist = []string{"汇总", "发送"}
		return nil
	}
	a.switchPage(pageTasks)
	a.taskSub = 1
	a.sparkMode = true
	tt.Frame()
	if err := tt.Click("点击进入 AI 模式：自然语言建任务"); err != nil {
		t.Fatal(err, tt.Texts())
	}
	tt.Frame()
	if !a.taskAI || a.sparkMode || !tt.HasText("AI 模式：回车让 AI 解析时间、重复与分组（点击退出）") {
		t.Fatal("✨ 应点亮且与 💡 互斥")
	}
	a.parseTaskDraftAI("每周一10点交周报，放工作组，拆一下")
	waitUpd(a, func() bool { return a.taskAIDraft != nil })
	tt.Frame()
	for _, s := range []string{"AI 解析结果 · 回车确认，Esc 回到编辑", "优先级 中", "工作", "每周", "2 项检查"} {
		if !tt.HasText(s) {
			t.Fatalf("缺 %q %v", s, tt.Texts())
		}
	}
	tt.Click("去掉2 项检查")
	tt.Click("确认 ⏎")
	tt.Frame()
	var got store.Task
	for _, x := range a.store.Tasks() {
		if x.Text == "交周报" {
			got = x
		}
	}
	if got.Section != work || got.Priority != "mid" || got.Recurrence != "weekly" || len(got.Checklist) != 0 ||
		!got.DueAt.Equal(time.Date(2026, 11, 9, 10, 0, 0, 0, time.Local)) {
		t.Fatalf("%+v", got)
	}
	// 失败回退：按原文建普通任务
	aiJSON = func(ai.Config, string, string, any) error { return ai.ErrNoKey }
	a.parseTaskDraftAI("买牛奶")
	waitUpd(a, func() bool { return !a.taskAIBusy })
	found := false
	for _, x := range a.store.Tasks() {
		found = found || x.Text == "买牛奶"
	}
	if !found {
		t.Fatal("AI 失败应按原文建任务")
	}
}
