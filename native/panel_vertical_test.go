package main

import (
	"testing"

	"github.com/egoist/mygo"

	"github.com/toskr/native/internal/store"
)

func TestPanelFrameSettings(t *testing.T) {
	wa := mygo.Rectangle{X: 0, Y: 25, Width: 1440, Height: 875}
	fullH := wa.Height - panelMargin*2
	var st store.Settings
	// 拖上缘下移 100：记顶部下移量，高度到底记自动
	got := panelFrameSettings(st, mygo.Rectangle{X: 1050, Y: wa.Y + panelMargin + 100, Width: 380, Height: fullH - 100}, wa, false)
	if got.PanelTop != 100 || got.PanelHeight != 0 || got.PanelWidth != 0 {
		t.Fatalf("%+v", got)
	}
	// 再拖下缘缩短：记高度
	got = panelFrameSettings(got, mygo.Rectangle{X: 1050, Y: wa.Y + panelMargin + 100, Width: 420, Height: 500}, wa, false)
	if got.PanelTop != 100 || got.PanelHeight != 500 || got.PanelWidth != 420 {
		t.Fatalf("%+v", got)
	}
	// 伴随停靠：位置跟着别人的窗口，不改顶部下移量
	got2 := panelFrameSettings(got, mygo.Rectangle{X: 600, Y: 300, Width: 420, Height: 400}, wa, true)
	if got2.PanelTop != 100 {
		t.Fatalf("%+v", got2)
	}
	// 自由移动：记位置，不改顶部
	st.FreeMove = true
	got3 := panelFrameSettings(st, mygo.Rectangle{X: 200, Y: 300, Width: 380, Height: 400}, wa, false)
	if got3.PanelX != 200 || got3.PanelY != 300 || got3.PanelTop != 0 {
		t.Fatalf("%+v", got3)
	}
}

func TestPanelVerticalReset(t *testing.T) {
	a, tt := testApp(t)
	st := a.store.Settings()
	st.PanelTop, st.PanelHeight = 80, 500
	_ = a.store.SetSettings(st)
	tt.Frame()
	r, ok := tt.Find("拖拽调整高度 · 双击复位自动高度")
	if !ok {
		t.Fatal("缺下缘把手")
	}
	tt.ClickAt(r.X+r.W/2, r.Y+r.H/2)
	tt.ClickAt(r.X+r.W/2, r.Y+r.H/2)
	tt.Frame()
	if st := a.store.Settings(); st.PanelTop != 0 || st.PanelHeight != 0 {
		t.Fatalf("双击应复位 %+v", st.PanelTop)
	}
	// Platinum 收起框切换密度
	curScheme = "platinum"
	defer func() { curScheme = "default" }()
	tt.Frame()
	if err := tt.Click("舒适 / 紧凑切换"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if a.store.Settings().CardDensity != "compact" {
		t.Fatal("收起框应切到紧凑")
	}
}
