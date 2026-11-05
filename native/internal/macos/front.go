//go:build darwin

package macos

import "github.com/ebitengine/purego/objc"

// FrontApp 是前台应用身份。
type FrontApp struct {
	PID      int32
	BundleID string
	Name     string
}

// Frontmost 返回当前前台应用（NSWorkspace.frontmostApplication）。
func Frontmost() (FrontApp, bool) {
	load()
	var out FrontApp
	ok := false
	withPool(func() {
		app := class("NSWorkspace").Send(sel("sharedWorkspace")).Send(sel("frontmostApplication"))
		if app == 0 {
			return
		}
		out.PID = objc.Send[int32](app, sel("processIdentifier"))
		out.BundleID = goString(uintptr(app.Send(sel("bundleIdentifier"))))
		out.Name = goString(uintptr(app.Send(sel("localizedName"))))
		ok = true
	})
	return out, ok
}

// Activate 把 pid 对应应用切到前台（NSApplicationActivateIgnoringOtherApps 已弃用，
// macOS 14+ 用默认选项即可让出焦点）。
func Activate(pid int32) bool {
	load()
	ok := false
	withPool(func() {
		app := class("NSRunningApplication").Send(sel("runningApplicationWithProcessIdentifier:"), pid)
		if app == 0 {
			return
		}
		const allWindows = 1 << 0
		ok = objc.Send[bool](app, sel("activateWithOptions:"), uint(allWindows|1<<1))
	})
	return ok
}
