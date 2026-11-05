package main

import (
	"bytes"
	"fmt"
	"image"
	"image/png"
	"math"
	"slices"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/shot"
)

// 长图标注窗（LongShotView）：可滚动查看拼好的长截屏，用与遮罩相同的工具标注，可裁剪；
// 完成后存入「剪贴」/ 分组 / 另存为。从钉图打开时 ✓ 改为更新那张钉图。

type longOrigin struct {
	front, frontID string
	pin            *pinWin // 非空：✓ 写回这张钉图
}

type longCropDrag struct {
	handle shot.Handle
	x, y   float64
	orig   shot.Rect
}

type longEditor struct {
	d        *shotDisplay // 图片当作一块「屏」：W/H 为图片 pt，sx = sy = 像素 / pt
	origin   longOrigin
	win      *mygo.Window
	crop     *shot.Rect // 裁剪框（图片 pt），nil = 整张
	cropping bool
	cropDrag *longCropDrag
	hover    ui.Cursor
	z        float64 // 显示倍率（宽于窗口时等比缩小）
	closed   bool
}

func (a *app) openLongEditor(img *image.RGBA, scale float64, display shot.Rect, origin longOrigin) *longEditor {
	pxW, pxH := img.Rect.Dx(), img.Rect.Dy()
	d := &shotDisplay{W: float64(pxW) / scale, H: float64(pxH) / scale, pxW: pxW, pxH: pxH, sx: scale, sy: scale, img: img, bm: ui.NewBitmap(img)}
	le := &longEditor{d: d, origin: origin, z: 1}
	winW := math.Min(math.Max(d.W+48, 680), display.W*0.9)
	winH := math.Min(math.Max(d.H+120, 400), display.H*0.85)
	title := fmt.Sprintf(tr("长截屏 %d×%d"), pxW, pxH)
	if origin.pin != nil {
		title = fmt.Sprintf(tr("编辑钉图 %d×%d"), pxW, pxH)
	}
	le.win = mygo.NewWindow(mygo.WindowOptions{
		Title: title, Width: int(winW), Height: int(winH), UseContentSize: true, MinWidth: 640, MinHeight: 400, AlwaysOnTop: true, Hidden: true,
		X: int(display.X + (display.W-winW)/2), Y: int(display.Y + (display.H-winH)/2),
		Content: ui.View(func(c *ui.Context) { a.longEditorView(c, le) }),
	})
	le.win.OnClosed(func() { le.closed = true })
	le.win.SetVisibleOnAllWorkspaces(true)
	macos.ActivateSelf()
	le.win.Show()
	le.win.Focus()
	return le
}

func (le *longEditor) close() {
	if le.closed {
		return
	}
	le.closed = true
	if le.win != nil {
		le.win.Destroy()
	}
}

// finish：出图（标注 + 裁剪 + 圆角阴影）后写回来源，或按动作存入 / 另存为，随后关窗。
func (a *app) longFinish(le *longEditor, act shotAction, section string) {
	d, e := le.d, &le.d.ed
	sel := shot.Rect{W: d.W, H: d.H}
	if le.crop != nil {
		sel = *le.crop
	}
	shapes := e.allShapes()
	out := renderShot(d, sel, shapes, a.shotFrame())
	if out == nil {
		return
	}
	caption := shot.CalloutPrompt(shapes, tr("图上的标注（序号对应图中区域）："))
	le.close()
	if act == shotSave && le.origin.pin != nil {
		a.pinReplace(le.origin.pin, out)
		return
	}
	var buf bytes.Buffer
	_ = (&png.Encoder{CompressionLevel: png.BestSpeed}).Encode(&buf, out)
	if act == shotSaveAs {
		go a.saveShotAs(buf.Bytes())
		return
	}
	a.storeShot(buf.Bytes(), out.Rect.Dx(), out.Rect.Dy(), act, section, caption, le.origin.front, le.origin.frontID)
}

func (a *app) longKeys(c *ui.Context, le *longEditor) {
	e := &le.d.ed
	if e.editing != nil || e.note != nil {
		return
	}
	if !e.sectionMenu && e.pickedShape() != nil {
		switch {
		case c.Shortcut(0, ui.KeyBackspace) || c.Shortcut(0, ui.KeyDelete):
			e.replacePicked(e.pickedShape(), nil)
			return
		case c.Shortcut(0, ui.KeyEscape):
			e.picked = nil
			return
		}
	}
	switch {
	case c.Shortcut(0, ui.KeyEscape):
		switch {
		case e.sectionMenu:
			e.sectionMenu = false
		case le.cropping:
			le.cropping = false
		case e.tool != "":
			e.tool = ""
		default:
			le.close()
		}
	case c.Shortcut(ui.Cmd, ui.KeyZ):
		e.hist = shot.Undo(e.hist)
	case c.Shortcut(ui.Cmd|ui.Shift, ui.KeyZ):
		e.hist = shot.Redo(e.hist)
	case !e.sectionMenu && c.Shortcut(0, ui.KeyEnter):
		a.longFinish(le, shotSave, "")
	}
}

