package store

import (
	"slices"
	"strings"
	"time"
)

// Section 是笔记分组。inbox / clipboard 为系统分组（ID 稳定，不可删）。
type Section struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Color         string `json:"color,omitempty"`
	Collapsed     bool   `json:"collapsed,omitempty"`
	KeepAfterSend bool   `json:"keepAfterSend,omitempty"` // 发送后不标记完成（提示词库等）
}

const TaskInbox = "task-inbox"

func (s *Store) ensureDefaults() {
	s.mu.Lock()
	defer s.mu.Unlock()
	has := func(list []Section, id string) bool {
		return slices.ContainsFunc(list, func(x Section) bool { return x.ID == id })
	}
	if !has(s.sections, SectionInbox) {
		s.sections = slices.Insert(s.sections, 0, Section{ID: SectionInbox, Name: "收件箱"})
	}
	if !has(s.sections, SectionClipboard) {
		s.sections = append(s.sections, Section{ID: SectionClipboard, Name: "剪贴板"})
	}
	if !has(s.taskSections, TaskInbox) {
		s.taskSections = slices.Insert(s.taskSections, 0, Section{ID: TaskInbox, Name: "收集箱"})
	}
}

func IsSystemSection(id string) bool { return id == SectionInbox || id == SectionClipboard }

func (s *Store) Sections() []Section {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.sections)
}

// AddSection 新建分组（放在剪贴板之前），返回 ID。
func (s *Store) AddSection(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return ""
	}
	id := "sec-" + newID()
	_ = s.mutate(func() bool {
		at := slices.IndexFunc(s.sections, func(x Section) bool { return x.ID == SectionClipboard })
		if at < 0 {
			at = len(s.sections)
		}
		s.sections = slices.Insert(s.sections, at, Section{ID: id, Name: name})
		return true
	})
	return id
}

func (s *Store) UpdateSection(sec Section) error {
	return s.mutate(func() bool {
		i := slices.IndexFunc(s.sections, func(x Section) bool { return x.ID == sec.ID })
		if i < 0 || strings.TrimSpace(sec.Name) == "" {
			return false
		}
		s.sections[i] = sec
		return true
	})
}

// DeleteSection 删除自定义分组，组内笔记移回收件箱（不丢数据）。
func (s *Store) DeleteSection(id string) bool {
	if IsSystemSection(id) {
		return false
	}
	ok := false
	_ = s.mutate(func() bool {
		i := slices.IndexFunc(s.sections, func(x Section) bool { return x.ID == id })
		if i < 0 {
			return false
		}
		s.sections = slices.Delete(s.sections, i, i+1)
		for k := range s.notes {
			if s.notes[k].Section == id {
				s.notes[k].Section = SectionInbox
			}
		}
		ok = true
		return true
	})
	return ok
}

func (s *Store) MoveSection(id string, delta int) error {
	return s.mutate(func() bool {
		i := slices.IndexFunc(s.sections, func(x Section) bool { return x.ID == id })
		j := i + delta
		if i < 0 || j < 0 || j >= len(s.sections) {
			return false
		}
		s.sections[i], s.sections[j] = s.sections[j], s.sections[i]
		return true
	})
}

func (s *Store) section(id string) (Section, bool) {
	i := slices.IndexFunc(s.sections, func(x Section) bool { return x.ID == id })
	if i < 0 {
		return Section{}, false
	}
	return s.sections[i], true
}

// SetDone 切换完成态。
func (s *Store) SetDone(id string, done bool) error {
	return s.mutate(func() bool {
		i := s.index(id)
		if i < 0 || s.notes[i].Done == done {
			return false
		}
		s.notes[i].Done = done
		return true
	})
}

// ClearDone 清理分组内已完成项，返回被清掉的项（供撤销）。
func (s *Store) ClearDone(section string) []Note {
	var removed []Note
	_ = s.mutate(func() bool {
		s.notes = slices.DeleteFunc(s.notes, func(n Note) bool {
			if n.Section == section && n.Done {
				removed = append(removed, n)
				return true
			}
			return false
		})
		return len(removed) > 0
	})
	return removed
}

// RestoreMany 把撤销的若干项放回分组顶部（保持原相对顺序）。
func (s *Store) RestoreMany(notes []Note) error {
	return s.mutate(func() bool {
		var add []Note
		for _, n := range notes {
			if s.index(n.ID) < 0 {
				add = append(add, n)
			}
		}
		s.notes = slices.Concat(add, s.notes)
		return len(add) > 0
	})
}

