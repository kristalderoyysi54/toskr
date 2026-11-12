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

// 详情窗编辑中：在面板里双击剪贴卡 / 点卡片发送钮 = 追加进编辑草稿（含图片），不外发；笔记卡照常外发。
func TestListSendsIntoEditingDetail(t *testing.T) {
	orig := detailVisible
	t.Cleanup(func() { detailVisible = orig })
	detailVisible = func(*app) bool { return true }
	a, _ := testApp(t)
	sys := &recSys{}
	a.sys = sys
	target, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: "目标正文"})
	clip, _, _ := a.store.Add(store.Note{Section: store.SectionClipboard, Text: "剪贴内容"})
	a.detail = detailState{id: target.ID, pickAnchor: -1, pickEnd: -1, editSel: [2]int{-1, -1}}
	a.enterDetailEdit(target)
	a.cardDoubleClick(clip, 0, true)
	if a.detailText != "目标正文\n\n剪贴内容" || len(sys.sent()) != 0 {
		t.Fatalf("双击剪贴卡应进草稿不外发 %q sent=%v", a.detailText, sys.sent())
	}
	if got, _ := a.store.Note(target.ID); got.Text != "目标正文" {
		t.Fatal("编辑中只改草稿，保存时才落库")
	}
	img := imageNote(t, a)
	_ = a.store.MoveToAt(img.ID, store.SectionClipboard, 0)
	img, _ = a.store.Note(img.ID)
	a.sendFromList([]store.Note{img})
	if len(a.detail.blocks) == 0 && len(sys.sent()) != 0 {
		t.Fatalf("剪贴图片也应进卡片 sent=%v", sys.sent())
	}
	if a.insertsIntoOpenCard([]store.Note{target}) {
		t.Fatal("笔记卡不进打开的卡片（照常外发）")
	}
}

// 详情编辑中从面板添加：插在光标处；有选区则替换选区；光标未知追加到末尾。图文卡插进当前文字块，图片紧跟其后。
func TestInsertAtDetailCursor(t *testing.T) {
	orig := detailVisible
	t.Cleanup(func() { detailVisible = orig })
	detailVisible = func(*app) bool { return true }
	a, _ := testApp(t)
	a.sys = &recSys{}
	target, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: "第一段\n第二段"})
	clip, _, _ := a.store.Add(store.Note{Section: store.SectionClipboard, Text: "X"})
	a.detail = detailState{id: target.ID, pickAnchor: -1, pickEnd: -1, editSel: [2]int{-1, -1}}
	a.enterDetailEdit(target)
	a.detail.editSel, a.detail.editRange = [2]int{-1, -1}, [2]int{3, 3} // 光标在「第一段」之后
	a.sendFromList([]store.Note{clip})
	if a.detailText != "第一段X\n第二段" || a.detail.editSel != [2]int{4, 4} {
		t.Fatalf("应插在光标处、光标落在后面 %q %v", a.detailText, a.detail.editSel)
	}
	a.detail.editSel, a.detail.editRange = [2]int{-1, -1}, [2]int{5, 8} // 选中「第二段」（反向选也一样）
	a.sendFromList([]store.Note{clip})
	if a.detailText != "第一段X\nX" {
		t.Fatalf("有选区应替换 %q", a.detailText)
	}
	// 图文卡：插进当前文字块光标处，图片紧跟该块
	img := imageNote(t, a)
	_ = a.store.MoveToAt(img.ID, store.SectionClipboard, 0)
	img, _ = a.store.Note(img.ID)
	a.detail.blocks = []store.ContentBlock{{Type: "text", Text: "前后"}, {Type: "image", File: "a.png"}}
	a.detail.blkActive, a.detail.blkRange = 1, [2]int{1, 1}
	a.sendFromList([]store.Note{clip})
	if a.detail.blocks[0].Text != "前X后" || a.detail.blkSet != [3]int{1, 2, 2} {
		t.Fatalf("图文卡插在块内光标处 %+v %v", a.detail.blocks, a.detail.blkSet)
	}
	a.insertIntoDraft(target.ID, "", []store.ContentBlock{{Type: "image", File: img.ImageFile}})
	if len(a.detail.blocks) != 3 || a.detail.blocks[1].File != img.ImageFile {
		t.Fatalf("图片紧跟当前文字块 %+v", a.detail.blocks)
	}
}

