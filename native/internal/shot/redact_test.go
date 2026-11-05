package shot

import (
	"image"
	"math"
	"slices"
	"testing"
)

// 对应 imageEditor.test.ts（打码坐标、样式与框编辑）与 imageZoom.test.ts。

func TestRedactFitMapping(t *testing.T) {
	r := FitRect(400, 400, 800, 400)
	if r != (Rect{0, 100, 400, 200}) {
		t.Fatal(r)
	}
	sx, sy := PointToImage(100-20, 150-30, r, 800, 400)
	ex, ey := PointToImage(220-20, 230-30, r, 800, 400)
	if b, ok := BoxFromDrag(sx, sy, ex, ey, 800, 400); !ok || b != (PxBox{160, 40, 240, 160}) {
		t.Fatal(b)
	}
}

func TestRedactDragClamp(t *testing.T) {
	if b, ok := BoxFromDrag(120, 70, -10, 200, 100, 80); !ok || b != (PxBox{0, 70, 100, 10}) {
		t.Fatal(b)
	}
	if _, ok := BoxFromDrag(2, 2, 2, 2, 100, 80); ok {
		t.Fatal("零面积")
	}
	if v := BoxToView(PxBox{200, 100, 400, 200}, Rect{0, 100, 400, 200}, 800, 400); v != (Rect{100, 150, 200, 100}) {
		t.Fatal(v)
	}
}

func TestRedactZoomedMapping(t *testing.T) {
	d := ZoomView{2, 30, -10}.Transformed(Rect{0, 100, 400, 200})
	if d != (Rect{-170, -10, 800, 400}) {
		t.Fatal(d)
	}
	if x, y := PointToImage(250-20, 190-30, d, 800, 400); x != 400 || y != 170 {
		t.Fatal(x, y)
	}
}

func px(w, h int, at func(x, y int) [3]uint8) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			c := at(x, y)
			o := y*img.Stride + x*4
			img.Pix[o], img.Pix[o+1], img.Pix[o+2], img.Pix[o+3] = c[0], c[1], c[2], 255
		}
	}
	return img
}

func pixel(out []byte, w, x, y int) []byte { return out[(y*w+x)*4 : (y*w+x)*4+4] }

func TestMosaicBlockPx(t *testing.T) {
	if MosaicBlockPx(PxBox{0, 0, 300, 22}) != 12 || MosaicBlockPx(PxBox{0, 0, 300, 60}) != 20 {
		t.Fatal("马赛克块")
	}
}

func TestMosaicPixelsMatchRust(t *testing.T) {
	src := px(30, 12, func(x, _ int) [3]uint8 {
		if x < 18 {
			return [3]uint8{}
		}
		return [3]uint8{255, 255, 255}
	})
	out := RedactedPixels(src, PxBox{0, 0, 24, 12}, RedactStyle{Kind: RedactMosaic})
	if !slices.Equal(pixel(out, 24, 5, 5), []byte{0, 0, 0, 255}) || !slices.Equal(pixel(out, 24, 13, 3), []byte{127, 127, 127, 255}) ||
		!slices.Equal(pixel(out, 24, 23, 11), []byte{127, 127, 127, 255}) {
		t.Fatal("马赛克像素")
	}
}

func TestPickAveragesRing(t *testing.T) {
	src := px(10, 10, func(x, y int) [3]uint8 {
		if x >= 3 && x < 7 && y >= 3 && y < 7 {
			return [3]uint8{}
		}
		return [3]uint8{200, 100, 50}
	})
	if r := RedactedPixels(src, PxBox{3, 3, 4, 4}, RedactStyle{Kind: RedactPick}); !slices.Equal(pixel(r, 4, 1, 1), []byte{200, 100, 50, 255}) {
		t.Fatal("外圈平均")
	}
	if f := RedactedPixels(src, PxBox{0, 0, 10, 10}, RedactStyle{Kind: RedactPick}); !slices.Equal(pixel(f, 10, 0, 0), []byte{168, 84, 42, 255}) {
		t.Fatal("占满整图取框内平均", pixel(f, 10, 0, 0))
	}
}

func TestMoveAndResizeBox(t *testing.T) {
	b := PxBox{10, 10, 20, 10}
	if m := MoveBox(b, -50, 500, 100, 50); m != (PxBox{0, 40, 20, 10}) {
		t.Fatal(m)
	}
	if r := ResizeBox(b, "se", 50, 40, 100, 50); r != (PxBox{10, 10, 40, 30}) {
		t.Fatal(r)
	}
	if r := ResizeBox(b, "nw", 40, 30, 100, 50); r != (PxBox{30, 20, 10, 10}) {
		t.Fatal(r)
	}
}

func TestApplyRedactionsInOrder(t *testing.T) {
	src := px(20, 20, func(x, y int) [3]uint8 { return [3]uint8{uint8(x * 10), uint8(y * 10), 7} })
	out := ApplyRedactions(src, []Region{{PxBox{0, 0, 10, 10}, RedactStyle{Kind: RedactSolid, Color: RedactWhite}}, {PxBox{5, 5, 10, 10}, RedactStyle{Kind: RedactSolid, Color: RedactBlack}}})
	if out.Pix[0] != 255 || out.Pix[(6*20+6)*4] != 20 || out.Pix[(18*20+18)*4] != 180 || src.Pix[0] != 0 {
		t.Fatal("按顺序覆盖、不改原图")
	}
}

func TestZoomAround(t *testing.T) {
	before := ZoomView{2, 30, 10}
	ax, ay := 120.0, -40.0
	after := ZoomAround(before, 4, ax, ay)
	px, py := (ax-before.X)/before.Zoom, (ay-before.Y)/before.Zoom
	if after.Zoom != 4 || math.Abs(after.X+after.Zoom*px-ax) > 1e-9 || math.Abs(after.Y+after.Zoom*py-ay) > 1e-9 {
		t.Fatal(after)
	}
	if ZoomAround(ZoomView{6, 5, 5}, 100, 0, 0).Zoom != MaxZoom || ZoomAround(ZoomView{1.2, 80, -60}, 0.5, 33, 44) != (ZoomView{0.5, 0, 0}) ||
		ZoomAround(ZoomView{0.5, 0, 0}, 0.01, 0, 0).Zoom != MinZoom || ZoomAround(ZoomView{0.5, 0, 0}, 1, 12, 34) != FitView {
		t.Fatal("夹限与居中")
	}
	if WheelZoomFactor(-100) <= 1 || math.Abs(WheelZoomFactor(100)*WheelZoomFactor(-100)-1) > 1e-10 {
		t.Fatal("滚轮因子")
	}
}
