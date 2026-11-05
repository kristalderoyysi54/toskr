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
	"github.com/toskr/native/internal/store"
)

// 钉图（PinView + screenshot.rs pin_*）：置顶小窗显示一张截图；拖动移动、滚轮缩放（20%–400%）、
// ⌘C 复制、双击或 Esc 关闭、右键菜单（复制 / 存入 / 另存为 / 识别文字 / 透明度 / 原大小 / 关闭）。

type pinWin struct {
	img     *image.RGBA
	bm      *ui.Bitmap
	w, h    float64 // 原大小（pt）
	factor  float64
	alpha   int // 透明度 %
	zoomAt  time.Time
	win     *mygo.Window
	closing bool
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
	p.win.Destroy()
}

func (p *pinWin) png() []byte {
	var buf bytes.Buffer
	_ = (&png.Encoder{CompressionLevel: png.BestSpeed}).Encode(&buf, p.img)
	return buf.Bytes()
}

func (p *pinWin) zoom(at time.Time, f float64) {
	p.factor = math.Min(4, math.Max(0.2, f))
	if p.win != nil {
		p.win.SetSize(max(1, int(math.Round(p.w*p.factor))), max(1, int(math.Round(p.h*p.factor))))
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
	border := stok(c).primary.Alpha(0.4)
	el := ui.Box(c).Fill().Cursor(ui.CursorGrab).DragWindow().
		Tooltip(tr("钉图：拖动移动 · 滚轮缩放 · ⌘C 复制 · 双击或 Esc 关闭 · 右键更多")).
		HandleInput(func(ev ui.InputEvent) bool {
			if ev.Kind != ui.InputScroll {
				return false
			}
			p.zoom(ev.Time, p.factor*(1-float64(ev.DY)*0.002))
			return true
		}).
		Draw(func(pt *ui.Painter, r ui.Rect) {
			pt.ImageRegion(p.bm, ui.Rect{}, r, ui.ImageOptions{})
			pt.Stroke(r, border, 0, 1)
		}).
		ContextMenu(func(m *ui.Menu) { a.pinMenu(c, m, p) })
	if el.DoubleClicked() {
		a.closePin(p)
		return
	}
	// 缩放时在图上短暂显示当前比例
	if left := 900*time.Millisecond - c.Now().Sub(p.zoomAt); !p.zoomAt.IsZero() && left > 0 {
		c.After(left)
		ui.Box(c).Absolute().Top(0).Left(0).Right(0).Bottom(0).Center().PassThrough().Children(func() {
			ui.Box(c).Padding(4, 8).Radius(8).Background(gray(0, 0.7)).Children(func() {
				text(c, fmt.Sprintf("%d%%", int(math.Round(p.factor*100))), 12, 17, 400, colWhite).Font(fontMono).FontFeatures("tnum")
			})
		})
	}
}

func (a *app) pinCopy(p *pinWin) {
	a.sys.Write([]macos.Item{{macos.TypePNG: p.png()}}, false)
	a.showHUD("ok", tr("已复制钉图"))
}

func (a *app) pinMenu(c *ui.Context, m *ui.Menu, p *pinWin) {
	w, h := p.img.Rect.Dx(), p.img.Rect.Dy()
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
		p.zoom(time.Now(), 1)
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
