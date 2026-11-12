package store

import (
	"slices"
	"strings"
	"time"
)

// SetTitle 改自定义标题（空 = 清除）；打 updatedAt（同 Tauri updateNoteTitle）。
func (s *Store) SetTitle(id, title string) error {
	title = strings.TrimSpace(title)
	return s.mutate(func() bool {
		i := s.index(id)
		if i < 0 || s.notes[i].Title == title {
			return false
		}
		s.notes[i].Title, s.notes[i].UpdatedAt = title, time.Now()
		return true
	})
}

// SetBlur 切换卡面模糊（组织类操作，不打 updatedAt）。
func (s *Store) SetBlur(id string, on bool) error {
	return s.mutate(func() bool {
		i := s.index(id)
		if i < 0 || s.notes[i].Blur == on {
			return false
		}
		s.notes[i].Blur = on
		return true
	})
}

// AllTags：全部笔记用过的标签（按首次出现顺序）。
func (s *Store) AllTags() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []string
	for _, n := range s.notes {
		for _, t := range n.Tags {
			if !slices.Contains(out, t) {
				out = append(out, t)
			}
		}
	}
	return out
}

// ConvertToTask 把笔记原子地换成任务（同 Tauri convertNoteToTask / Smart）：删笔记、任务插到最前。
// title 为空用正文；返回被删的笔记与位置供撤销。图片 / 图文卡不支持。
func (s *Store) ConvertToTask(id, title string, checklist []string) (Task, Note, int, bool) {
	var t Task
	var n Note
	pos := -1
	_ = s.mutate(func() bool {
		i := s.index(id)
		if i < 0 || len(s.notes[i].MediaFiles()) > 0 || s.notes[i].Kind == "image" {
			return false
		}
		n, pos = s.notes[i], i
		t = Task{ID: "task-" + newID(), Text: n.Text, Status: "todo", Priority: "none", CreatedAt: time.Now()}
		if strings.TrimSpace(title) != "" {
			t.Text = strings.TrimSpace(title)
			if t.Text != strings.TrimSpace(n.Text) {
				t.Note = n.Text
			}
		}
		for _, c := range checklist {
			if c = strings.TrimSpace(c); c != "" {
				t.Checklist = append(t.Checklist, ChecklistItem{ID: newID(), Text: c})
			}
		}
		s.notes = slices.Delete(s.notes, i, i+1)
		s.tasks = slices.Insert(s.tasks, 0, t)
		return true
	})
	return t, n, pos, pos >= 0
}

// UndoConvert 撤销转为任务：删任务、笔记放回原位。
func (s *Store) UndoConvert(t Task, n Note, pos int) error {
	return s.mutate(func() bool {
		s.tasks = slices.DeleteFunc(s.tasks, func(x Task) bool { return x.ID == t.ID })
		if s.index(n.ID) < 0 {
			s.notes = slices.Insert(s.notes, min(max(pos, 0), len(s.notes)), n)
		}
		return true
	})
}
