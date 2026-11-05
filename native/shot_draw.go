package main

import (
	"image"
	"math"
	"strconv"
	"strings"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/shot"
)

// 标注的绘制：屏上与出图同一套（移植 annotate.ts drawShapes 与 ShotShapesSvg），坐标为本屏 pt。
// 出图时外面套一层 pt → 像素的变换，几何完全同源。

const shotFont = "system-ui, PingFang SC"

func f32(v float64) float32 { return float32(v) }

func uiRect(r shot.Rect) ui.Rect { return ui.Rect{X: f32(r.X), Y: f32(r.Y), W: f32(r.W), H: f32(r.H)} }

// rectPath：圆角矩形路径（ccw 为逆时针，用于在填充里挖洞）。
func rectPath(p *ui.Path, x, y, w, h, r float32, ccw bool) {
	r = min(r, w/2, h/2)
	const k = 0.5523
	if !ccw {
		p.MoveTo(x+r, y).LineTo(x+w-r, y).CubeTo(x+w-r+r*k, y, x+w, y+r-r*k, x+w, y+r).
			LineTo(x+w, y+h-r).CubeTo(x+w, y+h-r+r*k, x+w-r+r*k, y+h, x+w-r, y+h).
			LineTo(x+r, y+h).CubeTo(x+r-r*k, y+h, x, y+h-r+r*k, x, y+h-r).
			LineTo(x, y+r).CubeTo(x, y+r-r*k, x+r-r*k, y, x+r, y).Close()
		return
	}
	p.MoveTo(x+r, y).CubeTo(x+r-r*k, y, x, y+r-r*k, x, y+r).
		LineTo(x, y+h-r).CubeTo(x, y+h-r+r*k, x+r-r*k, y+h, x+r, y+h).
		LineTo(x+w-r, y+h).CubeTo(x+w-r+r*k, y+h, x+w, y+h-r+r*k, x+w, y+h-r).
		LineTo(x+w, y+r).CubeTo(x+w, y+r-r*k, x+w-r+r*k, y, x+w-r, y).Close()
}

func ellipsePath(p *ui.Path, cx, cy, rx, ry float32) {
	const k = 0.5523
	p.MoveTo(cx+rx, cy).CubeTo(cx+rx, cy+ry*k, cx+rx*k, cy+ry, cx, cy+ry).
		CubeTo(cx-rx*k, cy+ry, cx-rx, cy+ry*k, cx-rx, cy).
		CubeTo(cx-rx, cy-ry*k, cx-rx*k, cy-ry, cx, cy-ry).
		CubeTo(cx+rx*k, cy-ry, cx+rx, cy-ry*k, cx+rx, cy).Close()
}

var shotColorCache = map[string]ui.Color{}

// shotColor：#RRGGBB（标注色画进截图像素，不随主题）。
func shotColor(hex string) ui.Color {
	if c, ok := shotColorCache[hex]; ok {
		return c
	}
	v, _ := strconv.ParseUint(strings.TrimPrefix(hex, "#"), 16, 32)
	c := ui.RGB(uint8(v>>16), uint8(v>>8), uint8(v))
	shotColorCache[hex] = c
	return c
}

// centerText：以 (x, y) 为中心画一行文字。
func centerText(p *ui.Painter, x, y float32, s string, size float32, weight int, col ui.Color) {
	sp := ui.Span{Text: s, Font: shotFont, Size: size, Weight: weight, Color: col}
	w, h := p.MeasureText(0, sp)
	p.RichText(x-w/2, y-h/2, 0, sp)
}

// mosaicCache：马赛克色块缓存（已入历史的图形不可变；画框中的按框与档位判断是否要重算）。
type mosaicEntry struct {
	box  shot.Rect
	size int
	bm   *ui.Bitmap
}

