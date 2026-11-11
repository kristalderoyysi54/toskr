package store

import (
	"strings"
	"testing"
	"time"
)

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

// 同 Tauri mergeNotes：含图片的卡合并时图片一并带上，按列表底→顶（捕获先后）排列；撤销按原顺序放回。
func TestMergeNotesWithImages(t *testing.T) {
	s, _ := OpenDir(t.TempDir(), nil)
	img, _, _ := s.Add(Note{Section: SectionInbox, Kind: "image", Text: "图片 30×20", ImageFile: "a.png", ImageW: 30, ImageH: 20})
	txt, _, _ := s.Add(Note{Section: SectionInbox, Text: "说明文字", Tags: []string{"工作"}})
	combo, _, _ := s.Add(Note{Section: SectionInbox, Text: "附图", ImageFile: "b.png", Attachments: []string{"c.png"}, Tags: []string{"工作", "图"}})
	// 列表自上而下：combo、txt、img（ids 顺序故意打乱）
	m, orig, ok := s.Merge([]string{img.ID, combo.ID, txt.ID}, "\n\n")
	if !ok {
		t.Fatal("合并失败")
	}
	if got := m.MediaFiles(); len(got) != 3 || got[0] != "a.png" || got[1] != "b.png" || got[2] != "c.png" {
		t.Fatalf("图片应全部带上、按捕获先后 %v", got)
	}
	if m.Text != "说明文字\n\n附图" || m.Kind == "image" {
		t.Fatalf("图片占位文字剔除，文字空行分隔 %q kind=%q", m.Text, m.Kind)
	}
	var order []string
	for _, b := range m.Blocks {
		order = append(order, b.Type+":"+b.File+b.Text)
	}
	want := []string{"image:a.png", "text:说明文字", "text:\n\n", "text:附图", "image:b.png", "image:c.png"}
	if strings.Join(order, "|") != strings.Join(want, "|") {
		t.Fatalf("图文块顺序 %v", order)
	}
	if len(m.Tags) != 2 {
		t.Fatalf("标签合并去重 %v", m.Tags)
	}
	if ns := s.Notes(); len(ns) != 1 || ns[0].ID != m.ID {
		t.Fatalf("其余卡被消费 %+v", ns)
	}
	if err := s.Unmerge(m, orig); err != nil {
		t.Fatal(err)
	}
	ns := s.Notes()
	if len(ns) != 3 || ns[0].ID != combo.ID || ns[1].ID != txt.ID || ns[2].ID != img.ID {
		t.Fatalf("撤销应按原列表顺序放回 %v %v %v", ns[0].Text, ns[1].Text, ns[2].Text)
	}
}

// 纯图片：合成图片卡「图片 N 张」；剪贴页同样支持（原卡保留）。
func TestMergeImagesOnly(t *testing.T) {
	s, _ := OpenDir(t.TempDir(), nil)
	a, _, _ := s.Add(Note{Section: SectionClipboard, Kind: "image", Text: "图片 10×10", ImageFile: "a.png"})
	b, _, _ := s.Add(Note{Section: SectionClipboard, Kind: "image", Text: "截图 20×20", ImageFile: "b.png"})
	c, ok := s.MergeClipsAsNew([]string{b.ID, a.ID}, "\n\n")
	if !ok || c.Kind != "image" || c.Text != "图片 2 张" || c.ImageFile != "a.png" || len(c.Attachments) != 1 || c.Attachments[0] != "b.png" {
		t.Fatalf("纯图片组合卡 %+v", c)
	}
	if len(s.Notes()) != 3 {
		t.Fatal("剪贴合并保留原卡")
	}
}

// ReplaceMediaFile：主图 / 附件 / 图文块里那张原位替换，且不改动调用方持有的旧副本（撤销用）。
func TestReplaceMediaFileInPlace(t *testing.T) {
	s, _ := OpenDir(t.TempDir(), nil)
	atts := []string{"b.png", "c.png"}
	n, _, _ := s.Add(Note{Section: SectionInbox, Text: "x", ImageFile: "a.png", Attachments: atts,
		Blocks: []ContentBlock{{Type: "text", Text: "x"}, {Type: "image", File: "b.png"}}})
	before, _ := s.Note(n.ID)
	prev, err := s.ReplaceMediaFile(n.ID, "b.png", "z.png", 3, 4)
	got, _ := s.Note(n.ID)
	if err != nil || got.Attachments[0] != "z.png" || got.Blocks[1].File != "z.png" || got.Blocks[1].Width != 3 {
		t.Fatalf("%v %+v", err, got)
	}
	if atts[0] != "b.png" || before.Attachments[0] != "b.png" || prev.Attachments[0] != "b.png" {
		t.Fatal("不应原地改动旧副本")
	}
	if _, err := s.ReplaceMediaFile(n.ID, "nope.png", "y.png", 1, 1); err == nil {
		t.Fatal("没有这张图应报错")
	}
}

// 同 Tauri doneIdsAfterSend：常用卡与剪贴历史发送后不标完成。
func TestMarkSentKeepsKeptAndClips(t *testing.T) {
	s, _ := OpenDir(t.TempDir(), nil)
	kept, _, _ := s.Add(Note{Section: SectionInbox, Text: "常用"})
	_ = s.SetKept(kept.ID, true)
	clip, _, _ := s.Add(Note{Section: SectionClipboard, Text: "剪贴"})
	plain, _, _ := s.Add(Note{Section: SectionInbox, Text: "普通"})
	_ = s.MarkSent([]string{kept.ID, clip.ID, plain.ID}, time.Now())
	for id, want := range map[string]bool{kept.ID: false, clip.ID: false, plain.ID: true} {
		if n, _ := s.Note(id); n.Done != want || n.SentAt.IsZero() {
			t.Fatalf("%s done=%v want %v", n.Text, n.Done, want)
		}
	}
}
