package store

import (
	"slices"
	"testing"
)

func sectionIDs(s *Store) []string {
	var out []string
	for _, x := range s.Sections() {
		out = append(out, x.ID)
	}
	return out
}

// 拖动分组标题重排（同 Tauri reorderSections）：移到目标位置，其余相对顺序不变。
func TestReorderSection(t *testing.T) {
	s, _ := OpenDir(t.TempDir(), nil)
	a := s.AddSection("A")
	b := s.AddSection("B")
	before := sectionIDs(s)
	if err := s.ReorderSection(b, before[0]); err != nil {
		t.Fatal(err)
	}
	got := sectionIDs(s)
	if got[0] != b || len(got) != len(before) {
		t.Fatalf("B 应移到首位 %v", got)
	}
	if i, j := slices.Index(got, a), slices.Index(got, before[0]); i < j {
		t.Fatalf("其余顺序应保持 %v", got)
	}
	_ = s.ReorderSection(b, "不存在")
	if !slices.Equal(sectionIDs(s), got) {
		t.Fatal("目标不存在时不动")
	}
}

// 上移 / 下移跳过笔记页看不见的剪贴板分组（同 Tauri moveSection）。
func TestMoveSectionSkipsClipboard(t *testing.T) {
	s, _ := OpenDir(t.TempDir(), nil)
	a := s.AddSection("A")
	_ = s.ReorderSection(SectionClipboard, a) // […, 剪贴板, A]
	ids := sectionIDs(s)
	ci := slices.Index(ids, SectionClipboard)
	if ci < 1 || ids[ci+1] != a {
		t.Fatalf("准备失败 %v", ids)
	}
	_ = s.MoveSection(a, -1)
	after := sectionIDs(s)
	if after[ci] != SectionClipboard || after[ci-1] != a || after[ci+1] != ids[ci-1] {
		t.Fatalf("应跨过剪贴板分组与上一个可见分组交换 %v → %v", ids, after)
	}
}
