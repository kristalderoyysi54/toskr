package main

import (
	"bytes"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"strings"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
	"golang.org/x/image/draw"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// thumbPx 是卡片缩略图的像素宽（300 DIP × 2 倍屏）。只缓存缩略图，原图用完即弃。
const thumbPx = 600

func (a *app) thumb(name string) ui.ImageSource {
	if img, ok := a.thumbs[name]; ok {
		return img
	}
	var out ui.ImageSource
	if raw, err := a.store.LoadImage(name); err == nil {
		if src, err := png.Decode(bytes.NewReader(raw)); err == nil {
			out = scaledBitmap(src, thumbPx)
		}
	}
	a.thumbs[name] = out // 失败也缓存 nil，避免每帧重解
	return out
}

func scaledBitmap(src image.Image, maxW int) *ui.Bitmap {
	b := src.Bounds()
	if b.Dx() <= maxW {
		return ui.NewBitmap(src)
	}
	h := b.Dy() * maxW / b.Dx()
	dst := image.NewRGBA(image.Rect(0, 0, maxW, h))
	draw.ApproxBiLinear.Scale(dst, dst.Bounds(), src, b, draw.Src, nil)
	bm := ui.NewBitmap(dst)
	return bm
}

// withTempImage 把加密图片解到 0600 临时文件交给系统 API，用完立即删除。
func (a *app) withTempImage(name string, fn func(path string)) error {
	raw, err := a.store.LoadImage(name)
	if err != nil {
		return err
	}
	dir, err := os.MkdirTemp("", "toskr-img-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "img.png")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		return err
	}
	fn(path)
	return nil
}

func (a *app) ocrNote(n store.Note) {
	a.aiBusy = n.ID
	go func() {
		var text string
		var ocrErr error
		err := a.withTempImage(n.ImageFile, func(p string) { text, ocrErr = macos.OCR(p, []string{"zh-Hans", "en-US"}) })
		if err == nil {
			err = ocrErr
		}
		a.panel.Update(func() {
			a.aiBusy = ""
			switch {
			case err != nil:
				a.showHUD("warn", tr("识别失败：")+err.Error())
			case strings.TrimSpace(text) == "":
				a.showHUD("info", tr("没有识别到文字"))
			default:
				_ = a.store.Update(n.ID, text)
				a.showHUD("added", tr("已识别 ")+itoa(len([]rune(text)))+tr(" 字"))
			}
		})
	}()
}

// pinImage 把图片钉成置顶小窗（双击或 Esc 关闭，关闭即销毁窗口释放位图）。
func (a *app) pinImage(n store.Note) {
	raw, err := a.store.LoadImage(n.ImageFile)
	if err != nil {
		a.showHUD("warn", err.Error())
		return
	}
	src, err := png.Decode(bytes.NewReader(raw))
	if err != nil {
		return
	}
	bm := scaledBitmap(src, 1600)
	w, h := ui.ImageSize(bm)
	scale := min(1, 640/w, 480/h)
	dw, dh := int(w*scale), int(h*scale)
	var win *mygo.Window
	win = mygo.NewWindow(mygo.WindowOptions{
		Title: "Toskr Pin", Frameless: true, AlwaysOnTop: true, Width: dw, Height: dh, CornerRadius: 8,
		Content: ui.View(func(c *ui.Context) {
			c.Root().Background(ui.Transparent)
			if c.Shortcut(0, ui.KeyEscape) {
				win.Destroy()
			}
			img := ui.Image(c, bm).Fill().DragWindow()
			if img.DoubleClicked() {
				win.Destroy()
			}
		}),
	})
	win.SetVisibleOnAllWorkspaces(true)
	win.Center()
	win.Show()
}

// copyPrivate 写临时类型剪贴板：本应用与其他剪贴板管理器都不记录（秘文、口令封装结果）。
func (a *app) copyPrivate(text string) {
	a.sys.Write([]macos.Item{{macos.TypeString: []byte(text)}}, true)
}
