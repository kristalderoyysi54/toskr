package core

import (
	"errors"
	"slices"
	"time"

	"github.com/toskr/native/internal/macos"
)

var (
	ErrNoTarget      = errors.New("没有可发送的目标应用")
	ErrTargetFocus   = errors.New("目标应用未能回到前台，已中止发送（未粘贴、未标记完成）")
	ErrTargetExited  = errors.New("发送中止：目标应用已退出（未粘贴、未标记完成）")
	ErrTargetChanged = errors.New("目标应用已重启（进程身份变化），已中止发送：请切回目标后重新唤出面板")
	ErrEmpty         = errors.New("没有可发送的内容")
	ErrFocusDrift    = errors.New("发送中途目标应用失去前台，已停止后续粘贴（未标记完成）")
)

const (
	focusWait = 900 * time.Millisecond
	focusPoll = 30 * time.Millisecond
	pasteGap  = 60 * time.Millisecond
	// 同 Tauri runtime.pause(180)：目标到前台后再等一会儿，Electron / WebView 类应用要异步把键盘焦点还给输入框，
	// 过早的 ⌘V 会落空（Alma 实测：60ms 时读不到焦点输入框，粘贴丢失）
	activateSettle = 180 * time.Millisecond
	focusReadyWait = 360 * time.Millisecond // 读得到焦点输入框（AX）之前最多再等这么久；读不到的应用（终端等）照常粘贴
	stepGap        = 350 * time.Millisecond // 多段粘贴之间：等目标应用把上一段（尤其图片）落进输入框
	enterGap       = 120 * time.Millisecond // 等目标应用把粘贴内容落进输入框再回车
	verifyWait     = 250 * time.Millisecond
)

// Payload 是一次发送的内容：文本，或图片（PNG，同时附文本作回退）。
type Payload struct {
	Text string
	PNG  []byte
	// Steps 非空时按序逐段粘贴（同 Tauri delivery segments）：每段单独写剪贴板再 ⌘V，文字与图片交错；
	// 文字和图片放进同一个剪贴板条目时，目标应用只会取其中一种（能贴图的只贴图），文字就丢了。
	Steps []Step
}

// Step 是一段粘贴：文字或一张图。
type Step struct {
	Text string
	PNG  []byte
}

func (p Payload) steps() []Step {
	if len(p.Steps) > 0 {
		return p.Steps
	}
	return []Step{{p.Text, p.PNG}}
}

func (s Step) item() macos.Item {
	item := macos.Item{}
	if s.Text != "" {
		item[macos.TypeString] = []byte(s.Text)
	}
	if len(s.PNG) > 0 {
		item[macos.TypePNG] = s.PNG
	}
	return item
}

// Options 是发送方案。
type Options struct {
	Enter     bool  // 粘贴后补回车
	StartedMs int64 // 目标进程启动时刻（面板唤出时锁定）；非 0 时发送前核对，防 pid 复用 / 目标重启
	// OnClipboard 报告剪贴板还原结果（同 Tauri ClipboardOutcome）：restored | skippedUserChanged | nothingToRestore。
	// 粘贴成功时在后台还原后才回调（另一个 goroutine）。
	OnClipboard func(string)
	// StepGap 多段粘贴之间的等待（0 = 默认 350ms）：网页对话框贴图慢时调大，避免下一段在上一张图落地前粘进去。
	StepGap time.Duration
	// Trace 写诊断日志（逐段粘贴、焦点就绪），nil 不记。
	Trace func(format string, args ...any)
}

func (o Options) trace(format string, args ...any) {
	if o.Trace != nil {
		o.Trace(format, args...)
	}
}

func (o Options) clip(result string) {
	if o.OnClipboard != nil {
		o.OnClipboard(result)
	}
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
		opt.clip("nothingToRestore")
		return CheckUnknown, ErrNoTarget
	}
	steps := slices.DeleteFunc(slices.Clone(p.steps()), func(s Step) bool { return normalize(s.Text) == "" && len(s.PNG) == 0 })
	if len(steps) == 0 {
		opt.clip("nothingToRestore")
		return CheckUnknown, ErrEmpty
	}
	if id, ok := sys.(identity); ok && opt.StartedMs != 0 {
		if started := id.ProcessStartMs(target.PID); started == 0 { // 进程已不在（同 Tauri TargetReason::TargetExited）
			opt.clip("nothingToRestore")
			return CheckUnknown, ErrTargetExited
		} else if started != opt.StartedMs {
			opt.clip("nothingToRestore")
			return CheckUnknown, ErrTargetChanged
		}
	}
	pbMu.Lock()
	original := sys.Snapshot()
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
		pbMu.Unlock()
		opt.clip("nothingToRestore")
		return CheckUnknown, ErrTargetFocus
	}
	sys.Sleep(activateSettle)
	vr, canVerify := sys.(valueReader)
	before, hasBefore := "", false
	if canVerify { // 等焦点落到可读的输入框（读不到的应用不硬等）
		for waited := time.Duration(0); ; waited += focusPoll {
			if before, hasBefore = vr.FocusedValue(); hasBefore || waited >= focusReadyWait {
				break
			}
			sys.Sleep(focusPoll)
		}
	}
	opt.trace("发送: 目标就绪 段数=%d 焦点输入框可读=%v", len(steps), hasBefore)
	gap := opt.StepGap
	if gap <= 0 {
		gap = stepGap
	}
	written := 0
	for i, s := range steps {
		if i > 0 || len(s.PNG) > 0 { // 同 Tauri：图片段与后续段之前留时间给目标消化上一段
			sys.Sleep(gap)
		}
		if f, ok := sys.Frontmost(); !ok || f.PID != target.PID { // 同 Tauri ValidationGate::Frontmost：每段粘贴前核对
			opt.trace("发送: 第 %d/%d 段前目标失去前台（当前 pid=%d），停止", i+1, len(steps), f.PID)
			if written != 0 {
				markOwn(sys.Write(original, true))
				opt.clip("restored")
			} else {
				opt.clip("nothingToRestore")
			}
			pbMu.Unlock()
			if i == 0 {
				return CheckUnknown, ErrTargetFocus
			}
			return CheckUnknown, ErrFocusDrift
		}
		written = sys.Write([]macos.Item{s.item()}, true)
		markOwn(written)
		sys.Sleep(pasteGap)
		sys.PostKey(macos.KeyV, macos.FlagCommand)
		kind := "文字"
		if len(s.PNG) > 0 {
			kind = "图片"
		}
		opt.trace("发送: 第 %d/%d 段（%s）已粘贴", i+1, len(steps), kind)
	}
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
			opt.clip("restored")
		} else {
			opt.clip("skippedUserChanged")
		}
	}()
	return check, nil
}

// WaitIdle 等待进行中的剪贴板事务结束（测试与退出时用）。
func WaitIdle() { pbMu.Lock(); pbMu.Unlock() }
