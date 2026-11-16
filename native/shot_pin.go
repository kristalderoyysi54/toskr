package main

import (
	"bytes"
	"fmt"
	"image"
	"image/png"
	"math"
	"slices"
	"strings"
	"time"
	"unicode"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/shot"
	"github.com/toskr/native/internal/store"
)

// 钉图（PinView + screenshot.rs pin_*）：置顶小窗显示一张截图；拖动移动、滚轮缩放（20%–400%）、
// 拖四边 / 四角等比缩放（对边 / 对角不动，拖上下边时水平居中、拖左右边时竖直居中；样式不变，只换光标）、
// ⌘C 复制、双击或 Esc 关闭、右键菜单（复制 / 存入 / 另存为 / 识别文字 / 透明度 / 原大小 / 关闭）。

type pinWin struct {
	img      *image.RGBA
	bm       *ui.Bitmap
	w, h     float64 // 原大小（pt）
	factor   float64
	alpha    int // 透明度 %
	zoomAt   time.Time
	original *image.RGBA // 编辑标注前的原图（「还原原图」）
	win      *mygo.Window
	frame    pinFrame // 拖动 / 缩放读写的窗口框（即 win；测试换成假窗口）
	closing  bool
	rs       pinResize // 拖动中：平移或缩放把手与起点
	closeReq bool      // 双击关闭，留到下一帧执行
}

type pinFrame interface {
	Bounds() mygo.Rectangle
	SetBounds(mygo.Rectangle)
}

var pinCursor = mygo.Screen.CursorScreenPoint // 屏幕指针（测试替换）

// pinZoomRect：把 r 缩放到 w×h，锚点 (ax, ay)（窗内比例 0–1）在屏幕上不动。
func pinZoomRect(r mygo.Rectangle, w, h int, ax, ay float64) mygo.Rectangle {
	ax, ay = math.Min(1, math.Max(0, ax)), math.Min(1, math.Max(0, ay))
	return mygo.Rectangle{
		X: r.X + int(math.Round(ax*float64(r.Width-w))), Y: r.Y + int(math.Round(ay*float64(r.Height-h))),
		Width: w, Height: h,
	}
}

type pinResize struct {
	edge   string // move = 平移；n / s / e / w / nw / ne / sw / se = 缩放；空 = 未在拖动
	from   mygo.Point
	bounds mygo.Rectangle
}

// pinResizeRect：按把手 edge 与屏幕位移 (dx, dy) 等比缩放 r（宽高比 ar = 宽/高），宽钳在 [minW, maxW]。
// 角把手把位移投影到对角线；含 w / n 的一侧移动、对侧固定，单拖上下边时水平居中、单拖左右边时竖直居中。
func pinResizeRect(edge string, r mygo.Rectangle, dx, dy int, ar, minW, maxW float64) mygo.Rectangle {
	W, H := float64(r.Width), float64(r.Height)
	hasN, hasS := strings.Contains(edge, "n"), strings.Contains(edge, "s")
	hasW, hasE := strings.Contains(edge, "w"), strings.Contains(edge, "e")
	ex, ey := W+float64(dx), H+float64(dy) // 拖动后的角相对固定侧的宽高
	if hasW {
		ex = W - float64(dx)
	}
	if hasN {
		ey = H - float64(dy)
	}
	var w float64
	switch {
	case (hasN || hasS) && (hasE || hasW):
		// 角：投影到对角线上，连续变化。取两轴中较大变化会在两轴反号处换驱动轴，100% 附近跳变
		w = W * (ex*W + ey*H) / (W*W + H*H)
	case hasE || hasW:
		w = ex
	default:
		w = ey * ar
	}
	w = math.Min(maxW, math.Max(minW, w))
	h := w / ar
	x, y := float64(r.X), float64(r.Y)
	switch {
	case hasW:
		x += W - w
	case !hasE:
		x += (W - w) / 2
	}
	switch {
	case hasN:
		y += H - h
	case !hasS:
		y += (H - h) / 2
	}
	return mygo.Rectangle{X: int(math.Round(x)), Y: int(math.Round(y)), Width: max(1, int(math.Round(w))), Height: max(1, int(math.Round(h)))}
}

