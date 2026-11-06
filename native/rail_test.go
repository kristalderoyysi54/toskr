package main

import (
	"testing"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// 分组侧栏：开关可点 → 列出全部 / 各分组 / 新建；点分组只显示该组并收起；右键可重命名、上移下移。
func TestNoteGroupRail(t *testing.T) {
	a, tt := testApp(t, "收件箱里的")
	id := a.store.AddSection("提示词")
	n, _, _ := a.store.Add(store.Note{Section: id, Text: "提示词里的"})
	_ = n
	a.reload()
	tt.Frame()
	if err := tt.Click("选择笔记分组，当前：全部"); err != nil {
		t.Fatalf("侧栏开关不可点：%v", err)
	}
	tt.Frame()
	if !a.noteRailOpen || !tt.HasText("全部") || !tt.HasText("新建") {
		t.Fatalf("侧栏 %v", tt.Texts())
	}
	if err := tt.Click("提示词"); err != nil {
		t.Fatal(err)
	}
	tt.Advance(time.Second)
	tt.Frame()
	if a.noteFilter != id || a.noteRailOpen || tt.HasText("收件箱里的") || !tt.HasText("提示词里的") || a.section != id {
		t.Fatalf("过滤后 filter=%q open=%v %v", a.noteFilter, a.noteRailOpen, tt.Texts())
	}
	a.noteRailOpen = true
	tt.Frame()
	_ = tt.RightClick("提示词")
	if err := tt.ChooseMenuItem("重命名"); err != nil {
		t.Fatalf("%v %v", err, tt.Menu())
	}
	tt.Frame()
	tt.Key(ui.Cmd, ui.KeyA)
	tt.Type("Prompt 库")
	tt.Key(0, ui.KeyEnter)
	tt.Frame()
	if secs := a.store.Sections(); secs[1].Name != "Prompt 库" {
		t.Fatalf("改名 %+v", secs)
	}
	_ = tt.RightClick("Prompt 库")
	if err := tt.ChooseMenuItem("上移"); err != nil {
		t.Fatalf("%v %v", err, tt.Menu())
	}
	if secs := a.store.Sections(); secs[0].ID != id {
		t.Fatalf("上移 %+v", secs)
	}
	_ = tt.Click("全部")
	tt.Frame()
	if a.noteFilter != "" || !tt.HasText("收件箱里的") {
		t.Fatal("回到全部")
	}
}

// 任务页头部：筛选开关出搜索栏与 chip、按关键词过滤；日历开关出月历，点某天可为该天加任务。
func TestTaskFilterAndCalendar(t *testing.T) {
	a, tt := testApp(t)
	now := time.Date(2026, 11, 6, 10, 0, 0, 0, time.Local)
	a.clock = func() time.Time { return now }
	a.store.AddTask(store.Task{Text: "写周报", Priority: "high", DueAt: now.Add(48 * time.Hour)})
	a.store.AddTask(store.Task{Text: "买菜"})
	a.switchPage(pageTasks)
	a.taskSub = 1
	a.reload()
	tt.Advance(time.Second)
	tt.Frame()
	if err := tt.Click("搜索与筛选任务"); err != nil {
		t.Fatalf("筛选开关不可点：%v", err)
	}
	tt.Frame()
	tt.Type("周报")
	tt.Frame()
	if !tt.HasText("写周报") || tt.HasText("买菜") || !tt.HasText("1 条") {
		t.Fatalf("关键词过滤 %v", tt.Texts())
	}
	tt.Key(0, ui.KeyEscape) // 清空关键词
	tt.Frame()
	_ = tt.Click("高优先级")
	tt.Frame()
	if !tt.HasText("写周报") || tt.HasText("买菜") {
		t.Fatalf("chip 过滤 %v", tt.Texts())
	}
	_ = tt.Click("关闭搜索与筛选")
	tt.Frame()
	if a.taskFilterOn || a.taskFilter.active() {
		t.Fatal("关闭即清空")
	}
	if err := tt.Click("显示任务日历"); err != nil {
		t.Fatalf("日历开关不可点：%v", err)
	}
	tt.Frame()
	if !tt.HasText("2026 年 11 月") {
		t.Fatalf("月历 %v", tt.Texts())
	}
	if err := tt.Click("11月8日"); err != nil {
		t.Fatalf("日期格不可点：%v", err)
	}
	tt.Frame()
	if !tt.HasText("写周报") {
		t.Fatalf("当天任务 %v", tt.Texts())
	}
	_ = tt.Click("11月9日")
	tt.Frame()
	_ = tt.Click("为选中日期添加任务")
	tt.Type("交房租")
	tt.Key(0, ui.KeyEnter)
	tt.Frame()
	var got store.Task
	for _, x := range a.store.Tasks() {
		if x.Text == "交房租" {
			got = x
		}
	}
	if got.DueAt != time.Date(2026, 11, 9, 9, 0, 0, 0, time.Local) {
		t.Fatalf("为该日添加 %+v", got)
	}
	if err := tt.Click("下个月"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if !tt.HasText("2026 年 12 月") {
		t.Fatal("翻月")
	}
}

// 卡片右键补齐：重命名（标题栏就地输入）、模糊、新标签、转为任务（可撤销）；键盘 ⌘1 快发、←→ 单选、p 常用、⌘A 全选。
func TestCardMenuAndKeys(t *testing.T) {
	a, tt := testApp(t, "第一条", "第二条")
	_ = tt.RightClick("第一条")
	if err := tt.ChooseMenuItem("重命名…"); err != nil {
		t.Fatalf("%v %v", err, tt.Menu())
	}
	tt.Frame()
	tt.Type("周报")
	tt.Key(0, ui.KeyEnter)
	tt.Frame()
	if !tt.HasText("周报") {
		t.Fatalf("标题 %v", tt.Texts())
	}
	_ = tt.RightClick("第二条")
	_ = tt.ChooseMenuItem("模糊内容")
	tt.Frame()
	if tt.HasText("第二条") {
		t.Fatal("模糊后卡面不应露出原文")
	}
	_ = tt.RightClick("周报")
	_ = tt.ChooseMenuItem("标签", "新标签…")
	tt.Frame()
	tt.Type("工作")
	tt.Key(0, ui.KeyEnter)
	n0 := a.store.Section(store.SectionInbox)[0]
	if n0.Title != "周报" || len(n0.Tags) != 1 || n0.Tags[0] != "工作" {
		t.Fatalf("%+v", n0)
	}
	_ = tt.RightClick("周报")
	if err := tt.ChooseMenuItem("转为任务"); err != nil {
		t.Fatalf("%v %v", err, tt.Menu())
	}
	if len(a.store.Notes()) != 1 || len(a.store.Tasks()) != 1 || a.store.Tasks()[0].Text != "第一条" {
		t.Fatalf("转为任务 %d %+v", len(a.store.Notes()), a.store.Tasks())
	}
	tt.Key(ui.Cmd, ui.KeyZ)
	if len(a.store.Notes()) != 2 || len(a.store.Tasks()) != 0 {
		t.Fatal("撤销转为任务")
	}
	tt.Frame()
	tt.Key(0, ui.KeyRight)
	if a.chosen.Len() != 1 {
		t.Fatal("→ 单选")
	}
	tt.Key(0, ui.KeyP)
	if n, _ := a.store.Note(a.notes[a.selected].ID); !n.Kept {
		t.Fatal("p 设为常用")
	}
	tt.Key(ui.Cmd, ui.KeyA)
	if a.chosen.Len() != 2 {
		t.Fatal("⌘A 全选")
	}
	sys := &recSys{}
	a.sys = sys
	a.target = macos.FrontApp{PID: 42, Name: "Cursor"}
	tt.Key(ui.Cmd, ui.Key1)
	if len(sys.sent()) == 0 {
		t.Fatal("⌘1 快发第一张")
	}
}

// 面板尺寸：记住的宽夹在 320–720，高度 0 = 铺满；跟随应用可停在左侧。
func TestPanelSizeAndDockSide(t *testing.T) {
	if w, h := panelSize(store.Settings{PanelWidth: 1000}); w != panelMaxW || h != 0 {
		t.Fatal(w, h)
	}
	if w, _ := panelSize(store.Settings{PanelWidth: 200}); w != panelMinW {
		t.Fatal(w)
	}
	wa := mygo.Rectangle{X: 0, Y: 25, Width: 1440, Height: 875}
	r := dockBeside(macos.Rect{X: 500, Y: 60, W: 800, H: 700}, wa, 400, true)
	if r.X != 500-400-6 || r.Width != 400 {
		t.Fatalf("左侧停靠 %+v", r)
	}
	r = dockBeside(macos.Rect{X: 20, Y: 60, W: 800, H: 700}, wa, 400, true)
	if r.X != 26 {
		t.Fatalf("左边放不下贴内侧 %+v", r)
	}
}
