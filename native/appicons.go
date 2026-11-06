package main

import (
	"bytes"
	"image/png"

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
		if raw := appIconPNG(bundle); raw != nil {
			if img, err := png.Decode(bytes.NewReader(raw)); err == nil {
				out = scaledBitmap(img, 80)
			}
		}
		if out != nil {
			a.onMain(func() { a.appIcons[bundle] = out })
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