// Merge 把 ids（按给定顺序）合并为一条，放在第一条的位置；返回被合并的原项（供撤销）。
func (s *Store) Merge(ids []string, sep string) (Note, []Note, bool) {
	var merged Note
	var originals []Note
	ok := false
	_ = s.mutate(func() bool {
		if len(ids) < 2 {
			return false
		}
		first := s.index(ids[0])
		if first < 0 {
			return false
		}
		var texts []string
		for _, id := range ids {
			if i := s.index(id); i >= 0 {
				originals = append(originals, s.notes[i])
				texts = append(texts, s.notes[i].Text)
			}
		}
		merged = originals[0]
		merged.ID, merged.Text, merged.HTML, merged.Done = newID(), strings.Join(texts, sep), "", false
		s.notes[first] = merged
		drop := map[string]bool{}
		for _, o := range originals[1:] {
			drop[o.ID] = true
		}
		s.notes = slices.DeleteFunc(s.notes, func(n Note) bool { return drop[n.ID] })
		ok = true
		return true
	})
	return merged, originals, ok
}

// MergeDomainsMixed：剪贴卡与笔记混选（同 Tauri mergeDomainsMixed，两种合并语义不能混用）。
func MergeDomainsMixed(notes []Note) bool {
	clips := 0
	for _, n := range notes {
		if n.Section == SectionClipboard {
			clips++
		}
	}
	return clips > 0 && clips < len(notes)
}

// MergeClipsAsNew：剪贴板域是历史记录，合并不消费原卡——按捕获先后（列表底→顶）拼成一张新组合卡置顶（同 Tauri mergeNotes 剪贴分支）。
func (s *Store) MergeClipsAsNew(ids []string, sep string) (Note, bool) {
	var combo Note
	ok := false
	_ = s.mutate(func() bool {
		pick := map[string]bool{}
		for _, id := range ids {
			pick[id] = true
		}
		var src []Note
		for _, n := range s.notes {
			if pick[n.ID] {
				if n.Section != SectionClipboard {
					return false
				}
				src = append(src, n)
			}
		}
		if len(src) < 2 {
			return false
		}
		slices.Reverse(src)
		var texts []string
		for _, n := range src {
			if n.Kind != "image" {
				texts = append(texts, n.Text)
			}
		}
		combo = Note{ID: newID(), Section: SectionClipboard, Text: strings.Join(texts, sep), CreatedAt: time.Now()}
		if len(texts) == 0 {
			return false // 纯图片合并原生版暂不支持组合图卡
		}
		s.notes = slices.Concat([]Note{combo}, s.notes)
		ok = true
		return true
	})
	return combo, ok
}

// Unmerge 撤销合并：删掉合并项并放回原项。
func (s *Store) Unmerge(merged Note, originals []Note) error {
	return s.mutate(func() bool {
		i := s.index(merged.ID)
		if i < 0 {
			return false
		}
		s.notes = slices.Concat(s.notes[:i], originals, s.notes[i+1:])
		return true
	})
}

// MoveToAt 把 id 移到 section 的第 pos 位（跨组拖拽；pos 超出则放到组尾）。
func (s *Store) MoveToAt(id, section string, pos int) error {
	return s.mutate(func() bool {
		i := s.index(id)
		if i < 0 {
			return false
		}
		n := s.notes[i]
		n.Section = section
		s.notes = slices.Delete(s.notes, i, i+1)
		var idx []int
		for k, o := range s.notes {
			if o.Section == section {
				idx = append(idx, k)
			}
		}
		at := 0
		switch {
		case pos >= 0 && pos < len(idx):
			at = idx[pos]
		case len(idx) > 0:
			at = idx[len(idx)-1] + 1
		}
		s.notes = slices.Insert(s.notes, at, n)
		return true
	})
}

// PruneClipboard 清理超过 days 天的未保留剪贴板项，返回清掉的数量。
func (s *Store) PruneClipboard(days int, perApp map[string]int, now func() int64) int {
	if days <= 0 && len(perApp) == 0 {
		return 0
	}
	removed := 0
	_ = s.mutate(func() bool {
		s.notes = slices.DeleteFunc(s.notes, func(n Note) bool {
			limit, ok := perApp[ClipSourceKey(n)] // 来源单独设定优先，其余跟随全局（全局永久时只清有单独设定的来源）
			if !ok {
				limit = days
			}
			if limit > 0 && n.Section == SectionClipboard && !n.Kept && n.CreatedAt.Unix() < now()-int64(limit)*86400 {
				removed++
				return true
			}
			return false
		})
		return removed > 0
	})
	return removed
}

