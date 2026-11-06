package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// 混排卡：阅读态按块顺序出图，编辑态逐块改字、移除图片，保存后正文同步为投影文字。
func TestDetailMixedBlocksReadEdit(t *testing.T) {
	a, _ := testApp(t)
	f1, _ := a.store.SaveImage(whitePNG(t, 60, 30))
	f2, _ := a.store.SaveImage(whitePNG(t, 61, 30))
	bs := []store.ContentBlock{{Type: "text", Text: "开头"}, {Type: "image", File: f1}, {Type: "text", Text: "中段"}, {Type: "image", File: f2}}
	n, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: store.TextFromBlocks(bs), Blocks: bs})
	if n.Text != "开头\n中段" {
		t.Fatalf("%q", n.Text)
	}
	a.detail = detailState{id: n.ID, pickAnchor: -1, pickEnd: -1, editSel: [2]int{-1, -1}}
	tt := ui.NewTester(a.detailView, 600, 700)
	tt.Frame()
	if !tt.HasText("开头") || !tt.HasText("中段") {
		t.Fatal(tt.Texts())
	}
	a.enterDetailEdit(n)
	tt.Frame()
	if len(a.detail.blocks) != 4 {
		t.Fatal(a.detail.blocks)
	}
	a.detail.blocks[2].Text = "改过的中段"
	a.detail.blocks = append(a.detail.blocks[:3:3], a.detail.blocks[4:]...) // 移除第二张图
	a.saveDetail()
	got, _ := a.store.Note(n.ID)
	if got.Text != "开头\n改过的中段" || len(got.Blocks) != 3 || len(got.MediaFiles()) != 1 {
		t.Fatalf("%q %+v", got.Text, got.Blocks)
	}
}

// 纯文本卡：拖入图片追加为主图 / 附件，可撤销；非图片提示；⌘V 粘贴位图追加。
func TestDetailDropAndPasteImages(t *testing.T) {
	a, tt0 := testApp(t, "只有文字")
	_ = tt0
	sys := &clipSys{}
	a.sys = sys
	n := a.store.Notes()[0]
	a.detail = detailState{id: n.ID, pickAnchor: -1, pickEnd: -1, editSel: [2]int{-1, -1}}
	tt := ui.NewTester(a.detailView, 600, 700)
	tt.Frame()
	dir := t.TempDir()
	p, txt := filepath.Join(dir, "x.png"), filepath.Join(dir, "x.txt")
	_ = os.WriteFile(p, whitePNG(t, 33, 22), 0o600)
	_ = os.WriteFile(txt, []byte("t"), 0o600)
	if !tt.DropFiles(300, 300, txt) {
		t.Fatal("详情窗应接收拖入")
	}
	tt.Frame()
	if got, _ := a.store.Note(n.ID); len(got.MediaFiles()) != 0 {
		t.Fatal("非图片不应入卡")
	}
	tt.DropFiles(300, 300, p)
	tt.Frame()
	got, _ := a.store.Note(n.ID)
	if got.ImageFile == "" || got.ImageW != 33 || got.Text != "只有文字" {
		t.Fatalf("%+v", got)
	}
	sys.items = []macos.Item{{macos.TypePNG: whitePNG(t, 44, 22)}}
	tt.Key(ui.Cmd, ui.KeyV)
	tt.Frame()
	got, _ = a.store.Note(n.ID)
	if len(got.Attachments) != 1 {
		t.Fatalf("⌘V 应追加附件 %+v", got)
	}
	// 再粘一次同一张：重复
	if _, added, _ := a.store.AddImages(n.ID, []store.ContentBlock{{File: got.Attachments[0]}}); added != 0 {
		t.Fatal("同图不应重复追加")
	}
	// 编辑态移除主图：附件顶上
	a.enterDetailEdit(got)
	tt.Frame()
	prev, ok := a.store.RemoveImage(n.ID, got.ImageFile)
	if cur, _ := a.store.Note(n.ID); !ok || cur.ImageFile != got.Attachments[0] || len(cur.Attachments) != 0 {
		t.Fatalf("%+v", cur)
	}
	a.store.RestoreContent(prev)
	if cur, _ := a.store.Note(n.ID); cur.ImageFile != got.ImageFile || len(cur.Attachments) != 1 {
		t.Fatalf("撤销 %+v", cur)
	}
}
