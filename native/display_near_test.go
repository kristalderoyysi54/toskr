package main

import (
	"testing"

	"github.com/egoist/mygo"
)

// 面板停靠在副屏右缘（中心已出屏）时，详情窗要开在副屏上，而不是退回主屏。
func TestDisplayNearOffscreenPoint(t *testing.T) {
	ds := []mygo.Display{
		{Bounds: mygo.Rectangle{X: 0, Y: 0, Width: 1728, Height: 1117}},
		{Bounds: mygo.Rectangle{X: -1920, Y: -94, Width: 1920, Height: 1080}},
		{Bounds: mygo.Rectangle{X: 1728, Y: -87, Width: 1920, Height: 1080}},
	}
	cases := []struct {
		x, y, want int
	}{
		{3805, 680, 1728}, // 副屏右缘外
		{900, 500, 0},     // 主屏内
		{-2500, 100, -1920},
	}
	for _, c := range cases {
		d, ok := displayNear(ds, c.x, c.y)
		if !ok || d.Bounds.X != c.want {
			t.Fatalf("displayNear(%d,%d) = %v,%v, want X=%d", c.x, c.y, d.Bounds, ok, c.want)
		}
	}
	if _, ok := displayNear(nil, 0, 0); ok {
		t.Fatal("no displays should report false")
	}
}
