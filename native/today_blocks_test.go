package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

func TestLayoutBlocksAndGaps(t *testing.T) {
	ev := &macos.CalendarEvent{ID: "e"}
	tk := func(status string) *store.Task { return &store.Task{Status: status} }
	bs := layoutBlocks([]dayBlock{
		{start: 16 * 60, end: 17*60 + 30, task: tk("todo")},
		{start: 15 * 60, end: 16 * 60, ev: ev},
		{start: 15*60 + 30, end: 16 * 60, task: tk("todo")}, // 与日程相交：并排两栏
		{start: 18*60 + 15, end: 18*60 + 45, task: tk("todo")},
		{start: 19 * 60, end: 20 * 60, task: tk("done")}, // 已完成不占空档
	})
	if bs[0].ev == nil || bs[0].lanes != 2 || bs[1].lane != 1 || bs[1].lanes != 2 || bs[2].lanes != 1 || bs[2].lane != 0 {
		t.Fatalf("%+v", bs)
	}
	gaps := freeGaps(bs, 14*60+30, 30)
	if len(gaps) != 2 || gaps[0] != [2]int{14*60 + 30, 15 * 60} || gaps[1] != [2]int{17*60 + 30, 18*60 + 15} {
		t.Fatalf("%v", gaps)
	}
	if g := freeGaps(bs, 17*60, 30); len(g) != 1 || g[0] != [2]int{17*60 + 30, 18*60 + 15} { // 现在落在某块里：从它结束算起
		t.Fatalf("%v", g)
	}
	if hm(16*60+5) != "16:05" || durLabel(90) != "1 小时 30 分钟" || durLabel(120) != "2 小时" || durLabel(45) != "45 分钟" {
		t.Fatal("格式")
	}
}

// 今天页：统计压成一行；时间块显示起止；未排期任务拖进时间轴即排期（15 分钟一档，可撤销）；拖下沿改时长；右键菜单可设时长。
func TestTodayTimeBlocks(t *testing.T) {
	a, tt := testApp(t)
	now := time.Date(2026, 11, 10, 14, 30, 0, 0, time.Local)
	day := dayStart(now)
	a.clock = func() time.Time { return now }
	a.patchSettings(func(x *store.Settings) { x.CalendarOn = true })
	a.calEvents = []macos.CalendarEvent{{ID: "e1", Title: "周会", StartMs: day.Add(15 * time.Hour).UnixMilli(), EndMs: day.Add(16 * time.Hour).UnixMilli(), CalendarColor: "#2a78d6", CalendarTitle: "工作"}}
	rep := a.store.AddTask(store.Task{Text: "交 mygo 对比报告", DueAt: day.Add(16 * time.Hour), DurationMin: 90})
	a.store.AddTask(store.Task{Text: "回复设计评审", DueAt: day.Add(18*time.Hour + 15*time.Minute)})
	a.store.AddTask(store.Task{Text: "复核账单提醒逻辑", DueAt: now.Add(-26 * time.Hour), Priority: "high"})
	un := a.store.AddTask(store.Task{Text: "整理截图标注需求"})
	a.store.AddTask(store.Task{Text: "一个灵感", Spark: true})
	a.reload()
	a.switchPage(pageTasks)
	a.taskSub = 0
	tt.Frame()
	tt.Frame()
	for _, s := range []string{"待办", "已完成", "已逾期", "日程", "周会", "16:00–17:30", "空档 45 分钟", "未排期", "整理截图标注需求", "往日未完成"} {
		if !tt.HasText(s) {
			t.Fatalf("缺 %q %v", s, tt.Texts())
		}
	}
	if tt.HasText("一个灵感") {
		t.Fatal("灵感不进未排期")
	}
	shot := func(name string) {
		if dir := os.Getenv("TOSKR_SHOT_DIR"); dir != "" {
			for _, dark := range []bool{false, true} {
				v := ui.NewTester(a.panelView, 320, 760)
				v.SetDark(dark)
				v.Frame()
				v.Frame()
				save(t, filepath.Join(dir, name+"-"+map[bool]string{false: "light", true: "dark"}[dark]+".png"), v.Image())
			}
		}
	}
	shot("today-blocks")
	// 拖「未排期」的任务到 17:30 那条线附近
	src, _ := tt.Find("整理截图标注需求")
	grid, ok := tt.Find("今天的时间轴")
	if !ok {
		t.Fatal("应有时间轴")
	}
	y1730 := grid.Y + (17.5-14)*hourH + 2 // 网格从 14:00 起
	sx, sy := src.X+src.W/2, src.Y+src.H/2
	tt.Move(sx, sy)
	tt.Press(sx, sy)
	for i := 1; i <= 6; i++ {
		tt.Move(sx, sy+(y1730-sy)*float32(i)/6)
		tt.Frame()
	}
	tt.Release(sx, y1730)
	tt.Frame()
	got, _ := a.taskByID(un.ID)
	if !got.DueAt.Equal(day.Add(17*time.Hour+30*time.Minute)) || a.hudText != "已排到 17:30" || a.hudUndo == nil {
		t.Fatalf("应排到 17:30：%v hud=%q", got.DueAt, a.hudText)
	}
	a.hudUndo()
	if back, _ := a.taskByID(un.ID); !back.DueAt.IsZero() {
		t.Fatal("撤销应回到未排期")
	}
	// 改时长：直接调用 + 右键菜单口径一致
	cur, _ := a.taskByID(rep.ID)
	a.setTaskDuration(cur, 60)
	a.reload()
	tt.Frame()
	if !tt.HasText("16:00–17:00") || a.hudText != "时长 1 小时" {
		t.Fatalf("%q %v", a.hudText, tt.Texts())
	}
}

