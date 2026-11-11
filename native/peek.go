package main

import (
	"bytes"
	"fmt"
	"image/png"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// 紧凑行悬停（同 Tauri CompactRow）：
//   - 全局至多一行处于悬停态（claim）：驱动该行文字跑马灯；
//   - 带图行悬停 360ms 后在光标旁弹原始尺寸窥视窗（不抢焦点、鼠标穿透），离行 / 按下 / 滚走即收；
//   - 只认真实移动：列表滚动把行送到静止指针下不算悬停（指针的窗口坐标没变）。

const (
	peekDelay = 360 * time.Millisecond
	peekPad   = 6
)

type rowHover struct {
	id     string
	at     time.Time // 认领时刻（跑马灯计时起点）
	px, py float32   // 上次看到的指针窗口坐标
	gen    int       // 窥视计时代次：离行 / 换行即作废
	rect   ui.Rect   // 认领行在面板里的位置（窥视窗看门狗用）
}

// compactHover：在紧凑行渲染时调用，返回该行是否为当前悬停行。
func (a *app) compactHover(c *ui.Context, box ui.Element, n store.Note) bool {
	h := &a.rowHov
	_, _, over := box.PointerPosition()
	if !over || box.Pressed() {
		if h.id == n.ID {
			a.releaseRow()
		}
		return false
	}
	px, py, _ := c.Root().PointerPosition()
	if h.id != n.ID {
		if px == h.px && py == h.py {
			return false // 指针没动，是行被滚到了指针下
		}
		a.releaseRow()
		h.id, h.at = n.ID, c.Now()
		if files := n.MediaFiles(); len(files) > 0 && !n.Blur {
			a.armPeek(files)
		}
	}
	h.px, h.py, h.rect = px, py, box.Bounds()
	return true
}

func (a *app) releaseRow() {
	a.rowHov.id = ""
	a.rowHov.gen++
	a.hidePeek()
}

func (a *app) armPeek(files []string) {
	gen := a.rowHov.gen
	if a.panel == nil {
		return
	}
	time.AfterFunc(peekDelay, func() {
		a.panel.Update(func() {
			if a.rowHov.gen == gen && a.rowHov.id != "" && a.panel.IsVisible() {
				a.showPeek(files, gen)
			}
		})
	})
}

// peekFrame 同 Tauri transient_peek_frame：贴光标弹出，上方空间够放就放上方，否则放下方；
// 图片按原始像素当点数、不放大，超出工作区 90% 等比缩小；最小 240×180。
func peekFrame(cx, cy float64, wa mygo.Rectangle, imgW, imgH float64) (x, y, w, h float64) {
	const gapAbove, gapBelow, minW, minH = 12.0, 24.0, 240.0, 180.0
	wx, wy, ww, wh := float64(wa.X), float64(wa.Y), float64(wa.Width), float64(wa.Height)
	imgW, imgH = max(imgW, 1), max(imgH, 1)
	above := cy - gapAbove - wy
	below := wy + wh - (cy + gapBelow)
	capH := max(wh*0.9, minH)
	availH := min(max(max(above, below), min(320, capH)), capH)
	maxW := max(ww*0.9, minW)
	r := min(maxW/imgW, availH/imgH, 1)
	w, h = max(imgW*r, minW), max(imgH*r, minH)
	x = wx
	if ww > w {
		x = min(max(cx-w/2, wx), wx+ww-w)
	}
	if h <= above {
		y = cy - gapAbove - h
	} else {
		y = max(min(cy+gapBelow, wy+wh-h), wy)
	}
	return
}

// loadPeek：解码第 i 张作窥视图（最宽 2400），返回原始像素尺寸。
func (a *app) loadPeek(file string) (ui.ImageSource, int, int, bool) {
	raw, err := a.store.LoadImage(file)
	if err != nil {
		return nil, 0, 0, false
	}
	src, err := png.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, 0, 0, false
	}
	iw, ih := src.Bounds().Dx(), src.Bounds().Dy()
	return scaledBitmap(src, min(iw, 2400)), iw, ih, true
}

// peekStep：窥视中按 ← / → 换张（同 Tauri 预览窗多图：窗按起始张定尺寸，其余张在窗内等比适配）。
func (a *app) peekStep(d int) {
	i := min(max(a.peekIdx+d, 0), len(a.peekFiles)-1)
	if i == a.peekIdx {
		return
	}
	if img, _, _, ok := a.loadPeek(a.peekFiles[i]); ok {
		a.peekImg, a.peekIdx = img, i
		if a.peekWin != nil {
			a.peekWin.Invalidate()
		}
	}
}

