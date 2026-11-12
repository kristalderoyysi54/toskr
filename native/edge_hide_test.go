package main

import (
	"testing"

	"github.com/egoist/mygo"
)

func TestDockLine(t *testing.T) {
	one := []mygo.Display{{Bounds: mygo.Rectangle{X: 0, Y: 0, Width: 1512, Height: 982}}}
	two := append(one, mygo.Display{Bounds: mygo.Rectangle{X: 1512, Y: 0, Width: 1920, Height: 1080}})
	cases := []struct {
		name string
		ds   []mygo.Display
		r    mygo.Rectangle
		ok   bool
	}{
		{"贴右缘 20pt 内", one, mygo.Rectangle{X: 1512 - 380 - 20, Y: 100, Width: 380, Height: 800}, true},
		{"拖出屏外一截", one, mygo.Rectangle{X: 1512 - 300, Y: 100, Width: 380, Height: 800}, true},
		{"离右缘 40pt", one, mygo.Rectangle{X: 1512 - 380 - 40, Y: 100, Width: 380, Height: 800}, false},
		{"右侧还有屏（接缝）", two, mygo.Rectangle{X: 1512 - 380 - 10, Y: 100, Width: 380, Height: 800}, false},
		{"副屏右缘", two, mygo.Rectangle{X: 1512 + 1920 - 380, Y: 100, Width: 380, Height: 800}, true},
	}
	for _, c := range cases {
		if _, _, _, ok := dockLine(c.ds, c.r); ok != c.ok {
			t.Errorf("%s: got %v", c.name, ok)
		}
	}
}

func TestEdgeAnchorGeometry(t *testing.T) {
	e := edgeAnchor{x: 1132, y: 100, w: 380, h: 800, line: 1512, monY: 0, monH: 982}
	if !e.inside(1200, 400) || !e.inside(1510, 400) || e.inside(1100, 400) || e.inside(1200, 950) {
		t.Fatal("展开态范围：面板到屏缘之间算在内")
	}
	if !e.touching(1511, 30) || !e.touching(1490, 600) || e.touching(1400, 600) {
		t.Fatal("触边唤回：屏缘 24pt 内任意高度")
	}
}

// 快捷键 / 双击唤出（同 Tauri shortcutHoldOpen + panel_auto_hide_armed=false）：失焦不收、不贴边滑出；真实拖动后解除。
func TestShortcutHoldBlocksEdgeHide(t *testing.T) {
	a, _ := testApp(t)
	a.edge = &edgeAnchor{x: 1132, y: 100, w: 380, h: 800, line: 1512, monH: 982}
	a.holdOpen, a.edgeArmed = true, false
	if a.edgeHideNow(false) || a.edgeHidden {
		t.Fatal("快捷键保护期间失焦不应滑出")
	}
	a.panelMovedByUser()
	if a.holdOpen || !a.edgeArmed || a.edge != nil {
		t.Fatalf("真实拖动应解除保护并清锚点 hold=%v armed=%v", a.holdOpen, a.edgeArmed)
	}
}

// 拖动途中失焦：拖动已清掉锚点，此时不能按普通失焦把面板整个收起（症状：拖向右缘时面板消失、入坞不生效），
// 只记下待裁决，等落定后的入坞评估。
func TestBlurDuringDragDefersHide(t *testing.T) {
	a, _ := testApp(t)
	a.panelMovedByUser()
	if !a.dockPending {
		t.Fatal("拖动后应等待入坞评估")
	}
	a.blurHide()
	if !a.dragBlur || a.panelHiding {
		t.Fatalf("拖动中失焦应延后裁决 dragBlur=%v hiding=%v", a.dragBlur, a.panelHiding)
	}
}
