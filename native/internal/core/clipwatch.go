package core

import (
	"slices"
	"time"

	"github.com/toskr/native/internal/macos"
)

const ClipPoll = 500 * time.Millisecond

// ClipEvent 是一次外部复制。
type ClipEvent struct {
	Text   string
	Source macos.FrontApp
}

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
	if text = normalize(text); text == "" {
		return ClipEvent{}, false
	}
	return ClipEvent{Text: text, Source: front}, true
}
