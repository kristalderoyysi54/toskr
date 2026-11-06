package main

import (
	"bytes"
	"image"
	"image/png"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

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

// 连续复制两次自动置顶（10 秒内）、可关闭；暂停收集 / 立即恢复写回并改托盘状态键。
func TestClipDoubleCopyKeepAndPause(t *testing.T) {
	a, _ := testApp(t)
	now := time.Date(2026, 11, 6, 10, 0, 0, 0, time.Local)
	a.clock = func() time.Time { return now }
	src := macos.FrontApp{Name: "Notes"}
	n, _ := a.addClip(core.ClipEvent{Text: "常用地址", Source: src})
	now = now.Add(5 * time.Second)
	again, _ := a.addClip(core.ClipEvent{Text: "常用地址", Source: src})
	if again.ID != n.ID || !again.Kept {
		t.Fatalf("10 秒内复制两次应固定 %+v", again)
	}
	other, _ := a.addClip(core.ClipEvent{Text: "另一段", Source: src})
	now = now.Add(11 * time.Second)
	if x, _ := a.addClip(core.ClipEvent{Text: "另一段", Source: src}); x.ID != other.ID || x.Kept {
		t.Fatal("超过 10 秒不固定")
	}
	st := a.store.Settings()
	st.ClipDoubleCopyOff = true
	_ = a.store.SetSettings(st)
	third, _ := a.addClip(core.ClipEvent{Text: "第三段", Source: src})
	if x, _ := a.addClip(core.ClipEvent{Text: "第三段", Source: src}); x.ID != third.ID || x.Kept {
		t.Fatal("关闭后不固定")
	}

	a.openSettingsState()
	a.setPage = 2 // 剪贴板
	cur := a.store.Settings()
	cur.ClipboardWatch = true
	_ = a.store.SetSettings(cur)
	set := ui.NewTester(a.settingsView, 1040, 720)
	set.Frame()
	before := a.trayKey()
	if err := set.Click("15 分"); err != nil {
		t.Fatalf("%v %v", err, set.Texts())
	}
	set.Frame()
	if got := a.store.Settings().ClipPauseUntil; !got.Equal(now.Add(15*time.Minute)) || !set.HasText("已暂停，10:15 恢复") || a.trayKey() == before {
		t.Fatalf("暂停 15 分钟 %v %v", got, set.Texts())
	}
	_ = set.Click("立即恢复")
	set.Frame()
	if !a.store.Settings().ClipPauseUntil.IsZero() {
		t.Fatal("立即恢复")
	}
}
