//go:build darwin

package macos

import (
	"fmt"
	"strings"
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
	cgWindowListCreateImage                func(rect cgRect, option, relative, imageOption uint32) uintptr
	cgImageGetWidth, cgImageGetHeight      func(img uintptr) uintptr
	cgImageGetBytesPerRow                  func(img uintptr) uintptr
	cgImageGetBitsPerPixel                 func(img uintptr) uintptr
	cgImageGetBitmapInfo                   func(img uintptr) uint32
	cgImageGetDataProvider                 func(img uintptr) uintptr
	cgDataProviderCopyData                 func(p uintptr) uintptr
	cfDataGetBytePtr                       func(d uintptr) unsafe.Pointer
	cfDataGetLength                        func(d uintptr) int
	cgWarpMouseCursorPosition              func(p cgPoint) int32
)

type cgPoint struct{ X, Y float64 }

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
		purego.RegisterLibFunc(&cgWindowListCreateImage, cg, "CGWindowListCreateImage")
		purego.RegisterLibFunc(&cgImageGetWidth, cg, "CGImageGetWidth")
		purego.RegisterLibFunc(&cgImageGetHeight, cg, "CGImageGetHeight")
		purego.RegisterLibFunc(&cgImageGetBytesPerRow, cg, "CGImageGetBytesPerRow")
		purego.RegisterLibFunc(&cgImageGetBitsPerPixel, cg, "CGImageGetBitsPerPixel")
		purego.RegisterLibFunc(&cgImageGetBitmapInfo, cg, "CGImageGetBitmapInfo")
		purego.RegisterLibFunc(&cgImageGetDataProvider, cg, "CGImageGetDataProvider")
		purego.RegisterLibFunc(&cgDataProviderCopyData, cg, "CGDataProviderCopyData")
		purego.RegisterLibFunc(&cfDataGetBytePtr, cf, "CFDataGetBytePtr")
		purego.RegisterLibFunc(&cfDataGetLength, cf, "CFDataGetLength")
		purego.RegisterLibFunc(&cgWarpMouseCursorPosition, cg, "CGWarpMouseCursorPosition")
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
// self 为本进程：includeSelf 时本进程的窗口（面板、钉图常在浮动层 0–19）也作为吸附目标，否则跳过；其他应用只取普通层。
func WindowRects(self int32, includeSelf bool) []WinRect {
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
		if n := cfDictionaryGetValue(d, kWinLayer); n == 0 || !cfNumberGetValue(n, sint32, unsafe.Pointer(&layer)) {
			continue
		}
		if n := cfDictionaryGetValue(d, kWinOwnerPID); n != 0 {
			cfNumberGetValue(n, kind, unsafe.Pointer(&pid))
		}
		if pid == self {
			if !includeSelf || layer < 0 || layer >= 20 {
				continue
			}
		} else if layer != 0 {
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
// OverlayLevel：截图遮罩的窗口层级（高于菜单栏与全屏应用）。
const OverlayLevel = 1000

func MakeOverlay(nsWindow uintptr) {
	if nsWindow == 0 {
		return
	}
	load()
	w := objc.ID(nsWindow)
	w.Send(sel("setLevel:"), OverlayLevel)
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

// CaptureRect 截取全局 pt 矩形内的屏幕（原生像素，RGBA，不透明）。长截屏逐帧取用，
// 进程内调用比起 screencapture 子进程快一个数量级。失败返回 nil。
// below 非 0 时只截该窗口（CGWindowID）之下的内容：长截屏的边框与提示不会被截进去。
func CaptureRect(x, y, w, h float64, below uint32) (pix []byte, pw, ph int) {
	loadScreen()
	const onScreenOnly, onScreenBelow, bestResolution = 1 << 0, 1 << 2, 1 << 3
	opt := uint32(onScreenOnly)
	if below != 0 {
		opt = onScreenBelow
	}
	img := cgWindowListCreateImage(cgRect{x, y, w, h}, opt, below, bestResolution)
	if img == 0 {
		return nil, 0, 0
	}
	defer CFRelease(img)
	pw, ph = int(cgImageGetWidth(img)), int(cgImageGetHeight(img))
	stride := int(cgImageGetBytesPerRow(img))
	if cgImageGetBitsPerPixel(img) != 32 || pw == 0 || ph == 0 {
		return nil, 0, 0
	}
	data := cgDataProviderCopyData(cgImageGetDataProvider(img))
	if data == 0 {
		return nil, 0, 0
	}
	defer CFRelease(data)
	n := cfDataGetLength(data)
	src := unsafe.Slice((*byte)(cfDataGetBytePtr(data)), n)
	// 32 位小端（kCGBitmapByteOrder32Little）为 BGRA，否则按 RGBA / ARGB 处理
	info := cgImageGetBitmapInfo(img)
	little := info&0x7000 == 0x2000
	alphaFirst := info&0x1f == 2 || info&0x1f == 4 || info&0x1f == 6
	pix = make([]byte, pw*ph*4)
	for row := range ph {
		s := src[row*stride : row*stride+pw*4]
		d := pix[row*pw*4 : (row+1)*pw*4]
		for i := 0; i < pw*4; i += 4 {
			switch {
			case little: // BGRA
				d[i], d[i+1], d[i+2] = s[i+2], s[i+1], s[i]
			case alphaFirst: // ARGB
				d[i], d[i+1], d[i+2] = s[i+1], s[i+2], s[i+3]
			default: // RGBA
				d[i], d[i+1], d[i+2] = s[i], s[i+1], s[i+2]
			}
			d[i+3] = 255
		}
	}
	return pix, pw, ph
}

// WarpCursor 把光标移到全局 pt 位置（长截屏开始时移到选区中央，滚轮才落在要截的区域上）。
func WarpCursor(x, y float64) {
	loadScreen()
	cgWarpMouseCursorPosition(cgPoint{x, y})
}

// WindowNumber：NSWindow 的 windowNumber（即 CGWindowID）。
func WindowNumber(nsWindow uintptr) uint32 {
	if nsWindow == 0 {
		return 0
	}
	load()
	return uint32(objc.Send[int](objc.ID(nsWindow), sel("windowNumber")))
}

// RaiseIMEWindows：输入法候选窗由系统画在本进程里（实测层级 20），会被遮罩挡住（同 Tauri raise_ime_windows）：
// 把本进程中可见、不属于 ours（mygo 窗口）、层级不高于遮罩的窗口提到遮罩之上，返回被提升的窗口类名与尺寸。仅限主线程。
func RaiseIMEWindows(ours map[uintptr]bool) []string {
	load()
	var raised []string
	withPool(func() {
		wins := class("NSApplication").Send(sel("sharedApplication")).Send(sel("windows"))
		for i, n := 0, objc.Send[int](wins, sel("count")); i < n; i++ {
			w := wins.Send(sel("objectAtIndex:"), i)
			if ours[uintptr(w)] || !objc.Send[bool](w, sel("isVisible")) || objc.Send[int](w, sel("level")) > OverlayLevel {
				continue
			}
			cls := goString(uintptr(w.Send(sel("className"))))
			if strings.Contains(cls, "StatusBar") { // 菜单栏托盘图标也是本进程窗口，不能提上来
				continue
			}
			w.Send(sel("setLevel:"), OverlayLevel+1)
			f := objc.Send[cgRect](w, sel("frame"))
			raised = append(raised, fmt.Sprintf("%s %.0f×%.0f", cls, f.W, f.H))
		}
	})
	return raised
}
