// Package detector 识别「双击修饰键」（默认 ⇧），移植自 src-tauri/src/input/detector.rs。
//
// 两次干净的短按（期间不夹杂其他键、每次按住 < MaxTapHold、两击释放间隔
// < 释放间隔）才触发；拒绝时给出原因，供诊断日志解释「为什么这次没触发」。
package detector

import "time"

const (
	MaxTapHold    = 650 * time.Millisecond
	MaxReleaseGap = 400 * time.Millisecond
)

// Kind 是喂给检测器的输入类型。
type Kind int

const (
	TargetDown Kind = iota // 目标修饰键按下
	TargetUp               // 目标修饰键松开
	Other                  // 其他按键或其他修饰键变化
)

// Event 是一次输入。OtherMods 仅对 TargetDown 有意义：按下时是否同时按着别的修饰键。
type Event struct {
	Kind      Kind
	At        time.Time
	OtherMods bool
}

// Outcome 是一次 Feed 的结果。
type Outcome struct {
	Triggered bool
	Rejected  string // 非空表示近失，原因
	Ms        int64
}

type state int

const (
	idle state = iota
	firstDown
	firstUp
	secondDown
)

// Detector 非并发安全，由事件回调线程独占。
type Detector struct {
	st         state
	downAt     time.Time
	upAt       time.Time
	dirty      bool
	ReleaseGap time.Duration
}

func New() *Detector { return &Detector{ReleaseGap: MaxReleaseGap} }

func (d *Detector) Feed(ev Event) Outcome {
	switch ev.Kind {
	case TargetDown:
		switch d.st {
		case firstUp:
			gap := ev.At.Sub(d.upAt)
			if gap > d.ReleaseGap {
				d.st, d.downAt, d.dirty = firstDown, ev.At, ev.OtherMods
				return Outcome{Rejected: "两击间隔超时", Ms: gap.Milliseconds()}
			}
			d.st, d.downAt, d.dirty = secondDown, ev.At, ev.OtherMods
		default: // idle / 重复按下：从第一击重新开始
			d.st, d.downAt, d.dirty = firstDown, ev.At, ev.OtherMods
		}
	case TargetUp:
		held := ev.At.Sub(d.downAt)
		switch d.st {
		case firstDown:
			if d.dirty {
				d.st = idle
				return Outcome{Rejected: "第一击夹杂其他按键"}
			}
			if held >= MaxTapHold {
				d.st = idle
				return Outcome{Rejected: "第一击按住过长", Ms: held.Milliseconds()}
			}
			d.st, d.upAt = firstUp, ev.At
		case secondDown:
			d.st = idle
			if d.dirty {
				return Outcome{Rejected: "第二击夹杂其他按键"}
			}
			if held >= MaxTapHold {
				return Outcome{Rejected: "第二击按住过长", Ms: held.Milliseconds()}
			}
			return Outcome{Triggered: true}
		}
	case Other:
		switch d.st {
		case firstDown, secondDown:
			d.dirty = true
		case firstUp:
			d.st = idle
		}
	}
	return Outcome{}
}
