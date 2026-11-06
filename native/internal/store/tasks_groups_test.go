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

func TestMoveNoteBeforeAndMoveTask(t *testing.T) {
	s, _ := OpenDir(t.TempDir(), bytes.Repeat([]byte{4}, 32))
	other := s.AddSection("其他")
	c, _, _ := s.Add(Note{Section: SectionInbox, Text: "C"})
	b, _, _ := s.Add(Note{Section: SectionInbox, Text: "B"})
	a, _, _ := s.Add(Note{Section: SectionInbox, Text: "A"})
	x, _, _ := s.Add(Note{Section: other, Text: "X"})
	texts := func(sec string) (out []string) {
		for _, n := range s.Section(sec) {
			out = append(out, n.Text)
		}
		return
	}
	_ = s.MoveNoteBefore(c.ID, a.ID) // A B C → C A B
	if got := texts(SectionInbox); len(got) != 3 || got[0] != "C" || got[1] != "A" || got[2] != "B" {
		t.Fatalf("组内上移 %v", got)
	}
	_ = s.MoveNoteBefore(c.ID, b.ID) // C A B → A C B
	if got := texts(SectionInbox); got[0] != "A" || got[1] != "C" || got[2] != "B" {
		t.Fatalf("组内下移 %v", got)
	}
	_ = s.MoveNoteBefore(x.ID, b.ID) // 跨组：X 进收件箱，在 B 前
	if got := texts(SectionInbox); len(got) != 4 || got[2] != "X" || len(texts(other)) != 0 {
		t.Fatalf("跨组 %v", got)
	}
	work := s.AddTaskSection("工作")
	t1 := s.AddTask(Task{Text: "1"})
	t2 := s.AddTask(Task{Text: "2"})
	_ = s.MoveTask(t2.ID, "", t1.ID)
	if ts := s.Tasks(); ts[0].ID != t2.ID {
		t.Fatalf("任务前移 %+v", ts)
	}
	_ = s.MoveTask(t2.ID, work, "")
	if ts := s.Tasks(); ts[len(ts)-1].ID != t2.ID || ts[len(ts)-1].Section != work {
		t.Fatalf("移到分组末尾 %+v", ts)
	}
}
