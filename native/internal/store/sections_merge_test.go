package store

import "testing"

func TestMergeClipsAsNewKeepsOriginals(t *testing.T) {
	s, _ := OpenDir(t.TempDir(), nil)
	a, _, _ := s.Add(Note{Section: SectionClipboard, Text: "先复制"})
	b, _, _ := s.Add(Note{Section: SectionClipboard, Text: "后复制"})
	// 列表新卡在上：ids 按列表顺序（b 在 a 上面）
	combo, ok := s.MergeClipsAsNew([]string{b.ID, a.ID}, "\n\n")
	if !ok || combo.Text != "先复制\n\n后复制" {
		t.Fatalf("应按捕获先后拼接 %q", combo.Text)
	}
	ns := s.Notes()
	if len(ns) != 3 || ns[0].ID != combo.ID {
		t.Fatalf("组合卡置顶、原卡保留 %+v", ns)
	}
	n, _, _ := s.Add(Note{Section: SectionInbox, Text: "笔记"})
	if !MergeDomainsMixed([]Note{a, n}) || MergeDomainsMixed([]Note{a, b}) {
		t.Fatal("混选判定")
	}
	if _, ok := s.MergeClipsAsNew([]string{a.ID, n.ID}, "\n\n"); ok {
		t.Fatal("混选不应合并")
	}
}
