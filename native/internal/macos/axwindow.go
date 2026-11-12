//go:build darwin

package macos

import (
	"sync"

	"github.com/ebitengine/purego"
)

var (
	axWinOnce                    sync.Once
	axUIElementCreateApplication func(pid int32) uintptr
	axValueGetValue              func(v uintptr, typ int32, out *[2]float64) bool
)

// Rect 是屏幕坐标（左上原点，与 AX / CG 一致）。
type Rect struct{ X, Y, W, H float64 }

// FocusedWindowFrame 读取 pid 的焦点窗口位置与大小（伴随停靠用，需辅助功能授权）。
func FocusedWindowFrame(pid int32) (Rect, bool) {
	load()
	axWinOnce.Do(func() {
		purego.RegisterLibFunc(&axUIElementCreateApplication, ax, "AXUIElementCreateApplication")
		purego.RegisterLibFunc(&axValueGetValue, ax, "AXValueGetValue")
	})
	app := axUIElementCreateApplication(pid)
	if app == 0 {
		return Rect{}, false
	}
	defer CFRelease(app)
	win := copyAttr(app, "AXFocusedWindow")
	if win == 0 {
		return Rect{}, false
	}
	defer CFRelease(win)
	pos, size := copyAttr(win, "AXPosition"), copyAttr(win, "AXSize")
	if pos == 0 || size == 0 {
		if pos != 0 {
			CFRelease(pos)
		}
		if size != 0 {
			CFRelease(size)
		}
		return Rect{}, false
	}
	defer CFRelease(pos)
	defer CFRelease(size)
	var p, s [2]float64
	if !axValueGetValue(pos, 1, &p) || !axValueGetValue(size, 2, &s) { // kAXValueCGPointType / CGSizeType
		return Rect{}, false
	}
	return Rect{X: p[0], Y: p[1], W: s[0], H: s[1]}, s[0] > 0 && s[1] > 0
}

func copyAttr(el uintptr, name string) uintptr {
	attr := cfString(name)
	defer CFRelease(attr)
	var out uintptr
	if AXUIElementCopyAttributeValue(el, attr, &out) != 0 {
		return 0
	}
	return out
}
