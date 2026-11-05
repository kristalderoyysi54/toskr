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
