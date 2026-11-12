package shot

import (
	"image"
	"math"
	"slices"
)

// 图片打码（移植自 lib/imageEditor.ts 与 lib/imageZoom.ts；像素算法与 Rust image_firewall 同构）：
// 框为原图像素坐标，样式为马赛克 / 实色 / 取色（框外一圈平均色）。

type PxBox struct{ X, Y, W, H int }

type RedactKind string

const (
	RedactMosaic RedactKind = "mosaic"
	RedactSolid  RedactKind = "solid"
	RedactPick   RedactKind = "pick"
)

type RedactStyle struct {
	Kind  RedactKind `json:"kind"`
	Color [3]uint8   `json:"color,omitzero"`
}

var (
	RedactBlack = [3]uint8{20, 20, 22}
	RedactWhite = [3]uint8{255, 255, 255}
	// RedactStyles：选中框浮条与工具栏共用的样式选项。
	RedactStyles = []struct {
		Style RedactStyle
		Label string
	}{
		{RedactStyle{Kind: RedactMosaic}, "马赛克"},
		{RedactStyle{Kind: RedactSolid, Color: RedactBlack}, "黑色"},
		{RedactStyle{Kind: RedactSolid, Color: RedactWhite}, "白色"},
		{RedactStyle{Kind: RedactPick}, "取色（框外平均色）"},
	}
)

// Region 是一个打码框。
type Region struct {
	PxBox
	Style RedactStyle
}

// ValidStyle：已知样式（实色须带颜色以外的种类不认）。
func ValidStyle(s RedactStyle) bool {
	return s.Kind == RedactMosaic || s.Kind == RedactPick || s.Kind == RedactSolid
}

// MosaicBlockPx：马赛克块边长：至少 12px，且不小于框短边的 1/3（与 Rust mosaic_block 一致）。
func MosaicBlockPx(b PxBox) int { return max(12, min(b.W, b.H)/3) }

func average(src *image.RGBA, pts func(yield func(x, y int))) ([3]uint8, bool) {
	var r, g, b, n int
	pts(func(x, y int) {
		o := y*src.Stride + x*4
		r += int(src.Pix[o])
		g += int(src.Pix[o+1])
		b += int(src.Pix[o+2])
		n++
	})
	if n == 0 {
		return [3]uint8{}, false
	}
	return [3]uint8{uint8(r / n), uint8(g / n), uint8(b / n)}, true
}

func rectPts(x0, y0, x1, y1 int) func(func(x, y int)) {
	return func(yield func(x, y int)) {
		for y := y0; y < y1; y++ {
			for x := x0; x < x1; x++ {
				yield(x, y)
			}
		}
	}
}

// RedactedPixels：按样式算出框内像素（RGBA，W×H）。src 为整图，box 为图内坐标。
func RedactedPixels(src *image.RGBA, box PxBox, style RedactStyle) []byte {
	out := make([]byte, box.W*box.H*4)
	fill := func(x0, y0, x1, y1 int, c [3]uint8) {
		for y := y0; y < y1; y++ {
			for x := x0; x < x1; x++ {
				k := ((y-box.Y)*box.W + (x - box.X)) * 4
				out[k], out[k+1], out[k+2], out[k+3] = c[0], c[1], c[2], 255
			}
		}
	}
	right, bottom := box.X+box.W, box.Y+box.H
	sw, sh := src.Rect.Dx(), src.Rect.Dy()
	switch style.Kind {
	case RedactSolid:
		fill(box.X, box.Y, right, bottom, style.Color)
	case RedactPick:
		in := func(x, y int) bool { return x >= 0 && y >= 0 && x < sw && y < sh }
		ring := func(yield func(x, y int)) {
			for x := box.X - 1; x <= right; x++ {
				for _, y := range []int{box.Y - 1, bottom} {
					if in(x, y) {
						yield(x, y)
					}
				}
			}
			for y := box.Y; y < bottom; y++ {
				for _, x := range []int{box.X - 1, right} {
					if in(x, y) {
						yield(x, y)
					}
				}
			}
		}
		c, ok := average(src, ring)
		if !ok {
			if c, ok = average(src, rectPts(box.X, box.Y, right, bottom)); !ok {
				c = RedactBlack
			}
		}
		fill(box.X, box.Y, right, bottom, c)
	default:
		block := MosaicBlockPx(box)
		for by := box.Y; by < bottom; by += block {
			by1 := min(by+block, bottom)
			for bx := box.X; bx < right; bx += block {
				bx1 := min(bx+block, right)
				if c, ok := average(src, rectPts(bx, by, bx1, by1)); ok {
					fill(bx, by, bx1, by1, c)
				}
			}
		}
	}
	return out
}

// ApplyRedactions：按顺序把各框的打码像素写进图的副本（后画的盖前面的）。
func ApplyRedactions(src *image.RGBA, regions []Region) *image.RGBA {
	out := image.NewRGBA(image.Rect(0, 0, src.Rect.Dx(), src.Rect.Dy()))
	copy(out.Pix, src.Pix)
	for _, r := range regions {
		pix := RedactedPixels(out, r.PxBox, r.Style)
		for y := range r.H {
			copy(out.Pix[(r.Y+y)*out.Stride+r.X*4:], pix[y*r.W*4:(y+1)*r.W*4])
		}
	}
	return out
}