func (le *longEditor) cropRect() shot.Rect {
	if le.crop != nil {
		return *le.crop
	}
	return shot.Rect{W: le.d.W, H: le.d.H}
}

func (a *app) longInput(le *longEditor, ev ui.InputEvent) bool {
	d, e, z := le.d, &le.d.ed, le.z
	x, y := float64(ev.X)/z, float64(ev.Y)/z
	shift := ev.Mods&ui.Shift != 0
	switch ev.Kind {
	case ui.InputPointerDown:
		if ev.Button != 0 {
			return false
		}
		if le.cropping {
			cr := le.cropRect()
			for _, h := range shot.Handles {
				p := shot.HandlePoint(cr, h)
				if math.Abs(p.X-x)*z <= 8 && math.Abs(p.Y-y)*z <= 8 {
					le.cropDrag = &longCropDrag{h, x, y, cr}
					return true
				}
			}
			return true
		}
		wasEditing := e.editing != nil
		if e.editing != nil || e.note != nil {
			e.commitEditing()
		}
		if e.editDown(x, y) || e.tool == "" {
			return true
		}
		ink, lv := a.shotStyle(e.tool)
		switch e.tool {
		case shot.Text:
			if !wasEditing {
				e.editing = &shot.TextDraft{X: x, Y: y - shot.FontSize[lv]/2, Color: ink, Size: lv}
			}
		case shot.Number:
			e.hist = shot.PushShape(e.hist, &shot.Shape{Kind: shot.Number, X: x, Y: y, N: shot.NextNumber(e.hist.Shapes), Color: ink, Size: lv})
		case shot.Pen:
			e.draft = &shot.Shape{Kind: shot.Pen, Points: []shot.Point{{X: x, Y: y}}, Color: ink, Size: lv}
		default:
			e.draft = &shot.Shape{Kind: e.tool, X1: x, Y1: y, X2: x, Y2: y, Color: ink, Size: lv}
		}
		return true
	case ui.InputPointerMove:
		if g := le.cropDrag; g != nil {
			if next := shot.ResizeRect(g.orig, g.handle, x-g.x, y-g.y, d.W, d.H); next.W >= shot.LongMinCrop && next.H >= shot.LongMinCrop {
				le.crop = &next
			}
			return true
		}
		if e.editMove(d, x, y) {
			return true
		}
		if s := e.draft; s != nil {
			n := *s
			if s.Kind == shot.Pen {
				n.Points = append(slices.Clip(s.Points), shot.Point{X: x, Y: y})
			} else {
				n.X2, n.Y2 = shot.DragEnd(s.Kind, s.X1, s.Y1, x, y, shift)
			}
			e.draft = &n
			return true
		}
		le.hover = 0
		if !le.cropping {
			if cur, ok := e.editCursor(x, y); ok {
				le.hover = cur
			}
		}
		return true
	case ui.InputPointerUp:
		if ev.Button != 0 {
			return false
		}
		le.cropDrag = nil
		if e.editUp(d, x, y) {
			return true
		}
		if s := e.draft; s != nil {
			done := *s
			if s.Kind == shot.Pen {
				done.Points = append(slices.Clip(s.Points), shot.Point{X: x, Y: y})
			} else {
				done.X2, done.Y2 = shot.DragEnd(s.Kind, s.X1, s.Y1, x, y, shift)
			}
			if done.Kind == shot.Callout && shot.IsMeaningful(&done) {
				e.note = &shot.NoteDraft{Shape: &done}
			} else {
				e.hist = shot.PushShape(e.hist, &done)
			}
			e.draft = nil
		} else if ev.Clicks == 2 {
			e.beginTextEdit(x, y) // 双击已有文字改内容、双击批注改说明
		}
		return true
	}
	return false
}

