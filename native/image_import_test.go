package main

import (
	"os"
	"path/filepath"
	"strings"
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
	if _, ok := tt.Find("移除这张图片"); !ok {
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

// 同 Tauri DraftImageChip：暂存图点击是查看 / 编辑（不再是移除），✕ 才移除；标注 ✓ 替换这张暂存图。
func TestDraftImageChipOpenAndRemove(t *testing.T) {
	a, tt := testApp(t)
	sys := &clipSys{}
	a.sys = sys
	sys.items = []macos.Item{{macos.TypePNG: whitePNG(t, 30, 20)}}
	if !a.pasteIntoDraft("") {
		t.Fatal("应收为草稿图")
	}
	tt.Frame()
	if r, ok := tt.Find("查看或编辑这张草稿图片"); !ok || r.W == 0 {
		t.Fatalf("缺查看入口 %v", tt.Texts())
	}
	old := a.draftImgs[0].file
	a.replaceDraftImage(old, whitePNG(t, 50, 40), 50, 40)
	if len(a.draftImgs) != 1 || a.draftImgs[0].w != 50 || a.draftImgs[0].file == old {
		t.Fatalf("标注后应替换暂存图 %+v", a.draftImgs)
	}
	tt.Frame()
	mustClick(t, tt, "移除这张图片")
	if len(a.draftImgs) != 0 {
		t.Fatal("✕ 应移除")
	}
}

// 剪贴卡页脚右端按类型：链接 → 域名，代码 → 语言 · 行数，多行 → 行数，长单行 → 字符数，短单行不显示。
func TestClipFootMeta(t *testing.T) {
	long := strings.Repeat("长", clipLongRunes)
	for _, c := range []struct {
		n    store.Note
		want string
	}{
		{store.Note{Kind: "link", URL: "https://www.github.com/egoist/mygo", Text: "https://www.github.com/egoist/mygo"}, "github.com"},
		{store.Note{Kind: "link", Text: "不是网址"}, "链接"},
		{store.Note{Kind: "code", CodeLang: "sql", Text: "SELECT 1;\nSELECT 2;\n"}, "sql · 2 行"},
		{store.Note{Text: "a\nb\nc"}, "3 行"},
		{store.Note{Text: "brew install --cask toskr"}, ""},
		{store.Note{Text: long}, "200 字符"},
		{store.Note{Kind: "image", ImageFile: "a.png", ImageW: 640, ImageH: 280}, "640 × 280"},
	} {
		if got := clipFootMeta(c.n); got != c.want {
			t.Errorf("%+v → %q，应为 %q", c.n.Text, got, c.want)
		}
	}
}