// ClipSourceKey 同 Tauri clipSourceKey：bundle id 优先，其次应用名。
func ClipSourceKey(n Note) string {
	if n.BundleID != "" {
		return n.BundleID
	}
	return n.SourceApp
}

// SetCreatedAt 改写创建时间（数据导入与视觉对照测试用）。
func (s *Store) SetCreatedAt(id string, at time.Time) error {
	return s.mutate(func() bool {
		i := s.index(id)
		if i < 0 {
			return false
		}
		s.notes[i].CreatedAt = at
		return true
	})
}

// BumpClip：重复复制 = 再次使用（同 Tauri addClipNote duplicate）——刷新时间与来源，卡片已由 Add 提到最前。
func (s *Store) BumpClip(id string, at time.Time, app, bundle string) error {
	return s.mutate(func() bool {
		i := s.index(id)
		if i < 0 {
			return false
		}
		n := &s.notes[i]
		n.CreatedAt = at
		if app != "" {
			n.SourceApp, n.BundleID = app, bundle
		}
		return true
	})
}

// MoveNoteBefore 把笔记移到 beforeID 之前（可跨分组，归入目标所在分组）。
func (s *Store) MoveNoteBefore(id, beforeID string) error {
	if id == beforeID {
		return nil
	}
	s.mu.Lock()
	bi := s.index(beforeID)
	if bi < 0 {
		s.mu.Unlock()
		return nil
	}
	sec := s.notes[bi].Section
	pos := 0
	for _, o := range s.notes[:bi] {
		if o.Section == sec && o.ID != id {
			pos++
		}
	}
	s.mu.Unlock()
	return s.MoveToAt(id, sec, pos)
}

// MoveClipsToNotes 把剪贴卡移进笔记分组（同 Tauri moveClipsToNotes：剪贴「固定不清理」与笔记「常用」语义不同，
// 一并清掉 keep / done）。移到目标组顶部，按传入顺序。返回撤销函数：把这些卡按原样放回原位置。
func (s *Store) MoveClipsToNotes(ids []string, section string) (undo func(), moved int) {
	type orig struct {
		n   Note
		pos int
	}
	var before []orig
	_ = s.mutate(func() bool {
		var picked []Note
		for _, id := range ids {
			if i := s.index(id); i >= 0 && s.notes[i].Section == SectionClipboard {
				before = append(before, orig{s.notes[i], i})
				n := s.notes[i]
				n.Section, n.Kept, n.Done = section, false, false
				picked = append(picked, n)
			}
		}
		if len(picked) == 0 {
			return false
		}
		s.notes = slices.DeleteFunc(s.notes, func(n Note) bool {
			return slices.ContainsFunc(picked, func(p Note) bool { return p.ID == n.ID })
		})
		at := slices.IndexFunc(s.notes, func(n Note) bool { return n.Section == section })
		if at < 0 {
			at = len(s.notes)
		}
		s.notes = slices.Insert(s.notes, at, picked...)
		return true
	})
	slices.SortFunc(before, func(a, b orig) int { return a.pos - b.pos })
	return func() {
		_ = s.mutate(func() bool {
			s.notes = slices.DeleteFunc(s.notes, func(n Note) bool {
				return slices.ContainsFunc(before, func(o orig) bool { return o.n.ID == n.ID })
			})
			for _, o := range before {
				s.notes = slices.Insert(s.notes, min(o.pos, len(s.notes)), o.n)
			}
			return true
		})
	}, len(before)
}

// ClearSectionNotes 同 ClearSection，返回被清掉的卡（撤销时交给 RestoreMany 放回）。
func (s *Store) ClearSectionNotes(section string) []Note {
	var removed []Note
	_ = s.mutate(func() bool {
		s.notes = slices.DeleteFunc(s.notes, func(n Note) bool {
			if n.Section == section && !n.Kept {
				removed = append(removed, n)
				return true
			}
			return false
		})
		return len(removed) > 0
	})
	return removed
}
