package main

import (
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

// 长按 ⌥：只按 ⌥ 满 650ms 才浮出全部快捷键，松开即收；⌘⌥ 组合不触发。按住 ⌘ 前 9 张卡显示 ⌘N 角标。
func TestShortcutHelpAndQuickBadges(t *testing.T) {
	a, tt := testApp(t, "甲", "乙")
	tt.HoldModifiers(ui.Alt)
	tt.Frame()
	if tt.HasText("撤销上一步操作") {
		t.Fatal("未满 650ms 不应弹出")
	}
	tt.Advance(700 * time.Millisecond)
	tt.Frame()
	if !tt.HasText("撤销上一步操作") || !tt.HasText("⌘1-9") {
		t.Fatalf("长按 ⌥ 应弹速查 %v", tt.Texts())
	}
	tt.HoldModifiers(0)
	tt.Frame()
	if tt.HasText("撤销上一步操作") || !a.altSince.IsZero() {
		t.Fatal("松开即收")
	}
	tt.HoldModifiers(ui.Cmd | ui.Alt)
	tt.Frame()
	tt.Advance(time.Second)
	tt.Frame()
	if tt.HasText("撤销上一步操作") {
		t.Fatal("⌘⌥ 组合不触发")
	}
	tt.HoldModifiers(ui.Cmd)
	tt.Frame()
	if !tt.HasText("⌘1") || !tt.HasText("⌘2") || tt.HasText("⌘3") {
		t.Fatalf("⌘ 角标 %v", tt.Texts())
	}
	tt.HoldModifiers(0)
	tt.Frame()
	if tt.HasText("⌘1") {
		t.Fatal("松开 ⌘ 角标消失")
	}

	// 设置「快捷键」页的静态表：默认收起，展开后列全
	a.openSettingsState()
	a.setPage = 1
	st := ui.NewTester(a.settingsView, 1040, 900)
	st.Frame()
	if !st.HasText("20 项 · 面板里长按 ⌥ 也能速查") || st.HasText("撤销上一步操作") {
		t.Fatalf("设置表默认收起 %v", st.Texts())
	}
	if err := st.Click("展开"); err != nil {
		t.Fatal(err)
	}
	st.Frame()
	if !st.HasText("撤销上一步操作") || !st.HasText("收起") {
		t.Fatal("展开后列出全部")
	}
}

// 详情窗 W 切换选词模式；编辑中不响应。
func TestDetailWTogglesPick(t *testing.T) {
	a, _ := testApp(t, "一段文字")
	n := a.store.Notes()[0]
	a.detail = detailState{id: n.ID, pickAnchor: -1, pickEnd: -1}
	dt := ui.NewTester(a.detailView, 560, 540)
	dt.Frame()
	dt.Key(0, ui.KeyW)
	dt.Frame()
	if !a.detail.pick {
		t.Fatal("W 应进入选词")
	}
	dt.Key(0, ui.KeyW)
	dt.Frame()
	if a.detail.pick {
		t.Fatal("再按 W 退出")
	}
}
