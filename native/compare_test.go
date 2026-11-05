package main

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// TestCompareWithTauri 在设置 TOSKR_COMPARE_DIR 时，用与 Tauri 参照截图相同的数据渲染主面板，
// 与 ref-main-{light,dark}.png 逐像素比较，输出原生渲染图、差异热图与并排图，并打印差异比例。
func TestCompareWithTauri(t *testing.T) {
	dir := os.Getenv("TOSKR_COMPARE_DIR")
	if dir == "" {
		t.Skip("set TOSKR_COMPARE_DIR")
	}
	st, err := store.OpenDir(t.TempDir(), bytes.Repeat([]byte{1}, 32))
	if err != nil {
		t.Fatal(err)
	}
	ago := time.Now().Add(-61 * time.Second)
	sec := st.AddSection("提示词库")
	_ = sec
	add := func(text string, done bool) {
		n, _, _ := st.Add(store.Note{Section: store.SectionInbox, Text: text, SourceApp: "Safari"})
		_ = st.SetCreatedAt(n.ID, ago)
		if done {
			_ = st.SetDone(n.ID, true)
		}
	}
	// 与参照一致：列表自上而下 n1 n2 n3（Add 插到顶部，所以倒序加）
	add("记得复核截图遮罩回收后的 Networking 进程占用", true)
	add("SELECT id, title FROM notes WHERE section = 'inbox' ORDER BY created_at DESC LIMIT 50;", false)
	add("会议纪要：周五前完成 mygo 原生版对比报告，附内存与启动耗时。", false)
	add("把这段接口说明发给 Claude：分页参数 page_size 默认 20，最大 200；超过返回 400。", false)
	a := newApp(nopSys{}, st)
	a.target = macos.FrontApp{PID: 42, Name: "Cursor"}
	a.reload()
	for _, scheme := range []string{"light", "dark"} {
		tt := ui.NewTester(a.panelView, 380, 760)
		tt.SetDark(scheme == "dark")
		tt.SetVibrancy(false)
		tt.Move(379, 2)
		tt.Frame()
		got := onWhite(tt.Image())
		save(t, filepath.Join(dir, "mygo-main-"+scheme+".png"), got)
		ref := load(t, filepath.Join(dir, "ref-main-"+scheme+".png"))
		ratio, heat := diff(ref, got)
		save(t, filepath.Join(dir, "diff-main-"+scheme+".png"), heat)
		save(t, filepath.Join(dir, "side-main-"+scheme+".png"), sideBySide(ref, got, heat))
		fmt.Printf("%s: 差异像素 %.2f%%（通道差 > 24，1px 容差）\n", scheme, ratio*100)
	}
}

func onWhite(src *image.RGBA) *image.RGBA {
	out := image.NewRGBA(src.Bounds())
	draw.Draw(out, out.Bounds(), image.White, image.Point{}, draw.Src)
	draw.Draw(out, out.Bounds(), src, src.Bounds().Min, draw.Over)
	return out
}

func diff(a, b image.Image) (float64, *image.RGBA) {
	r := a.Bounds().Intersect(b.Bounds())
	heat := image.NewRGBA(r)
	bad := 0
	for y := r.Min.Y; y < r.Max.Y; y++ {
		for x := r.Min.X; x < r.Max.X; x++ {
			c1 := color.RGBAModel.Convert(a.At(x, y)).(color.RGBA)
			g := uint8(255 - (int(c1.R)+int(c1.G)+int(c1.B))/3/4) // 参照图淡化作底
			// 容差 1px：邻域内有一处颜色相近就算一致（抵消文字抗锯齿的亚像素差）
			d := 999
			for dy := -1; dy <= 1 && d > 24; dy++ {
				for dx := -1; dx <= 1 && d > 24; dx++ {
					c2 := color.RGBAModel.Convert(b.At(x+dx, y+dy)).(color.RGBA)
					d = min(d, max(absd(c1.R, c2.R), absd(c1.G, c2.G), absd(c1.B, c2.B)))
				}
			}
			if d > 24 {
				bad++
				heat.Set(x, y, color.RGBA{255, 0, 60, 255})
			} else {
				heat.Set(x, y, color.RGBA{g, g, g, 255})
			}
		}
	}
	return float64(bad) / float64(r.Dx()*r.Dy()), heat
}

func absd(a, b uint8) int {
	if a > b {
		return int(a - b)
	}
	return int(b - a)
}

func sideBySide(imgs ...image.Image) *image.RGBA {
	w, h := 0, 0
	for _, im := range imgs {
		w += im.Bounds().Dx() + 8
		h = max(h, im.Bounds().Dy())
	}
	out := image.NewRGBA(image.Rect(0, 0, w-8, h))
	draw.Draw(out, out.Bounds(), image.White, image.Point{}, draw.Src)
	x := 0
	for _, im := range imgs {
		draw.Draw(out, image.Rect(x, 0, x+im.Bounds().Dx(), im.Bounds().Dy()), im, im.Bounds().Min, draw.Src)
		x += im.Bounds().Dx() + 8
	}
	return out
}

func save(t *testing.T, path string, img image.Image) {
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := png.Encode(f, img); err != nil {
		t.Fatal(err)
	}
}

func load(t *testing.T, path string) image.Image {
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	img, err := png.Decode(f)
	if err != nil {
		t.Fatal(err)
	}
	return img
}
