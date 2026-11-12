package main

import (
	"testing"

	"github.com/egoist/mygo"

	"github.com/toskr/native/internal/macos"

	"github.com/toskr/native/internal/store"
)

// 同 Tauri sidebar_rect 2|3：铺满屏宽减间隙，高 = 32% 夹在 260–420。
func TestBarRect(t *testing.T) {
	wa := mygo.Rectangle{X: 0, Y: 25, Width: 1512, Height: 957}
	r := barRect(wa, "bottom")
	if r.X != 10 || r.Width != 1492 || r.Height != 306 || r.Y+r.Height != 25+957-10 {
		t.Fatalf("底部横栏 %+v", r)
	}
	if r := barRect(mygo.Rectangle{Width: 2560, Height: 1415}, "top"); r.Height != 420 || r.Y != 10 {
		t.Fatalf("大屏高度封顶 420、顶部贴上缘 %+v", r)
	}
	if r := barRect(mygo.Rectangle{Width: 1280, Height: 700}, "bottom"); r.Height != 260 {
		t.Fatalf("小屏高度保底 260 %+v", r)
	}
}

func TestEdgeAnchorBottom(t *testing.T) {
	e := edgeAnchor{x: 10, y: 666, w: 1492, h: 306, line: 982, monY: 0, monH: 1512, axis: edgeBottom}
	if !e.inside(700, 800) || !e.inside(700, 980) || e.inside(700, 600) {
		t.Fatal("底栏展开范围：面板到屏底之间算在内")
	}
	if !e.touching(30, 981) || e.touching(30, 900) {
		t.Fatal("底栏触边：屏底 24pt 内任意横向位置")
	}
	if e.hiddenAt() != 979 || e.shownAt() != 666 {
		t.Fatalf("底栏滑出只留 3pt：hidden=%d shown=%d", e.hiddenAt(), e.shownAt())
	}
	if x, y := e.pos(979); x != 10 || y != 979 {
		t.Fatal("底栏沿纵轴滑动")
	}
}

