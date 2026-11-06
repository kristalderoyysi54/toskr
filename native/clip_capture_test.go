package main

import (
	"bytes"
	"image"
	"image/png"
	"testing"

	"github.com/toskr/native/internal/core"
	"github.com/toskr/native/internal/macos"
)

// 剪贴板收链接与图片：整段链接成 link 卡（剪贴页显示「链接」），图片存进媒体库成图片卡；同一张图再复制只算已存在。
func TestClipCaptureLinksAndImages(t *testing.T) {
	a, tt := testApp(t)
	src := macos.FrontApp{Name: "Arc", BundleID: "company.thebrowser.Browser"}
	l, err := a.addClip(core.ClipEvent{Text: "https://github.com/egoist/mygo\n", Link: true, Source: src})
	if err != nil || l.Kind != "link" || l.URL != "https://github.com/egoist/mygo" || noteLink(l) != l.URL {
		t.Fatalf("链接卡 %+v %v", l, err)
	}
	var buf bytes.Buffer
	_ = png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 3, 2)))
	img, err := a.addClip(core.ClipEvent{PNG: buf.Bytes(), W: 3, H: 2, Source: src})
	if err != nil || img.Kind != "image" || img.ImageFile == "" || img.Text != "图片 3×2" {
		t.Fatalf("图片卡 %+v %v", img, err)
	}
	if raw, err := a.store.LoadImage(img.ImageFile); err != nil || !bytes.Equal(raw, buf.Bytes()) {
		t.Fatal("图片应存进媒体库")
	}
	a.switchPage(pageClip)
	tt.Frame()
	for _, s := range []string{"链接", "3 × 2", "github.com/egoist/mygo"} {
		if !tt.HasText(s) {
			t.Fatalf("剪贴页缺 %q：%v", s, tt.Texts())
		}
	}
	before := len(a.store.Notes())
	_, _ = a.addClip(core.ClipEvent{PNG: buf.Bytes(), W: 3, H: 2, Source: src})
	if len(a.store.Notes()) != before {
		t.Fatal("同一张图重复复制不应新增")
	}
}