func (a *app) pinShot(img *image.RGBA, x, y, w, h float64) {
	p := &pinWin{img: img, bm: ui.NewBitmap(img), w: w, h: h, factor: 1, alpha: 100}
	bounds := mygo.Rectangle{X: int(math.Round(x)), Y: int(math.Round(y)), Width: max(1, int(math.Round(w))), Height: max(1, int(math.Round(h)))}
	p.win = mygo.NewWindow(mygo.WindowOptions{
		Title: "Toskr Pin", Frameless: true, AlwaysOnTop: true, DisableResize: true, Hidden: true,
		X: bounds.X, Y: bounds.Y, Width: bounds.Width, Height: bounds.Height,
		Content: ui.View(func(c *ui.Context) { a.pinView(c, p) }),
	})
	p.win.SetBounds(bounds)
	p.frame = p.win
	macos.MakeBorderless(p.win.NativeHandle(), false) // 钉图落在截图原位：贴屏顶时不被推到菜单栏下
	p.win.SetVisibleOnAllWorkspaces(true)
	p.win.OnClosed(func() { a.pins = slices.DeleteFunc(a.pins, func(q *pinWin) bool { return q == p }) })
	a.pins = append(a.pins, p)
	p.win.Show()
}

func (a *app) closePin(p *pinWin) {
	if p.closing {
		return
	}
	p.closing = true
	a.pins = slices.DeleteFunc(a.pins, func(q *pinWin) bool { return q == p })
	if p.win != nil { // 无头测试没有真窗口
		p.win.Destroy()
	}
}

func (p *pinWin) png() []byte {
	var buf bytes.Buffer
	_ = (&png.Encoder{CompressionLevel: png.BestSpeed}).Encode(&buf, p.img)
	return buf.Bytes()
}

// zoom 以窗内比例 (ax, ay) 处为锚点缩放：滚轮传指针位置（指针下的像素不动），「恢复原大小」传左上角。
func (p *pinWin) zoom(at time.Time, f, ax, ay float64) {
	p.factor = math.Min(4, math.Max(0.2, f))
	if p.frame != nil {
		w, h := max(1, int(math.Round(p.w*p.factor))), max(1, int(math.Round(p.h*p.factor)))
		p.frame.SetBounds(pinZoomRect(p.frame.Bounds(), w, h, ax, ay))
	}
	p.zoomAt = at
}

func (a *app) pinView(c *ui.Context, p *pinWin) {
	c.Root().Background(ui.Transparent)
	if c.Shortcut(0, ui.KeyEscape) {
		a.closePin(p)
		return
	}
	if c.Shortcut(ui.Cmd, ui.KeyC) {
		a.pinCopy(p)
	}
	if p.closeReq {
		a.closePin(p)
		return
	}
	border := stok(c).primary.Alpha(0.4)
	cur := ui.CursorGrab
	if p.rs.edge == "move" {
		cur = ui.CursorGrabbing
	}
	el := tipOf(c, ui.Box(c).Fill().Cursor(cur), tr("钉图：拖动移动 · 拖边缘缩放 · 滚轮缩放 · ⌘C 复制 · 双击或 Esc 关闭 · 右键更多")).
		HandleInput(p.dragInput("move")).
		Draw(func(pt *ui.Painter, r ui.Rect) {
			pt.ImageRegion(p.bm, ui.Rect{}, r, ui.ImageOptions{})
			pt.Stroke(r, border, 0, 1)
		}).
		ContextMenu(func(m *ui.Menu) { a.pinMenu(c, m, p) })
	if el.DoubleClicked() { // 无窗口（测试）时按下不被拖动接管，双击走这里
		a.closePin(p)
		return
	}
	pinHandles(c, p)
	// 缩放时在图上短暂显示当前比例
	if left := 900*time.Millisecond - c.Now().Sub(p.zoomAt); !p.zoomAt.IsZero() && left > 0 {
		c.After(left)
		ui.Box(c).Absolute().Top(0).Left(0).Right(0).Bottom(0).Center().PassThrough().Children(func() {
			ui.Box(c).Padding(4, 8).Radius(rr(8)).Background(gray(0, 0.7)).Children(func() {
				text(c, fmt.Sprintf("%d%%", int(math.Round(p.factor*100))), 12, 17, 400, colWhite).Font(fontMono).FontFeatures("tnum").MinWidth(36).TextAlign(ui.Center) // 等宽字体 4 字符宽，99%→100% 胶囊不变宽
			})
		})
	}
}

