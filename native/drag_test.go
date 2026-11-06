package main

import (
	"testing"

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
