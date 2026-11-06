package main

import (
	"testing"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

func TestTaskKeyboard(t *testing.T) {
	a, tt := testApp(t)
	a.store.AddTask(store.Task{Text: "第二"})
	a.store.AddTask(store.Task{Text: "第一"})
	a.switchPage(pageTasks)
	a.taskSub = 1
	tt.Frame()
	tt.Key(0, ui.KeyDown)
	tt.Frame()
	first, _ := a.taskByID(a.taskFocus)
	if first.Text != "第一" {
		t.Fatalf("↓ 落到第一条：%q", first.Text)
	}
	tt.Key(0, ui.KeyDown)
	tt.Key(0, ui.KeySpace)
	tt.Frame()
	if got, _ := a.taskByID(a.taskFocus); got.Text != "第二" || got.Status != "done" {
		t.Fatalf("Space 切完成：%+v", got)
	}
	tt.Key(0, ui.KeyX)
	tt.Frame()
	if got, _ := a.taskByID(a.taskFocus); got.Status != "todo" {
		t.Fatal("x 再切回未完成")
	}
	tt.Key(0, ui.KeyEnter)
	tt.Frame()
	if a.taskOpen != a.taskFocus {
		t.Fatal("Enter 展开编辑")
	}
	a.taskOpen = ""
	tt.Frame()
	tt.Key(ui.Cmd, ui.KeyBackspace)
	tt.Frame()
	if len(a.store.Tasks()) != 1 || a.taskFocus != first.ID {
		t.Fatalf("⌘⌫ 删除并挪焦点：%d %s", len(a.store.Tasks()), a.taskFocus)
	}
	// 速记框有焦点时空格是输入
	a.taskIn.Focus()
	tt.Frame()
	tt.Type(" ")
	tt.Frame()
	if got, _ := a.taskByID(first.ID); got.Status != "todo" {
		t.Fatal("速记框里打空格不应切完成")
	}
}

// 分组右键「设为捕获目标」⇄「捕获改回存入收件箱」。
func TestSectionCaptureTargetMenu(t *testing.T) {
	a, tt := testApp(t)
	id := a.store.AddSection("工作")
	a.store.Add(store.Note{Section: id, Text: "工作笔记"})
	a.reload()
	tt.Frame()
	if err := tt.RightClick("工作"); err != nil {
		t.Fatalf("%v %v", err, tt.Texts())
	}
	if err := tt.ChooseMenuItem("设为捕获目标"); err != nil {
		t.Fatalf("%v %v", err, tt.Menu())
	}
	if a.store.Settings().CaptureSection != id {
		t.Fatal(a.store.Settings().CaptureSection)
	}
	tt.Frame()
	_ = tt.RightClick("工作")
	if err := tt.ChooseMenuItem("捕获改回存入收件箱"); err != nil {
		t.Fatalf("%v %v", err, tt.Menu())
	}
	if a.store.Settings().CaptureSection != "" {
		t.Fatal("应改回收件箱")
	}
}
