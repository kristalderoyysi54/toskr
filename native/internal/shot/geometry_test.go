package shot

import "testing"

// 对应 src/lib/screenshot/geometry.test.ts（含工作区新增的 3 例：整边缩放、6pt 容差、四角优先）。
const W, H = 1440.0, 900.0

func eqRect(t *testing.T, got, want Rect) {
	t.Helper()
	if got != want {
		t.Fatalf("得 %+v，应为 %+v", got, want)
	}
}

func TestRectFromPoints(t *testing.T) {
	eqRect(t, RectFromPoints(300, 200, 100, 50, W, H), Rect{100, 50, 200, 150})
	eqRect(t, RectFromPoints(1400, 850, 1600, 1000, W, H), Rect{1400, 850, 40, 50})
}

func TestWindowAtAndClip(t *testing.T) {
	ws := []Rect{{100, 100, 200, 200}, {-200, 0, 800, 600}}
	if WindowAt(ws, 150, 150) != 0 || WindowAt(ws, 50, 50) != 1 || WindowAt(ws, 1000, 800) != -1 {
		t.Fatal("窗口命中应取最上层")
	}
	c, ok := ClipToScreen(ws[1], W, H)
	if !ok {
		t.Fatal("应有交集")
	}
	eqRect(t, c, Rect{0, 0, 600, 600})
	if _, ok := ClipToScreen(Rect{-500, 0, 100, 100}, W, H); ok {
		t.Fatal("屏外窗口应无交集")
	}
}

func TestHandleHitAndFlip(t *testing.T) {
	r := Rect{100, 100, 200, 100}
	if HitHandle(r, 302, 199, 6) != "se" || HitHandle(r, 200, 98, 6) != "n" || HitHandle(r, 200, 150, 6) != "" {
		t.Fatal("手柄命中")
	}
	eqRect(t, ResizeRect(r, "e", -250, 0, W, H), Rect{50, 100, 50, 100})
	eqRect(t, ResizeRect(r, "nw", -200, -200, W, H), Rect{0, 0, 300, 200})
}

func TestWholeEdgeResize(t *testing.T) {
	r := Rect{100, 100, 200, 100}
	for _, x := range []float64{107, 140, 260, 293} {
		if HitHandle(r, x, 100, 6) != "n" || HitHandle(r, x, 200, 6) != "s" {
			t.Fatalf("上下边 x=%v", x)
		}
	}
	for _, y := range []float64{107, 125, 175, 193} {
		if HitHandle(r, 100, y, 6) != "w" || HitHandle(r, 300, y, 6) != "e" {
			t.Fatalf("左右边 y=%v", y)
		}
	}
	eqRect(t, ResizeRect(r, HitHandle(r, 140, 100, 6), 30, -20, W, H), Rect{100, 80, 200, 120})
	eqRect(t, ResizeRect(r, HitHandle(r, 300, 125, 6), 30, -20, W, H), Rect{100, 100, 230, 100})
}

func TestEdgeTolerance(t *testing.T) {
	r := Rect{100, 100, 200, 100}
	for _, d := range []float64{-6, 6} {
		if HitHandle(r, 140, 100+d, 6) != "n" || HitHandle(r, 140, 200+d, 6) != "s" ||
			HitHandle(r, 100+d, 125, 6) != "w" || HitHandle(r, 300+d, 125, 6) != "e" {
			t.Fatalf("容差 d=%v", d)
		}
	}
	for _, p := range [][2]float64{{140, 93}, {140, 107}, {140, 193}, {140, 207}, {93, 125}, {107, 125}, {293, 125}, {307, 125}, {80, 100}, {300, 220}} {
		if h := HitHandle(r, p[0], p[1], 6); h != "" {
			t.Fatalf("%v 不应命中，得 %q", p, h)
		}
	}
	if HitHandle(r, 140, 103, 2) != "" {
		t.Fatal("自定义容差")
	}
}

func TestCornerPriority(t *testing.T) {
	r := Rect{100, 100, 200, 100}
	if HitHandle(r, 106, 106, 6) != "nw" || HitHandle(r, 294, 106, 6) != "ne" || HitHandle(r, 294, 194, 6) != "se" || HitHandle(r, 106, 194, 6) != "sw" {
		t.Fatal("四角优先")
	}
	s := Rect{100, 100, 10, 10}
	if HitHandle(s, 110, 100, 6) != "ne" || HitHandle(s, 110, 110, 6) != "se" || HitHandle(s, 100, 110, 6) != "sw" {
		t.Fatal("小选区")
	}
}

func TestMoveRect(t *testing.T) {
	eqRect(t, MoveRect(Rect{100, 100, 200, 100}, 5000, -5000, W, H), Rect{1240, 0, 200, 100})
}

func TestToPixelRect(t *testing.T) {
	eqRect(t, ToPixelRect(Rect{10.3, 20, 100, 50.4}, 2, 2, 2880, 1800), Rect{21, 40, 200, 101})
	eqRect(t, ToPixelRect(Rect{1400, 0, 100, 10}, 2, 2, 2880, 1800), Rect{2800, 0, 80, 20})
}

func TestPlaceNear(t *testing.T) {
	if p := PlaceNear(100, 100, 120, 150, W, H, 20); p != (Point{120, 120}) {
		t.Fatal(p)
	}
	if p := PlaceNear(1400, 850, 120, 150, W, H, 20); p != (Point{1260, 680}) {
		t.Fatal(p)
	}
}