func (a *app) longEditorView(c *ui.Context, le *longEditor) {
	d, e := le.d, &le.d.ed
	shot.TextWidth = func(line string, fs float64) float64 {
		w, _ := c.MeasureText(0, ui.Span{Text: line, Font: shotFont, Size: f32(fs), Weight: 600})
		return float64(w)
	}
	k := tok(c)
	pal := shotColors(c)
	bg, muted := gray(1, 1), gray(0.97, 0.4)
	if k.dark {
		bg, muted = gray(0.145, 1), gray(0.269, 0.4)
	}
	c.Root().Background(bg)
	a.longKeys(c, le)
	if le.closed {
		return
	}
	fr := a.shotFrame()
	W, H := c.Size()
	le.z = math.Min(1, (float64(W)-32)/d.W)
	styleKind, styleInk, styleLv := a.shotStyleTarget(e)
	showStyle := styleKind != "" && styleKind != shot.Spotlight
	cr := le.cropRect()
	out := shot.ToPixelRect(cr, d.sx, d.sy, float64(d.pxW), float64(d.pxH))
	ui.Column(c).Fill().Children(func() {
		top := ui.Column(c).Padding(6, 8).Gap(4).BorderWidth(0, 0, 1, 0).BorderColor(pal.border)
		top.Children(func() {
			ui.Row(c).Gap(4).AlignItems(ui.Center).Children(func() {
				for _, t := range shotTools {
					if a.shotButton(c, d, pal, string(t.tool), t.icon, tr(t.tip), e.tool == t.tool, false, nil).Clicked() {
						e.commitEditing()
						le.cropping = false
						if e.tool == t.tool {
							e.tool = ""
						} else {
							e.tool = t.tool
						}
					}
				}
				if a.shotButton(c, d, pal, "crop", "crop", tr("裁剪：拖动边角调整，Esc 结束"), le.cropping, false, nil).Clicked() {
					e.commitEditing()
					e.tool = ""
					le.cropping = !le.cropping
				}
				shotSep(c, pal)
				if a.shotButton(c, d, pal, "undo", "undo-2", tr("撤销（⌘Z）"), false, len(e.hist.Undo) == 0, nil).Clicked() && len(e.hist.Undo) > 0 {
					e.hist = shot.Undo(e.hist)
				}
				if a.shotButton(c, d, pal, "redo", "redo-2", tr("重做（⇧⌘Z）"), false, len(e.hist.Redo) == 0, nil).Clicked() && len(e.hist.Redo) > 0 {
					e.hist = shot.Redo(e.hist)
				}
				shotSep(c, pal)
				a.shotFrameSliders(c, d, pal, fr)
				ui.Spacer(c)
				text(c, fmt.Sprintf("%d × %d", int(out.W), int(out.H)), 11, 16, 400, pal.muted).Font(fontMono).FontFeatures("tnum").Margin(0, 4, 0, 0)
				if a.shotButton(c, d, pal, "saveas", "download", tr("另存为图片…：保存为 PNG 文件"), false, false, nil).Clicked() {
					a.longFinish(le, shotSaveAs, "")
					return
				}
				cancelTip := tr("放弃长截屏")
				doneTip := tr("完成：复制并存入「剪贴」（Enter）；长按选择存入的分组")
				if le.origin.pin != nil {
					cancelTip, doneTip = tr("放弃标注"), tr("完成：更新钉图（Enter）；长按选择存入的分组")
				}
				if a.shotButton(c, d, pal, "cancel", "x", cancelTip, false, false, nil).Clicked() {
					le.close()
					return
				}
				a.shotCheckButton(c, d, pal, doneTip, false, func() { a.longFinish(le, shotSave, "") })
			})
			if showStyle {
				a.shotStyleRow(c, d, pal, styleKind, styleInk, styleLv)
			}
		})
		if le.closed {
			return
		}
		ui.Scroll(c).Grow(1).Background(muted).Children(func() {
			ui.Row(c).Padding(16).Justify(ui.Center).Children(func() { a.longPage(c, le, pal, fr) })
		})
	})
	if le.closed {
		return
	}
	if e.sectionMenu {
		a.shotSectionMenu(c, d, pal, float64(W), float64(H), func(m ui.Element) { m.Right(8).Top(44) },
			func(id string) { a.longFinish(le, shotSection, id) })
	}
	if !e.sectionMenu {
		a.shotHoverTip(c, d, float64(W), float64(H))
	}
}

