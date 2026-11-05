// Package shot 是截图编辑器的纯逻辑，逐个移植自 Tauri 版 src/lib/screenshot（geometry / annotate / shapeEdit / frame / crosshair），
// 测试用例一一对应。坐标均为本屏左上角原点的 pt，W/H 为本屏尺寸。
package shot

import (
	"math"
	"strings"
)

type Rect struct{ X, Y, W, H float64 }

type Point struct{ X, Y float64 }

type Handle string

var Handles = []Handle{"nw", "n", "ne", "e", "se", "s", "sw", "w"}

// RectFromPoints：拖拽起止点 → 规范矩形，并裁进屏内。
func RectFromPoints(ax, ay, bx, by, W, H float64) Rect {
	return fromEdges(math.Min(ax, bx), math.Min(ay, by), math.Max(ax, bx), math.Max(ay, by), W, H)
}

func fromEdges(l, t, r, b, W, H float64) Rect {
	x0 := clamp(math.Min(l, r), 0, W)
	y0 := clamp(math.Min(t, b), 0, H)
	x1 := clamp(math.Max(l, r), 0, W)
	y1 := clamp(math.Max(t, b), 0, H)
	return Rect{x0, y0, x1 - x0, y1 - y0}
}

func clamp(v, lo, hi float64) float64 { return math.Min(hi, math.Max(lo, v)) }

// jsRound 同 JS Math.round（.5 向 +∞）。
func jsRound(v float64) float64 { return math.Floor(v + 0.5) }

// ClipToScreen 与屏幕求交；无交集返回 false（窗口可能部分在别的屏上）。
func ClipToScreen(r Rect, W, H float64) (Rect, bool) {
	c := fromEdges(r.X, r.Y, r.X+r.W, r.Y+r.H, W, H)
	return c, c.W > 0 && c.H > 0
}

// WindowAt：光标下最上层窗口（列表自顶向下），返回下标，-1 为无。
func WindowAt(windows []Rect, x, y float64) int {
	for i, r := range windows {
		if x >= r.X && y >= r.Y && x < r.X+r.W && y < r.Y+r.H {
			return i
		}
	}
	return -1
}

// HandlePoint：手柄中心点。
func HandlePoint(r Rect, h Handle) Point {
	x, y := r.X+r.W/2, r.Y+r.H/2
	if strings.Contains(string(h), "w") {
		x = r.X
	} else if strings.Contains(string(h), "e") {
		x = r.X + r.W
	}
	if strings.HasPrefix(string(h), "n") {
		y = r.Y
	} else if strings.HasPrefix(string(h), "s") {
		y = r.Y + r.H
	}
	return Point{x, y}
}

// HitHandle：命中整条边框（容差 tol pt），四角优先；窄选区取较近的边。未命中返回 ""。
func HitHandle(r Rect, x, y, tol float64) Handle {
	left, right := math.Abs(x-r.X), math.Abs(x-r.X-r.W)
	top, bottom := math.Abs(y-r.Y), math.Abs(y-r.Y-r.H)
	horizontal, vertical := "", ""
	if math.Min(left, right) <= tol {
		horizontal = "e"
		if left <= right {
			horizontal = "w"
		}
	}
	if math.Min(top, bottom) <= tol {
		vertical = "s"
		if top <= bottom {
			vertical = "n"
		}
	}
	switch {
	case horizontal != "" && vertical != "":
		return Handle(vertical + horizontal)
	case vertical != "" && x >= r.X && x <= r.X+r.W:
		return Handle(vertical)
	case horizontal != "" && y >= r.Y && y <= r.Y+r.H:
		return Handle(horizontal)
	}
	return ""
}

func Inside(r Rect, x, y float64) bool { return x >= r.X && y >= r.Y && x <= r.X+r.W && y <= r.Y+r.H }

// ResizeRect：拖动手柄调整；越过对边时自动翻转，结果裁进屏内。
func ResizeRect(o Rect, h Handle, dx, dy, W, H float64) Rect {
	l, t, r, b := o.X, o.Y, o.X+o.W, o.Y+o.H
	s := string(h)
	if strings.Contains(s, "w") {
		l += dx
	}
	if strings.Contains(s, "e") {
		r += dx
	}
	if strings.HasPrefix(s, "n") {
		t += dy
	}
	if strings.HasPrefix(s, "s") {
		b += dy
	}
	return fromEdges(l, t, r, b, W, H)
}

// MoveRect：整体平移，尺寸不变、贴边停住。
func MoveRect(o Rect, dx, dy, W, H float64) Rect {
	return Rect{clamp(o.X+dx, 0, W-o.W), clamp(o.Y+dy, 0, H-o.H), o.W, o.H}
}

// ToPixelRect：pt 选区 → 冻结帧像素矩形（四边分别取整，保证相邻选区不重叠不漏缝）。
func ToPixelRect(r Rect, sx, sy, pxW, pxH float64) Rect {
	x0 := clamp(jsRound(r.X*sx), 0, pxW)
	y0 := clamp(jsRound(r.Y*sy), 0, pxH)
	x1 := clamp(jsRound((r.X+r.W)*sx), 0, pxW)
	y1 := clamp(jsRound((r.Y+r.H)*sy), 0, pxH)
	return Rect{x0, y0, x1 - x0, y1 - y0}
}

// PlaceNear：放大镜等浮层贴光标摆放：默认在右下，越界翻到另一侧。
func PlaceNear(x, y, w, h, W, H, gap float64) Point {
	px := x + gap
	if x+gap+w > W {
		px = x - gap - w
	}
	py := y + gap
	if y+gap+h > H {
		py = y - gap - h
	}
	return Point{clamp(px, 0, math.Max(0, W-w)), clamp(py, 0, math.Max(0, H-h))}
}
