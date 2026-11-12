package main

import (
	"fmt"
	"image"
	"math"
	"sync"
	"sync/atomic"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/diag"
	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/shot"
)

// 长截屏（screenshot.rs long + screenshot_long.rs + LongFrameView / LongPreviewView）：
// 遮罩结束后选区四周画框、旁边放预览面板，用户自己滚动页面；定时截取选区、按重叠行拼接，
// 点「完成」进长图标注窗，「取消」或 Esc 放弃。

type longCapture struct {
	region, display shot.Rect // 全局 pt
	front, frontID  string
	frameWin        *mygo.Window
	panelWin        *mygo.Window
	frameID         atomic.Uint32 // 边框窗的 CGWindowID：只截它下面的内容
	stop            atomic.Int32  // shot.Stop
	done            bool

	mu      sync.Mutex
	preview shot.LongPreview
	pw, ph  int // 已拼尺寸（像素）
	stalled bool
	bm      *ui.Bitmap // 预览位图（主线程用）
	bmRows  int
}

const longMinInterval = 60 * time.Millisecond // 取帧最短间隔：画面静止时不空转

func (a *app) shotStartLong(c *ui.Context, d *shotDisplay) {
	e := &d.ed
	if e.sel == nil {
		return
	}
	if len(e.hist.Shapes) > 0 {
		e.flash(c, tr("长截屏不保留标注，请先撤销标注"))
		return
	}
	sel, s := *e.sel, a.shot
	lc := &longCapture{region: shot.Rect{X: d.X + sel.X, Y: d.Y + sel.Y, W: sel.W, H: sel.H},
		display: shot.Rect{X: d.X, Y: d.Y, W: d.W, H: d.H}, front: s.front, frontID: s.frontID}
	a.endShot(false)
	a.longCap.Store(lc)
	go a.runLong(lc)
}

// longEsc：滚动截取中按 Esc（焦点在被截的应用上，由全局键盘 tap 转来）。
func (a *app) longEsc() bool {
	lc := a.longCap.Load()
	if lc == nil {
		return false
	}
	lc.stop.Store(int32(shot.StopCancelled))
	return true
}

func (a *app) runLong(lc *longCapture) {
	time.Sleep(300 * time.Millisecond) // 等遮罩藏好、焦点回到原应用，滚轮事件才落到目标窗口
	opened := make(chan struct{})
	a.panel.Update(func() { a.openLongWindows(lc); close(opened) })
	<-opened
	r := lc.region
	macos.WarpCursor(r.X+r.W/2, r.Y+r.H/2)
	time.Sleep(120 * time.Millisecond)
	// ScreenCaptureKit 连续取帧（macOS 14+，排除本应用窗口）；不可用时退回逐帧截屏
	stream, serr := macos.StartRegionStream(r.X, r.Y, r.W, r.H)
	if serr != nil {
		diag.Push("长截屏 ScreenCaptureKit 不可用，退回逐帧截屏：%v", serr)
	}
	var last time.Time
	capture := func() ([]byte, int, int, error) {
		if stream != nil {
			// 有新帧立即返回；画面静止时最多等 100ms 交回上一帧，循环照常检查完成 / 取消
			pix, w, h, err := stream.Next(100 * time.Millisecond)
			if err == nil {
				return pix, w, h, nil
			}
			diag.Push("长截屏 ScreenCaptureKit 取帧失败，退回逐帧截屏：%v", err)
			stream.Close()
			stream = nil
		}
		if wait := longMinInterval - time.Since(last); wait > 0 {
			time.Sleep(wait)
		}
		last = time.Now()
		if pix, w, h := macos.CaptureRect(r.X, r.Y, r.W, r.H, lc.frameID.Load()); pix != nil {
			return pix, w, h, nil
		}
		img, err := captureRect(mygo.Rectangle{X: int(math.Round(r.X)), Y: int(math.Round(r.Y)), Width: int(math.Round(r.W)), Height: int(math.Round(r.H))})
		if err != nil {
			return nil, 0, 0, err
		}
		return img.Pix, img.Rect.Dx(), img.Rect.Dy(), nil
	}
	started := time.Now()
	first, w, h, err := capture()
	var st *shot.Stitcher
	stop, stats := shot.StopNone, shot.LongStats{}
	if err == nil {
		st = shot.NewStitcher(first, w, h)
		lc.stitched(a, st)
		stop, stats, err = shot.Follow(st, capture, func() shot.Stop { return shot.Stop(lc.stop.Swap(0)) },
			func() { lc.stitched(a, st) }, func(v bool) { lc.setStalled(a, v) }, nil)
	}
	stream.Close()
	a.longCap.CompareAndSwap(lc, nil)
	a.panel.Update(func() {
		lc.frameWin.Destroy()
		lc.panelWin.Destroy()
		if err != nil {
			diag.Push("长截屏失败：%v", err)
			a.showHUD("warn", tr("长截屏失败，详情见诊断日志"))
			return
		}
		ms := time.Since(started).Milliseconds()
		n := max(int64(stats.Frames), 1)
		diag.Push("长截屏 %d×%d 结束=%d 耗时 %dms 帧 %d（平均 %dms，取帧 %dms）接不上 %d（最长连续 %d，其间相邻帧可对齐 %d/%d）最大位移 %d%%",
			st.W, st.TotalH, stop, ms, stats.Frames, ms/n, stats.CaptureMs/n, stats.Misses, stats.LongestMissRun, st.LostAligned, st.LostPairs, st.MaxStep*100/max(h, 1))
		if stop == shot.StopCancelled {
			return
		}
		img := &image.RGBA{Pix: st.Out, Stride: st.W * 4, Rect: image.Rect(0, 0, st.W, st.TotalH)}
		a.openLongEditor(img, float64(st.W)/r.W, lc.display, longOrigin{front: lc.front, frontID: lc.frontID})
	})
}

