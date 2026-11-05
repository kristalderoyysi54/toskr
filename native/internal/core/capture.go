package core

import (
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/toskr/native/internal/macos"
)

// pbMu 串行化所有剪贴板事务（捕获 / 发送 / 监听跳过自写），对应 Rust 版 pasteboard::try_claim。
var pbMu sync.Mutex

// ownWrites 记录本应用写入后的 changeCount，剪贴板监听据此跳过自身写入。
var ownWrites = struct {
	sync.Mutex
	counts []int
}{}

func markOwn(n int) {
	ownWrites.Lock()
	ownWrites.counts = append(ownWrites.counts, n)
	if len(ownWrites.counts) > 32 {
		ownWrites.counts = ownWrites.counts[16:]
	}
	ownWrites.Unlock()
}

func isOwn(n int) bool {
	ownWrites.Lock()
	defer ownWrites.Unlock()
	return slices.Contains(ownWrites.counts, n)
}

type Captured struct {
	Text, HTML string
	Source     macos.FrontApp
	Warning    string // 剪贴板未能还原等，提示用户
}

const (
	copyWait     = 350 * time.Millisecond
	copyPoll     = 15 * time.Millisecond
	restoreDelay = 1500 * time.Millisecond
)

// Capture 读取前台应用的选中内容：先 AX 直读，再走「⌘C + 剪贴板快照还原」拿富文本；
// AX 报空不可信（部分终端从不填充），照样走剪贴板路径。没有选中内容返回 ok=false。
func Capture(sys System, front macos.FrontApp) (Captured, bool) {
	kind, axText := sys.SelectedText()
	axText = normalize(axText)
	out := Captured{Source: front}
	if !pbMu.TryLock() {
		if kind == macos.SelText && axText != "" {
			out.Text = axText
			return out, true
		}
		return out, false
	}
	defer pbMu.Unlock()
	original := sys.Snapshot()
	before := sys.ChangeCount()
	sys.PostKey(macos.KeyC, macos.FlagCommand)
	changed := false
	for waited := time.Duration(0); waited < copyWait; waited += copyPoll {
		sys.Sleep(copyPoll)
		if sys.ChangeCount() != before {
			changed = true
			break
		}
	}
	if changed {
		text, html := sys.ReadString()
		out.Text, out.HTML = normalize(text), html
		// 还原用户原剪贴板（带临时标记，监听不会把还原当成新复制）
		markOwn(sys.Write(original, true))
	}
	if out.Text == "" {
		out.Text, out.HTML = axText, ""
	}
	if out.Text == "" {
		return out, false
	}
	return out, true
}

func normalize(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.TrimRight(s, " \t\n")
	if strings.TrimSpace(s) == "" {
		return ""
	}
	return s
}
