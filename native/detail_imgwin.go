package main

import (
	"github.com/egoist/mygo"

	"github.com/toskr/native/internal/store"
)

// 看图窗尺寸（同 Tauri preview_image_on_main 常规预览）：原始像素当点数、小图不放大，最大到工作区 90%，
// 外加标题栏 / 页脚等 chrome。图片卡开窗即按图定尺寸；图文卡点开图时把详情窗临时放大到图的尺寸，回正文还原。

// imageChrome：看图层除图片外的高度——标题栏 38 + 看图区上下留白 16 + 页脚 28，图片卡另有文字备注条 39。
func imageChrome(n store.Note) int {
	if n.Kind == "image" {
		return 121
	}
	return 82
}

func imageWindowFrame(wa mygo.Rectangle, imgW, imgH, chrome int) mygo.Rectangle {
	if imgW <= 0 || imgH <= 0 {
		imgW, imgH = 800, 600
	}
	maxW := max(float64(wa.Width)*0.9, 240)
	maxH := max(float64(wa.Height)*0.9-float64(chrome), 180)
	r := min(maxW/float64(imgW), maxH/float64(imgH), 1)
	w := max(int(float64(imgW)*r+16), 380) // +16：看图区左右留白；380 = 窗口最小宽
	h := max(int(float64(imgH)*r)+chrome, 300)
	return mygo.Rectangle{X: wa.X + (wa.Width-w)/2, Y: wa.Y + (wa.Height-h)/2, Width: w, Height: h}
}

// detailWorkArea：面板所在屏的工作区（详情 / 看图窗都开在这里）。
func (a *app) detailWorkArea() mygo.Rectangle {
	wa := mygo.Rectangle{Width: 1440, Height: 900}
	if a.panel != nil {
		b := a.panel.Bounds()
		if d, ok := displayAt(mygo.Screen.Displays(), b.X+b.Width/2, b.Y+b.Height/2); ok {
			wa = d.WorkArea
		}
	}
	return wa
}

// rememberDetailSize：只记文字详情窗的尺寸；按图定尺寸的窗不记，图文卡看图中关窗记放大前的尺寸。
func (a *app) rememberDetailSize(win *mygo.Window) {
	switch d := a.detail; {
	case d.galleryBack != nil:
		a.detailSize[0], a.detailSize[1] = d.galleryBack.Width, d.galleryBack.Height
	case !d.imgSized:
		a.detailSize[0], a.detailSize[1] = win.Size()
	}
}

// enterGalleryFrame：图文卡点开图——详情窗放大到这张图的看图尺寸（居中在窗口所在屏），记下原位置以便返回。
func (a *app) enterGalleryFrame(n store.Note) {
	win := a.detailWin
	if win == nil || a.detail.imgSized || a.detail.galleryBack != nil {
		return
	}
	b := win.Bounds()
	a.detail.galleryBack = &b
	wa := a.detailWorkArea()
	if d, ok := displayAt(mygo.Screen.Displays(), b.X+b.Width/2, b.Y+b.Height/2); ok {
		wa = d.WorkArea
	}
	win.SetBounds(imageWindowFrame(wa, a.detail.imgW, a.detail.imgH, imageChrome(n)))
}

// exitGallery：回到正文，窗口还原到看图前的位置与尺寸。
func (a *app) exitGallery() {
	a.detail.gallery = false
	if back := a.detail.galleryBack; back != nil {
		a.detail.galleryBack = nil
		if a.detailWin != nil {
			a.detailWin.SetBounds(*back)
		}
	}
}
