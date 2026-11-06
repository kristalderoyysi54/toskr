package main

import (
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// drag 按住 from 的中心，分几步移到 to 的中心后松开（实机拖拽手势）。
func drag(t *testing.T, tt *ui.Tester, from, to string, toDY float32) {
	t.Helper()
	f, ok1 := tt.Find(from)
	g, ok2 := tt.Find(to)
	if !ok1 || !ok2 {
		t.Fatalf("找不到 %q / %q：%v", from, to, tt.Texts())
	}
	fx, fy := f.X+f.W/2, f.Y+f.H/2
	gx, gy := g.X+g.W/2, g.Y+g.H/2+toDY
	tt.Move(fx, fy)
	tt.Press(fx, fy)
	for i := 1; i <= 6; i++ {
		tt.Move(fx+(gx-fx)*float32(i)/6, fy+(gy-fy)*float32(i)/6)
		tt.Frame()
	}
	tt.Release(gx, gy)
	tt.Frame()
	tt.Frame()
}

// 拖拽排序：卡片拖到另一张卡上 = 插到它前面；拖到分组头 = 移入该组；任务行同理。
func TestDragReorderNotesAndTasks(t *testing.T) {
	a, tt := testApp(t, "甲卡", "乙卡", "丙卡")
	texts := func() (out []string) {
		for _, n := range a.store.Section(store.SectionInbox) {
			out = append(out, n.Text)
		}
		return
	}
	drag(t, tt, "丙卡", "甲卡", 0)
	if got := texts(); len(got) != 3 || got[0] != "丙卡" || got[1] != "甲卡" {
		t.Fatalf("丙拖到甲前 %v", got)
	}
	sec := a.store.AddSection("资料")
	tt.Frame()
	drag(t, tt, "乙卡", "资料", 0)
	if got := a.store.Section(sec); len(got) != 1 || got[0].Text != "乙卡" {
		t.Fatalf("拖到分组头应移入 %v / 收件箱 %v", got, texts())
	}

	work := a.store.AddTaskSection("工作")
	a.store.AddTask(store.Task{Text: "任务一"})
	a.store.AddTask(store.Task{Text: "任务二"})
	a.switchPage(pageTasks)
	a.taskSub = 1
	tt.Frame()
	tt.Frame()
	drag(t, tt, "任务二", "任务一", 0)
	if ts := a.store.Tasks(); ts[0].Text != "任务二" {
		t.Fatalf("任务二拖到任务一前 %+v", ts)
	}
	drag(t, tt, "任务一", "工作", 0)
	for _, x := range a.store.Tasks() {
		if x.Text == "任务一" && x.Section != work {
			t.Fatalf("拖到任务分组头应移入 %+v", x)
		}
	}
}

// 拖到折叠分组头上悬停 500ms 自动展开（QA#12）。
func TestDragHoverExpandsCollapsedGroup(t *testing.T) {
	orig := dragNow
	t.Cleanup(func() { dragNow = orig })
	now := time.Now()
	dragNow = func() time.Time { return now }
	a, tt := testApp(t, "甲卡")
	sec := a.store.AddSection("资料")
	_, _, _ = a.store.Add(store.Note{Section: sec, Text: "里面的卡"})
	for _, s := range a.store.Sections() {
		if s.ID == sec {
			s.Collapsed = true
			_ = a.store.UpdateSection(s)
		}
	}
	a.reload()
	tt.Frame()
	f, _ := tt.Find("甲卡")
	g, _ := tt.Find("资料")
	fx, fy := f.X+f.W/2, f.Y+f.H/2
	gx, gy := g.X+g.W/2, g.Y+g.H/2
	tt.Move(fx, fy)
	tt.Press(fx, fy)
	for i := 1; i <= 6; i++ {
		tt.Move(fx+(gx-fx)*float32(i)/6, fy+(gy-fy)*float32(i)/6)
		tt.Frame()
	}
	collapsed := func() bool {
		for _, s := range a.store.Sections() {
			if s.ID == sec {
				return s.Collapsed
			}
		}
		return false
	}
	if !collapsed() {
		t.Fatal("刚悬停不应展开")
	}
	now = now.Add(600 * time.Millisecond)
	tt.Frame()
	if collapsed() {
		t.Fatal("悬停 500ms 后应自动展开")
	}
	tt.Release(gx, gy)
	tt.Frame()
}