func (lc *longCapture) stitched(a *app, st *shot.Stitcher) {
	lc.mu.Lock()
	lc.preview.Extend(st.Out, st.W, st.TotalH)
	lc.pw, lc.ph = st.W, st.TotalH
	lc.mu.Unlock()
	lc.refresh()
}

func (lc *longCapture) setStalled(a *app, v bool) {
	lc.mu.Lock()
	lc.stalled = v
	lc.mu.Unlock()
	lc.refresh()
}

func (lc *longCapture) refresh() {
	if lc.panelWin != nil {
		lc.panelWin.Invalidate()
	}
	if lc.frameWin != nil {
		lc.frameWin.Invalidate()
	}
}

func (a *app) openLongWindows(lc *longCapture) {
	r := lc.region
	pad := shot.LongFramePad
	fb := mygo.Rectangle{X: int(math.Round(r.X - pad)), Y: int(math.Round(r.Y - pad)), Width: int(math.Round(r.W + 2*pad)), Height: int(math.Round(r.H + 2*pad))}
	lc.frameWin = mygo.NewWindow(mygo.WindowOptions{
		Title: "Toskr Scrolling Capture", Panel: true, Hidden: true, Frameless: true, Transparent: true, DisableShadow: true, DisableResize: true,
		AlwaysOnTop: true, X: fb.X, Y: fb.Y, Width: fb.Width, Height: fb.Height,
		Content: ui.View(func(c *ui.Context) { a.longFrameView(c, lc) }),
	})
	lc.frameWin.SetBounds(fb)
	macos.MakeBorderless(lc.frameWin.NativeHandle(), true) // 选区贴屏顶时边框不被系统推到菜单栏下（与遮罩同因）
	lc.frameWin.SetIgnoreMouseEvents(true)                 // 滚轮要落到选区下面的页面
	lc.frameWin.SetVisibleOnAllWorkspaces(true)
	lc.frameWin.ShowInactive()
	lc.frameID.Store(macos.WindowNumber(lc.frameWin.NativeHandle()))

	pr := shot.LongPanelRect(lc.display, r)
	pb := mygo.Rectangle{X: int(math.Round(pr.X)), Y: int(math.Round(pr.Y)), Width: int(pr.W), Height: int(math.Round(pr.H))}
	lc.panelWin = mygo.NewWindow(mygo.WindowOptions{
		Title: "Toskr Scrolling Capture", Panel: true, Hidden: true, Frameless: true, Transparent: true, DisableShadow: true, DisableResize: true,
		AlwaysOnTop: true, X: pb.X, Y: pb.Y, Width: pb.Width, Height: pb.Height,
		Content: ui.View(func(c *ui.Context) { a.longPreviewView(c, lc) }),
	})
	lc.panelWin.SetBounds(pb)
	macos.MakeBorderless(lc.panelWin.NativeHandle(), true)
	lc.panelWin.SetVisibleOnAllWorkspaces(true)
	lc.panelWin.ShowInactive()
}