func (a *app) longPage(c *ui.Context, le *longEditor, pal shotPalette, fr shotFrame) {
	d, e, z := le.d, &le.d.ed, le.z
	radius := f32(shot.ClampRadius(fr.Radius, d.W, d.H) * z)
	shapes := shot.WithNoteDraft(e.editShapes(), e.note)
	if e.editing != nil && e.editing.Orig != nil {
		shapes = replaceShape(shapes, e.editing.Orig, nil)
	}
	all := shapes
	if e.draft != nil {
		all = append(slices.Clip(shapes), e.draft)
	}
	cursor := le.hover
	if cursor == 0 {
		switch {
		case e.tool == shot.Text:
			cursor = ui.CursorText
		case e.tool != "":
			cursor = ui.CursorCrosshair
		default:
			cursor = ui.CursorDefault
		}
	}
	page := ui.Box(c).Size(f32(d.W*z), f32(d.H*z)).Radius(radius).Cursor(cursor).
		HandleInput(func(ev ui.InputEvent) bool { return a.longInput(le, ev) })
	if fr.Shadow > 0 {
		blur, offY := shot.ShadowGeometry(fr.Shadow * z)
		page.Shadow(0, f32(offY), f32(blur), 0, ui.RGBA(0, 0, 0, f32(fr.ShadowAlpha/100)))
	} else {
		page.Shadow(0, 4, 6, -1, gray(0, 0.1)).Shadow(0, 2, 4, -2, gray(0, 0.1))
	}
	full := shot.Rect{W: d.W, H: d.H}
	page.Draw(func(p *ui.Painter, r ui.Rect) {
		at := ui.Scaling(f32(z), f32(z)).Then(ui.Translation(r.X, r.Y))
		p.Clip(r, radius, func() {
			p.ImageRegion(d.bm, ui.Rect{}, r, ui.ImageOptions{})
			if len(all) > 0 {
				p.Transform(at, 0, 0, func() { drawShapes(p, d, all, full) })
			}
		})
		p.Transform(ui.Translation(r.X, r.Y), 0, 0, func() {
			if pk := e.pickedShape(); pk != nil {
				if e.preview != nil {
					pk = e.preview
				}
				paintEditFrame(p, pk, pal.primary, z)
			}
			if le.crop != nil {
				cr := le.crop
				var hole ui.Path
				rectPath(&hole, 0, 0, r.W, r.H, 0, false)
				rectPath(&hole, f32(cr.X*z), f32(cr.Y*z), f32(cr.W*z), f32(cr.H*z), 0, true)
				p.FillPath(&hole, ui.RGBA(0, 0, 0, 0.45))
				p.Stroke(ui.Rect{X: f32(cr.X*z) - 1, Y: f32(cr.Y*z) - 1, W: f32(cr.W*z) + 2, H: f32(cr.H*z) + 2}, pal.primary, 0, 1)
			}
			if le.cropping {
				for _, h := range shot.Handles {
					pt := shot.HandlePoint(le.cropRect(), h)
					hr := ui.Rect{X: f32(pt.X*z) - 6, Y: f32(pt.Y*z) - 6, W: 12, H: 12}
					p.Fill(hr, colWhite, 6)
					p.Stroke(hr, pal.primary, 6, 1)
				}
			}
		})
	})
	page.Children(func() {
		a.shotCallouts(c, d, shapes, z)
		if e.editing != nil {
			a.shotTextEditor(c, d, z, pal.fg.Alpha(0.5))
		}
	})
}

// ---- 钉图：编辑标注 / 还原原图 ----

// pinEdit：钉图交给长图标注窗编辑，✓ 写回。
func (a *app) pinEdit(p *pinWin) {
	b := p.win.Bounds()
	d := mygo.Screen.DisplayNearestPoint(mygo.Point{X: b.X + b.Width/2, Y: b.Y + b.Height/2})
	disp := shot.Rect{X: float64(d.Bounds.X), Y: float64(d.Bounds.Y), W: float64(d.Bounds.Width), H: float64(d.Bounds.Height)}
	a.openLongEditor(p.img, float64(p.img.Rect.Dx())/p.w, disp, longOrigin{pin: p})
}

// pinReplace：标注后的图换进钉图（保留原图供「还原原图」），按原像素密度换算窗口大小。
func (a *app) pinReplace(p *pinWin, img *image.RGBA) {
	if p.closing {
		return
	}
	if p.original == nil {
		p.original = p.img
	}
	a.pinSetImage(p, img)
}

func (a *app) pinRestore(p *pinWin) {
	if p.original == nil {
		return
	}
	a.pinSetImage(p, p.original)
	p.original = nil
}

func (a *app) pinSetImage(p *pinWin, img *image.RGBA) {
	density := float64(p.img.Rect.Dx()) / p.w
	p.img, p.bm = img, ui.NewBitmap(img)
	p.w, p.h = float64(img.Rect.Dx())/density, float64(img.Rect.Dy())/density
	p.factor = 1
	if p.win != nil {
		p.win.SetSize(max(1, int(math.Round(p.w))), max(1, int(math.Round(p.h))))
		p.win.Invalidate()
	}
}
