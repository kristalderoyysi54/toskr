package main

import (
	"testing"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

func TestAddClipsToOpenCard(t *testing.T) {
	orig := detailVisible
	t.Cleanup(func() { detailVisible = orig })
	detailVisible = func(*app) bool { return true }
	a, tt := testApp(t)
	sys := &recSys{}
	a.sys = sys
	target, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: "目标正文"})
	c1, _, _ := a.store.Add(store.Note{Section: store.SectionClipboard, Text: "剪贴一"})
	c2, _, _ := a.store.Add(store.Note{Section: store.SectionClipboard, Text: "剪贴二"})
	img := imageNote(t, a)
	_ = a.store.MoveToAt(img.ID, store.SectionClipboard, 0)
	img, _ = a.store.Note(img.ID)
	a.detail = detailState{id: target.ID, pickAnchor: -1, pickEnd: -1, editSel: [2]int{-1, -1}}
	a.detailText = target.Text
	a.switchPage(pageClip)
	a.reload()
	a.chosen.Add(c1.ID)
	a.chosen.Add(c2.ID)
	a.chosen.Add(img.ID)
	tt.Frame()
	if !tt.HasText("添加到卡片") {
		t.Fatalf("按钮应如实显示目的地 %v", tt.Texts())
	}
	a.sendSelected()
	got, _ := a.store.Note(target.ID)
	if got.Text != "目标正文\n\n1. 剪贴二\n2. 剪贴一" {
		t.Fatalf("%q", got.Text)
	}
	if got.ImageFile != img.ImageFile || len(sys.sent()) != 0 {
		t.Fatalf("图片应追加、不外发 %+v %v", got, sys.sent())
	}
	if a.chosen.Len() != 0 {
		t.Fatal("添加后清空选择")
	}
	// 编辑中：进草稿
	a.enterDetailEdit(got)
	a.addToOpenCard([]store.Note{c1})
	if a.detailText != got.Text+"\n\n剪贴一" {
		t.Fatalf("%q", a.detailText)
	}
	// 只选了目标自身
	a.detail.edit = false
	a.chosen.Add(target.ID)
	a.addToOpenCard([]store.Note{target})
	tt.Frame()
	_ = ui.KeyEscape
}

func TestAppendPreviewContent(t *testing.T) {
	for _, c := range [][3]string{{"", "x", "x"}, {"a", "x", "a\n\nx"}, {"a\n", "x", "a\n\nx"}, {"a\n\n", "x", "a\n\nx"}, {"a", "  ", "a"}} {
		if got := appendPreviewContent(c[0], c[1]); got != c[2] {
			t.Errorf("%q+%q=%q want %q", c[0], c[1], got, c[2])
		}
	}
}
