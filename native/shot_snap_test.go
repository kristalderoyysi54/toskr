package main

import (
	"image"
	"image/draw"
	"image/png"
	"os"
	"path/filepath"
	"testing"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/shot"
	"github.com/toskr/native/internal/store"
)

// 截图遮罩各状态的离屏快照（目检用）：SHOT_SNAP=<目录>，冻结帧取 <目录>/frame.png（1512×982pt @2x）。
func TestShotSnapshots(t *testing.T) {
	dir := os.Getenv("SHOT_SNAP")
	if dir == "" {
		t.Skip("SHOT_SNAP 未设置")
	}
	f, err := os.Open(filepath.Join(dir, "frame.png"))
	if err != nil {
		t.Fatal(err)
	}
	src, err := png.Decode(f)
	f.Close()
	if err != nil {
		t.Fatal(err)
	}
	img := image.NewRGBA(src.Bounds())
	draw.Draw(img, img.Rect, src, image.Point{}, draw.Src)
	W, H := 1512, 982
	a, _ := testApp(t)
	d := &shotDisplay{W: float64(W), H: float64(H), pxW: img.Rect.Dx(), pxH: img.Rect.Dy(), img: img, bm: ui.NewBitmap(img).Pixelated(),
		windows: []shot.Rect{{X: 200, Y: 120, W: 900, H: 600}}}
	d.sx, d.sy = float64(d.pxW)/d.W, float64(d.pxH)/d.H
	a.shot = &shotSession{displays: []*shotDisplay{d}, done: make(chan struct{})}
	tt := ui.NewTester(func(c *ui.Context) { a.shotView(c, d) }, W, H)
	tt.SetScale(2)
	if os.Getenv("SHOT_DARK") != "" {
		tt.SetDark(true)
	}
	save := func(name string) {
		tt.Frame()
		out, _ := os.Create(filepath.Join(dir, name+".png"))
		_ = png.Encode(out, tt.Image())
		out.Close()
	}
	tt.Move(600, 400)
	save("1-hover")
	dragOn(tt, 300, 200, 1000, 640)
	tt.Move(980, 500)
	save("2-selected")
	_ = tt.Click("矩形")
	dragOn(tt, 360, 300, 600, 420)
	_ = tt.Click("箭头")
	dragOn(tt, 700, 500, 620, 430)
	_ = tt.Click("马赛克")
	dragOn(tt, 700, 300, 900, 380)
	_ = tt.Click("序号")
	tt.Move(380, 460)
	tt.Press(380, 460)
	tt.Release(380, 460)
	_ = tt.Click("批注")
	dragOn(tt, 640, 520, 960, 610)
	tt.Type("这里要改成蓝色")
	tt.Key(0, ui.KeyEnter)
	_ = tt.Click("文字")
	tt.Move(330, 560)
	tt.Press(330, 560)
	tt.Release(330, 560)
	tt.Type("标注文字 Hello")
	save("3-annotated-typing")
	tt.Key(0, ui.KeyEnter)
	_ = tt.Click("聚光灯")
	dragOn(tt, 320, 220, 560, 290)
	_ = tt.Click("矩形")
	r, _ := tt.Find("椭圆")
	tt.Move(r.X+r.W/2, r.Y+r.H/2)
	tt.Advance(500e6)
	save("4-style-tip")
	fr := shotFrame{Radius: 16, Shadow: 24, ShadowAlpha: 45}
	a.setShotFrame(fr)
	tt.Key(0, ui.KeyEscape)
	save("5-frame")
	out := renderShot(d, *d.ed.sel, d.ed.allShapes(), fr)
	o, _ := os.Create(filepath.Join(dir, "6-export.png"))
	_ = png.Encode(o, out)
	o.Close()
}