// mosaicTile：每块一个像素，取块内平均色（大块隔点取样）；放大时按像素画即成色块。
func mosaicTile(d *shotDisplay, s *shot.Shape) *ui.Bitmap {
	b := shot.Box(s)
	if e, ok := d.ed.mosaics[s]; ok && e.box == b && e.size == s.Size {
		return e.bm
	}
	cols, rows := shot.MosaicGrid(s)
	tile := image.NewRGBA(image.Rect(0, 0, cols, rows))
	x0, y0 := b.X*d.sx, b.Y*d.sy
	cw, ch := b.W*d.sx/float64(cols), b.H*d.sy/float64(rows)
	img := d.img
	for j := range rows {
		py0, py1 := int(y0+float64(j)*ch), int(math.Ceil(y0+float64(j+1)*ch))
		py0, py1 = max(py0, 0), min(py1, d.pxH)
		sy := max(1, (py1-py0)/8)
		for i := range cols {
			px0, px1 := int(x0+float64(i)*cw), int(math.Ceil(x0+float64(i+1)*cw))
			px0, px1 = max(px0, 0), min(px1, d.pxW)
			sx := max(1, (px1-px0)/8)
			var r, g, bl, n int
			for y := py0; y < py1; y += sy {
				o := y*img.Stride + px0*4
				for x := px0; x < px1; x += sx {
					r += int(img.Pix[o])
					g += int(img.Pix[o+1])
					bl += int(img.Pix[o+2])
					n++
					o += sx * 4
				}
			}
			if n == 0 {
				continue
			}
			k := j*tile.Stride + i*4
			tile.Pix[k], tile.Pix[k+1], tile.Pix[k+2], tile.Pix[k+3] = uint8(r/n), uint8(g/n), uint8(bl/n), 255
		}
	}
	bm := ui.NewBitmap(tile).Pixelated()
	if d.ed.mosaics == nil {
		d.ed.mosaics = map[*shot.Shape]mosaicEntry{}
	}
	d.ed.mosaics[s] = mosaicEntry{b, s.Size, bm}
	return bm
}

func lineWidth(s *shot.Shape) float32 { return f32(shot.LineWidth[clampLv(s.Size)]) }

func clampLv(lv int) int { return min(max(lv, 0), 2) }

// drawShapes：画顺序同 drawShapes：聚光灯 → 马赛克 → 图内翻译 → 其余标注。clip 外的部分由调用方裁掉。
func drawShapes(p *ui.Painter, d *shotDisplay, shapes []*shot.Shape, clip shot.Rect) {
	var spots []*shot.Shape
	for _, s := range shapes {
		if s.Kind == shot.Spotlight {
			spots = append(spots, s)
		}
	}
	if len(spots) > 0 {
		p.Fill(uiRect(clip), ui.RGBA(0, 0, 0, shot.SpotlightDim), 0)
		for _, s := range spots {
			b := shot.Box(s)
			p.ImageRegion(d.bm, ui.Rect{X: f32(b.X * d.sx), Y: f32(b.Y * d.sy), W: f32(b.W * d.sx), H: f32(b.H * d.sy)}, uiRect(b), ui.ImageOptions{})
		}
	}
	for _, s := range shapes {
		if s.Kind == shot.Mosaic {
			if b := shot.Box(s); b.W >= 1 && b.H >= 1 {
				p.ImageRegion(mosaicTile(d, s), ui.Rect{}, uiRect(b), ui.ImageOptions{})
			}
		}
	}
	for _, s := range shapes {
		if s.Kind != shot.Translate {
			continue
		}
		for _, it := range s.Items {
			pad := shot.TranslatePad
			if it.Patch != nil {
				p.ImageRegion(d.ed.patchBitmap(it.Patch), ui.Rect{}, ui.Rect{X: f32(it.X - pad), Y: f32(it.Y - pad), W: f32(it.W + pad*2), H: f32(it.H + pad*2)}, ui.ImageOptions{})
			}
			sp := ui.Span{Text: it.Text, Font: shotFont, Size: f32(it.FontSize), Weight: 500, Color: shotColor(it.FG)}
			_, h := p.MeasureText(0, sp)
			p.RichText(f32(it.X), f32(it.Y+it.H/2)-h/2, 0, sp)
		}
	}
	numbers := shot.CalloutNumbers(shapes)
	for _, s := range shapes {
		drawShape(p, s, numbers[s])
	}
}

