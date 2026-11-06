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