// 长图标注窗与长截屏预览面板快照（同 SHOT_SNAP）。
func TestLongSnapshots(t *testing.T) {
	dir := os.Getenv("SHOT_SNAP")
	if dir == "" {
		t.Skip("SHOT_SNAP 未设置")
	}
	f, err := os.Open(filepath.Join(dir, "frame.png"))
	if err != nil {
		t.Fatal(err)
	}
	src, _ := png.Decode(f)
	f.Close()
	img := image.NewRGBA(image.Rect(0, 0, 1600, 4000))
	for y := 0; y < 4000; y += 1000 {
		draw.Draw(img, image.Rect(0, y, 1600, y+1000), src, image.Point{X: 600, Y: 400 + y/10}, draw.Src)
	}
	a, _ := testApp(t)
	d := &shotDisplay{W: 800, H: 2000, pxW: 1600, pxH: 4000, sx: 2, sy: 2, img: img, bm: ui.NewBitmap(img)}
	le := &longEditor{d: d, z: 1}
	tt := ui.NewTester(func(c *ui.Context) { a.longEditorView(c, le) }, 1000, 700)
	tt.SetScale(2)
	if os.Getenv("SHOT_DARK") != "" {
		tt.SetDark(true)
	}
	tt.Frame()
	_ = tt.Click("箭头")
	tt.Frame()
	a.longInput(le, ui.InputEvent{Kind: ui.InputPointerDown, X: 100, Y: 100})
	a.longInput(le, ui.InputEvent{Kind: ui.InputPointerMove, X: 300, Y: 220})
	a.longInput(le, ui.InputEvent{Kind: ui.InputPointerUp, X: 300, Y: 220})
	le.crop = &shot.Rect{X: 40, Y: 40, W: 700, H: 1800}
	le.cropping = true
	tt.Frame()
	out, _ := os.Create(filepath.Join(dir, "7-long-editor.png"))
	_ = png.Encode(out, tt.Image())
	out.Close()

	lc := &longCapture{}
	st := shot.NewStitcher(img.Pix[:1600*1000*4], 1600, 1000)
	st.Out, st.TotalH = img.Pix, 4000
	lc.stitched(a, st)
	pt := ui.NewTester(func(c *ui.Context) { a.longPreviewView(c, lc) }, 220, 500)
	pt.SetScale(2)
	pt.Frame()
	o2, _ := os.Create(filepath.Join(dir, "8-long-preview.png"))
	_ = png.Encode(o2, pt.Image())
	o2.Close()
}

// 图片打码窗快照（同 SHOT_SNAP）。
func TestRedactSnapshot(t *testing.T) {
	dir := os.Getenv("SHOT_SNAP")
	if dir == "" {
		t.Skip("SHOT_SNAP 未设置")
	}
	raw, err := os.ReadFile(filepath.Join(dir, "frame.png"))
	if err != nil {
		t.Fatal(err)
	}
	a, _ := testApp(t)
	file, _ := a.store.SaveImage(raw)
	n, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Kind: "image", ImageFile: file, ImageW: 3024, ImageH: 1964, Text: "x"})
	re, err := a.newRedactor(n)
	if err != nil {
		t.Fatal(err)
	}
	tt := ui.NewTester(func(c *ui.Context) { a.redactView(c, re) }, 900, 620)
	tt.SetScale(2)
	if os.Getenv("SHOT_DARK") != "" {
		tt.SetDark(true)
	}
	tt.Frame()
	tt.Frame()
	in := func(k ui.InputKind, x, y float32) { a.redactInput(re, ui.InputEvent{Kind: k, X: x, Y: y}) }
	in(ui.InputPointerDown, 100, 120)
	in(ui.InputPointerMove, 300, 200)
	in(ui.InputPointerUp, 300, 200)
	in(ui.InputPointerDown, 420, 300)
	in(ui.InputPointerMove, 600, 360)
	in(ui.InputPointerUp, 600, 360)
	re.present[1].Style = shot.RedactStyles[1].Style
	re.candidates = []redactCandidate{{shot.PxBox{X: 1500, Y: 600, W: 600, H: 80}, "银行卡号"}}
	tt.Frame()
	out, _ := os.Create(filepath.Join(dir, "9-redact.png"))
	_ = png.Encode(out, tt.Image())
	out.Close()
}
