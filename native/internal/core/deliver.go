package core

import (
	"errors"
	"time"

	"github.com/toskr/native/internal/macos"
)

var (
	ErrNoTarget      = errors.New("没有可发送的目标应用")
	ErrTargetFocus   = errors.New("目标应用未能回到前台，已中止发送（未粘贴、未标记完成）")
	ErrTargetChanged = errors.New("目标应用已重启（进程身份变化），已中止发送：请切回目标后重新唤出面板")
	ErrEmpty         = errors.New("没有可发送的内容")
)

const (
	focusWait  = 900 * time.Millisecond
	focusPoll  = 30 * time.Millisecond
	pasteGap   = 60 * time.Millisecond
	enterGap   = 120 * time.Millisecond // 等目标应用把粘贴内容落进输入框再回车
	verifyWait = 250 * time.Millisecond
)

// Payload 是一次发送的内容：文本，或图片（PNG，同时附文本作回退）。
type Payload struct {
	Text string
	PNG  []byte
}

// Options 是发送方案。
type Options struct {
	Enter     bool  // 粘贴后补回车
	StartedMs int64 // 目标进程启动时刻（面板唤出时锁定）；非 0 时发送前核对，防 pid 复用 / 目标重启
}

// Check 是粘贴结果核验结论。
type Check string

const (
	CheckVerified  Check = "verified"  // 焦点输入框内容已变化
	CheckUnchanged Check = "unchanged" // 读得到输入框但内容没变：可能没粘进去
	CheckUnknown   Check = "unknown"   // 目标不暴露 AXValue（终端、画布类），无法核验
)

// identity 与 valueReader 是可选能力（真实系统实现，测试替身可不实现）。
type identity interface{ ProcessStartMs(pid int32) int64 }
type valueReader interface{ FocusedValue() (string, bool) }

// KeyReturn 是回车键的虚拟键码（kVK_Return）。
const KeyReturn = 36

// Deliver 把 text 发回 target：写剪贴板 → 激活目标 → 确认目标在前台 → ⌘V →
// 1.5s 后若剪贴板未被他人改动则还原原内容。目标未就绪必须中止且不粘贴。
func Deliver(sys System, target macos.FrontApp, text string) error {
	_, err := DeliverWith(sys, target, Payload{Text: text}, Options{})
	return err
}

// DeliverWith 同 Deliver，可发图片，带发送方案；返回粘贴结果核验结论。
func DeliverWith(sys System, target macos.FrontApp, p Payload, opt Options) (Check, error) {
	if target.PID == 0 || target.PID == sys.SelfPID() {
		return CheckUnknown, ErrNoTarget
	}
	if normalize(p.Text) == "" && len(p.PNG) == 0 {
		return CheckUnknown, ErrEmpty
	}
	if id, ok := sys.(identity); ok && opt.StartedMs != 0 && id.ProcessStartMs(target.PID) != opt.StartedMs {
		return CheckUnknown, ErrTargetChanged
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
		return CheckUnknown, ErrTargetFocus
	}
	vr, canVerify := sys.(valueReader)
	before, hasBefore := "", false
	if canVerify {
		before, hasBefore = vr.FocusedValue()
	}
	sys.Sleep(pasteGap)
	sys.PostKey(macos.KeyV, macos.FlagCommand)
	check := CheckUnknown
	if hasBefore {
		sys.Sleep(verifyWait)
		if after, ok := vr.FocusedValue(); ok {
			check = CheckUnchanged
			if after != before {
				check = CheckVerified
			}
		}
	}
	if opt.Enter {
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
	return check, nil
}

// WaitIdle 等待进行中的剪贴板事务结束（测试与退出时用）。
func WaitIdle() { pbMu.Lock(); pbMu.Unlock() }
