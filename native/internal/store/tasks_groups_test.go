package store

import (
	"bytes"
	"testing"
)

func TestTaskSectionMoveDeleteUndo(t *testing.T) {
	s, err := OpenDir(t.TempDir(), bytes.Repeat([]byte{3}, 32))
	if err != nil {
		t.Fatal(err)
	}
	a := s.AddTaskSection("工作")
	b := s.AddTaskSection("生活")
	task := s.AddTask(Task{Text: "写周报", Section: a})
	if err := s.MoveTaskSection(b, -1); err != nil {
		t.Fatal(err)
	}
	if secs := s.TaskSections(); secs[len(secs)-2].ID != b {
		t.Fatalf("上移 %+v", secs)
	}
	if _, ok := s.DeleteTaskSection(TaskInbox); ok {
		t.Fatal("收集箱不可删")
	}
	undo, ok := s.DeleteTaskSection(a)
	if !ok || len(s.TaskSections()) != 2 {
		t.Fatal("删除分组")
	}
	if got := s.Tasks()[0]; got.ID != task.ID || got.Section != TaskInbox {
		t.Fatalf("任务应移回收集箱 %+v", got)
	}
	undo()
	if got := s.Tasks()[0]; got.Section != a || len(s.TaskSections()) != 3 {
		t.Fatalf("撤销 %+v", got)
	}
}
