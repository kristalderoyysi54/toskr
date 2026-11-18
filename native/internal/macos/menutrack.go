package macos

import (
	"sync"
	"sync/atomic"

	"github.com/ebitengine/purego/objc"
)

// 原生菜单（「…」弹出菜单、右键菜单、托盘菜单）打开期间主线程停在 AppKit 的菜单追踪循环里：
// Carbon 全局热键不送达（关掉菜单后才补发），鼠标事件也只进菜单。这里记下正在追踪的菜单，
// 供键盘监听线程判断、主线程取消。

var (
	trackingMenu  atomic.Uintptr // 正在追踪的根菜单（NSMenu*，不持有；结束通知先于菜单释放）
	menuWatchOnce sync.Once
	menuObservers [2]objc.Block // 常驻，不释放
)

// WatchMenuTracking 订阅菜单追踪的开始 / 结束通知（主线程上送达）。只生效一次。
func WatchMenuTracking() {
	menuWatchOnce.Do(func() {
		load()
		menuObservers[0] = objc.NewBlock(func(_ objc.Block, n objc.ID) { trackingMenu.Store(uintptr(n.Send(sel("object")))) })
		menuObservers[1] = objc.NewBlock(func(_ objc.Block, _ objc.ID) { trackingMenu.Store(0) })
		withPool(func() {
			center := class("NSNotificationCenter").Send(sel("defaultCenter"))
			for i, name := range []string{"NSMenuDidBeginTrackingNotification", "NSMenuDidEndTrackingNotification"} {
				center.Send(sel("addObserverForName:object:queue:usingBlock:"), nsString(name), objc.ID(0), objc.ID(0), menuObservers[i])
			}
		})
	})
}

// MenuTracking：此刻有原生菜单开着。任意线程可调。
func MenuTracking() bool { return trackingMenu.Load() != 0 }

// CancelMenuTracking 关掉正在追踪的菜单（不选任何项），返回是否关了一个。主线程调用。
func CancelMenuTracking() bool {
	m := trackingMenu.Load()
	if m == 0 {
		return false
	}
	objc.ID(m).Send(sel("cancelTrackingWithoutAnimation"))
	return true
}
