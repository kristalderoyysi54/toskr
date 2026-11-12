package main

import (
	"testing"

	"github.com/toskr/native/internal/store"
)

// 面板菜单「位置与停靠」：自由移动 ⇄ 屏幕右侧 / 底部，选中态跟着变；切换清掉记住的自由位置（同 Tauri applySidebar），
// 选当前模式不动（不清位置）。
func TestScreenPlacementSwitch(t *testing.T) {
	a, tt := testApp(t, "甲")
	a.patchSettings(func(x *store.Settings) { x.CompanionOff = true })
	pick := func(label string) store.Settings {
		t.Helper()
		a.menuOpen, a.placementOpen = true, true
		tt.Frame()
		tt.Frame()
		if err := tt.Click(label); err != nil {
			t.Fatal(label, err, tt.Texts())
		}
		tt.Frame()
		return a.store.Settings()
	}
	if st := pick("自由移动"); !st.FreeMove {
		t.Fatal("应切到自由移动")
	}
	a.patchSettings(func(x *store.Settings) { x.PanelX, x.PanelY = 900, 120 }) // 用户拖到的位置
	if st := pick("自由移动"); st.PanelX != 900 {
		t.Fatal("选当前模式不应清掉自由位置")
	}
	if st := pick("屏幕底部"); st.FreeMove || st.SidebarEdge != "bottom" || st.PanelX != 0 || st.PanelY != 0 {
		t.Fatalf("切到屏幕底部应清自由位置 %+v", st)
	}
	if st := pick("屏幕右侧"); st.FreeMove || st.SidebarEdge != "right" {
		t.Fatalf("切到屏幕右侧 %+v", st)
	}
	a.menuOpen, a.placementOpen = true, true
	tt.Frame()
	tt.Frame()
	if !tt.HasText("当前位置：屏幕右侧") {
		t.Fatalf("当前位置应同步 %v", tt.Texts())
	}
}

// 保持展开 + 自由移动：拖到屏缘也不入坞、不滑出；取消保持展开后恢复。
func TestPinnedFreeMoveNoEdgeHide(t *testing.T) {
	a, _ := testApp(t, "甲")
	a.patchSettings(func(x *store.Settings) { x.CompanionOff, x.FreeMove = true, true })
	a.pinned = true
	a.edge = &edgeAnchor{x: 100, y: 0, w: 320, h: 600, line: 420, monY: 0, monH: 900}
	a.edgeArmed = true
	if a.edgeHideNow(true) || a.edgeHidden {
		t.Fatal("保持展开 + 自由移动不应贴边隐藏（含 Esc）")
	}
	a.pinned = false
	if !a.pinnedFree() == false {
		t.Fatal("取消保持展开后应恢复")
	}
}
