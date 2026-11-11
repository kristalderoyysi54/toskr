package main

import (
	"bytes"
	"fmt"
	"image/png"
	"math"
	"time"

	"github.com/egoist/mygo/ui"
)

// 看图层缩放 / 平移（同 Tauri ImagePreviewView + lib/imageZoom.ts）：滚轮 / 双指捏合以光标为锚缩放（0.2×–8×），
// 放大后拖拽平移图片（适配态拖拽仍是拖窗），放大 / 缩小态双击复位；翻页复位。

const (
	minImgZoom = 0.2
	maxImgZoom = 8
)

type zoomView struct{ zoom, x, y float32 }

var fitView = zoomView{zoom: 1}

// zoomAround 同 Tauri zoomViewAround：锚点（相对容器中心）下的图像点保持不动；1× 及以下居中并清零平移。
func zoomAround(v zoomView, next float32, ax, ay float32) zoomView {
	z := min(maxImgZoom, max(minImgZoom, next))
	if z == v.zoom {
		return v
	}
	if z <= 1 {
		return zoomView{zoom: z}
	}
	r := z / v.zoom
	return zoomView{zoom: z, x: ax - r*(ax-v.x), y: ay - r*(ay-v.y)}
}

const (
	detailFullW = 3200 // 看图层常规版最宽：常见截图（≤3200 px）直接用原图像素，不重采样
	detailHiW   = 5120 // 放大时载入的高分辨率版最宽（够 8× 下的视窗宽度，又不至于整张 4K+ 原图常驻内存）
)

// loadDetailHi：后台解码当前这张图的高分辨率版，回主线程挂到它所在的详情窗；期间翻页 / 换图就丢弃。
func (a *app) loadDetailHi() {
	d := &a.detail
	d.hiLoading = true
	file, w, win, p := d.fullFile, d.imgW, a.detailWin, a.curPane
	decode := func() ui.ImageSource {
		raw, err := a.store.LoadImage(file)
		if err != nil {
			return nil
		}
		src, err := png.Decode(bytes.NewReader(raw))
		if err != nil {
			return nil
		}
		return scaledBitmap(src, min(w, detailHiW))
	}
	apply := func(img ui.ImageSource) {
		if a.detailWin != win && p != nil && p.win == win {
			a.usePane(p)
		}
		if a.detail.fullFile == file && a.detail.hiLoading {
			a.detail.hi, a.detail.hiFile, a.detail.hiLoading = img, file, false
		}
	}
	if win == nil { // 无窗口（测试）：同步载入
		apply(decode())
		return
	}
	go func() {
		img := decode()
		win.Update(func() { apply(img) })
	}()
}

const zoomKeyStep = 1.25

// zoomStep：按钮 / ⌘± 以看图区中心缩放一档。
func (a *app) zoomStep(f float32) {
	a.detail.view, a.detail.pan = zoomAround(a.detail.view, max(a.detail.view.zoom, minImgZoom)*f, 0, 0), nil
}

// detailZoomControls：看图区右下角缩放胶囊「− 100% +」（悬停看图区或已缩放时显示）；点百分比适配窗口。
// 叠在图片上，与左右翻页钮同款暗底白字。
func (a *app) detailZoomControls(c *ui.Context, hovered bool) {
	v := a.detail.view
	if v.zoom == 0 {
		v = fitView
	}
	if !hovered && v == fitView {
		return
	}
	fade := ui.ElementTransition{Duration: 120 * time.Millisecond, Ease: easeStandard, Enter: &ui.Motion{}, Exit: &ui.Motion{}}
	ui.Row(c).Absolute().Right(12).Bottom(12).Height(28).Padding(0, 2).Radius(14).AlignItems(ui.Center).Key("zoom-ctl").Transition(fade).
		Background(ui.RGBA(0, 0, 0, 0.45)).Children(func() { // token-exception: 叠在图片上的暗底控件（同翻页钮 bg-black/40）
		btn := func(key, icon, label string, disabled bool) bool {
			b := ui.Box(c).Size(24, 24).Radius(12).Center().Key(key).Role(ui.RoleButton).Label(label).Tooltip(label)
			fg := ui.RGBA(255, 255, 255, 0.85)
			switch {
			case disabled:
				b.Opacity(0.35)
			case b.Hovered():
				b.Background(ui.RGBA(255, 255, 255, 0.16))
				fg = ui.RGB(255, 255, 255)
			}
			b.Children(func() { licon(c, icon, 14, fg) })
			return b.Clicked() && !disabled
		}
		if btn("zoom-out", "minus", tr("缩小（⌘−）"), v.zoom <= minImgZoom) {
			a.zoomStep(1 / zoomKeyStep)
		}
		pct := fmt.Sprintf("%d%%", int(math.Round(float64(v.zoom)*100)))
		fit := ui.Row(c).Height(24).MinWidth(max(44, numSlot(c, "800%", 11, 500)+8)).Padding(0, 4).Radius(12).Justify(ui.Center).AlignItems(ui.Center).Key("zoom-fit").
			Role(ui.RoleButton).Label(tr("适配窗口（⌘0）")).Tooltip(tr("适配窗口（⌘0）"))
		if fit.Hovered() && v != fitView {
			fit.Background(ui.RGBA(255, 255, 255, 0.16))
		}
		fit.Children(func() { text(c, pct, 11, 16, 500, ui.RGB(255, 255, 255)).FontFeatures("tnum") })
		if fit.Clicked() {
			a.detail.view, a.detail.pan = fitView, nil
		}
		if btn("zoom-in", "plus", tr("放大（⌘+）"), v.zoom >= maxImgZoom) {
			a.zoomStep(zoomKeyStep)
		}
	})
}

