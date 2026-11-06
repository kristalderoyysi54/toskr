package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

type clipSys struct {
	recSys
	items []macos.Item
}

func (s *clipSys) Snapshot() []macos.Item { return s.items }

func TestPasteAndDropImagesIntoDraft(t *testing.T) {
	a, tt := testApp(t)
	sys := &clipSys{}
	a.sys = sys

	// 只有位图：收为草稿图，吞掉粘贴
	sys.items = []macos.Item{{macos.TypePNG: whitePNG(t, 30, 20)}}
	if !a.pasteIntoDraft("") || len(a.draftImgs) != 1 || a.draftImgs[0].w != 30 {
		t.Fatalf("%+v", a.draftImgs)
	}
	// 有文字：照常插入文字，不读位图
	if a.pasteIntoDraft("hello") || len(a.draftImgs) != 1 {
		t.Fatal("文字粘贴不应被图片截走")
	}
	// Finder 复制图片文件：走文件分支（即使带文件名文字），非图片跳过
	dir := t.TempDir()
	pngPath, txtPath := filepath.Join(dir, "b.png"), filepath.Join(dir, "a.txt")
	_ = os.WriteFile(pngPath, whitePNG(t, 40, 10), 0o600)
	_ = os.WriteFile(txtPath, []byte("x"), 0o600)
	sys.items = []macos.Item{{macos.TypeFileURL: []byte("file://" + txtPath)}, {macos.TypeFileURL: []byte("file://" + pngPath), macos.TypePNG: whitePNG(t, 8, 8)}}
	if !a.pasteIntoDraft("b.png") || len(a.draftImgs) != 2 || a.draftImgs[1].w != 40 {
		t.Fatalf("文件分支 %+v", a.draftImgs)
	}
	// 拖入同一张：去重
	a.addDraftImages(a.importImagePaths([]string{pngPath, txtPath}), "")
	if len(a.draftImgs) != 2 {
		t.Fatalf("去重 %+v", a.draftImgs)
	}
	tt.Frame()
	if _, ok := tt.Find("移除图片"); !ok {
		t.Fatalf("输入区应显示暂存图 %v", tt.Texts())
	}

	// 有文字 + 图：组合卡（主图 + 附件）
	a.draft = "看这两张图"
	a.addDraft()
	n := a.store.Notes()[0]
	if n.Kind != "" || n.ImageFile == "" || len(n.Attachments) != 1 || n.Text != "看这两张图" || a.draftImgs != nil {
		t.Fatalf("%+v", n)
	}
	tt.Frame() // 组合卡渲染缩略

	// 只有图：图片卡，两张不同图同尺寸不应被当成重复
	a.draftImgs = []pastedImage{{file: n.ImageFile, w: 30, h: 20}}
	a.addDraft()
	other, _ := a.savePNG(whitePNG(t, 30, 21))
	other.h = 20
	a.draftImgs = []pastedImage{other}
	a.addDraft()
	imgs := 0
	for _, x := range a.store.Notes() {
		if x.Kind == "image" {
			imgs++
		}
	}
	if imgs != 2 {
		t.Fatalf("同标题不同图应是两张卡：%d", imgs)
	}
	if got := draftNote(store.SectionInbox, "", []pastedImage{{file: "x", w: 1, h: 1}, {file: "y"}}); got.Text != "图片 2 张" || got.Kind != "image" {
		t.Fatalf("%+v", got)
	}
}

func TestDropImageOnComposer(t *testing.T) {
	a, tt := testApp(t)
	dir := t.TempDir()
	p := filepath.Join(dir, "c.png")
	_ = os.WriteFile(p, whitePNG(t, 12, 12), 0o600)
	tt.Frame()
	r, ok := tt.Find("转大窗编辑")
	if !ok {
		t.Fatal("找不到输入区")
	}
	if !tt.DropFiles(r.X-60, r.Y+r.H/2, p) {
		t.Fatal("输入区应接收拖入文件")
	}
	tt.Frame()
	if len(a.draftImgs) != 1 {
		t.Fatalf("%+v", a.draftImgs)
	}
}