// BoxFromDrag：拖拽起止点（图片像素，可反向）→ 夹在图内的正尺寸框；无面积返回 false。
func BoxFromDrag(sx, sy, ex, ey float64, w, h int) (PxBox, bool) {
	left := max(0, int(math.Floor(math.Min(sx, ex))))
	top := max(0, int(math.Floor(math.Min(sy, ey))))
	right := min(w, int(math.Ceil(math.Max(sx, ex))))
	bottom := min(h, int(math.Ceil(math.Max(sy, ey))))
	b := PxBox{left, top, right - left, bottom - top}
	return b, b.W > 0 && b.H > 0
}

// MoveBox：平移框，整体夹在图内。
func MoveBox(b PxBox, dx, dy float64, w, h int) PxBox {
	b.X = min(w-b.W, max(0, int(jsRound(float64(b.X)+dx))))
	b.Y = min(h-b.H, max(0, int(jsRound(float64(b.Y)+dy))))
	return b
}

// ResizeBox：拖角缩放：对角固定，拖过对角会翻转；越界夹回图内。handle 为 nw / ne / sw / se。
func ResizeBox(b PxBox, handle string, px, py float64, w, h int) PxBox {
	fx, fy := float64(b.X), float64(b.Y)
	if handle[1] == 'w' {
		fx = float64(b.X + b.W)
	}
	if handle[0] == 'n' {
		fy = float64(b.Y + b.H)
	}
	if nb, ok := BoxFromDrag(fx, fy, px, py, w, h); ok {
		return nb
	}
	return b
}

// FitRect：object-contain 的显示框（容器内坐标）。
func FitRect(cw, ch float64, iw, ih int) Rect {
	if cw <= 0 || ch <= 0 || iw <= 0 || ih <= 0 {
		return Rect{}
	}
	s := math.Min(cw/float64(iw), ch/float64(ih))
	w, h := float64(iw)*s, float64(ih)*s
	return Rect{(cw - w) / 2, (ch - h) / 2, w, h}
}

// ZoomView：以容器中心为原点的缩放 + 平移。
type ZoomView struct{ Zoom, X, Y float64 }

var FitView = ZoomView{Zoom: 1}

const (
	MinZoom = 0.2
	MaxZoom = 8.0
)

// Transformed：基准框经「容器中心缩放 + 平移」后的真实显示框。
func (v ZoomView) Transformed(base Rect) Rect {
	w, h := base.W*v.Zoom, base.H*v.Zoom
	return Rect{base.X + base.W/2 + v.X - w/2, base.Y + base.H/2 + v.Y - h/2, w, h}
}

// ZoomAround：以锚点（相对容器中心）缩放，锚点下的图像点保持不动；1× 及以下居中并清零平移。
func ZoomAround(v ZoomView, next, ax, ay float64) ZoomView {
	z := math.Min(MaxZoom, math.Max(MinZoom, next))
	if z == v.Zoom {
		return v
	}
	if z <= 1 {
		return ZoomView{Zoom: z}
	}
	r := z / v.Zoom
	return ZoomView{z, ax - r*(ax-v.X), ay - r*(ay-v.Y)}
}

// WheelZoomFactor：滚轮增量 → 倍率因子（负 = 放大；指数保证平滑可逆）。
func WheelZoomFactor(dy float64) float64 { return math.Exp(-dy * 0.0022) }

// PointToImage：显示坐标 → 原图像素（夹在图内）。
func PointToImage(x, y float64, shown Rect, iw, ih int) (float64, float64) {
	px := math.Min(float64(iw), math.Max(0, (x-shown.X)/shown.W*float64(iw)))
	py := math.Min(float64(ih), math.Max(0, (y-shown.Y)/shown.H*float64(ih)))
	return px, py
}

// BoxToView：原图像素框 → 显示坐标。
func BoxToView(b PxBox, shown Rect, iw, ih int) Rect {
	sx, sy := shown.W/float64(iw), shown.H/float64(ih)
	return Rect{shown.X + float64(b.X)*sx, shown.Y + float64(b.Y)*sy, float64(b.W) * sx, float64(b.H) * sy}
}

func intersectArea(a, b PxBox) int {
	l, r := max(a.X, b.X), min(a.X+a.W, b.X+b.W)
	t, btm := max(a.Y, b.Y), min(a.Y+a.H, b.Y+b.H)
	if r <= l || btm <= t {
		return 0
	}
	return (r - l) * (btm - t)
}

// StillShowsText：复检契约（同 Rust redacted_regions_still_show_text）：识别框有一半及以上落在打码框内即未通过。
// 实色 / 马赛克框内不该再有字形，过半重叠只可能来自坐标映射缺陷；边缘相触是 Vision 框松弛，不算。
func StillShowsText(obs PxBox, regions []PxBox) bool {
	area := obs.W * obs.H
	if area <= 0 {
		return false
	}
	covered := 0
	for _, r := range regions {
		covered += intersectArea(obs, r) // 框互相重叠会高估，只会更严格
	}
	return covered*2 >= area
}

// FailingRegions：未通过的识别框各归到与它交集最大的打码框，返回去重升序的框下标（0 起）。
func FailingRegions(observations, regions []PxBox) []int {
	var out []int
	for _, o := range observations {
		if !StillShowsText(o, regions) {
			continue
		}
		best, bestArea := -1, -1
		for i, r := range regions {
			if a := intersectArea(o, r); a > bestArea {
				best, bestArea = i, a
			}
		}
		if best >= 0 && !slices.Contains(out, best) {
			out = append(out, best)
		}
	}
	slices.Sort(out)
	return out
}
