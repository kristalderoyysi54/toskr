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

// Intersects 报告两个矩形是否有非空重叠区域。
func Intersects(a, b Rect) bool {
	return a.X < b.X+b.W && a.X+a.W > b.X && a.Y < b.Y+b.H && a.Y+a.H > b.Y
}

// SnapTol 是拖动选区边角 / 平移时自动吸附窗口边界的容差（pt）。
const SnapTol = 6.0

// SnapGuides 记录当前帧命中吸附的参考线坐标（本屏 pt，用于绘制对齐虚线）。
type SnapGuides struct {
	X []float64
	Y []float64
}

func windowEdges(windows []Rect, W, H float64) (xs, ys []float64) {
	xs = make([]float64, 0, len(windows)*2)
	ys = make([]float64, 0, len(windows)*2)
	for _, w := range windows {
		c, ok := ClipToScreen(w, W, H)
		if !ok {
			continue
		}
		xs = append(xs, c.X, c.X+c.W)
		ys = append(ys, c.Y, c.Y+c.H)
	}
	return xs, ys
}

func nearestEdge(v float64, edges []float64, tol float64) (target float64, ok bool) {
	bestDist := tol + 1
	for _, e := range edges {
		if d := math.Abs(v - e); d <= tol && d < bestDist {
			bestDist, target, ok = d, e, true
		}
	}
	return target, ok
}

// SnapResize 对正在拖动的选区边（由手柄 h 决定）向窗口边缘做轻微吸附，返回调整后的选区与参考线。
func SnapResize(r Rect, h Handle, windows []Rect, W, H, tol float64) (Rect, SnapGuides) {
	if len(windows) == 0 || tol <= 0 {
		return r, SnapGuides{}
	}
	xs, ys := windowEdges(windows, W, H)
	l, t, ri, b := r.X, r.Y, r.X+r.W, r.Y+r.H
	s := string(h)
	var g SnapGuides
	if strings.Contains(s, "w") {
		if tx, ok := nearestEdge(l, xs, tol); ok && ri-tx >= 2 {
			l = tx
			g.X = append(g.X, tx)
		}
	} else if strings.Contains(s, "e") {
		if tx, ok := nearestEdge(ri, xs, tol); ok && tx-l >= 2 {
			ri = tx
			g.X = append(g.X, tx)
		}
	}
	if strings.HasPrefix(s, "n") {
		if ty, ok := nearestEdge(t, ys, tol); ok && b-ty >= 2 {
			t = ty
			g.Y = append(g.Y, ty)
		}
	} else if strings.HasPrefix(s, "s") {
		if ty, ok := nearestEdge(b, ys, tol); ok && ty-t >= 2 {
			b = ty
			g.Y = append(g.Y, ty)
		}
	}
	return fromEdges(l, t, ri, b, W, H), g
}

// SnapMove 在平移选区时让四边向窗口边缘做轻微吸附（保持尺寸不变），返回吸附后的选区与参考线。
func SnapMove(r Rect, windows []Rect, W, H, tol float64) (Rect, SnapGuides) {
	if len(windows) == 0 || tol <= 0 {
		return r, SnapGuides{}
	}
	xs, ys := windowEdges(windows, W, H)
	var g SnapGuides
	bestDx, snapX, hasX := tol+1, 0.0, false
	for _, edge := range [2]struct{ cur, base float64 }{{r.X, 0}, {r.X + r.W, r.W}} {
		if tx, ok := nearestEdge(edge.cur, xs, tol); ok {
			nx := tx - edge.base
			if nx >= 0 && nx+r.W <= W {
				if d := math.Abs(tx - edge.cur); d < bestDx {
					bestDx, snapX, hasX = d, tx, true
					r.X = nx
				}
			}
		}
	}
	if hasX {
		g.X = append(g.X, snapX)
	}
	bestDy, snapY, hasY := tol+1, 0.0, false
	for _, edge := range [2]struct{ cur, base float64 }{{r.Y, 0}, {r.Y + r.H, r.H}} {
		if ty, ok := nearestEdge(edge.cur, ys, tol); ok {
			ny := ty - edge.base
			if ny >= 0 && ny+r.H <= H {
				if d := math.Abs(ty - edge.cur); d < bestDy {
					bestDy, snapY, hasY = d, ty, true
					r.Y = ny
				}
			}
		}
	}
	if hasY {
		g.Y = append(g.Y, snapY)
	}
	return r, g
}

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
