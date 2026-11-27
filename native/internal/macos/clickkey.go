//go:build darwin

package macos

import "github.com/ebitengine/purego/objc"

var clickKeyMonitor objc.Block // 常驻，不释放

// KeyOnClick：本进程收到落在窗口 win 上的鼠标左键按下、而 win 还不是键盘窗口时，先把它设为键盘窗口再派发这次点击，
// 并回调 onClaim（主线程）。用于不激活应用的浮窗：点了窗内输入框，键入必须进这扇窗，而不是留在前台应用。只装一次。
func KeyOnClick(win uintptr, onClaim func()) {
	if win == 0 || clickKeyMonitor != 0 {
		return
	}
	clickKeyMonitor = objc.NewBlock(func(_ objc.Block, ev objc.ID) objc.ID {
		if w := ev.Send(sel("window")); uintptr(w) == win && !objc.Send[bool](w, sel("isKeyWindow")) {
			w.Send(sel("makeKeyWindow"))
			if onClaim != nil {
				onClaim()
			}
		}
		return ev
	})
	const leftMouseDown = 1 << 1 // NSEventMaskLeftMouseDown
	class("NSEvent").Send(sel("addLocalMonitorForEventsMatchingMask:handler:"), uint64(leftMouseDown), clickKeyMonitor)
}
