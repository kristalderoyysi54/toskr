package core

import (
	"errors"
	"time"

	"github.com/toskr/native/internal/macos"
)

var (
	ErrNoTarget    = errors.New("没有可发送的目标应用")
	ErrTargetFocus = errors.New("目标应用未能回到前台，已中止发送（未粘贴、未标记完成）")
	ErrEmpty       = errors.New("没有可发送的内容")
)

const (
	focusWait = 900 * time.Millisecond
	focusPoll = 30 * time.Millisecond
	pasteGap  = 60 * time.Millisecond
	enterGap  = 120 * time.Millisecond // 等目标应用把粘贴内容落进输入框再回车
)

// Deliver 把 text 发回 target：写剪贴板 → 激活目标 → 确认目标在前台 → ⌘V →
// 1.5s 后若剪贴板未被他人改动则还原原内容。目标未就绪必须中止且不粘贴。
func Deliver(sys System, target macos.FrontApp, text string) error {
	return DeliverWith(sys, target, Payload{Text: text}, false)
}

// Payload 是一次发送的内容：文本，或图片（PNG，同时附文本作回退）。
type Payload struct {
	Text string
	PNG  []byte
}

// KeyReturn 是回车键的虚拟键码（kVK_Return）。
const KeyReturn = 36

// DeliverWith 同 Deliver，可发图片；enter 为 true 时粘贴后补一次回车（「粘贴后回车」发送方案）。
func DeliverWith(sys System, target macos.FrontApp, p Payload, enter bool) error {
	if target.PID == 0 || target.PID == sys.SelfPID() {
		return ErrNoTarget
	}
	if normalize(p.Text) == "" && len(p.PNG) == 0 {
		return ErrEmpty
	}
	item := macos.Item{}
	if p.Text != "" {
		item[macos.TypeString] = []byte(p.Text)
	}
	if len(p.PNG) > 0 {
		item[macos.TypePNG] = p.PNG
	}
	pbMu.Lock()
	original := sys.Snapshot()
	written := sys.Write([]macos.Item{item}, true)
	markOwn(written)
	sys.Activate(target.PID)
	ready := false
	for waited := time.Duration(0); waited < focusWait; waited += focusPoll {
		if f, ok := sys.Frontmost(); ok && f.PID == target.PID {
			ready = true
			break
		}
		sys.Sleep(focusPoll)
	}
	if !ready {
		markOwn(sys.Write(original, true))
		pbMu.Unlock()
		return ErrTargetFocus
	}
	sys.Sleep(pasteGap)
	sys.PostKey(macos.KeyV, macos.FlagCommand)
	if enter {
		sys.Sleep(enterGap)
		sys.PostKey(KeyReturn, 0)
	}
	go func() {
		defer pbMu.Unlock()
		sys.Sleep(restoreDelay)
		if sys.ChangeCount() == written { // 期间用户没复制别的，才还原
			markOwn(sys.Write(original, true))
		}
	}()
	return nil
}

// WaitIdle 等待进行中的剪贴板事务结束（测试与退出时用）。
func WaitIdle() { pbMu.Lock(); pbMu.Unlock() }
