//go:build darwin

package macos

import (
	"slices"
	"strings"

	"github.com/ebitengine/purego/objc"
)

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

// AppInfo 是运行中应用的身份：pid + bundle + 主可执行路径 + 进程启动时刻（内核记录）。
type AppInfo struct {
	PID       int32
	BundleID  string
	Name      string
	BinPath   string
	StartedMs int64
}

// RunningApp 读取 pid 对应应用的身份；启动时刻取 proc_pidinfo，spawn 起的进程也有。
func RunningApp(pid int32) (AppInfo, bool) {
	load()
	var out AppInfo
	ok := false
	withPool(func() {
		app := class("NSRunningApplication").Send(sel("runningApplicationWithProcessIdentifier:"), pid)
		if app == 0 {
			return
		}
		out.PID = pid
		out.BundleID = goString(uintptr(app.Send(sel("bundleIdentifier"))))
		out.Name = goString(uintptr(app.Send(sel("localizedName"))))
		if u := app.Send(sel("executableURL")); u != 0 {
			out.BinPath = goString(uintptr(u.Send(sel("path"))))
		}
		ok = true
	})
	out.StartedMs = ProcessStartMs(pid)
	return out, ok
}

// RunningPIDs 返回 bundle id 对应的运行中进程。
func RunningPIDs(bundle string) []int32 {
	load()
	var out []int32
	withPool(func() {
		arr := class("NSRunningApplication").Send(sel("runningApplicationsWithBundleIdentifier:"), nsString(bundle))
		n := objc.Send[uint](arr, sel("count"))
		for i := range n {
			out = append(out, objc.Send[int32](arr.Send(sel("objectAtIndex:"), i), sel("processIdentifier")))
		}
	})
	return out
}

// Terminate 请求应用优雅退出（等同菜单「退出」）。
func Terminate(pid int32) bool {
	load()
	ok := false
	withPool(func() {
		app := class("NSRunningApplication").Send(sel("runningApplicationWithProcessIdentifier:"), pid)
		if app != 0 {
			ok = objc.Send[bool](app, sel("terminate"))
		}
	})
	return ok
}

// RegularApps 列出运行中的常规（有 Dock 图标）应用，按名称排序、同 bundle 去重（同 Tauri running_regular_apps）。
func RegularApps() []AppInfo {
	load()
	var out []AppInfo
	seen := map[string]bool{}
	withPool(func() {
		arr := class("NSWorkspace").Send(sel("sharedWorkspace")).Send(sel("runningApplications"))
		for i := range objc.Send[uint](arr, sel("count")) {
			app := arr.Send(sel("objectAtIndex:"), i)
			if objc.Send[int](app, sel("activationPolicy")) != 0 { // NSApplicationActivationPolicyRegular
				continue
			}
			info := AppInfo{PID: objc.Send[int32](app, sel("processIdentifier")), BundleID: goString(uintptr(app.Send(sel("bundleIdentifier")))),
				Name: goString(uintptr(app.Send(sel("localizedName"))))}
			if u := app.Send(sel("executableURL")); u != 0 {
				info.BinPath = goString(uintptr(u.Send(sel("path"))))
			}
			if info.BundleID == "" || info.BinPath == "" || seen[info.BundleID] || strings.HasPrefix(info.BundleID, "com.toskr.") {
				continue
			}
			seen[info.BundleID] = true
			if info.Name == "" {
				info.Name = info.BundleID
			}
			out = append(out, info)
		}
	})
	slices.SortFunc(out, func(a, b AppInfo) int { return strings.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name)) })
	return out
}
