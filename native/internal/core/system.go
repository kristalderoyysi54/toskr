// Package core 是原生版的业务链路：划词捕获、发回对话、剪贴板监听。
// 系统调用经 System 接口注入，测试用假实现覆盖时序与中止条件。
package core

import (
	"time"

	"github.com/toskr/native/internal/macos"
)

type System interface {
	Frontmost() (macos.FrontApp, bool)
	SelectedText() (macos.Selection, string)
	ChangeCount() int
	Types() []string
	ReadString() (text, html string)
	Snapshot() []macos.Item
	Write(items []macos.Item, transient bool) int
	PostKey(key uint16, flags uint64)
	Activate(pid int32) bool
	Sleep(d time.Duration)
	SelfPID() int32
}