// longFrameView：选区边框（画在选区外）；接不上时变警示色闪烁并提示往回滚。
func (a *app) longFrameView(c *ui.Context, lc *longCapture) {
	c.Root().Background(ui.Transparent)
	lc.mu.Lock()
	stalled := lc.stalled
	lc.mu.Unlock()
	k := tok(c)
	col := stok(c).primary
	if stalled {
		col = k.amberText.Alpha(0.5 + 0.5*float32(math.Abs(math.Cos(float64(c.Root().Loop("pulse", 2*time.Second, ui.Linear))*math.Pi))))
	}
	ui.Box(c).Absolute().Top(2).Left(2).Right(2).Bottom(2).Radius(rr(6)).Border(2, col).AlignItems(ui.Center).Children(func() {
		if !stalled {
			return
		}
		pal := shotColors(c)
		bar := ui.Box(c).Margin(8, 0, 0, 0).Padding(4, 8).Radius(rr(8))
		pal.float(bar).Children(func() { text(c, tr("滚太快接不上，往回滚一点"), 11, 16, 400, k.amberText) })
	})
}

// longPreviewView：整张长图等比缩放完整显示（越拼越长就越细），下方尺寸、提示与 ✕ / ✓。
func (a *app) longPreviewView(c *ui.Context, lc *longCapture) {
	c.Root().Background(ui.Transparent)
	pal := shotColors(c)
	lc.mu.Lock()
	if lc.preview.Rows != lc.bmRows && lc.preview.Rows > 0 {
		img := image.NewRGBA(image.Rect(0, 0, shot.LongPreviewW, lc.preview.Rows))
		copy(img.Pix, lc.preview.RGBA)
		lc.bm, lc.bmRows = ui.NewBitmap(img), lc.preview.Rows
	}
	pw, ph, stalled := lc.pw, lc.ph, lc.stalled
	lc.mu.Unlock()
	W, H := c.Size()
	stopWith := func(s shot.Stop) {
		lc.done = true
		lc.stop.Store(int32(s))
	}
	ui.Column(c).Fill().Gap(8).Children(func() {
		area := ui.Box(c).Grow(1).AlignItems(ui.Start).Justify(ui.Center).Clip()
		area.Children(func() {
			if lc.bm == nil {
				return
			}
			bw, bh := ui.ImageSize(lc.bm)
			maxH := H - 8 - 52 // 下方工具条约 52pt
			s := min(W/bw, maxH/bh)
			ui.Image(c, lc.bm).Size(bw*s, bh*s).Radius(rr(6)).Border(1, gray(1, 0.7)).Shadow(0, 10, 15, -3, gray(0, 0.1)).Shadow(0, 4, 6, -4, gray(0, 0.1))
		})
		bar := ui.Column(c).Padding(6, 8).Gap(4).Radius(rr(8))
		pal.float(bar).Children(func() {
			ui.Row(c).Gap(4).AlignItems(ui.Center).Children(func() {
				label := ""
				if pw > 0 {
					label = fmt.Sprintf("%d × %d", pw, ph)
				}
				text(c, label, 11, 16, 400, pal.muted).Font(fontMono).FontFeatures("tnum").Grow(1)
				if longIconButton(c, pal, "x", tr("取消"), lc.done, nil) {
					stopWith(shot.StopCancelled)
				}
				primary := pal.primary
				if longIconButton(c, pal, "check", tr("完成"), lc.done, &primary) {
					stopWith(shot.StopFinished)
				}
			})
			hint, col := tr("滚动鼠标滚轮或拖动滚动条截取长图"), pal.muted
			if stalled {
				hint, col = tr("滚太快接不上，往回滚一点"), pal.k.amberText
			}
			text(c, hint, 10, 14, 400, col).Wrap()
		})
	})
}

// longIconButton：IconButton sm（24pt，图标 14）。
func longIconButton(c *ui.Context, pal shotPalette, icon, label string, disabled bool, iconColor *ui.Color) bool {
	b := ui.Box(c).Size(22, 22).Radius(rr(8)).Center().Label(label).Role(ui.RoleButton).Key("lb-" + icon)
	fg := pal.muted
	if disabled {
		b.Opacity(0.45)
	} else if b.Hovered() {
		b.Background(pal.hover)
		fg = pal.fg
	}
	if iconColor != nil {
		fg = *iconColor
	}
	b.Children(func() { licon(c, icon, 14, fg) })
	return b.Clicked() && !disabled
}
