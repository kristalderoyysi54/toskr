//go:build darwin

package macos

import (
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
)

// 截图用的系统接口：屏幕录制权限、屏上窗口列表（悬停吸附）、遮罩窗层级。
// 对应 Rust 版 screenshot.rs 的 copy_window_info / create_overlay。

var (
	scrOnce                                sync.Once
	cgPreflightScreenCaptureAccess         func() bool
	cgRequestScreenCaptureAccess           func() bool
	cgWindowListCopyWindowInfo             func(option, relative uint32) uintptr
	cgRectMakeWithDictionaryRepresentation func(dict uintptr, rect *cgRect) bool
	cfArrayGetCount                        func(a uintptr) int
	cfArrayGetValueAtIndex                 func(a uintptr, i int) uintptr
	cfDictionaryGetValue                   func(d, key uintptr) uintptr
	cfNumberGetValue                       func(n uintptr, typ int, out unsafe.Pointer) bool
	kWinLayer, kWinBounds, kWinOwnerPID    uintptr
)

type cgRect struct{ X, Y, W, H float64 }

func loadScreen() {
	scrOnce.Do(func() {
		load()
		purego.RegisterLibFunc(&cgPreflightScreenCaptureAccess, cg, "CGPreflightScreenCaptureAccess")
		purego.RegisterLibFunc(&cgRequestScreenCaptureAccess, cg, "CGRequestScreenCaptureAccess")
		purego.RegisterLibFunc(&cgWindowListCopyWindowInfo, cg, "CGWindowListCopyWindowInfo")
		purego.RegisterLibFunc(&cgRectMakeWithDictionaryRepresentation, cg, "CGRectMakeWithDictionaryRepresentation")
		purego.RegisterLibFunc(&cfArrayGetCount, cf, "CFArrayGetCount")
		purego.RegisterLibFunc(&cfArrayGetValueAtIndex, cf, "CFArrayGetValueAtIndex")
		purego.RegisterLibFunc(&cfDictionaryGetValue, cf, "CFDictionaryGetValue")
		purego.RegisterLibFunc(&cfNumberGetValue, cf, "CFNumberGetValue")
		kWinLayer = deref(cg, "kCGWindowLayer")
		kWinBounds = deref(cg, "kCGWindowBounds")
		kWinOwnerPID = deref(cg, "kCGWindowOwnerPID")
	})
}

// ScreenCaptureAllowed：是否已有屏幕录制权限（不弹窗）。
func ScreenCaptureAllowed() bool { loadScreen(); return cgPreflightScreenCaptureAccess() }

// RequestScreenCapture：请求屏幕录制权限（首次弹系统窗，之后由用户去设置里开）。
func RequestScreenCapture() bool { loadScreen(); return cgRequestScreenCaptureAccess() }

// WinRect 是屏上窗口的全局坐标（pt，原点为主屏左上角）。
type WinRect struct{ X, Y, W, H float64 }

// WindowRects：屏上 layer 0 的普通窗口，自顶向下；排除宽或高小于 8pt 的与 skipPID 自己的窗口。
func WindowRects(skipPID int32) []WinRect {
	loadScreen()
	const onScreenOnly, excludeDesktop = 1 << 0, 1 << 4
	arr := cgWindowListCopyWindowInfo(onScreenOnly|excludeDesktop, 0)
	if arr == 0 {
		return nil
	}
	defer CFRelease(arr)
	const sint32, kind = 3, 3
	var out []WinRect
	for i := range cfArrayGetCount(arr) {
		d := cfArrayGetValueAtIndex(arr, i)
		var layer, pid int32
		if n := cfDictionaryGetValue(d, kWinLayer); n == 0 || !cfNumberGetValue(n, sint32, unsafe.Pointer(&layer)) || layer != 0 {
			continue
		}
		if n := cfDictionaryGetValue(d, kWinOwnerPID); n != 0 && cfNumberGetValue(n, kind, unsafe.Pointer(&pid)) && pid == skipPID {
			continue
		}
		var r cgRect
		if b := cfDictionaryGetValue(d, kWinBounds); b == 0 || !cgRectMakeWithDictionaryRepresentation(b, &r) || r.W < 8 || r.H < 8 {
			continue
		}
		out = append(out, WinRect{r.X, r.Y, r.W, r.H})
	}
	return out
}

// MakeOverlay 把窗口设成截图遮罩：层级 1000（盖过菜单栏与 Dock）、所有桌面、全屏 Space 上也显示、不进窗口循环。
func MakeOverlay(nsWindow uintptr) {
	if nsWindow == 0 {
		return
	}
	load()
	w := objc.ID(nsWindow)
	w.Send(sel("setLevel:"), 1000)
	const joinAll, stationary, ignoresCycle, fullScreenAux = 1 << 0, 1 << 4, 1 << 6, 1 << 8
	w.Send(sel("setCollectionBehavior:"), uint(joinAll|stationary|ignoresCycle|fullScreenAux))
	w.Send(sel("setAcceptsMouseMovedEvents:"), true)
}

// ActivateSelf 让本应用到前台（遮罩要接键盘）。
func ActivateSelf() {
	load()
	withPool(func() {
		app := class("NSApplication").Send(sel("sharedApplication"))
		app.Send(sel("activateIgnoringOtherApps:"), true)
	})
}