// dragInput：同截图选区的拖动——按下即接管指针，之后的 Move / Up 都送到这里（指针出窗也是）。
// edge = "move" 平移，其余为缩放把手。位移取屏幕坐标：窗口在指针下移动，窗内坐标会漂。
// 滚轮也在这里：把手盖住边缘，滚轮落在把手上同样要缩放。
func (p *pinWin) dragInput(edge string) func(ui.InputEvent) bool {
	return func(ev ui.InputEvent) bool {
		switch ev.Kind {
		case ui.InputScroll:
			ax, ay := 0.0, 0.0 // 锚点 = 指针在窗内的比例（屏幕坐标算，与落在哪个把手无关）
			if p.frame != nil {
				b, pt := p.frame.Bounds(), pinCursor()
				ax, ay = float64(pt.X-b.X)/float64(max(1, b.Width)), float64(pt.Y-b.Y)/float64(max(1, b.Height))
			}
			p.zoom(ev.Time, p.factor*(1-float64(ev.DY)*0.002), ax, ay)
			return true
		case ui.InputPointerDown:
			if ev.Button != 0 || p.frame == nil {
				return false
			}
			if edge == "move" && ev.Clicks >= 2 {
				p.closeReq = true // 关窗留到下一帧，不在事件分发里销毁窗口
				return true
			}
			p.rs = pinResize{edge: edge, from: pinCursor(), bounds: p.frame.Bounds()}
			return true
		case ui.InputPointerMove, ui.InputPointerUp:
			if p.rs.edge != edge {
				return false
			}
			p.dragTo(pinCursor(), ev.Time)
			if ev.Kind == ui.InputPointerUp {
				p.rs = pinResize{}
			}
			return true
		}
		return false
	}
}

func (p *pinWin) dragTo(pt mygo.Point, at time.Time) {
	g := p.rs
	dx, dy := pt.X-g.from.X, pt.Y-g.from.Y
	r := g.bounds
	if g.edge == "move" {
		r.X, r.Y = r.X+dx, r.Y+dy
	} else {
		r = pinResizeRect(g.edge, g.bounds, dx, dy, p.w/p.h, p.w*0.2, p.w*4)
		p.factor = float64(r.Width) / p.w
		p.zoomAt = at // 同滚轮缩放：短暂显示当前比例
	}
	if r != p.frame.Bounds() {
		p.frame.SetBounds(r)
	}
}

