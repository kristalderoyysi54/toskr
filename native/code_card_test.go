package main

import (
	"testing"

	"github.com/toskr/native/internal/store"
)

// 代码卡：新增时识别语言，通栏显示语言名、卡面着色；编辑成普通文字后回到「文本」。
func TestCodeCardDetectAndTitle(t *testing.T) {
	a, tt := testApp(t)
	src := "package main\n\nfunc main() {\n\tfmt.Println(\"hi\")\n}"
	n, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: src})
	if n.CodeLang != "go" || cardTitle(n) != "go" {
		t.Fatalf("%q %q", n.CodeLang, cardTitle(n))
	}
	a.reload()
	tt.Frame()
	if !tt.HasText("go") {
		t.Fatalf("通栏应显示语言 %v", tt.Texts())
	}
	_ = a.store.Update(n.ID, "今天下午三点开会，记得带电脑。")
	got, _ := a.store.Note(n.ID)
	if got.CodeLang != "" || cardTitle(got) != "文本" {
		t.Fatalf("%q", got.CodeLang)
	}
	ts, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: "const add = (a, b) => {\n  return a + b;\n};"})
	if cardTitle(ts) != "js" {
		t.Fatal(cardTitle(ts))
	}
}
