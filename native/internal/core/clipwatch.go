package core

import (
	"bytes"
	"image"
	"image/png"
	"regexp"
	"slices"
	"strings"
	"time"

	"golang.org/x/image/tiff"

	"github.com/toskr/native/internal/macos"
)

const ClipPoll = 500 * time.Millisecond

// ClipEvent 是一次外部复制。
type ClipEvent struct {
	Text   string
	Link   bool   // 整段是一个 http(s) 链接
	PNG    []byte // 复制的是图片（无文字时）
	W, H   int
	Source macos.FrontApp
}

// TypeTIFF：截图、预览、浏览器「拷贝图像」常只给 TIFF。
const TypeTIFF = "public.tiff"

const maxClipImage = 32 << 20

var singleURL = regexp.MustCompile(`^https?://[^\s]+$`)

// ClipWatcher 轮询 changeCount（NSPasteboard 没有变更通知），跳过本应用写入、
// 临时/密码类型与排除名单应用。
type ClipWatcher struct {
	Sys      System
	Excluded func() []string
	Enabled  func() bool
	last     int
}

var concealedTypes = []string{macos.TypeTransient, "org.nspasteboard.ConcealedType", "com.agilebits.onepassword"}

// Tick 检查一次；有新的外部复制返回事件。
func (w *ClipWatcher) Tick() (ClipEvent, bool) {
	n := w.Sys.ChangeCount()
	if n == w.last {
		return ClipEvent{}, false
	}
	first := w.last == 0
	w.last = n
	if first || isOwn(n) || (w.Enabled != nil && !w.Enabled()) {
		return ClipEvent{}, false
	}
	for _, t := range w.Sys.Types() {
		if slices.Contains(concealedTypes, t) {
			return ClipEvent{}, false
		}
	}
	front, _ := w.Sys.Frontmost()
	if w.Excluded != nil && slices.Contains(w.Excluded(), front.BundleID) {
		return ClipEvent{}, false
	}
	text, _ := w.Sys.ReadString()
	if text = normalize(text); text != "" {
		t := strings.TrimSpace(text)
		return ClipEvent{Text: text, Link: singleURL.MatchString(t), Source: front}, true
	}
	if ev, ok := clipImage(w.Sys.Snapshot()); ok {
		ev.Source = front
		return ev, true
	}
	return ClipEvent{}, false
}

// clipImage 取剪贴板第一项里的图片（PNG 优先，TIFF 转 PNG）。
func clipImage(items []macos.Item) (ClipEvent, bool) {
	if len(items) == 0 {
		return ClipEvent{}, false
	}
	raw, isPNG := items[0][macos.TypePNG], true
	if len(raw) == 0 {
		raw, isPNG = items[0][TypeTIFF], false
	}
	if len(raw) == 0 || len(raw) > maxClipImage {
		return ClipEvent{}, false
	}
	var img image.Image
	var err error
	if isPNG {
		img, err = png.Decode(bytes.NewReader(raw))
	} else {
		img, err = tiff.Decode(bytes.NewReader(raw))
	}
	if err != nil {
		return ClipEvent{}, false
	}
	if !isPNG {
		var buf bytes.Buffer
		if png.Encode(&buf, img) != nil {
			return ClipEvent{}, false
		}
		raw = buf.Bytes()
	}
	b := img.Bounds()
	return ClipEvent{PNG: raw, W: b.Dx(), H: b.Dy()}, true
}
