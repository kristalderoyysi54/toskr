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
	"github.com/toskr/native/internal/store"
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

// 剪贴历史按时间新→旧；重复复制刷新时间与来源（同 Tauri），不会出现「昨天」排在「今天」上面。
func TestClipOrderAndDuplicateBump(t *testing.T) {
	a, _ := testApp(t)
	now := time.Date(2026, 11, 6, 13, 0, 0, 0, time.Local)
	a.clock = func() time.Time { return now }
	old, _, _ := a.store.Add(store.Note{Section: store.SectionClipboard, Text: "旧的", CreatedAt: now.Add(-20 * time.Hour)})
	_, _, _ = a.store.Add(store.Note{Section: store.SectionClipboard, Text: "新的", CreatedAt: now.Add(-time.Minute)})
	_ = a.store.MoveToAt(old.ID, store.SectionClipboard, 0) // 模拟导入打乱的顺序：旧的排在最前
	got := arrangeClips(a.store.Section(store.SectionClipboard), "time")
	if got[0].Text != "新的" {
		t.Fatalf("应按时间新→旧 %v", got[0].Text)
	}
	if _, err := a.addClip(core.ClipEvent{Text: "旧的", Source: macos.FrontApp{Name: "Safari", BundleID: "com.apple.Safari"}}); err != nil {
		t.Fatal(err)
	}
	n, _ := a.store.Note(old.ID)
	if !n.CreatedAt.Equal(now) || n.SourceApp != "Safari" || n.BundleID != "com.apple.Safari" {
		t.Fatalf("重复复制应刷新时间与来源 %+v", n)
	}
	if got := arrangeClips(a.store.Section(store.SectionClipboard), "time"); got[0].ID != old.ID {
		t.Fatal("刷新后排到最前")
	}
}

// 剪贴「图片」视图：方格墙（同 Tauri images 视图），瓷砖底行来源 + 尺寸。
func TestClipImageGrid(t *testing.T) {
	a, tt := testApp(t)
	for i := 0; i < 5; i++ {
		var b bytes.Buffer
		_ = png.Encode(&b, image.NewRGBA(image.Rect(0, 0, 40+i, 20)))
		if _, err := a.addClip(core.ClipEvent{PNG: b.Bytes(), W: 40 + i, H: 20, Source: macos.FrontApp{Name: "Safari"}}); err != nil {
			t.Fatal(err)
		}
	}
	a.switchPage(pageClip)
	a.clipView = "image"
	a.reload()
	tt.Frame()
	tt.Frame()
	if !tt.HasText("44 × 20") {
		t.Fatalf("瓷砖底行显示尺寸 %v", tt.Texts())
	}
	r0, _ := tt.Find("40 × 20")
	r1, _ := tt.Find("41 × 20")
	if r0.Y != r1.Y {
		t.Fatalf("同一行并排 %v %v", r0, r1)
	}
}