func (a *app) showPeek(files []string, gen int) {
	img, iw, ih, ok := a.loadPeek(files[0])
	if !ok {
		return
	}
	a.peekImg, a.peekFiles, a.peekIdx = img, files, 0
	cx, cy := macos.CursorLocation()
	d, ok := displayAt(mygo.Screen.Displays(), int(cx), int(cy))
	if !ok {
		return
	}
	x, y, w, h := peekFrame(cx, cy, d.WorkArea, float64(iw), float64(ih)) // 同 Tauri：原始像素当点数
	x, y, w, h = x-peekPad, y-peekPad, w+2*peekPad, h+2*peekPad           // 外圈留给投影，图本身仍是原始尺寸
	if a.peekWin == nil {
		a.peekWin = mygo.NewWindow(mygo.WindowOptions{
			Title: "Toskr Peek", Panel: true, Hidden: true, Frameless: true, Transparent: true,
			Width: int(w), Height: int(h), DisableResize: true, AlwaysOnTop: true,
			Content: ui.View(a.peekView),
		})
		macos.MakeBorderless(a.peekWin.NativeHandle(), true) // 贴菜单栏附近也不被系统往下挪
		a.peekWin.SetIgnoreMouseEvents(true)
		a.peekWin.SetVisibleOnAllWorkspaces(true)
	}
	a.peekWin.SetBounds(mygo.Rectangle{X: int(x), Y: int(y), Width: int(w), Height: int(h)})
	a.peekWin.Invalidate()
	a.peekWin.ShowInactive()
	a.peekOn = true
	a.peekWatch(gen)
}

// peekWatch 同 Tauri spawn_peek_watchdog：行级离开事件可能漏（指针直接飞出面板），每 150ms 核对光标是否还在触发行（含 12pt 余量）。
func (a *app) peekWatch(gen int) {
	time.AfterFunc(150*time.Millisecond, func() {
		a.panel.Update(func() {
			if !a.peekOn || a.rowHov.gen != gen {
				return
			}
			cx, cy := macos.CursorLocation()
			pb := a.panel.Bounds()
			r := a.rowHov.rect
			const m = 12
			x0, y0 := float64(pb.X)+float64(r.X), float64(pb.Y)+float64(r.Y)
			if !a.panel.IsVisible() || cx < x0-m || cx > x0+float64(r.W)+m || cy < y0-m || cy > y0+float64(r.H)+m {
				a.releaseRow()
				if a.panel.IsVisible() {
					a.panel.Invalidate()
				}
				return
			}
			a.peekWatch(gen)
		})
	})
}

func (a *app) hidePeek() {
	if !a.peekOn {
		return
	}
	a.peekOn = false
	if a.peekWin != nil {
		a.peekWin.Hide()
	}
}

// peekView：窥视窗内容——图片铺满（contain），圆角 + 细边 + 投影；多张时右下角「共 N 张」。
func (a *app) peekView(c *ui.Context) {
	k := tok(c)
	ui.Box(c).Fill().Padding(peekPad).Children(func() {
		card := ui.Box(c).Fill().Radius(10).Clip().Background(k.card).Border(1, k.fg.Alpha(0.1)).Shadow(0, 8, 24, -6, ui.RGBA(0, 0, 0, 0.35)) // token-exception: 浮窗投影
		card.Children(func() {
			if a.peekImg != nil {
				ui.Image(c, a.peekImg).Fill().Fit(ui.Contain)
			}
			if n := len(a.peekFiles); n > 1 { // 张序 + 换张提示（窥视窗鼠标穿透，换张靠面板里的 ← / →）
				ui.Row(c).Absolute().Right(8).Bottom(8).Height(20).Padding(0, 8).Gap(6).Radius(10).AlignItems(ui.Center).
					Background(ui.RGBA(0, 0, 0, 0.55)).Children(func() { // token-exception: 叠在图片上的暗底胶囊
					text(c, fmt.Sprintf("%d / %d", a.peekIdx+1, n), 10, 14, 600, ui.RGB(255, 255, 255)).FontFeatures("tnum")
					text(c, tr("← → 换张"), 10, 14, 400, ui.RGBA(255, 255, 255, 0.7))
				})
			}
		})
	})
}

// marqueeLine 同 Tauri MarqueeLine：悬停行文字溢出时匀速（50pt/s，至少 0.9s）向左滚完被截断的部分，
// 起步停 0.45s、读完停 0.7s 后跳回开头循环（只向左，不回摆）；非悬停 / 减弱动效时单行省略。
func (a *app) marqueeLine(c *ui.Context, key string, active bool, build func() ui.Element) {
	if !active || c.Preferences().ReduceMotion {
		build().SingleLine().Grow(1).Basis(0)
		return
	}
	row := ui.Row(c).Grow(1).Basis(0).Clip().AlignItems(ui.Center).Key("mq-" + key)
	cw := row.Bounds().W
	row.Children(func() {
		el := build().SingleLine().Shrink(0)
		switch over := el.Bounds().W - cw; {
		case cw == 0: // 首帧还没量到宽度
			c.AnimationFrame()
		case over > 4:
			el.Translate(-marqueeOffset(c.Now().Sub(a.rowHov.at), over), 0)
			c.AnimationFrame()
		}
	})
}

func marqueeOffset(t time.Duration, over float32) float32 {
	const startHold, endHold = 450 * time.Millisecond, 700 * time.Millisecond
	scroll := max(900*time.Millisecond, time.Duration(float64(over)/50*float64(time.Second)))
	m := t % (startHold + scroll + endHold)
	switch {
	case m < startHold:
		return 0
	case m < startHold+scroll:
		return over * float32(m-startHold) / float32(scroll)
	}
	return over
}

func init() {
	for k, v := range map[string]string{"← → 换张": "← → to switch"} {
		if _, ok := en[k]; !ok {
			en[k] = v
		}
	}
}
