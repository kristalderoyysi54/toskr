package main

import (
	"testing"

	"github.com/toskr/native/internal/macos"
)

type frontSys struct {
	nopSys
	front macos.FrontApp
}

func (f *frontSys) Frontmost() (macos.FrontApp, bool) { return f.front, true }

// 同 Tauri observe_front：面板开着时切到别的应用，发送目标跟着换；切回 Toskr 不换；
// 伴随停靠中切到伴随列表外的应用（截图工具等）不换（磁吸目标锁）。
func TestTargetFollowsFrontApp(t *testing.T) {
	a, _ := testApp(t)
	sys := &frontSys{}
	a.sys = sys
	a.target = macos.FrontApp{PID: 7, BundleID: "com.yetone.alma", Name: "Alma"}
	sys.front = macos.FrontApp{PID: 42, BundleID: "com.tencent.xinWeChat", Name: "微信"}
	a.observeFront()
	if a.target.PID != 42 {
		t.Fatalf("切到微信后目标应换过去，得到 %+v", a.target)
	}
	sys.front = macos.FrontApp{PID: sys.SelfPID()}
	a.observeFront()
	if a.target.PID != 42 {
		t.Fatal("回到 Toskr 不换目标")
	}
	sys.front = macos.FrontApp{PID: 50} // 无 bundle 的浮层
	a.observeFront()
	if a.target.PID != 42 {
		t.Fatal("无身份的前台不当目标")
	}
	st := a.store.Settings()
	st.Companion = []string{"com.googlecode.iterm2"}
	_ = a.store.SetSettings(st)
	a.target, a.docked = macos.FrontApp{PID: 60, BundleID: "com.googlecode.iterm2"}, true
	sys.front = macos.FrontApp{PID: 61, BundleID: "com.apple.screenshot"}
	a.observeFront()
	if a.target.PID != 60 {
		t.Fatal("伴随停靠中切到列表外应用不换目标")
	}
}
