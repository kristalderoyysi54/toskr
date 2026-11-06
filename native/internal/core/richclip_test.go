package core

import (
	"errors"
	"strings"
	"testing"

	"github.com/toskr/native/internal/store"
)

func TestBuildRichClipboard(t *testing.T) {
	png := append([]byte("\x89PNG\r\n\x1a\n"), 1, 2, 3)
	read := func(f string) ([]byte, error) {
		if f == "a.png" {
			return png, nil
		}
		return []byte("GIF89a"), nil
	}
	bs := []store.ContentBlock{{Type: "text", Text: "前 <b>"}, {Type: "image", File: "a.png"}, {Type: "text", Text: "\n后"}}
	plain, doc, n, err := BuildRichClipboard(bs, read)
	if err != nil || n != 1 {
		t.Fatal(err, n)
	}
	if plain != "前 <b>\n图片\n后" {
		t.Fatalf("%q", plain)
	}
	for _, want := range []string{`data-toskr-rich-clipboard="1"`, "前 &lt;b&gt;</span><br><img src=\"data:image/png;base64,iVBORw0KGgoBAgM=\" alt=\"图片\">", "\n后</span>"} {
		if !strings.Contains(doc, want) {
			t.Fatalf("缺 %q：%s", want, doc)
		}
	}
	if _, _, _, err := BuildRichClipboard([]store.ContentBlock{{Type: "image", File: "b.gif"}}, read); !errors.Is(err, ErrRichNotPNG) {
		t.Fatal(err)
	}
	if _, _, _, err := BuildRichClipboard([]store.ContentBlock{{Type: "text"}}, read); !errors.Is(err, ErrRichEmpty) {
		t.Fatal(err)
	}
}
