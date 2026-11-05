//go:build darwin

package macos

import (
	"sync"
	"sync/atomic"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
)

// 截图光标（同 Tauri CROSS_CURSOR，参照 iShot）：mygo 只认系统光标枚举，没有自定义图片光标。
// 这里替换 +[NSCursor crosshairCursor] 的实现：开关打开时返回自定义光标，否则调回原实现。
// mygo 每次设光标都现取 [NSCursor crosshairCursor]，所以开关即时生效，仍是硬件光标（不自绘、不掉帧）。

type nsPoint struct{ X, Y float64 }
type nsSize struct{ W, H float64 }

var (
	crossOnce   sync.Once
	crossOn     atomic.Bool
	crossCursor objc.ID
	crossOrig   uintptr
)

// InstallCrossCursor：png 为光标图（任意倍率），size 为 pt 尺寸，hot 为热点（pt）。只需调一次。
func InstallCrossCursor(png []byte, size, hot float64) bool {
	crossOnce.Do(func() {
		load()
		lib, err := purego.Dlopen("/usr/lib/libobjc.A.dylib", purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			return
		}
		var getClassMethod func(cls objc.Class, s objc.SEL) uintptr
		var setImpl func(m uintptr, imp objc.IMP) uintptr
		purego.RegisterLibFunc(&getClassMethod, lib, "class_getClassMethod")
		purego.RegisterLibFunc(&setImpl, lib, "method_setImplementation")
		withPool(func() {
			img := class("NSImage").Send(sel("alloc")).Send(sel("initWithData:"), nsData(png))
			if img == 0 {
				return
			}
			img.Send(sel("setSize:"), nsSize{size, size})
			cur := class("NSCursor").Send(sel("alloc")).Send(sel("initWithImage:hotSpot:"), img, nsPoint{hot, hot})
			img.Send(sel("release"))
			if cur == 0 {
				return
			}
			crossCursor = cur // 常驻，不释放
		})
		if crossCursor == 0 {
			return
		}
		m := getClassMethod(objc.GetClass("NSCursor"), sel("crosshairCursor"))
		if m == 0 {
			return
		}
		crossOrig = setImpl(m, objc.NewIMP(func(self objc.ID, cmd objc.SEL) objc.ID {
			if crossOn.Load() {
				return crossCursor
			}
			r, _, _ := purego.SyscallN(crossOrig, uintptr(self), uintptr(cmd))
			return objc.ID(r)
		}))
	})
	return crossOrig != 0
}

// SetCrossCursor：截图遮罩开着时打开（其它窗口的十字光标保持系统样式）。
func SetCrossCursor(on bool) { crossOn.Store(on) }

// CrosshairCursor：当前 [NSCursor crosshairCursor] 的返回值（测试用）。
func CrosshairCursor() (cur, custom uintptr) {
	load()
	withPool(func() { cur = uintptr(class("NSCursor").Send(sel("crosshairCursor"))) })
	return cur, uintptr(crossCursor)
}