// 专注：开始后面板顶部出胶囊、菜单栏标题给剩余分钟、任务转进行中；延后 +10 分钟；到点提醒并结束；完成即结束。
func TestFocusCapsule(t *testing.T) {
	a, tt := testApp(t)
	now := time.Date(2026, 11, 10, 14, 30, 0, 0, time.Local)
	a.clock = func() time.Time { return now }
	task := a.store.AddTask(store.Task{Text: "交 mygo 对比报告", DueAt: now.Add(time.Hour), DurationMin: 45})
	plain := a.store.AddTask(store.Task{Text: "没设时长"})
	a.reload()
	a.startFocus(task)
	tt.Frame()
	if cur, _ := a.taskByID(task.ID); cur.Status != "doing" || a.focusLeft() != 45 || a.trayTitle() != "专注 45 分" {
		t.Fatalf("status=%s left=%d title=%q", cur.Status, a.focusLeft(), a.trayTitle())
	}
	if !tt.HasText("专注中，剩 45 分钟") || !tt.HasText("交 mygo 对比报告") {
		t.Fatalf("笔记页也应看到胶囊 %v", tt.Texts())
	}
	if err := tt.Click("延后"); err != nil {
		t.Fatal(err)
	}
	if a.focusLeft() != 55 {
		t.Fatalf("延后应 +10 分钟 %d", a.focusLeft())
	}
	now = now.Add(20 * time.Minute)
	a.focusTick()
	if a.focus == nil || a.focusLeft() != 35 {
		t.Fatal("未到点不结束")
	}
	now = now.Add(36 * time.Minute)
	a.focusTick()
	if a.focus != nil || a.hudText != "专注时间到 · 交 mygo 对比报告" || a.trayTitle() != "" {
		t.Fatalf("到点应提醒并结束 %q", a.hudText)
	}
	a.startFocus(plain)
	if a.focusLeft() != focusDefault {
		t.Fatalf("未设时长默认 %d 分钟，得 %d", focusDefault, a.focusLeft())
	}
	tt.Frame()
	if err := tt.Click("完成"); err != nil {
		t.Fatalf("%v %v", err, tt.Texts())
	}
	if cur, _ := a.taskByID(plain.ID); cur.Status != "done" || a.focus != nil {
		t.Fatal("完成即结束专注")
	}
	if dir := os.Getenv("TOSKR_SHOT_DIR"); dir != "" {
		a.startFocus(task)
		for _, dark := range []bool{false, true} {
			v := ui.NewTester(a.panelView, 320, 300)
			v.SetDark(dark)
			v.Frame()
			v.Frame()
			save(t, filepath.Join(dir, "focus-"+map[bool]string{false: "light", true: "dark"}[dark]+".png"), v.Image())
		}
	}
}