// pinHandles：四边与四角的透明缩放把手（只换光标，不改钉图样式），盖在拖动区之上。
func pinHandles(c *ui.Context, p *pinWin) {
	W, H := float32(p.w*p.factor), float32(p.h*p.factor)
	t := min(6, min(W, H)/5)   // 边把手厚度：小图收窄，留出中间的拖动区
	cs := min(14, min(W, H)/3) // 角把手边长
	for _, e := range []string{"n", "s", "w", "e", "nw", "ne", "sw", "se"} {
		hb := ui.Box(c).Absolute().Key("pin-h-" + e).Cursor(handleCursor(shot.Handle(e)))
		if len(e) == 1 {
			if e == "n" || e == "s" {
				hb.Left(cs).Right(cs).Height(t)
			} else {
				hb.Top(cs).Bottom(cs).Width(t)
			}
		} else {
			hb.Width(cs).Height(cs)
		}
		if strings.Contains(e, "n") {
			hb.Top(0)
		}
		if strings.Contains(e, "s") {
			hb.Bottom(0)
		}
		if strings.Contains(e, "w") {
			hb.Left(0)
		}
		if strings.Contains(e, "e") {
			hb.Right(0)
		}
		hb.HandleInput(p.dragInput(e))
	}
}

func (a *app) pinCopy(p *pinWin) {
	a.sys.Write([]macos.Item{{macos.TypePNG: p.png()}}, false)
	a.showHUD("ok", tr("已复制钉图"))
}

func (a *app) pinMenu(c *ui.Context, m *ui.Menu, p *pinWin) {
	w, h := p.img.Rect.Dx(), p.img.Rect.Dy()
	if m.Item(tr("编辑标注…")).Chosen() {
		a.pinEdit(p)
	}
	if m.Item(tr("还原原图")).Disabled(p.original == nil).Chosen() {
		a.pinRestore(p)
	}
	m.Separator()
	if m.Item(tr("复制")).Chosen() {
		a.pinCopy(p)
	}
	if m.Item(tr("存入「剪贴」")).Chosen() {
		a.storeShot(p.png(), w, h, shotSave, "", "", "", "")
	}
	m.Submenu(tr("存入分组"), func(sm *ui.Menu) {
		n := 0
		for _, sec := range a.store.Sections() {
			if sec.ID == store.SectionClipboard {
				continue
			}
			n++
			if sm.Item(sectionName(sec)).Chosen() {
				a.storeShot(p.png(), w, h, shotSection, sec.ID, "", "", "")
			}
		}
		if n == 0 {
			sm.Item(tr("没有可存入的分组")).Disabled(true)
		}
	})
	if m.Item(tr("另存为图片…")).Chosen() {
		go a.saveShotAs(p.png())
	}
	if m.Item(tr("识别文字并复制")).Chosen() {
		go a.pinOCR(p)
	}
	m.Separator()
	m.Submenu(tr("透明度"), func(sm *ui.Menu) {
		for _, pct := range []int{100, 80, 60, 40} {
			if sm.Item(fmt.Sprintf("%d%%", pct)).Radio(p.alpha == pct).Chosen() {
				p.alpha = pct
				p.win.SetOpacity(float64(pct) / 100)
			}
		}
	})
	if m.Item(tr("恢复原大小")).Chosen() {
		p.zoom(time.Now(), 1, 0, 0)
	}
	m.Separator()
	if m.Item(tr("关闭")).Chosen() {
		a.closePin(p)
	}
	if m.Item(tr("关闭全部钉图")).Chosen() {
		for _, q := range slices.Clone(a.pins) {
			a.closePin(q)
		}
	}
}

// pinOCR：识别钉图文字并复制（不入库）。
func (a *app) pinOCR(p *pinWin) {
	lines, err := ocrImage(p.img)
	texts := make([]string, len(lines))
	for i, l := range lines {
		texts[i] = l.Text
	}
	text := strings.Join(texts, "\n")
	a.panel.Update(func() {
		if err != nil || strings.TrimSpace(text) == "" {
			a.showHUD("warn", tr("未识别到文字"))
			return
		}
		a.sys.Write([]macos.Item{{macos.TypeString: []byte(text)}}, false)
		n := 0
		for _, r := range text {
			if !unicode.IsSpace(r) {
				n++
			}
		}
		a.showHUD("ok", fmt.Sprintf(tr("已复制识别出的 %d 字"), n))
	})
}