// 拖进详情编辑器：落点按指针算到字；落在选区内替换选区，否则插在落点。
func TestDropIntoDetailDraft(t *testing.T) {
	a, _ := testApp(t)
	registerFonts()
	if i, _ := a.detailDropIndex("abc中文", 400, 999, 5); i != 5 {
		t.Fatalf("行尾右侧 → 末尾 %d", i)
	}
	if i, _ := a.detailDropIndex("abc中文", 400, 0, 5); i != 0 {
		t.Fatalf("行首 → 0 %d", i)
	}
	if i, _ := a.detailDropIndex("第一行\n第二行", 400, 0, 30); i != 4 {
		t.Fatalf("第二行行首 → 4 %d", i)
	}
	target, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: "甲乙丙"})
	src, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: "Z"})
	a.detail = detailState{id: target.ID, pickAnchor: -1, pickEnd: -1, editSel: [2]int{-1, -1}}
	a.enterDetailEdit(target)
	a.detail.editRange = [2]int{0, 0}
	a.dropIntoDraft(target, []store.Note{src}, 1, [2]int{0, 0}, -1)
	if a.detailText != "甲Z乙丙" {
		t.Fatalf("插在落点 %q", a.detailText)
	}
	a.detail.editSel, a.detail.editRange = [2]int{-1, -1}, [2]int{2, 4} // 选中「乙丙」，落在选区里
	a.dropIntoDraft(target, []store.Note{src}, 3, [2]int{2, 4}, -1)
	if a.detailText != "甲ZZ" {
		t.Fatalf("落在选区内替换 %q", a.detailText)
	}
	a.dropIntoDraft(target, []store.Note{target}, 0, [2]int{-1, -1}, -1)
	if a.detailText != "甲ZZ" {
		t.Fatal("拖自身不改")
	}
}

// 插入可撤销：气泡撤销退回插入前的草稿与选区；替换选区同理。
func TestInsertUndo(t *testing.T) {
	orig := detailVisible
	t.Cleanup(func() { detailVisible = orig })
	detailVisible = func(*app) bool { return true }
	a, _ := testApp(t)
	a.sys = &recSys{}
	target, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: "甲乙丙"})
	clip, _, _ := a.store.Add(store.Note{Section: store.SectionClipboard, Text: "Z"})
	a.detail = detailState{id: target.ID, pickAnchor: -1, pickEnd: -1, editSel: [2]int{-1, -1}}
	a.enterDetailEdit(target)
	a.detail.editSel, a.detail.editRange = [2]int{-1, -1}, [2]int{1, 2}
	a.sendFromList([]store.Note{clip})
	if a.detailText != "甲Z丙" || a.hudText != tr("已替换选中内容") || a.hudUndo == nil {
		t.Fatalf("替换并给撤销 %q %q", a.detailText, a.hudText)
	}
	a.hudUndo()
	if a.detailText != "甲乙丙" || a.detail.editSel != [2]int{1, 2} {
		t.Fatalf("撤销应退回草稿与选区 %q %v", a.detailText, a.detail.editSel)
	}
}

// 拖出预览：首条摘要 + 多张计数，按组缓存。
func TestCardDragPreview(t *testing.T) {
	registerFonts()
	o := cardDragOptions([]store.Note{{ID: "a", Text: "第一条\n第二行"}, {ID: "b", Text: "x"}}, false)
	img := o.Preview
	if img == nil || img.Bounds().Dx() != dragPreviewW || img.Bounds().Dy() != dragPreviewH {
		t.Fatalf("预览尺寸 %v", img)
	}
	if o2 := cardDragOptions([]store.Note{{ID: "a", Text: "第一条\n第二行"}, {ID: "b", Text: "x"}}, false); o2.Preview != img {
		t.Fatal("同一组应复用缓存")
	}
	if cardDragText([]store.Note{{Text: "一"}, {Text: "二"}}) != "1. 一\n2. 二" {
		t.Fatalf("多张拖出为编号列表 %q", cardDragText([]store.Note{{Text: "一"}, {Text: "二"}}))
	}
}
