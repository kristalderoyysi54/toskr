package main

import (
	"bytes"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/toskr/native/internal/store"
)

// 菜单栏图标状态优先级：权限 → 逾期 → 暂停 → 隐身 → 正常；图标旁标题只在开启设置且今天还有未到期任务时给时间。
func TestTrayStatePriority(t *testing.T) {
	a, _ := testApp(t)
	a.permAX = true
	a.tapReceiving.Store(true)
	now := time.Date(2026, 11, 10, 10, 0, 0, 0, time.Local)
	a.clock = func() time.Time { return now }
	if got := a.trayState(); got != "normal" {
		t.Fatalf("默认 %q", got)
	}
	a.patchSettings(func(x *store.Settings) { x.Stealth = true })
	if got := a.trayState(); got != "stealth" {
		t.Fatalf("隐身 %q", got)
	}
	a.patchSettings(func(x *store.Settings) { x.ClipboardWatch, x.ClipPauseUntil = true, now.Add(time.Hour) })
	if got := a.trayState(); got != "paused" {
		t.Fatalf("暂停优先于隐身 %q", got)
	}
	a.store.AddTask(store.Task{Text: "逾期的", DueAt: now.Add(-time.Hour)})
	a.store.AddTask(store.Task{Text: "下午的", DueAt: now.Add(4*time.Hour + 30*time.Minute)})
	a.store.AddTask(store.Task{Text: "明天的", DueAt: now.Add(30 * time.Hour)})
	a.reload()
	if got := a.trayState(); got != "overdue" {
		t.Fatalf("逾期优先于暂停 %q", got)
	}
	a.permAX = false
	if got := a.trayState(); got != "perm" {
		t.Fatalf("权限最优先 %q", got)
	}
	if a.trayTitle() != "" {
		t.Fatal("未开启设置不显示标题")
	}
	a.patchSettings(func(x *store.Settings) { x.TrayNextDue = true })
	if got := a.trayTitle(); got != "14:30" {
		t.Fatalf("下一个到期 %q", got)
	}
}

// 图标合成：暂停 / 隐身仍是模板图（只有黑 + 透明），逾期 / 权限带色点且底图随菜单栏深浅着色。
func TestTrayIconVariants(t *testing.T) {
	decode := func(b []byte) *image.NRGBA {
		src, err := png.Decode(bytes.NewReader(b))
		if err != nil {
			t.Fatal(err)
		}
		out := image.NewNRGBA(src.Bounds())
		draw.Draw(out, out.Rect, src, src.Bounds().Min, draw.Src)
		return out
	}
	base := decode(trayPNG)
	alpha := func(img *image.NRGBA) (sum int) {
		for i := 3; i < len(img.Pix); i += 4 {
			sum += int(img.Pix[i])
		}
		return
	}
	colored := func(img *image.NRGBA) (n int) {
		for i := 0; i < len(img.Pix); i += 4 {
			if img.Pix[i+3] > 200 && int(img.Pix[i])-int(img.Pix[i+2]) > 80 {
				n++
			}
		}
		return
	}
	if out, tmpl := trayIconFor(trayPNG, "normal", false); !tmpl || !bytes.Equal(out, trayPNG) {
		t.Fatal("正常态用原图")
	}
	var sheet []*image.NRGBA
	for _, c := range []struct {
		state      string
		dark, tmpl bool
	}{{"normal", false, true}, {"paused", false, true}, {"stealth", false, true}, {"overdue", false, false}, {"perm", false, false}, {"overdue", true, false}} {
		out, tmpl := trayIconFor(trayPNG, c.state, c.dark)
		img := decode(out)
		if tmpl != c.tmpl || img.Rect != base.Rect {
			t.Fatalf("%s template=%v", c.state, tmpl)
		}
		switch c.state {
		case "stealth":
			if a := alpha(img); a >= alpha(base)/2 || a == 0 {
				t.Fatalf("隐身应整体变淡 %d / %d", a, alpha(base))
			}
		case "paused":
			if colored(img) != 0 || bytes.Equal(img.Pix, base.Pix) {
				t.Fatal("暂停应只改黑色与透明度")
			}
		case "overdue", "perm":
			if colored(img) < 20 {
				t.Fatalf("%s 应有色点 %d", c.state, colored(img))
			}
		}
		sheet = append(sheet, img)
	}
	// 深色菜单栏：底图着白
	dark := sheet[len(sheet)-1]
	white := 0
	for i := 0; i < len(dark.Pix); i += 4 {
		if dark.Pix[i+3] > 200 && dark.Pix[i] > 240 && dark.Pix[i+2] > 240 {
			white++
		}
	}
	if white == 0 {
		t.Fatal("深色菜单栏下底图应为白色")
	}
	if dir := os.Getenv("TOSKR_SHOT_DIR"); dir != "" { // 目检：浅 / 深菜单栏底上各排一行，放大 4 倍
		const s, pad = 4, 12
		w, h := base.Rect.Dx(), base.Rect.Dy()
		out := image.NewNRGBA(image.Rect(0, 0, (w*s+pad)*len(sheet)+pad, (h*s+pad)*2+pad))
		for row, bg := range []color.NRGBA{{236, 236, 236, 255}, {40, 40, 42, 255}} {
			y0 := pad + row*(h*s+pad)
			draw.Draw(out, image.Rect(0, y0-pad/2, out.Rect.Dx(), y0+h*s+pad/2), &image.Uniform{bg}, image.Point{}, draw.Src)
			for i, c := range []string{"normal", "paused", "stealth", "overdue", "perm"} {
				raw, tmpl := trayIconFor(trayPNG, c, row == 1)
				img := decode(raw)
				for y := 0; y < h*s; y++ {
					for x := 0; x < w*s; x++ {
						px := img.NRGBAAt(x/s, y/s)
						if tmpl && row == 1 { // 模板图由系统着色：深色菜单栏下为白
							px.R, px.G, px.B = 255, 255, 255
						}
						draw.Draw(out, image.Rect(pad+i*(w*s+pad)+x, y0+y, pad+i*(w*s+pad)+x+1, y0+y+1), &image.Uniform{px}, image.Point{}, draw.Over)
					}
				}
			}
		}
		save(t, filepath.Join(dir, "tray-states.png"), out)
	}
}
