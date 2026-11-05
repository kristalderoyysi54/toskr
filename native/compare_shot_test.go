package main

import (
	"fmt"
	"image"
	"image/draw"
	"image/png"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/shot"
)

// TestCompareShot：截图遮罩与 Tauri ScreenshotView 逐像素对照。参照由 /tmp/toskr-cap/shot/job.mjs 抓取
// （同一冻结帧 SHOT_FRAME、同一窗口列表、同一组鼠标操作）：悬停窗口 / 拖出选区 / 矩形工具画框。
func TestCompareShot(t *testing.T) {
	dir, framePath := os.Getenv("TOSKR_COMPARE_DIR"), os.Getenv("SHOT_FRAME")
	if dir == "" || framePath == "" {
		t.Skip("set TOSKR_COMPARE_DIR and SHOT_FRAME")
	}
	f, err := os.Open(framePath)
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
	const W, H = 1512, 982
	for _, scheme := range []string{"light", "dark"} {
		a, _ := testApp(t)
		d := &shotDisplay{W: W, H: H, pxW: img.Rect.Dx(), pxH: img.Rect.Dy(), img: img, bm: ui.NewBitmap(img).Pixelated(),
			windows: []shot.Rect{{X: 200, Y: 120, W: 900, H: 600}}}
		d.sx, d.sy = float64(d.pxW)/d.W, float64(d.pxH)/d.H
		a.shot = &shotSession{displays: []*shotDisplay{d}, done: make(chan struct{})}
		tt := ui.NewTester(func(c *ui.Context) { a.shotView(c, d) }, W, H)
		tt.SetDark(scheme == "dark")
		snap := func(name string) {
			tt.Frame()
			tt.Advance(time.Second)
			tt.Frame()
			got := tt.Image()
			save(t, filepath.Join(dir, "mygo-shot-"+name+"-"+scheme+".png"), got)
			ref := load(t, filepath.Join(dir, "ref-shot-"+name+"-"+scheme+".png"))
			ratio, heat := diff(ref, got)
			save(t, filepath.Join(dir, "diff-shot-"+name+"-"+scheme+".png"), heat)
			save(t, filepath.Join(dir, "side-shot-"+name+"-"+scheme+".png"), sideBySide(ref, got, heat))
			fmt.Printf("shot-%s %s: 差异像素 %.2f%%（通道差 > 24，1px 容差）\n", name, scheme, ratio*100)
		}
		tt.Move(600, 400)
		snap("hover")
		dragOn(tt, 300, 200, 1000, 640)
		tt.Move(1300, 880)
		snap("selected")
		if err := tt.Click("矩形"); err != nil {
			t.Fatal(err)
		}
		dragOn(tt, 360, 300, 600, 420)
		tt.Move(1300, 880)
		snap("rect")
	}
}
