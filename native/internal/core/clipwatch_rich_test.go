package core

import (
	"testing"

	"github.com/toskr/native/internal/macos"
)

// 监听带 <img> 的 HTML 一并交出（之前只读纯文本，图片只剩文件名）；无图 HTML 不带。
func TestClipWatcherPassesRichHTML(t *testing.T) {
	f := &fake{count: 1, front: macos.FrontApp{PID: 9, BundleID: "com.x"}}
	w := &ClipWatcher{Sys: f}
	w.Tick() // 首次只记基线
	f.count, f.items = 2, []macos.Item{{macos.TypeString: []byte("正文\nimage_1.png"), macos.TypeHTML: []byte(`<p>正文</p><img src="data:image/png;base64,AA">`)}}
	ev, ok := w.Tick()
	if !ok || ev.HTML == "" {
		t.Fatalf("应带上 HTML %+v", ev)
	}
	f.count, f.items = 3, []macos.Item{{macos.TypeString: []byte("纯字"), macos.TypeHTML: []byte(`<p>纯字</p>`)}}
	if ev, _ := w.Tick(); ev.HTML != "" {
		t.Fatal("无图 HTML 不走图文")
	}
}