func drawShape(p *ui.Painter, s *shot.Shape, n int) {
	col := shotColor(s.Color)
	lw := lineWidth(s)
	lv := clampLv(s.Size)
	var path ui.Path
	switch s.Kind {
	case shot.RectK:
		b := shot.Box(s)
		rectPath(&path, f32(b.X), f32(b.Y), f32(b.W), f32(b.H), 0, false)
		p.StrokePath(path.Join(ui.RoundJoin), lw, col)
	case shot.Ellipse:
		b := shot.Box(s)
		ellipsePath(&path, f32(b.X+b.W/2), f32(b.Y+b.H/2), f32(b.W/2), f32(b.H/2))
		p.StrokePath(&path, lw, col)
	case shot.Line:
		path.MoveTo(f32(s.X1), f32(s.Y1)).LineTo(f32(s.X2), f32(s.Y2))
		p.StrokePath(&path, lw, col)
	case shot.Arrow:
		bx, by, head := shot.ArrowGeometry(s.X1, s.Y1, s.X2, s.Y2, float64(lw))
		path.MoveTo(f32(s.X1), f32(s.Y1)).LineTo(f32(bx), f32(by))
		p.StrokePath(&path, lw, col)
		var tri ui.Path
		tri.MoveTo(f32(head[0].X), f32(head[0].Y)).LineTo(f32(head[1].X), f32(head[1].Y)).LineTo(f32(head[2].X), f32(head[2].Y)).Close()
		p.FillPath(&tri, col)
	case shot.Pen:
		for i, pt := range s.Points {
			if i == 0 {
				path.MoveTo(f32(pt.X), f32(pt.Y))
			} else {
				path.LineTo(f32(pt.X), f32(pt.Y))
			}
		}
		if len(s.Points) > 1 {
			p.StrokePath(&path, lw, col)
		}
	case shot.Text:
		fs := shot.FontSize[lv]
		for i, line := range strings.Split(s.Text, "\n") {
			p.RichText(f32(s.X), f32(s.Y+float64(i)*fs*shot.TextLineHeight), 0, ui.Span{Text: line, Font: shotFont, Size: f32(fs), Weight: 600, Color: col})
		}
	case shot.Number:
		r := shot.NumberRadius[lv]
		path.Circle(f32(s.X), f32(s.Y), f32(r))
		p.FillPath(&path, col)
		centerText(p, f32(s.X), f32(s.Y+0.5), strconv.Itoa(s.N), f32(math.Round(r*1.2)), 700, shotColor(shot.NumberTextColor(s.Color)))
	case shot.Callout:
		if n == 0 {
			n = 1
		}
		b := shot.Box(s)
		t := shot.CalloutTag(s, n)
		c := math.Min(t.R, math.Min(b.W/2, b.H/2))
		rectPath(&path, f32(b.X), f32(b.Y), f32(b.W), f32(b.H), f32(c), false)
		p.FillPath(&path, col.Alpha(shot.CalloutTint))
		p.StrokePath(&path, lw, col)
		x, y, w, h, r := f32(t.X), f32(t.Y), f32(t.W), f32(t.H), f32(t.R)
		cc := f32(c)
		var tag ui.Path
		tag.MoveTo(x, y+cc).QuadTo(x, y, x+cc, y).LineTo(x+w, y).LineTo(x+w, y+h-r).QuadTo(x+w, y+h, x+w-r, y+h).LineTo(x, y+h).Close()
		p.FillPath(&tag, col)
		centerText(p, x+w/2, y+h/2+0.5, strconv.Itoa(n), f32(math.Round(t.H*0.62)), 700, shotColor(shot.NumberTextColor(s.Color)))
	}
}

// renderShot：按冻结帧像素裁出选区、合成标注，再加圆角与阴影边距（frame.ts frameImage）。
func renderShot(d *shotDisplay, sel shot.Rect, shapes []*shot.Shape, fr shotFrame) *image.RGBA {
	pr := shot.ToPixelRect(sel, d.sx, d.sy, float64(d.pxW), float64(d.pxH))
	if pr.W < 1 || pr.H < 1 {
		return nil
	}
	pad := math.Round(fr.Shadow * d.sx)
	radius := shot.ClampRadius(fr.Radius*d.sx, pr.W, pr.H)
	w, h := int(pr.W+pad*2), int(pr.H+pad*2)
	img := uiRect(shot.Rect{X: pad, Y: pad, W: pr.W, H: pr.H})
	return ui.Render(func(c *ui.Context) {
		c.Root().Background(ui.Transparent)
		ui.Box(c).Fill().Draw(func(p *ui.Painter, _ ui.Rect) {
			if pad > 0 {
				blur, offY := shot.ShadowGeometry(pad)
				p.Shadow(img, f32(radius), 0, f32(offY), f32(blur), 0, ui.RGBA(0, 0, 0, f32(fr.ShadowAlpha/100)))
			}
			p.Clip(img, f32(radius), func() {
				p.ImageRegion(d.bm, uiRect(pr), img, ui.ImageOptions{})
				if len(shapes) == 0 {
					return
				}
				t := ui.Translation(f32(-pr.X/d.sx), f32(-pr.Y/d.sy)).Then(ui.Scaling(f32(d.sx), f32(d.sy))).Then(ui.Translation(f32(pad), f32(pad)))
				p.Transform(t, 0, 0, func() { drawShapes(p, d, shapes, sel) })
			})
		})
	}, w, h, 1)
}

var colBlack, colWhite = ui.RGB(0, 0, 0), ui.RGB(255, 255, 255)
