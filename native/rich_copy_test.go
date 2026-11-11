package main

import (
	"strings"
	"sync"
	"testing"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

type itemSys struct {
	recSys
	mu    sync.Mutex
	items [][]macos.Item
}

func (r *itemSys) Write(items []macos.Item, enter bool) int {
	r.mu.Lock()
	r.items = append(r.items, items)
	r.mu.Unlock()
	return r.recSys.Write(items, enter)
}

func TestCopyNoteMedia(t *testing.T) {
	a, _ := testApp(t)
	sys := &itemSys{}
	a.sys = sys
	img := imageNote(t, a)
	if !a.copyNoteMedia(img) {
		t.Fatal("单图卡应走图片复制")
	}
	if got := sys.items[0][0]; len(got[macos.TypePNG]) == 0 || got[macos.TypeHTML] != nil {
		t.Fatalf("单图写原生 PNG：%v", got)
	}
	mixed := store.Note{Text: "说明", Blocks: []store.ContentBlock{{Type: "text", Text: "说明"}, {Type: "image", File: img.ImageFile}}}
	if !a.copyNoteMedia(mixed) {
		t.Fatal("图文卡应走富复制")
	}
	got := sys.items[1][0]
	if string(got[macos.TypeString]) != "说明\n图片" || !strings.Contains(string(got[macos.TypeHTML]), "data:image/png;base64,") {
		t.Fatalf("%q", got[macos.TypeString])
	}
	if a.copyNoteMedia(store.Note{Text: "纯文字"}) {
		t.Fatal("纯文字卡交给原路径")
	}
}

// 图片卡写了文字备注：复制时图与文字一起（之前只复制图片）；图片说明作替代文字进纯文本。
func TestCopyImageCardWithCaption(t *testing.T) {
	a, _ := testApp(t)
	sys := &itemSys{}
	a.sys = sys
	fs := addColorImages(t, a, 1)
	n, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Kind: "image", Text: "登录页设计稿", ImageFile: fs[0]})
	_, _, _ = a.store.SetImageAlt(n.ID, fs[0], "首页截图")
	n, _ = a.store.Note(n.ID)
	if !a.copyNoteMedia(n) {
		t.Fatal("应走图文复制")
	}
	got := sys.items[0][0]
	if string(got[macos.TypeString]) != "首页截图\n登录页设计稿" || !strings.Contains(string(got[macos.TypeHTML]), "data:image/png;base64,") {
		t.Fatalf("文字与图应一起复制 %q", got[macos.TypeString])
	}
}

// 多选复制含图片：编号列表 + 每条的图跟在后面，一次进剪贴板。
func TestCopyChosenRich(t *testing.T) {
	a, _ := testApp(t)
	sys := &itemSys{}
	a.sys = sys
	fs := addColorImages(t, a, 1)
	a.store.Add(store.Note{Section: store.SectionInbox, Text: "第一条"})
	a.store.Add(store.Note{Section: store.SectionInbox, Text: "第二条带图", ImageFile: fs[0]})
	a.reload()
	for _, n := range a.notes {
		a.chosen.Add(n.ID)
	}
	a.copyChosenAsList()
	got := sys.items[len(sys.items)-1][0]
	plain := string(got[macos.TypeString])
	if !strings.Contains(plain, "1. ") || !strings.Contains(plain, "2. ") || !strings.Contains(string(got[macos.TypeHTML]), "data:image/png") {
		t.Fatalf("多选图文一起复制 %q", plain)
	}
	if !strings.Contains(a.hudText, "2 条图文") {
		t.Fatalf("HUD %q", a.hudText)
	}
}
