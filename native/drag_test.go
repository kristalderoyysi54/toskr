package main

import (
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// drag 按住 from 的中心，分几步移到 to 的中心后松开（实机拖拽手势）。
func drag(t *testing.T, tt *ui.Tester, from, to string, toDY float32) {
	dragAt(t, tt, from, 0, to, toDY)
}

// cardGrab：卡面正文是拖出源（抓文字 = 拖原文到别的应用），排序要抓卡片其余部分——这里抓正文上方的通栏。
const cardGrab = -20

func dragAt(t *testing.T, tt *ui.Tester, from string, fromDY float32, to string, toDY float32) {
	t.Helper()
	f, ok1 := tt.Find(from)
	g, ok2 := tt.Find(to)
	if !ok1 || !ok2 {
		t.Fatalf("找不到 %q / %q：%v", from, to, tt.Texts())
	}
	fx, fy := f.X+f.W/2, f.Y+f.H/2+fromDY
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
	dragAt(t, tt, "丙卡", cardGrab, "甲卡", 0)
	if got := texts(); len(got) != 3 || got[0] != "丙卡" || got[1] != "甲卡" {
		t.Fatalf("丙拖到甲前 %v", got)
	}
	sec := a.store.AddSection("资料")
	tt.Frame()
	dragAt(t, tt, "乙卡", cardGrab, "资料", 0)
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
	fx, fy := f.X+f.W/2, f.Y+f.H/2+cardGrab
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

// 同 Tauri dragOutProps：抓正文拖动是把原文拖出到其他应用（原生拖拽），不触发卡片排序。
func TestDragCardTextIsDragOutNotReorder(t *testing.T) {
	a, tt := testApp(t, "甲卡", "乙卡", "丙卡")
	drag(t, tt, "丙卡", "甲卡", 0)
	if got := a.store.Section(store.SectionInbox); got[0].Text != "甲卡" || got[2].Text != "丙卡" {
		t.Fatalf("抓正文不应排序 %v", []string{got[0].Text, got[1].Text, got[2].Text})
	}
}

// 拖动分组组名到另一组上 = 移到它的位置（同 Tauri SectionGroup 可排序）；单击组名仍是折叠。
func TestDragReorderSections(t *testing.T) {
	a, tt := testApp(t, "甲卡")
	sec := a.store.AddSection("资料")
	a.store.Add(store.Note{Section: sec, Text: "乙卡"})
	tt.Frame()
	tt.Frame()
	pos := func(id string) int {
		for i, s := range a.noteSections() {
			if s.ID == id {
				return i
			}
		}
		return -1
	}
	if pos(sec) <= pos(store.SectionInbox) {
		t.Fatal("准备：资料应在收件箱之后")
	}
	inbox := sectionName(a.noteSections()[pos(store.SectionInbox)])
	// 拖动中途：收件箱让位下移、资料的落点占位上移（还没松手，顺序不变）
	f, _ := tt.Find("资料")
	g, _ := tt.Find(inbox)
	fx, fy := f.X+f.W/2, f.Y+f.H/2
	tt.Move(fx, fy)
	tt.Press(fx, fy)
	for i := 1; i <= 6; i++ {
		tt.Move(fx, fy+(g.Y+g.H/2-fy)*float32(i)/6)
		tt.Frame()
	}
	if a.secSort.active != sec || a.secSort.over != store.SectionInbox ||
		a.secSort.offset(a.secOrder, store.SectionInbox, 8) <= 0 || a.secSort.offset(a.secOrder, sec, 8) >= 0 || pos(sec) < pos(store.SectionInbox) {
		t.Fatalf("拖动中应让位 active=%q over=%q", a.secSort.active, a.secSort.over)
	}
	tt.Release(fx, g.Y+g.H/2)
	tt.Frame()
	tt.Frame()
	if a.secSort.active != "" {
		t.Fatal("松手后拖动状态应清空")
	}
	if pos(sec) >= pos(store.SectionInbox) {
		t.Fatalf("资料应拖到收件箱前 %+v", a.noteSections())
	}
}

// 任务分组同款拖动排序：拖动中途其余分组让位，松手落进空位。
func TestDragReorderTaskSections(t *testing.T) {
	a, tt := testApp(t)
	work := a.store.AddTaskSection("工作")
	a.store.AddTask(store.Task{Text: "任务一"})
	a.store.AddTask(store.Task{Text: "任务二", Section: work})
	a.switchPage(pageTasks)
	a.taskSub = 1
	tt.Frame()
	tt.Frame()
	idx := func(id string) int {
		for i, s := range a.store.TaskSections() {
			if s.ID == id {
				return i
			}
		}
		return -1
	}
	if idx(work) <= idx(store.TaskInbox) {
		t.Fatal("准备：工作应在收集箱之后")
	}
	f, ok1 := tt.Find("工作")
	g, ok2 := tt.Find("任务一")
	if !ok1 || !ok2 {
		t.Fatal(tt.Texts())
	}
	fx, fy := f.X+f.W/2, f.Y+f.H/2
	tt.Move(fx, fy)
	tt.Press(fx, fy)
	for i := 1; i <= 6; i++ {
		tt.Move(fx, fy+(g.Y-fy)*float32(i)/6)
		tt.Frame()
	}
	if a.tsecSort.active != work || a.tsecSort.offset(a.tsecOrder, store.TaskInbox, 12) <= 0 {
		t.Fatalf("拖动中收集箱应让位 active=%q over=%q", a.tsecSort.active, a.tsecSort.over)
	}
	tt.Release(fx, g.Y)
	tt.Frame()
	tt.Frame()
	if idx(work) >= idx(store.TaskInbox) || a.tsecSort.active != "" {
		t.Fatalf("工作应排到收集箱前 %+v", a.store.TaskSections())
	}
}

// 拖动分组到列表下缘：自动往下滚（长列表一次拖到底）。
func TestSectionDragAutoScroll(t *testing.T) {
	a, tt := testApp(t)
	var last string
	for i := 0; i < 8; i++ {
		id := a.store.AddSection("组" + itoa(i))
		for j := 0; j < 3; j++ {
			a.store.Add(store.Note{Section: id, Text: "组" + itoa(i) + "卡" + itoa(j)})
		}
		last = id
	}
	_ = last
	tt.Frame()
	tt.Frame()
	f, ok := tt.Find("组0")
	if !ok {
		t.Fatal(tt.Texts())
	}
	fx, fy := f.X+f.W/2, f.Y+f.H/2
	tt.Move(fx, fy)
	tt.Press(fx, fy)
	bottom := float32(720 - 90) // 列表区下缘附近（底部输入条之上）
	for i := 1; i <= 6; i++ {
		tt.Move(fx, fy+(bottom-fy)*float32(i)/6)
		tt.Frame()
	}
	before := a.noteScroll.Y
	for i := 0; i < 20; i++ {
		tt.Frame()
	}
	if a.noteScroll.Y <= before {
		t.Fatalf("靠近下缘应自动滚动 %v → %v（active=%q）", before, a.noteScroll.Y, a.secSort.active)
	}
	tt.Release(fx, bottom)
	tt.Frame()
}
