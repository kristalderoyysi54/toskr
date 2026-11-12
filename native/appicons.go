package main

import (
	"bytes"
	"image"
	"image/png"
	"math"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// 来源应用图标（同 Tauri useAppIcon）：按 bundle 后台取一次、缩到 80px 缓存（失败也缓存 nil）。
var (
	appIconPNG   = macos.AppIconPNG
	appIconAsync = func(f func()) { go f() } // 测试改为同步
)

func (a *app) appIcon(bundle string) ui.ImageSource {
	if bundle == "" {
		return nil
	}
	if img, ok := a.appIcons[bundle]; ok {
		return img
	}
	a.appIcons[bundle] = nil // 占位：加载中不重复发起
	appIconAsync(func() {
		var out ui.ImageSource
		var col ui.Color
		if raw := appIconPNG(bundle); raw != nil {
			if img, err := png.Decode(bytes.NewReader(raw)); err == nil {
				out, col = scaledBitmap(img, 80), dominantColor(img)
			}
		}
		if out != nil {
			a.onMain(func() {
				a.appIcons[bundle] = out
				if a.appIconColors == nil {
					a.appIconColors = map[string]ui.Color{}
				}
				a.appIconColors[bundle] = col
			})
		}
	})
	return nil
}

// sourceIcon 画来源应用图标（size×size）；没有图标时什么也不画。
func (a *app) sourceIcon(c *ui.Context, n store.Note, size float32) {
	if img := a.appIcon(n.BundleID); img != nil {
		ui.Image(c, img).Size(size, size)
	}
}

// appIconColor：来源应用图标主色（图标还没取到时 ok = false）。
func (a *app) appIconColor(bundle string) (ui.Color, bool) {
	a.appIcon(bundle)
	c, ok := a.appIconColors[bundle]
	return c, ok
}

// dominantColor 同 Tauri focus.rs dominant_color：忽略透明与近白 / 近黑 / 灰度像素，16 级色相桶按饱和度加权取主色，
// 亮度压到 ≤ 0.62（可承载白字）；纯灰度图标给中性灰 #5b5b60。
func dominantColor(img image.Image) ui.Color {
	type acc struct{ r, g, b, w float64 }
	var buckets [16]acc
	bd := img.Bounds()
	step := max(1, bd.Dx()/64) // 大图抽样，结果与逐像素一致到肉眼不可分
	for y := bd.Min.Y; y < bd.Max.Y; y += step {
		for x := bd.Min.X; x < bd.Max.X; x += step {
			r16, g16, b16, a16 := img.At(x, y).RGBA()
			if a16 < 0x8000 {
				continue
			}
			// 预乘还原
			rf, gf, bf := float64(r16)/float64(a16), float64(g16)/float64(a16), float64(b16)/float64(a16)
			mx, mn := math.Max(rf, math.Max(gf, bf)), math.Min(rf, math.Min(gf, bf))
			sat := 0.0
			if mx > 0 {
				sat = (mx - mn) / mx
			}
			w := sat * sat * mx * (1 - math.Abs(mx-0.5)*0.5)
			if w <= 0.02 {
				continue
			}
			hue := 0.0
			switch {
			case mx == mn:
			case mx == rf:
				hue = math.Mod(60*(gf-bf)/(mx-mn)+360, 360)
			case mx == gf:
				hue = 60*(bf-rf)/(mx-mn) + 120
			default:
				hue = 60*(rf-gf)/(mx-mn) + 240
			}
			e := &buckets[min(int(hue/22.5), 15)]
			e.r, e.g, e.b, e.w = e.r+rf*w, e.g+gf*w, e.b+bf*w, e.w+w
		}
	}
	best := buckets[0]
	for _, e := range buckets[1:] {
		if e.w > best.w {
			best = e
		}
	}
	if best.w <= 0 {
		return ui.RGB(0x5b, 0x5b, 0x60)
	}
	r, g, b := best.r/best.w, best.g/best.w, best.b/best.w
	if lum := 0.2126*r + 0.7152*g + 0.0722*b; lum > 0.62 {
		k := 0.62 / lum
		r, g, b = r*k, g*k, b*k
	}
	to := func(v float64) uint8 { return uint8(math.Round(math.Min(1, math.Max(0, v)) * 255)) }
	return ui.RGB(to(r), to(g), to(b))
}
