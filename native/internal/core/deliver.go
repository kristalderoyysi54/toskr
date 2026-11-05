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
)

// Deliver 把 text 发回 target：写剪贴板 → 激活目标 → 确认目标在前台 → ⌘V →
// 1.5s 后若剪贴板未被他人改动则还原原内容。目标未就绪必须中止且不粘贴。
func Deliver(sys System, target macos.FrontApp, text string) error {
	if target.PID == 0 || target.PID == sys.SelfPID() {
		return ErrNoTarget
	}
	if normalize(text) == "" {
		return ErrEmpty
	}
	pbMu.Lock()
	original := sys.Snapshot()
	written := sys.Write([]macos.Item{{macos.TypeString: []byte(text)}}, true)
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