// 横栏：页签并入标题行、笔记成卡串、输入区默认收起由「添加笔记」唤出、分组胶囊与「已完成」。
func TestBarLayoutNotes(t *testing.T) {
	a, tt := testApp(t, "甲卡", "乙卡")
	st := a.store.Settings()
	st.SidebarEdge = "bottom"
	_ = a.store.SetSettings(st)
	a.switchPage(pageNotes)
	tt.SetSize(1400, 320)
	tt.Frame()
	tt.Frame()
	for _, s := range []string{"Toskr", "剪贴", "笔记", "任务", "全部", "收件箱", "甲卡", "乙卡"} {
		if !tt.HasText(s) {
			t.Fatalf("横栏缺少 %q：%v", s, tt.Texts())
		}
	}
	if tt.HasText("转大窗编辑") {
		t.Fatal("横栏输入区默认收起")
	}
	if err := tt.Click("添加笔记"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if !a.bar.draftOpen || !tt.HasText("转大窗编辑") {
		t.Fatalf("点「添加笔记」应唤出输入区 open=%v hbar=%v %v", a.bar.draftOpen, a.hbar(), tt.Texts())
	}
	n := a.store.Notes()[0]
	_ = a.store.SetDone(n.ID, true)
	tt.Frame()
	if err := tt.Click("已完成 1"); err != nil {
		t.Fatal(err, tt.Texts())
	}
	tt.Frame()
	if a.noteFilter != doneFilter || len(a.notes) != 1 || a.notes[0].ID != n.ID {
		t.Fatalf("「已完成」胶囊只列已完成 filter=%q notes=%d", a.noteFilter, len(a.notes))
	}
	st.SidebarEdge = "right"
	_ = a.store.SetSettings(st)
	a.reload()
	if a.noteFilter != "" {
		t.Fatal("回到竖栏「已完成」过滤应落回全部")
	}
}

func TestBarTaskStripFilter(t *testing.T) {
	a, _ := testApp(t)
	work := a.store.AddTaskSection("工作")
	inbox := a.store.TaskSections()[0].ID
	a.store.AddTask(store.Task{Text: "收集箱任务", Status: "todo"})
	a.store.AddTask(store.Task{Text: "工作任务", Status: "todo", Section: work})
	a.store.AddTask(store.Task{Text: "做完的", Status: "done"})
	a.tasks = a.store.Tasks()
	if got := a.stripTasks(); len(got) != 2 {
		t.Fatalf("全部只列未完成 %v", got)
	}
	a.bar.taskFilter = inbox
	if got := a.stripTasks(); len(got) != 1 || got[0].Text != "收集箱任务" {
		t.Fatalf("无分组任务归收集箱 %v", got)
	}
	a.bar.taskFilter = doneFilter
	if got := a.stripTasks(); len(got) != 1 || got[0].Text != "做完的" {
		t.Fatalf("已完成 %v", got)
	}
}

// 位置菜单（同 Tauri PanelOptionsMenu）：跟随应用时只给「跟随位置」；关掉后「屏幕位置」有自由移动 / 屏幕右侧 / 屏幕底部。
func TestPlacementMenuBottom(t *testing.T) {
	a, tt := testApp(t)
	st := a.store.Settings()
	st.CompanionOff = true
	_ = a.store.SetSettings(st)
	a.menuOpen, a.placementOpen = true, true
	tt.Frame()
	for _, s := range []string{"屏幕位置", "自由移动", "屏幕右侧", "屏幕底部"} {
		if !tt.HasText(s) {
			t.Fatalf("缺少 %q %v", s, tt.Texts())
		}
	}
	if err := tt.Click("屏幕底部"); err != nil {
		t.Fatal(err)
	}
	if got := a.store.Settings(); got.SidebarEdge != "bottom" || got.FreeMove || barEdge(got) != "bottom" {
		t.Fatalf("%+v", got)
	}
	st = a.store.Settings()
	st.CompanionOff = false
	_ = a.store.SetSettings(st)
	a.menuOpen, a.placementOpen = true, true
	tt.Frame()
	if tt.HasText("屏幕位置") || !tt.HasText("跟随位置") {
		t.Fatalf("跟随应用时不给屏幕位置 %v", tt.Texts())
	}
}

// 横栏下秘文 / 消息子页也改横排瓷砖串（同 Tauri SecretPage / MessagePage horizontal）。
func TestBarSecretAndMessages(t *testing.T) {
	a, tt := testApp(t)
	st := a.store.Settings()
	st.SidebarEdge, st.SecretEnabled, st.MessagesEnabled = "bottom", true, true
	_ = a.store.SetSettings(st)
	a.switchPage(pageNotes)
	tt.SetSize(1400, 320)
	a.noteSub = subSecret
	tt.Frame()
	tt.Frame()
	if !tt.HasText("还没有秘文") {
		t.Fatalf("秘文横栏空态 %v", tt.Texts())
	}
	a.noteSub = subMessages
	tt.Frame()
	tt.Frame()
	if !tt.HasText("没有待处理消息") {
		t.Fatalf("消息横栏空态 %v", tt.Texts())
	}
}

// 横栏预检：概览与正文并排，仍可发送 / 取消。
func TestBarPreflightTwoColumns(t *testing.T) {
	a, tt := testApp(t, "联系 demo.user@example.com")
	a.sys = &recSys{}
	a.target = macos.FrontApp{PID: 42, Name: "Cursor"}
	st := a.store.Settings()
	st.SidebarEdge = "bottom"
	_ = a.store.SetSettings(st)
	tt.SetSize(1400, 320)
	a.send([]store.Note{a.store.Notes()[0]})
	tt.Frame()
	tt.Frame()
	if len(a.pending) == 0 || !tt.HasText("取消") || !tt.HasText("发送内容含敏感信息") {
		t.Fatalf("横栏预检 %v", tt.Texts())
	}
	if err := tt.Click("取消"); err != nil {
		t.Fatal(err)
	}
	if len(a.pending) != 0 {
		t.Fatal("取消应清掉预检")
	}
}