func init() {
	for k, v := range map[string]string{"缩小（⌘−）": "Zoom out (⌘−)", "放大（⌘+）": "Zoom in (⌘+)", "适配窗口（⌘0）": "Fit to window (⌘0)"} {
		if _, ok := en[k]; !ok {
			en[k] = v
		}
	}
}

// wheelZoomFactor 同 Tauri：负 DY = 放大；指数保证平滑且可逆。
func wheelZoomFactor(dy float32) float32 { return float32(math.Exp(float64(-dy) * 0.0022)) }

// detailZoomLayer：图片层（铺满看图区）。放大后接管拖拽做平移。
func (a *app) detailZoomLayer(c *ui.Context, img ui.ImageSource) {
	d := &a.detail
	if d.view.zoom == 0 {
		d.view = fitView
	}
	if d.view.zoom > 1 && d.imgW > detailFullW { // 放大后常规版会糊：后台载入原图（最宽 detailHiW）
		if d.hiFile == d.fullFile && d.hi != nil {
			img = d.hi
		} else if !d.hiLoading {
			a.loadDetailHi()
		}
	}
	layer := ui.Box(c).Fill().Key("img-zoom")
	b := layer.Bounds()
	layer.HandleInput(func(ev ui.InputEvent) bool {
		ax, ay := ev.X-b.W/2, ev.Y-b.H/2
		switch ev.Kind {
		case ui.InputScroll:
			d.view = zoomAround(d.view, d.view.zoom*wheelZoomFactor(ev.DY), ax, ay)
			return true
		case ui.InputZoom:
			d.view = zoomAround(d.view, d.view.zoom*ev.Scale, ax, ay)
			return true
		case ui.InputPointerDown:
			if ev.Button != 0 || d.view.zoom == 1 {
				return false // 适配态：拖窗 / 双击缩放窗口归系统
			}
			if ev.Clicks >= 2 {
				d.view, d.pan = fitView, nil
				return true
			}
			if d.view.zoom < 1 {
				return false // 缩小态单击拖拽仍是拖窗
			}
			d.pan = &[4]float32{ev.X, ev.Y, d.view.x, d.view.y}
			return true
		case ui.InputPointerMove:
			if p := d.pan; p != nil {
				d.view.x, d.view.y = p[2]+ev.X-p[0], p[3]+ev.Y-p[1]
				return true
			}
		case ui.InputPointerUp:
			if d.pan != nil {
				d.pan = nil
				return true
			}
		}
		return false
	})
	if d.view.zoom > 1 {
		layer.Cursor(map[bool]ui.Cursor{true: ui.CursorGrabbing, false: ui.CursorGrab}[d.pan != nil])
	}
	layer.Children(func() {
		wrap := ui.Box(c).Fill().PassThrough()
		if v := d.view; v != fitView {
			wrap.Scale(v.zoom, v.zoom).Translate(v.x, v.y)
		}
		wrap.Children(func() {
			// 按「张序」重挂载：翻页也有浮现过渡（同 Tauri motion.img initial scale 0.96 → 1）
			ui.Image(c, img).Fill().Fit(ui.Contain).Key("img-" + itoa(d.img)).
				Transition(ui.ElementTransition{Duration: 200 * time.Millisecond, Ease: easeStandard, Enter: &ui.Motion{Scale: 0.96}})
		})
	})
}
