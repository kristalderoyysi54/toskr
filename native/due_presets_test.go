package main

import (
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// 设置 → 到期快捷档：编辑（改类型 / 时间）、删除可撤销、添加、恢复默认；消息「提醒我」与任务「到期」读同一组档位。
func TestDuePresetSettings(t *testing.T) {
	a, tt := msgApp(t)
	a.openSettingsState()
	set := ui.NewTester(a.settingsView, 1040, 6000)
	a.setJump = "更多功能"
	set.Frame()
	set.Frame()
	for _, s := range []string{"到期提醒快捷档", "30 分钟后", "1 小时后", "6 小时后", "今天 20:00", "明天 9:00", "下个周一 9:00"} {
		if !set.HasText(s) {
			t.Fatalf("缺 %q：%v", s, set.Texts())
		}
	}
	if err := set.Click("编辑30 分钟后"); err != nil {
		t.Fatal(err)
	}
	set.Frame()
	if err := set.Click("下个周几"); err != nil {
		t.Fatal(err)
	}
	set.Frame()
	a.dueEdit.at, a.dueEdit.wd = "18:30", 5
	set.Frame()
	if !set.HasText("→ 下个周五 18:30") {
		t.Fatalf("预览 %v", set.Texts())
	}
	set.Click("保存")
	set.Frame()
	ps := a.store.Settings().Presets()
	if ps[0].Kind != "weekday" || ps[0].Weekday != 5 || ps[0].Hour != 18 || ps[0].Minute != 30 || a.dueEdit.id != "" {
		t.Fatalf("%+v", ps[0])
	}
	if err := set.Click("删除1 小时后"); err != nil {
		t.Fatal(err)
	}
	set.Frame()
	if len(a.store.Settings().Presets()) != 6 {
		t.Fatal("删除")
	}
	a.hudUndo()
	if len(a.store.Settings().Presets()) != 7 {
		t.Fatal("撤销删除")
	}
	set.Frame() // 撤销后行数变了，先重排再点
	if err := set.Click("添加档位"); err != nil {
		t.Fatal(err, set.Texts())
	}
	set.Frame()
	if got := a.store.Settings().Presets(); len(got) != 8 || a.dueEdit.id != got[7].ID {
		t.Fatalf("添加后直接进入编辑 %d %q %+v", len(got), a.dueEdit.id, got)
	}
	a.dueEdit.num, a.dueEdit.unit = "abc", 0
	set.Frame()
	set.Click("保存")
	if a.dueEdit.id == "" || a.hudText != "时间格式应为 时:分，如 9:30" {
		t.Fatalf("非法输入不保存 %q", a.hudText)
	}
	a.dueEdit.num = "90"
	set.Frame()
	set.Click("保存")
	if got := a.store.Settings().Presets(); got[7].Minutes != 90 {
		t.Fatalf("%+v", got[7])
	}

	// 消息「提醒我」：菜单项来自快捷档
	now := time.Date(2026, 11, 6, 10, 0, 0, 0, time.Local)
	a.clock = func() time.Time { return now }
	r, _ := tt.Find("小王")
	tt.Move(r.X+r.W/2, r.Y+r.H/2)
	tt.Frame()
	if err := tt.Click("提醒我"); err != nil {
		t.Fatal(err)
	}
	if err := tt.ChooseMenuItem("下个周五 18:30"); err != nil {
		t.Fatalf("%v %v", err, tt.Menu())
	}
	tt.Frame()
	tasks := a.store.Tasks()
	if len(tasks) != 1 || !tasks[0].DueAt.Equal(time.Date(2026, 11, 13, 18, 30, 0, 0, time.Local)) {
		t.Fatalf("%+v", tasks)
	}

	// 全删后菜单给去设置的提示
	empty := []store.DuePreset{}
	a.savePresets(empty)
	r, _ = tt.Find("小张")
	tt.Move(r.X+r.W/2, r.Y+r.H/2)
	tt.Frame()
	tt.Click("提醒我")
	if err := tt.ChooseMenuItem("没有快捷档，去设置添加…"); err != nil {
		t.Fatalf("%v %v", err, tt.Menu())
	}
}
