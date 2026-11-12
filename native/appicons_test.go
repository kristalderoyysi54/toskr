package main

import (
	"bytes"
	"image"
	"image/png"
	"testing"

	"github.com/toskr/native/internal/store"
)

func init() { // 视图测试不碰 NSWorkspace，且同步加载免得后台写缓存与渲染竞争
	appIconPNG = func(string) []byte { return nil }
	appIconAsync = func(f func()) { f() }
}

// 来源应用图标：按 bundle 取一次并缓存（缩到 80px）；空 bundle / 取不到不画；三种卡片形态渲染不出错。
func TestSourceAppIcon(t *testing.T) {
	calls := 0
	old := appIconPNG
	defer func() { appIconPNG = old }()
	appIconPNG = func(b string) []byte {
		calls++
		if b != "com.apple.Safari" {
			return nil
		}
		var buf bytes.Buffer
		_ = png.Encode(&buf, image.NewNRGBA(image.Rect(0, 0, 512, 512)))
		return buf.Bytes()
	}
	a, tt := testApp(t)
	_, _, _ = a.store.Add(store.Note{Section: store.SectionInbox, Text: "带图标", BundleID: "com.apple.Safari"})
	_, _, _ = a.store.Add(store.Note{Section: store.SectionClipboard, Text: "剪贴带图标", BundleID: "com.apple.Safari"})
	tt.Frame()
	if a.appIcons["com.apple.Safari"] == nil || a.appIcon("") != nil {
		t.Fatal("应取到并缓存 Safari 图标")
	}
	for _, density := range []string{"comfortable", "compact"} {
		st := a.store.Settings()
		st.CardDensity = density
		_ = a.store.SetSettings(st)
		for _, page := range []int{pageNotes, pageClip} {
			a.page = page
			a.reload()
			tt.Frame()
		}
	}
	a.appIcon("com.example.none")
	a.appIcon("com.example.none")
	if calls != 2 {
		t.Fatalf("每个 bundle 只取一次，实为 %d 次", calls)
	}
	if !tt.HasText("剪贴带图标") {
		t.Fatalf("%v", tt.Texts())
	}
}
