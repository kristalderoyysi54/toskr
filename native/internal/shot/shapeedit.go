package shot

import (
	"math"
	"strings"
)

// 已画标注的选中与调整：命中、手柄、移动 / 缩放。移植自 src/lib/screenshot/shapeEdit.ts。

// EditHandle：框类 8 个手柄；箭头 / 直线两端 start / end。
type EditHandle string

// IsBox：可拖手柄改框的图形。
func IsBox(s *Shape) bool {
	switch s.Kind {
	case RectK, Ellipse, Mosaic, Spotlight, Callout:
		return true
	}
	return false
}

// ShapeBounds：图形外接框；图内翻译不可编辑，返回 false。
func ShapeBounds(s *Shape) (Rect, bool) {
	switch s.Kind {
	case Translate:
		return Rect{}, false
	case Pen:
		if len(s.Points) == 0 {
			return Rect{}, false
		}
		pad := at(LineWidth, s.Size) / 2
		x0, y0, x1, y1 := math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)
		for _, p := range s.Points {
			x0, y0, x1, y1 = math.Min(x0, p.X), math.Min(y0, p.Y), math.Max(x1, p.X), math.Max(y1, p.Y)
		}
		x, y := x0-pad, y0-pad
		return Rect{x, y, x1 + pad - x, y1 + pad - y}, true
	case Text:
		fs := at(FontSize, s.Size)
		lines := strings.Split(s.Text, "\n")
		w := fs
		for _, l := range lines {
			w = math.Max(w, TextWidth(l, fs))
		}
		return Rect{s.X, s.Y, w, float64(len(lines)) * fs * TextLineHeight}, true
	case Number:
		r := at(NumberRadius, s.Size)
		return Rect{s.X - r, s.Y - r, r * 2, r * 2}, true
	}
	return Box(s), true
}

func within(r Rect, x, y, pad float64) bool {
	return x >= r.X-pad && y >= r.Y-pad && x <= r.X+r.W+pad && y <= r.Y+r.H+pad
}

func distToSegment(px, py, x1, y1, x2, y2 float64) float64 {
	dx, dy := x2-x1, y2-y1
	l := dx*dx + dy*dy
	t := 0.0
	if l != 0 {
		t = math.Max(0, math.Min(1, ((px-x1)*dx+(py-y1)*dy)/l))
	}
	return math.Hypot(px-(x1+t*dx), py-(y1+t*dy))
}

func onFrame(b Rect, x, y, pad float64) bool {
	return within(b, x, y, pad) && !(x > b.X+pad && y > b.Y+pad && x < b.X+b.W-pad && y < b.Y+b.H-pad)
}

// hits：线框类看描边，线条类看离线距离，块状类看框内。
func hits(s *Shape, x, y, tol float64) bool {
	lw := at(LineWidth, s.Size) / 2
	switch s.Kind {
	case Callout:
		t := CalloutTag(s, 10)
		if within(Rect{t.X, t.Y, t.W, t.H}, x, y, tol) {
			return true
		}
		return onFrame(Box(s), x, y, tol+lw)
	case RectK:
		return onFrame(Box(s), x, y, tol+lw)
	case Ellipse:
		b := Box(s)
		rx, ry := b.W/2, b.H/2
		if rx < 1 || ry < 1 {
			return within(b, x, y, tol)
		}
		d := math.Hypot((x-b.X-rx)/rx, (y-b.Y-ry)/ry)
		return math.Abs(d-1)*math.Min(rx, ry) <= tol+lw
	case Line, Arrow:
		return distToSegment(x, y, s.X1, s.Y1, s.X2, s.Y2) <= tol+lw
	case Pen:
		for i := 1; i < len(s.Points); i++ {
			a, b := s.Points[i-1], s.Points[i]
			if distToSegment(x, y, a.X, a.Y, b.X, b.Y) <= tol+lw {
				return true
			}
		}
		return false
	}
	b, ok := ShapeBounds(s)
	return ok && within(b, x, y, tol)
}

// ShapeAt：点中的最上层图形下标（-1 = 无）。先按描边精确命中，再退回到矩形 / 椭圆 / 批注框内，
// 这样框里画的箭头、文字不会被外面的大框抢走。accept 为 nil 时全部可选。
func ShapeAt(shapes []*Shape, x, y, tol float64, accept func(*Shape) bool) int {
	ok := func(s *Shape) bool { return accept == nil || accept(s) }
	for i := len(shapes) - 1; i >= 0; i-- {
		if s := shapes[i]; s.Kind != Translate && ok(s) && hits(s, x, y, tol) {
			return i
		}
	}
	for i := len(shapes) - 1; i >= 0; i-- {
		if s := shapes[i]; (s.Kind == RectK || s.Kind == Ellipse || s.Kind == Callout) && ok(s) && within(Box(s), x, y, 0) {
			return i
		}
	}
	return -1
}

type HandleSpot struct {
	ID   EditHandle
	X, Y float64
}

func EditHandles(s *Shape) []HandleSpot {
	if s.Kind == Arrow || s.Kind == Line {
		return []HandleSpot{{"start", s.X1, s.Y1}, {"end", s.X2, s.Y2}}
	}
	if IsBox(s) {
		b := Box(s)
		out := make([]HandleSpot, len(Handles))
		for i, h := range Handles {
			p := HandlePoint(b, h)
			out[i] = HandleSpot{EditHandle(h), p.X, p.Y}
		}
		return out
	}
	return nil
}

// HandleAt：命中的编辑手柄（"" = 无）。
func HandleAt(s *Shape, x, y, tol float64) EditHandle {
	for _, h := range EditHandles(s) {
		if math.Abs(h.X-x) <= tol && math.Abs(h.Y-y) <= tol {
			return h.ID
		}
	}
	return ""
}

func moveShape(s *Shape, dx, dy float64) *Shape {
	n := clone(s)
	switch s.Kind {
	case Pen:
		n.Points = make([]Point, len(s.Points))
		for i, p := range s.Points {
			n.Points[i] = Point{p.X + dx, p.Y + dy}
		}
	case Text, Number:
		n.X, n.Y = s.X+dx, s.Y+dy
	default:
		n.X1, n.Y1, n.X2, n.Y2 = s.X1+dx, s.Y1+dy, s.X2+dx, s.Y2+dy
	}
	return n
}

// EditShape：handle 为 "" 整体移动（外接框贴边停住），否则改框 / 改箭头端点。W/H 为可画范围。
func EditShape(o *Shape, handle EditHandle, dx, dy, W, H float64) *Shape {
	if handle == "" {
		if b, ok := ShapeBounds(o); ok && b.W <= W && b.H <= H {
			dx = clamp(dx, -b.X, W-b.X-b.W)
			dy = clamp(dy, -b.Y, H-b.Y-b.H)
		}
		return moveShape(o, dx, dy)
	}
	if (o.Kind == Arrow || o.Kind == Line) && (handle == "start" || handle == "end") {
		n := clone(o)
		if handle == "start" {
			n.X1, n.Y1 = clamp(o.X1+dx, 0, W), clamp(o.Y1+dy, 0, H)
		} else {
			n.X2, n.Y2 = clamp(o.X2+dx, 0, W), clamp(o.Y2+dy, 0, H)
		}
		return n
	}
	if IsBox(o) && handle != "start" && handle != "end" {
		r := ResizeRect(Box(o), Handle(handle), dx, dy, W, H)
		n := clone(o)
		n.X1, n.Y1, n.X2, n.Y2 = r.X, r.Y, r.X+r.W, r.Y+r.H
		return n
	}
	return o
}
