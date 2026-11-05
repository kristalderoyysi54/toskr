package main

import (
	"fmt"
	"image"
	"math"
	"slices"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/shot"
	"github.com/toskr/native/internal/store"
)

// 截图遮罩的界面与交互（逐项对照 ScreenshotView.tsx / ShotToolParts / ShotCallouts / ShapeEditFrame / useShapeEdit）。

const (
	shotDragSlop    = 3.0 // 起拖阈值：更短的按放视为单击（选中悬停窗口）
	shotLoupeSample = 15  // 放大镜取样边长（冻结帧像素）
	shotLoupeSize   = 120.0
	shotLoupePanelH = shotLoupeSize + 44
	shotToolbarWEst = 760.0 // 工具条宽度估值：选区右缘离左边不足此宽时改为贴左
	shotFrameBarW   = 480.0
	shotEditTol     = 6.0 // 已画图形的命中容差
	shotMinBox      = 6.0 // 框类调整后的最小边长
	shotTipDelay    = 400 * time.Millisecond
	shotLongPress   = 500 * time.Millisecond
)

type shotDrag struct {
	kind   string // create | move | resize
	x, y   float64
	orig   shot.Rect
	handle shot.Handle
	moved  bool
}

type shotEditDrag struct {
	x, y   float64
	orig   *shot.Shape
	handle shot.EditHandle
}

type shotEditor struct {
	sel          *shot.Rect
	cursor       *shot.Point
	dragging     bool
	drag         *shotDrag
	tool         shot.Kind
	hist         shot.History
	draft        *shot.Shape
	editing      *shot.TextDraft
	note         *shot.NoteDraft
	picked       *shot.Shape // 选中的已画图形（按指针认，撤销后自然失效）
	preview      *shot.Shape // 拖动中的预览
	edrag        *shotEditDrag
	gotPointer   bool // 收到过真实指针事件（之后光标以事件为准）
	sampled      string
	copiedAt     time.Time
	sectionMenu  bool
	notice       string
	noticeAt     time.Time
	tip          string // 悬停中的工具条按钮说明
	tipRect      ui.Rect
	tipAt        time.Time
	tipHidden    string // 点过的按钮：收起说明直到移到别的按钮
	tipSeen      bool   // 本帧有按钮在悬停
	checkDownAt  time.Time
	checkLong    bool
	mosaics      map[*shot.Shape]mosaicEntry
	patches      map[*image.RGBA]*ui.Bitmap
	ocr          *shotOCR
	translating  bool
	translateGen int
	translated   *shotTranslateJob
}

func (e *shotEditor) reset() { *e = shotEditor{} }

// ---- 使用习惯（颜色 / 粗细 / 圆角阴影 / 十字线色），存设置 ----

type shotFrame struct{ Radius, Shadow, ShadowAlpha float64 }

func (a *app) shotFrame() shotFrame {
	p := a.store.Settings().Shot
	alpha := p.ShadowAlpha
	if alpha == 0 {
		alpha = shot.ShadowAlphaDefault
	}
	return shotFrame{p.Radius, p.Shadow, alpha}
}

func (a *app) setShotFrame(f shotFrame) {
	st := a.store.Settings()
	st.Shot.Radius, st.Shot.Shadow, st.Shot.ShadowAlpha = f.Radius, f.Shadow, f.ShadowAlpha
	_ = a.store.SetSettings(st)
}

// shotStyle：批注单独一套颜色粗细（默认蓝），其余工具共用一套（默认红）。
func (a *app) shotStyle(kind shot.Kind) (string, int) {
	p := a.store.Settings().Shot
	ink, lv, def := p.Ink, p.SizeLv-1, shot.Colors[0]
	if kind == shot.Callout {
		ink, lv, def = p.CalloutInk, p.CalloutSizeLv-1, shot.Colors[3]
	}
	if !slices.Contains(shot.Colors, ink) {
		ink = def
	}
	if lv < 0 || lv > 2 {
		lv = 1
	}
	return ink, lv
}

func (a *app) setShotStyle(kind shot.Kind, ink string, lv int) {
	st := a.store.Settings()
	if kind == shot.Callout {
		st.Shot.CalloutInk, st.Shot.CalloutSizeLv = ink, lv+1
	} else {
		st.Shot.Ink, st.Shot.SizeLv = ink, lv+1
	}
	_ = a.store.SetSettings(st)
}

// shotCross：十字线、选框与手柄的颜色（设置 → 截图线条颜色）。
func (a *app) shotCross() ui.Color {
	p := a.store.Settings().Shot
	c := shot.DefaultCrosshair
	if _, ok := shot.CrosshairPresets[p.Crosshair]; ok {
		c.Preset = p.Crosshair
	}
	if p.CrosshairAlpha > 0 {
		c.Alpha = math.Min(shot.CrosshairAlphaMax, math.Max(shot.CrosshairAlphaMin, p.CrosshairAlpha))
	}
	rgb := shot.CrosshairPresets[c.Preset]
	return ui.RGBA(rgb[0], rgb[1], rgb[2], f32(c.Alpha/100))
}

// ---- 编辑状态的派生 ----

func (d *shotDisplay) hover() *shot.Rect {
	e := &d.ed
	if e.sel != nil || e.cursor == nil || e.dragging {
		return nil
	}
	r := shot.Rect{W: d.W, H: d.H}
	if i := shot.WindowAt(d.windows, e.cursor.X, e.cursor.Y); i >= 0 {
		r = d.windows[i]
	}
	c, ok := shot.ClipToScreen(r, d.W, d.H)
	if !ok {
		return nil
	}
	return &c
}

func (e *shotEditor) locked() bool { return e.tool != "" || len(e.hist.Shapes) > 0 }

func (e *shotEditor) showLoupe() bool { return e.cursor != nil && (e.sel == nil || e.dragging) }

// allShapes：出图与历史用：正在输入的文字 / 批注说明也算进去。
func (e *shotEditor) allShapes() []*shot.Shape {
	return shot.WithNoteDraft(shot.WithTextDraft(e.hist.Shapes, e.editing), e.note)
}

func (e *shotEditor) commitEditing() {
	if e.editing != nil {
		e.hist = shot.CommitText(e.hist, *e.editing)
		e.editing = nil
	}
	if e.note != nil {
		e.hist = shot.CommitNote(e.hist, *e.note)
		e.note = nil
	}
}

func (e *shotEditor) clearSel() {
	e.sel, e.ocr = nil, nil
	e.hist = shot.History{}
	e.picked, e.preview, e.edrag = nil, nil, nil
}

// ---- 已画图形的选中与调整（useShapeEdit）----

func (e *shotEditor) pickedShape() *shot.Shape {
	if e.picked == nil || e.picked.Kind == shot.Translate || !slices.Contains(e.hist.Shapes, e.picked) {
		return nil
	}
	return e.picked
}

func (e *shotEditor) canPick(s *shot.Shape) bool { return e.tool == "" || s.Kind == e.tool }

// editShapes：带拖动预览的图形列表（显示用）。
func (e *shotEditor) editShapes() []*shot.Shape {
	p := e.pickedShape()
	if p == nil || e.preview == nil {
		return e.hist.Shapes
	}
	out := slices.Clone(e.hist.Shapes)
	out[slices.Index(out, p)] = e.preview
	return out
}

func replaceShape(shapes []*shot.Shape, old, next *shot.Shape) []*shot.Shape {
	out := make([]*shot.Shape, 0, len(shapes))
	for _, s := range shapes {
		switch {
		case s != old:
			out = append(out, s)
		case next != nil:
			out = append(out, next)
		}
	}
	return out
}

func (e *shotEditor) replacePicked(target, next *shot.Shape) {
	e.hist = shot.CommitShapes(e.hist, replaceShape(e.hist.Shapes, target, next))
	e.picked = next
}

func (e *shotEditor) editDown(x, y float64) bool {
	p := e.pickedShape()
	var handle shot.EditHandle
	if p != nil {
		handle = shot.HandleAt(p, x, y, shotEditTol)
	}
	var target *shot.Shape
	if handle != "" {
		target = p
	} else if i := shot.ShapeAt(e.hist.Shapes, x, y, shotEditTol, e.canPick); i >= 0 {
		target = e.hist.Shapes[i]
	}
	e.picked = target
	if target == nil {
		return false
	}
	e.edrag = &shotEditDrag{x, y, target, handle}
	return true
}

func (e *shotEditor) editMove(d *shotDisplay, x, y float64) bool {
	g := e.edrag
	if g == nil {
		return false
	}
	e.preview = shot.EditShape(g.orig, g.handle, x-g.x, y-g.y, d.W, d.H)
	return true
}

func (e *shotEditor) editUp(d *shotDisplay, x, y float64) bool {
	g := e.edrag
	if g == nil {
		return false
	}
	e.edrag, e.preview = nil, nil
	next := shot.EditShape(g.orig, g.handle, x-g.x, y-g.y, d.W, d.H)
	if next == g.orig || (x == g.x && y == g.y) || !shot.IsMeaningful(next) {
		return true
	}
	if shot.IsBox(next) && (shot.Box(next).W < shotMinBox || shot.Box(next).H < shotMinBox) {
		return true
	}
	e.replacePicked(g.orig, next)
	return true
}

func (e *shotEditor) editCursor(x, y float64) (ui.Cursor, bool) {
	if p := e.pickedShape(); p != nil {
		if h := shot.HandleAt(p, x, y, shotEditTol); h != "" {
			if h == "start" || h == "end" {
				return ui.CursorCrosshair, true
			}
			return handleCursor(shot.Handle(h)), true
		}
	}
	if shot.ShapeAt(e.hist.Shapes, x, y, shotEditTol, e.canPick) >= 0 {
		return ui.CursorMove, true
	}
	return 0, false
}

func handleCursor(h shot.Handle) ui.Cursor {
	switch h {
	case "nw", "se":
		return ui.CursorResizeNWSE
	case "ne", "sw":
		return ui.CursorResizeNESW
	case "n", "s":
		return ui.CursorResizeNS
	}
	return ui.CursorResizeEW
}

// ---- 指针 ----

func (a *app) shotInput(d *shotDisplay, ev ui.InputEvent) bool {
	e := &d.ed
	x, y := float64(ev.X), float64(ev.Y)
	switch ev.Kind {
	case ui.InputPointerDown:
		e.gotPointer = true
		e.cursor = &shot.Point{X: x, Y: y}
		if d.win != nil && !d.win.IsFocused() {
			d.win.Focus()
		}
		if ev.Button == 1 {
			a.shotBack(d, false)
			return true
		}
		if ev.Button == 0 {
			a.shotDown(d, x, y)
		}
		return true
	case ui.InputPointerMove:
		e.gotPointer = true
		e.cursor = &shot.Point{X: x, Y: y}
		a.shotMove(d, x, y, ev.Mods&ui.Shift != 0)
		return true
	case ui.InputPointerUp:
		if ev.Button != 0 {
			return true
		}
		a.shotUp(d, x, y, ev.Mods&ui.Shift != 0)
		if ev.Clicks == 2 {
			a.shotDoubleClick(d, x, y)
		}
		return true
	}
	return false
}

func (a *app) shotDown(d *shotDisplay, x, y float64) {
	e := &d.ed
	wasEditing := e.editing != nil
	if e.editing != nil || e.note != nil {
		e.commitEditing()
	}
	if e.sel != nil && e.editDown(x, y) {
		return
	}
	if e.sel != nil && e.tool != "" {
		if !shot.Inside(*e.sel, x, y) {
			return
		}
		ink, lv := a.shotStyle(e.tool)
		switch e.tool {
		case shot.Text:
			// 文字框以光标为左上角，字号的一半上提让首行落在点击处
			if !wasEditing {
				e.editing = &shot.TextDraft{X: x, Y: y - shot.FontSize[lv]/2, Color: ink, Size: lv}
			}
			return
		case shot.Number:
			e.hist = shot.PushShape(e.hist, &shot.Shape{Kind: shot.Number, X: x, Y: y, N: shot.NextNumber(e.hist.Shapes), Color: ink, Size: lv})
			return
		case shot.Pen:
			e.draft = &shot.Shape{Kind: shot.Pen, Points: []shot.Point{{X: x, Y: y}}, Color: ink, Size: lv}
		default:
			e.draft = &shot.Shape{Kind: e.tool, X1: x, Y1: y, X2: x, Y2: y, Color: ink, Size: lv}
		}
		return
	}
	// 已有标注时选区锁定，避免标注与底图错位
	if e.sel != nil && e.locked() {
		return
	}
	switch {
	case e.sel != nil && shot.HitHandle(*e.sel, x, y, 6) != "":
		e.drag = &shotDrag{kind: "resize", x: x, y: y, orig: *e.sel, handle: shot.HitHandle(*e.sel, x, y, 6)}
	case e.sel != nil && shot.Inside(*e.sel, x, y):
		e.drag = &shotDrag{kind: "move", x: x, y: y, orig: *e.sel}
	default:
		e.drag = &shotDrag{kind: "create", x: x, y: y}
	}
}

func (a *app) shotMove(d *shotDisplay, x, y float64, shift bool) {
	e := &d.ed
	if e.editMove(d, x, y) {
		return
	}
	if s := e.draft; s != nil {
		n := *s
		if s.Kind == shot.Pen {
			n.Points = append(slices.Clip(s.Points), shot.Point{X: x, Y: y})
		} else {
			n.X2, n.Y2 = shot.DragEnd(s.Kind, s.X1, s.Y1, x, y, shift)
		}
		e.draft = &n
		return
	}
	g := e.drag
	if g == nil {
		return
	}
	dx, dy := x-g.x, y-g.y
	switch g.kind {
	case "create":
		if !g.moved && math.Hypot(dx, dy) < shotDragSlop {
			return
		}
		g.moved = true
		e.dragging = true
		r := shot.RectFromPoints(g.x, g.y, x, y, d.W, d.H)
		e.sel = &r
	case "move":
		e.dragging = true
		r := shot.MoveRect(g.orig, dx, dy, d.W, d.H)
		e.sel = &r
	default:
		e.dragging = true
		r := shot.ResizeRect(g.orig, g.handle, dx, dy, d.W, d.H)
		e.sel = &r
	}
}

func (a *app) shotUp(d *shotDisplay, x, y float64, shift bool) {
	e := &d.ed
	if e.editUp(d, x, y) {
		return
	}
	if s := e.draft; s != nil {
		// 按松手处收尾：最后一次移动可能还没进草稿
		done := *s
		if s.Kind == shot.Pen {
			done.Points = append(slices.Clip(s.Points), shot.Point{X: x, Y: y})
		} else {
			done.X2, done.Y2 = shot.DragEnd(s.Kind, s.X1, s.Y1, x, y, shift)
		}
		// 批注框画完先填说明，说明连同框一起入历史
		if done.Kind == shot.Callout && shot.IsMeaningful(&done) {
			e.note = &shot.NoteDraft{Shape: &done}
		} else {
			e.hist = shot.PushShape(e.hist, &done)
		}
		e.draft = nil
		return
	}
	g := e.drag
	e.drag = nil
	e.dragging = false
	if g != nil && g.kind == "create" && !g.moved && e.sel == nil {
		if h := d.hover(); h != nil {
			e.sel = h
		}
	}
	// 拖出零宽高的选区视为无效
	if e.sel != nil && (e.sel.W < 2 || e.sel.H < 2) {
		e.sel = nil
	}
}

func (a *app) shotDoubleClick(d *shotDisplay, x, y float64) {
	e := &d.ed
	if e.sel == nil || !shot.Inside(*e.sel, x, y) {
		return
	}
	// 双击已有文字 / 批注：改内容；否则无工具时双击完成截图
	if e.beginTextEdit(x, y) {
		return
	}
	if e.tool == "" {
		a.shotConfirm(d, shotSave, "")
	}
}

func (e *shotEditor) beginTextEdit(x, y float64) bool {
	if e.tool == "" || e.tool == shot.Callout {
		if i := shot.ShapeAt(e.hist.Shapes, x, y, 4, func(s *shot.Shape) bool { return s.Kind == shot.Callout }); i >= 0 {
			c := e.hist.Shapes[i]
			e.picked = nil
			e.note = &shot.NoteDraft{Shape: c, Text: c.Note, Orig: c}
			return true
		}
	}
	if e.tool != "" && e.tool != shot.Text {
		return false
	}
	i := shot.ShapeAt(e.hist.Shapes, x, y, 4, func(s *shot.Shape) bool { return s.Kind == shot.Text })
	if i < 0 {
		return false
	}
	s := e.hist.Shapes[i]
	e.picked = nil
	e.editing = &shot.TextDraft{X: s.X, Y: s.Y, Text: s.Text, Color: s.Color, Size: s.Size, Orig: s}
	return true
}

// shotBack：右键 / Esc 逐级退出：工具 → 选区 → 结束截图。Esc 先收起菜单与选中的图形。
func (a *app) shotBack(d *shotDisplay, esc bool) {
	e := &d.ed
	switch {
	case esc && e.sectionMenu:
		e.sectionMenu = false
	case esc && e.pickedShape() != nil:
		e.picked = nil
	case e.tool != "":
		e.tool = ""
	case e.sel != nil:
		e.clearSel()
	default:
		a.endShot(true)
	}
}

func (a *app) shotConfirm(d *shotDisplay, act shotAction, section string) {
	e := &d.ed
	if e.sel == nil {
		return
	}
	shapes := e.allShapes()
	fr := a.shotFrame()
	out := renderShot(d, *e.sel, shapes, fr)
	if out == nil {
		return
	}
	place := shot.Point{X: e.sel.X - fr.Shadow, Y: e.sel.Y - fr.Shadow}
	caption := shot.CalloutPrompt(shapes, tr("图上的标注（序号对应图中区域）："))
	a.commitShot(d, act, out, place, section, caption)
}

func (e *shotEditor) flash(c *ui.Context, text string) {
	e.notice, e.noticeAt = text, c.Now()
	c.After(2500 * time.Millisecond)
}

func (a *app) shotCopyColor(c *ui.Context, d *shotDisplay, rgb bool) {
	// 按键可能落在别的屏的遮罩窗：交给光标所在、正在显示放大镜的屏
	if !d.ed.showLoupe() && a.shot != nil {
		for _, o := range a.shot.displays {
			if o.ed.showLoupe() {
				d = o
				break
			}
		}
	}
	e := &d.ed
	if !e.showLoupe() || e.sampled == "" {
		return
	}
	v := e.sampled
	if rgb {
		col := shotColor(v)
		v = fmt.Sprintf("rgb(%d, %d, %d)", col.R, col.G, col.B)
	}
	a.copyShotColor(v)
	e.copiedAt = c.Now()
	c.After(900 * time.Millisecond)
	if d.win != nil {
		d.win.Invalidate()
	}
}

// ---- 键盘（遮罩临时接管；输入文字时交给输入框）----

func (a *app) shotKeys(c *ui.Context, d *shotDisplay) {
	e := &d.ed
	if e.ocr != nil && !e.sectionMenu { // 文字面板打开时只接管 Esc（关面板），其余交给面板里的输入框
		if c.Shortcut(0, ui.KeyEscape) {
			e.ocr = nil
		}
		return
	}
	if e.editing != nil || e.note != nil {
		return
	}
	if c.Shortcut(0, ui.KeyEscape) {
		a.shotBack(d, true)
		return
	}
	if e.sectionMenu {
		return
	}
	switch {
	case c.Shortcut(ui.Cmd, ui.KeyZ):
		e.hist = shot.Undo(e.hist)
	case c.Shortcut(ui.Cmd|ui.Shift, ui.KeyZ):
		e.hist = shot.Redo(e.hist)
	case e.pickedShape() != nil && (c.Shortcut(0, ui.KeyBackspace) || c.Shortcut(0, ui.KeyDelete)):
		e.replacePicked(e.pickedShape(), nil)
	case c.Shortcut(0, ui.KeyEnter) || c.Shortcut(ui.Cmd, ui.KeyC):
		a.shotConfirm(d, shotSave, "")
	case c.Shortcut(0, ui.KeyC):
		a.shotCopyColor(c, d, false)
	case c.Shortcut(ui.Shift, ui.KeyC):
		a.shotCopyColor(c, d, true)
	}
	if e.sel == nil || e.tool != "" || len(e.hist.Shapes) > 0 {
		return
	}
	for _, mods := range []ui.Modifiers{0, ui.Shift} {
		step := 1.0
		if mods != 0 {
			step = 10
		}
		for _, k := range []struct {
			key    ui.Key
			dx, dy float64
		}{{ui.KeyLeft, -1, 0}, {ui.KeyRight, 1, 0}, {ui.KeyUp, 0, -1}, {ui.KeyDown, 0, 1}} {
			if c.Shortcut(mods, k.key) {
				r := shot.MoveRect(*e.sel, k.dx*step, k.dy*step, d.W, d.H)
				e.sel = &r
			}
		}
	}
}

// ---- 视图 ----

// shotPalette：遮罩浮层的颜色（floatingSurface / border / accent / primary，随系统明暗）。
type shotPalette struct {
	surface, border, edge, accent, primary, fg, muted, hover ui.Color
	k                                                        tokens
}

func shotColors(c *ui.Context) shotPalette {
	k := tok(c)
	p := shotPalette{surface: k.floatBtn.Alpha(0.95), edge: k.floatBorder, fg: k.fg, muted: k.muted, primary: stok(c).primary, k: k}
	if k.dark {
		p.border, p.accent, p.hover = gray(1, 0.1), gray(0.269, 1), gray(1, 0.1)
	} else {
		p.border, p.accent, p.hover = gray(0.922, 1), gray(0.97, 1), gray(0, 0.05)
	}
	return p
}

func (p shotPalette) float(e ui.Element) ui.Element {
	k := p.k
	return e.Background(p.surface).Border(1, p.edge).
		Shadow(0, 1, 2, 0, k.floatShadowA).Shadow(0, 6, 16, -4, k.floatShadowB).InsetShadow(0, 1, 0, 0, k.floatInset)
}

func (a *app) shotView(c *ui.Context, d *shotDisplay) {
	e := &d.ed
	shot.TextWidth = func(line string, fs float64) float64 {
		w, _ := c.MeasureText(0, ui.Span{Text: line, Font: shotFont, Size: f32(fs), Weight: 600})
		return float64(w)
	}
	c.Root().Background(colBlack)
	a.shotKeys(c, d)
	if a.shot == nil || d.bm == nil {
		return
	}
	if e.translated != nil {
		a.applyTranslation(c, d)
	}
	pal := shotColors(c)
	cross := a.shotCross()
	fr := a.shotFrame()
	hover := d.hover()
	active := e.sel
	if active == nil {
		active = hover
	}
	shapes := shot.WithNoteDraft(e.editShapes(), e.note)
	if e.editing != nil && e.editing.Orig != nil {
		shapes = replaceShape(shapes, e.editing.Orig, nil) // 改已有文字时原文字先藏起来，由输入框显示
	}

	// 底层：冻结帧、压暗、标注、选框手柄、十字线（接全部指针）
	base := ui.Box(c).Size(f32(d.W), f32(d.H)).Cursor(a.shotCursorStyle(d)).
		HandleInput(func(ev ui.InputEvent) bool { return a.shotInput(d, ev) })
	base.Draw(func(p *ui.Painter, r ui.Rect) {
		if d.bm == nil {
			return
		}
		p.ImageRegion(d.bm, ui.Rect{}, r, ui.ImageOptions{})
		a.paintShotBase(p, d, active, shapes, fr, cross, pal.primary)
	})

	var pr shot.Rect
	if active != nil {
		pr = shot.ToPixelRect(*active, d.sx, d.sy, float64(d.pxW), float64(d.pxH))
	}
	if e.sel != nil {
		a.shotCallouts(c, d, shapes)
	}
	if active != nil && (e.sel == nil || e.dragging) {
		top := active.Y + 4
		if active.Y >= 26 {
			top = active.Y - 24
		}
		ui.Box(c).Absolute().Left(f32(active.X)).Top(f32(top)).Padding(2, 6).Radius(6).Background(gray(0, 0.7)).PassThrough().Children(func() {
			text(c, fmt.Sprintf("%d × %d", int(pr.W), int(pr.H)), 10, 14, 400, colWhite).Font(fontMono).FontFeatures("tnum")
		})
	}
	toolbarH := 44.0
	styleKind, styleInk, styleLv := a.shotStyleTarget(e)
	showStyle := styleKind != "" && styleKind != shot.Spotlight
	if showStyle {
		toolbarH = 84
	}
	var toolbarTop float64
	if e.sel != nil {
		s := e.sel
		if s.Y+s.H+8+toolbarH <= d.H {
			toolbarTop = s.Y + s.H + 8
		} else {
			toolbarTop = math.Max(s.Y-8-toolbarH, 0)
		}
	}
	if e.sel != nil && !e.dragging {
		a.shotFrameBar(c, d, pal, pr, fr)
		if e.notice != "" && c.Now().Sub(e.noticeAt) < 2500*time.Millisecond {
			ui.Box(c).Absolute().Left(f32(e.sel.X)).Top(f32(math.Max(4, toolbarTop-30))).Padding(4, 8).Radius(8).Background(gray(0, 0.75)).PassThrough().
				Children(func() { text(c, e.notice, 11, 16, 400, colWhite) })
		}
		a.shotToolbar(c, d, pal, toolbarTop, toolbarH, showStyle, styleKind, styleInk, styleLv)
		if a.shot == nil || d.bm == nil { // 工具条动作结束了截图
			return
		}
	}
	if e.sel != nil && e.ocr != nil {
		a.shotOCRPanel(c, d, pal)
	}
	if e.editing != nil {
		a.shotTextEditor(c, d)
	}
	if e.sel != nil && !e.dragging && !e.sectionMenu {
		a.shotHoverTip(c, d)
	}
	if e.showLoupe() {
		a.shotLoupe(c, d)
	}
}

// shotStyleTarget：样式行改谁：输入中的文字 > 选中的图形 > 当前工具。
func (a *app) shotStyleTarget(e *shotEditor) (shot.Kind, string, int) {
	if t := e.editing; t != nil {
		return shot.Text, t.Color, t.Size
	}
	if p := e.pickedShape(); p != nil {
		if e.preview != nil {
			p = e.preview
		}
		return p.Kind, p.Color, p.Size
	}
	if e.tool == "" {
		return "", "", 0
	}
	ink, lv := a.shotStyle(e.tool)
	return e.tool, ink, lv
}

func (a *app) shotCursorStyle(d *shotDisplay) ui.Cursor {
	e := &d.ed
	if e.cursor == nil {
		return ui.CursorCrosshair
	}
	x, y := e.cursor.X, e.cursor.Y
	if e.sel != nil && e.draft == nil {
		if cur, ok := e.editCursor(x, y); ok {
			return cur
		}
	}
	inSel := e.sel != nil && shot.Inside(*e.sel, x, y)
	if e.tool != "" {
		switch {
		case inSel && e.tool == shot.Text:
			return ui.CursorText
		case inSel:
			return ui.CursorCrosshair
		}
		return ui.CursorDefault
	}
	if e.sel != nil && !e.dragging && !e.locked() {
		if h := shot.HitHandle(*e.sel, x, y, 6); h != "" {
			return handleCursor(h)
		}
	}
	switch {
	case inSel && !e.locked():
		return ui.CursorMove
	case e.sel != nil && e.locked():
		return ui.CursorDefault
	}
	return ui.CursorCrosshair
}

func (a *app) paintShotBase(p *ui.Painter, d *shotDisplay, active *shot.Rect, shapes []*shot.Shape, fr shotFrame, cross, primary ui.Color) {
	e := &d.ed
	dim := ui.RGBA(0, 0, 0, 0.45)
	if active == nil {
		p.Fill(ui.Rect{W: f32(d.W), H: f32(d.H)}, dim, 0)
	} else {
		ar := uiRect(*active)
		var radius float32
		if e.sel != nil {
			radius = f32(shot.ClampRadius(fr.Radius, active.W, active.H))
		}
		var hole ui.Path
		rectPath(&hole, 0, 0, f32(d.W), f32(d.H), 0, false)
		rectPath(&hole, ar.X, ar.Y, ar.W, ar.H, radius, true)
		p.FillPath(&hole, dim)
		if e.sel != nil && fr.Shadow > 0 {
			blur, offY := shot.ShadowGeometry(fr.Shadow)
			p.Shadow(ar, radius, 0, f32(offY), f32(blur), 0, ui.RGBA(0, 0, 0, f32(fr.ShadowAlpha/100)))
		}
		outline := ui.Rect{X: ar.X - 2, Y: ar.Y - 2, W: ar.W + 4, H: ar.H + 4}
		or := radius
		if or > 0 {
			or += 2
		}
		p.Stroke(outline, cross, or, 2)
	}
	if e.sel != nil && (len(shapes) > 0 || e.draft != nil) {
		all := shapes
		if e.draft != nil {
			all = append(slices.Clip(shapes), e.draft)
		}
		p.Clip(uiRect(*e.sel), 0, func() { drawShapes(p, d, all, *e.sel) })
	}
	if e.sel != nil {
		if pk := e.pickedShape(); pk != nil {
			if e.preview != nil {
				pk = e.preview
			}
			paintEditFrame(p, pk, primary)
		}
	}
	if e.sel != nil && !e.dragging && !e.locked() {
		for _, h := range shot.Handles {
			pt := shot.HandlePoint(*e.sel, h)
			var dot ui.Path
			dot.Circle(f32(pt.X), f32(pt.Y), 4)
			p.FillPath(&dot, colWhite)
			var ring ui.Path
			ring.Circle(f32(pt.X), f32(pt.Y), 3)
			p.StrokePath(&ring, 2, cross)
		}
	}
	if e.showLoupe() {
		cy, cx := f32(math.Round(e.cursor.Y)-1), f32(math.Round(e.cursor.X)-1)
		p.Fill(ui.Rect{Y: cy, W: f32(d.W), H: 2}, cross, 0)
		p.Fill(ui.Rect{X: cx, W: 2, H: f32(d.H)}, cross, 0)
	}
}

// paintEditFrame：选中图形的虚线外框与手柄（箭头 / 直线只显示两端手柄）。
func paintEditFrame(p *ui.Painter, s *shot.Shape, primary ui.Color) {
	if b, ok := shot.ShapeBounds(s); ok && s.Kind != shot.Arrow && s.Kind != shot.Line {
		r := ui.Rect{X: f32(b.X - 2), Y: f32(b.Y - 2), W: f32(b.W + 4), H: f32(b.H + 4)}
		p.Stroke(ui.Rect{X: r.X - 1, Y: r.Y - 1, W: r.W + 2, H: r.H + 2}, gray(0, 0.4), 0, 1)
		p.StrokeDashed(r, colWhite, 0, 1)
	}
	for _, h := range shot.EditHandles(s) {
		r := ui.Rect{X: f32(h.X - 5), Y: f32(h.Y - 5), W: 10, H: 10}
		p.Shadow(r, 5, 0, 1, 2, 0, gray(0, 0.05))
		p.Fill(r, colWhite, 5)
		p.Stroke(r, primary, 5, 1)
	}
}

// shotLoupe：放大镜（冻结帧取样放大）+ 像素坐标与色值。
func (a *app) shotLoupe(c *ui.Context, d *shotDisplay) {
	e := &d.ed
	cur := *e.cursor
	pos := shot.PlaceNear(cur.X, cur.Y, shotLoupeSize, shotLoupePanelH, d.W, d.H, 20)
	px, py := int(math.Floor(cur.X*d.sx)), int(math.Floor(cur.Y*d.sy))
	e.sampled = ""
	if px >= 0 && py >= 0 && px < d.pxW && py < d.pxH {
		o := py*d.img.Stride + px*4
		e.sampled = fmt.Sprintf("#%02X%02X%02X", d.img.Pix[o], d.img.Pix[o+1], d.img.Pix[o+2])
	}
	half := shotLoupeSample / 2
	ui.Column(c).Absolute().Left(f32(pos.X)).Top(f32(pos.Y)).Width(shotLoupeSize).Radius(8).Clip().
		Background(gray(0, 0.8)).Border(1, gray(1, 0.6)).Shadow(0, 10, 15, -3, gray(0, 0.1)).Shadow(0, 4, 6, -4, gray(0, 0.1)).
		PassThrough().Children(func() {
		ui.Box(c).Size(shotLoupeSize, shotLoupeSize).Draw(func(p *ui.Painter, r ui.Rect) {
			p.Fill(r, colBlack, 0)
			cell := r.W / shotLoupeSample
			// 取样区越出画面的部分留黑：按可见部分裁剪源与目标
			x0, y0 := px-half, py-half
			sx0, sy0 := max(x0, 0), max(y0, 0)
			sx1, sy1 := min(x0+shotLoupeSample, d.pxW), min(y0+shotLoupeSample, d.pxH)
			if sx1 > sx0 && sy1 > sy0 {
				dst := ui.Rect{X: r.X + float32(sx0-x0)*cell, Y: r.Y + float32(sy0-y0)*cell, W: float32(sx1-sx0) * cell, H: float32(sy1-sy0) * cell}
				p.ImageRegion(d.bm, ui.Rect{X: float32(sx0), Y: float32(sy0), W: float32(sx1 - sx0), H: float32(sy1 - sy0)}, dst, ui.ImageOptions{})
			}
			p.Stroke(ui.Rect{X: r.X + float32(half)*cell, Y: r.Y + float32(half)*cell, W: cell, H: cell}, ui.RGBA(56, 132, 255, 0.9), 0, 1)
		})
		ui.Column(c).Padding(4, 6).Gap(2).Children(func() {
			mono := func(s string) { text(c, s, 10, 14, 400, colWhite).Font(fontMono).FontFeatures("tnum") }
			mono(fmt.Sprintf("%d, %d", int(math.Round(cur.X*d.sx)), int(math.Round(cur.Y*d.sy))))
			ui.Row(c).Gap(4).AlignItems(ui.Center).Children(func() {
				sw := ui.Box(c).Size(8, 8).Radius(2).Border(1, gray(1, 0.5))
				if e.sampled != "" {
					sw.Background(shotColor(e.sampled))
				}
				if !e.copiedAt.IsZero() && c.Now().Sub(e.copiedAt) < 900*time.Millisecond {
					mono(tr("已复制"))
				} else {
					mono(e.sampled + "  C · ⇧C RGB")
				}
			})
		})
	})
}

// shotFrameBar：选区上方：尺寸 + 出图圆角 / 阴影（参照 iShot）。
func (a *app) shotFrameBar(c *ui.Context, d *shotDisplay, pal shotPalette, pr shot.Rect, fr shotFrame) {
	s := d.ed.sel
	top := s.Y + 6
	if s.Y >= 40 {
		top = s.Y - 36
	}
	left := math.Min(s.X, math.Max(0, d.W-shotFrameBarW))
	bar := ui.Row(c).Absolute().Left(f32(left)).Top(f32(top)).Padding(4, 8).Gap(8).Radius(8).AlignItems(ui.Center).Cursor(ui.CursorDefault)
	pal.float(bar).Children(func() {
		text(c, fmt.Sprintf("%d × %d", int(pr.W), int(pr.H)), 11, 16, 400, pal.muted).Font(fontMono).FontFeatures("tnum")
		ui.Box(c).Size(1, 16).Background(pal.border)
		slider := func(v *float64, icon, tip string, lo, hi, step float64) {
			row := ui.Row(c).Gap(4).AlignItems(ui.Center).Key("fs-" + icon)
			row.Children(func() {
				licon(c, icon, 14, pal.muted)
				if ui.Slider(c, v, lo, hi).Step(step).Width(80).Changed() {
					a.setShotFrame(fr)
				}
				text(c, fmt.Sprintf("%d", int(*v)), 11, 16, 400, pal.fg).Font(fontMono).FontFeatures("tnum").Width(24)
			})
			a.shotTipTarget(c, d, row, tip)
		}
		slider(&fr.Radius, "square-round-corner", tr("圆角：出图四角裁成圆角（外侧透明）"), 0, shot.MaxRadius, 2)
		slider(&fr.Shadow, "layers-2", tr("阴影：出图四周加投影，数值为阴影大小（0 = 无）"), 0, shot.MaxShadow, 2)
		if fr.Shadow > 0 {
			slider(&fr.ShadowAlpha, "blend", tr("阴影浓淡：投影的深浅（%）"), shot.ShadowAlphaMin, shot.ShadowAlphaMax, 5)
		}
	})
}

type shotToolDef struct {
	tool             shot.Kind
	icon, label, tip string
}

var shotTools = []shotToolDef{
	{shot.Line, "slash", "直线", "直线：拖动画直线，按住 ⇧ 吸附水平 / 垂直 / 45°"},
	{shot.RectK, "square", "矩形", "矩形：拖动框出重点区域"},
	{shot.Ellipse, "circle", "椭圆", "椭圆：拖动圈出重点"},
	{shot.Arrow, "move-up-right", "箭头", "箭头：从起点拖到要指向的位置"},
	{shot.Pen, "pencil", "画笔", "画笔：按住随手画"},
	{shot.Text, "type", "文字", "文字：点击位置输入，Enter 完成、Shift+Enter 换行"},
	{shot.Mosaic, "grid-3x3", "马赛克", "马赛克：拖动框住要遮挡的隐私内容"},
	{shot.Spotlight, "focus", "聚光灯", "聚光灯：框出的区域保持原样，其余压暗"},
	{shot.Number, "hash", "序号", "序号：点击依次放置 1、2、3… 编号"},
	{shot.Callout, "message-square-text", "批注", "批注：框出要改的地方并写下说明，自动编号；存入或发送时编号说明随图附上，方便交给 AI"},
}

// shotTipTarget：记下悬停中的元素与说明（HoverTip：遮罩不激活应用，原生 tooltip 不出现，自己画）。
func (a *app) shotTipTarget(c *ui.Context, d *shotDisplay, el ui.Element, tip string) {
	e := &d.ed
	if !el.Hovered() {
		return
	}
	if el.Pressed() {
		e.tipHidden = tip
	}
	if e.tip != tip {
		e.tip, e.tipAt = tip, c.Now()
		if e.tipHidden != tip {
			e.tipHidden = ""
		}
		c.After(shotTipDelay)
	}
	e.tipRect = el.Bounds()
	e.tipSeen = true
}

// shotButton：工具条按钮 30pt、图标 18pt（IconButton sm + p-1.5）。
func (a *app) shotButton(c *ui.Context, d *shotDisplay, pal shotPalette, key, icon, tip string, pressed, disabled bool, iconColor *ui.Color) ui.Element {
	label, _, _ := strings.Cut(tip, "：")
	b := ui.Box(c).Size(30, 30).Radius(8).Center().Key("sb-" + key).Label(label).Role(ui.RoleButton)
	bg, fg := ui.Transparent, pal.muted
	if disabled {
		b.Opacity(0.45)
	} else {
		if b.Hovered() || pressed {
			bg, fg = pal.hover, pal.fg
		}
		b.AnimatePose(ui.Pose{Scale: pressScale(b.Pressed(), 0.94)}, tweenControl)
	}
	if iconColor != nil {
		fg = *iconColor
	}
	fadeColor(b, "bg", bg, tweenControl)
	b.Children(func() {
		ic := licon(c, icon, 18, fg)
		if icon == "loader-circle" { // animate-spin
			ic.Rotate(b.Loop("spin", time.Second, ui.Linear) * 360)
		}
	})
	a.shotTipTarget(c, d, b, tip)
	return b
}

func shotSep(c *ui.Context, pal shotPalette) {
	ui.Box(c).Size(1, 16).Margin(0, 2).Background(pal.border)
}

func (a *app) shotToolbar(c *ui.Context, d *shotDisplay, pal shotPalette, top, h float64, showStyle bool, styleKind shot.Kind, styleInk string, styleLv int) {
	e := &d.ed
	s := e.sel
	bar := ui.Column(c).Absolute().Top(f32(top)).Height(f32(h)).Padding(0, 8).Gap(6).Radius(10).Justify(ui.Center).Cursor(ui.CursorDefault)
	if s.X+s.W < shotToolbarWEst {
		bar.Left(4)
	} else {
		bar.Right(f32(math.Max(d.W-(s.X+s.W), 0)))
	}
	hasTranslation := slices.ContainsFunc(e.hist.Shapes, func(s *shot.Shape) bool { return s.Kind == shot.Translate })
	pal.float(bar).Children(func() {
		ui.Row(c).Gap(4).AlignItems(ui.Center).Children(func() {
			for _, t := range shotTools {
				if a.shotButton(c, d, pal, string(t.tool), t.icon, tr(t.tip), e.tool == t.tool, false, nil).Clicked() {
					e.commitEditing()
					if e.tool == t.tool {
						e.tool = ""
					} else {
						e.tool = t.tool
					}
				}
			}
			shotSep(c, pal)
			if a.shotButton(c, d, pal, "undo", "undo-2", tr("撤销（⌘Z）"), false, len(e.hist.Undo) == 0, nil).Clicked() && len(e.hist.Undo) > 0 {
				e.hist = shot.Undo(e.hist)
			}
			if a.shotButton(c, d, pal, "redo", "redo-2", tr("重做（⇧⌘Z）"), false, len(e.hist.Redo) == 0, nil).Clicked() && len(e.hist.Redo) > 0 {
				e.hist = shot.Redo(e.hist)
			}
			shotSep(c, pal)
			if a.shotButton(c, d, pal, "long", "scroll-text", tr("长截屏：点击后滚动页面，自动拼接成长图"), false, false, nil).Clicked() {
				a.shotStartLong(c, d)
			}
			if a.shotButton(c, d, pal, "ocr", "scan-text", tr("识别文字：提取选区里的文字，可复制或存入「剪贴」"), e.ocr != nil, false, nil).Clicked() {
				a.shotRunOCR(c, d)
			}
			trTip := tr("图内翻译：把图里的外文原位替换成中文")
			if hasTranslation {
				trTip = tr("去掉图内翻译")
			}
			trIcon := "languages"
			if e.translating {
				trIcon = "loader-circle"
			}
			if a.shotButton(c, d, pal, "translate", trIcon, trTip, hasTranslation, e.translating, nil).Clicked() && !e.translating {
				a.shotTranslate(c, d)
			}
			for _, act := range []struct {
				act       shotAction
				icon, tip string
			}{
				{shotPin, "pin", "钉在屏幕上：截图置顶悬浮，可拖动、滚轮缩放，右键更多"},
				{shotEdit, "shield", "在编辑器中打开（打码）：存入「剪贴」后打开图片编辑器打码"},
				{shotSend, "send", "发送到当前目标：存入「剪贴」并粘贴到目标应用"},
				{shotSaveAs, "download", "另存为图片…：选位置保存为 PNG 文件"},
			} {
				if a.shotButton(c, d, pal, string(act.act), act.icon, tr(act.tip), false, false, nil).Clicked() {
					a.shotConfirm(d, act.act, "")
					return
				}
			}
			shotSep(c, pal)
			if a.shotButton(c, d, pal, "cancel", "x", tr("取消（Esc）"), false, false, nil).Clicked() {
				a.endShot(true)
				return
			}
			a.shotCheckButton(c, d, pal)
		})
		if showStyle {
			a.shotStyleRow(c, d, pal, styleKind, styleInk, styleLv)
		}
	})
	if e.sectionMenu {
		a.shotSectionMenu(c, d, pal, top, h)
	}
}

// shotCheckButton：✓ 完成；长按或右键选择存入的分组。
func (a *app) shotCheckButton(c *ui.Context, d *shotDisplay, pal shotPalette) {
	e := &d.ed
	primary := pal.primary
	b := a.shotButton(c, d, pal, "done", "check", tr("完成：复制并存入「剪贴」（Enter）；长按选择存入的分组"), false, false, &primary)
	now := c.Now()
	switch {
	case b.Pressed():
		if e.checkDownAt.IsZero() {
			e.checkDownAt, e.checkLong = now, false
			c.After(shotLongPress)
		} else if !e.checkLong && now.Sub(e.checkDownAt) >= shotLongPress {
			e.checkLong, e.sectionMenu = true, true
		}
	default:
		e.checkDownAt = time.Time{}
	}
	if b.RightClicked() {
		e.sectionMenu = true
	}
	if b.Clicked() {
		if e.checkLong {
			e.checkLong = false
			return
		}
		a.shotConfirm(d, shotSave, "")
	}
}

func (a *app) shotSectionMenu(c *ui.Context, d *shotDisplay, pal shotPalette, top, h float64) {
	e := &d.ed
	if ui.Box(c).Absolute().Top(0).Left(0).Size(f32(d.W), f32(d.H)).Clicked() {
		e.sectionMenu = false
		return
	}
	s := e.sel
	m := ui.Column(c).Absolute().Width(192).MaxHeight(288).Padding(4).Radius(8).Key("shot-sections")
	// 贴 ✓ 按钮右缘（工具条右内边距 8）
	right := 8.0
	if s.X+s.W < shotToolbarWEst {
		right = d.W - (4 + shotToolbarWEst) + 8 // 工具条贴左时估算右缘
	} else {
		right += math.Max(d.W-(s.X+s.W), 0)
	}
	m.Right(f32(math.Max(right, 0)))
	if top > s.Y {
		m.Top(f32(top + h + 4))
	} else {
		m.Bottom(f32(d.H - top + 4))
	}
	var secs []store.Section
	for _, sec := range a.store.Sections() {
		if sec.ID != store.SectionClipboard {
			secs = append(secs, sec)
		}
	}
	pal.float(m).Children(func() {
		text(c, tr("存入分组"), 11, 16, 400, pal.muted).Padding(4, 8)
		if len(secs) == 0 {
			text(c, tr("没有可存入的分组"), 11, 16, 400, pal.muted).Padding(4, 8)
		}
		ui.Scroll(c).Children(func() {
			for _, sec := range secs {
				row := ui.Box(c).Padding(4, 8).Radius(6).Key("sec-" + sec.ID)
				if row.Hovered() {
					row.Background(pal.accent)
				}
				row.Children(func() { text(c, sectionName(sec), 12, 17, 400, pal.fg).SingleLine() })
				if row.Clicked() {
					e.sectionMenu = false
					a.shotConfirm(d, shotSection, sec.ID)
					return
				}
			}
		})
	})
}

// shotStyleRow：粗细三档 + 6 色（马赛克只显示粗细，即颗粒大小）。
func (a *app) shotStyleRow(c *ui.Context, d *shotDisplay, pal shotPalette, kind shot.Kind, ink string, lv int) {
	e := &d.ed
	apply := func(nink string, nlv int) {
		a.setShotStyle(kind, nink, nlv)
		if t := e.editing; t != nil {
			t.Color, t.Size = nink, nlv
		} else if p := e.pickedShape(); p != nil {
			n := *p
			n.Color, n.Size = nink, nlv
			e.replacePicked(p, &n)
		}
	}
	ui.Row(c).Gap(8).Padding(0, 4).AlignItems(ui.Center).Children(func() {
		for i := range 3 {
			b := ui.Box(c).Size(20, 20).Radius(6).Center().Key(fmt.Sprintf("lv-%d", i))
			if lv == i {
				b.Background(pal.accent)
			}
			sz := float32(4 + i*3)
			b.Children(func() { ui.Box(c).Size(sz, sz).Radius(sz / 2).Background(pal.fg) })
			if b.Clicked() {
				apply(ink, i)
			}
		}
		if kind == shot.Mosaic {
			return
		}
		ui.Box(c).Size(1, 16).Background(pal.border)
		for _, col := range shot.Colors {
			on := col == ink
			b := ui.Box(c).Size(16, 16).Radius(6).Background(shotColor(col)).Border(1, pal.border).Key("ink-" + col)
			if on {
				b.DrawOver(func(p *ui.Painter, r ui.Rect) {
					p.Stroke(ui.Rect{X: r.X - 3, Y: r.Y - 3, W: r.W + 6, H: r.H + 6}, pal.primary, 9, 2)
				})
			}
			if b.Clicked() {
				apply(col, lv)
			}
		}
	})
}

// shotTextEditor：文字输入框（600 字重、1.25 行高、虚线框）；Enter 完成、⇧Enter 换行、Esc 完成。
func (a *app) shotTextEditor(c *ui.Context, d *shotDisplay) {
	e := &d.ed
	t := e.editing
	fs := shot.FontSize[clampLv(t.Size)]
	lines := strings.Split(t.Text, "\n")
	w := 40.0
	for _, l := range lines {
		w = math.Max(w, shot.TextWidth(l, fs)+12)
	}
	ui.TextAreaBase(c, &t.Text).Absolute().Left(f32(t.X)).Top(f32(t.Y)).Width(f32(w)).Lines(len(lines), len(lines)).
		Font(shotFont).FontSize(f32(fs)).FontWeight(600).FixedLineHeight(f32(fs*shot.TextLineHeight)).TextColor(shotColor(t.Color)).
		Border(1, gray(1, 0.7)).BorderStyle(ui.BorderDashed).Scrollbars(false).Focus().
		OnTextKey(func(k ui.TextKey) bool {
			if k.Key == ui.KeyEscape || (k.Key == ui.KeyEnter && k.Mods&ui.Shift == 0) {
				e.commitEditing()
				return true
			}
			return false
		})
}

// shotCallouts：已填说明以浅色标签贴在编号贴片右侧（只在编辑时显示，不进出图）；正在填写时在框下方出输入卡。
func (a *app) shotCallouts(c *ui.Context, d *shotDisplay, shapes []*shot.Shape) {
	e := &d.ed
	numbers := shot.CalloutNumbers(shapes)
	var drafted *shot.Shape
	if e.note != nil {
		// 填写中的那条：替换原图形的位置，或追加在最后
		for _, s := range shapes {
			if s.Kind == shot.Callout && s.X1 == e.note.Shape.X1 && s.Y1 == e.note.Shape.Y1 && s.X2 == e.note.Shape.X2 && s.Y2 == e.note.Shape.Y2 {
				drafted = s
			}
		}
	}
	cardBg, cardBorder, cardText := gray(1, 0.7), gray(0, 0.1), gray(0, 0.85)
	for _, s := range shapes {
		n, ok := numbers[s]
		if !ok || strings.TrimSpace(s.Note) == "" || s == drafted {
			continue
		}
		t := shot.CalloutTag(s, n)
		ui.Row(c).Absolute().Left(f32(t.X+t.W)).Top(f32(t.Y)).Height(f32(t.H)).MaxWidth(240).Padding(0, 6).AlignItems(ui.Center).
			Radius(0, 8, 8, 0).Background(cardBg).Border(1, cardBorder).Shadow(0, 6, 16, -4, gray(0, 0.12)).PassThrough().Key(fmt.Sprintf("cl-%d", n)).
			Children(func() { text(c, s.Note, 11, 16, 400, cardText).SingleLine() })
	}
	if e.note == nil {
		return
	}
	b := shot.Box(e.note.Shape)
	n := numbers[drafted]
	if n == 0 {
		n = len(numbers)
	}
	color := e.note.Shape.Color
	ui.Row(c).Absolute().Left(f32(b.X)).Top(f32(b.Y+b.H+6)).Width(256).Padding(4, 8, 4, 4).Gap(8).Radius(8).AlignItems(ui.Center).
		Background(cardBg).Border(1, cardBorder).Shadow(0, 1, 2, 0, gray(0, 0.08)).Shadow(0, 6, 16, -4, gray(0, 0.12)).Cursor(ui.CursorDefault).
		Children(func() {
			ui.Box(c).Height(24).MinWidth(24).Padding(0, 4).Radius(8).Center().Background(shotColor(color)).
				Children(func() { text(c, fmt.Sprint(n), 11, 16, 700, shotColor(shot.NumberTextColor(color))) })
			ui.TextInputBase(c, &e.note.Text).Grow(1).Font(fontSans).FontSize(12).TextColor(cardText).
				Placeholder(tr("这里要怎么改？")).PlaceholderColor(gray(0, 0.4)).Label(tr("批注说明")).Focus().
				OnTextKey(func(k ui.TextKey) bool {
					if k.Key == ui.KeyEnter || k.Key == ui.KeyEscape {
						e.commitEditing()
						return true
					}
					return false
				})
		})
}

// shotHoverTip：停留 400ms 后在按钮下方（贴底时上方）显示说明。
func (a *app) shotHoverTip(c *ui.Context, d *shotDisplay) {
	e := &d.ed
	if !e.tipSeen {
		e.tip = ""
	}
	e.tipSeen = false
	if e.tip == "" || e.tipHidden == e.tip || c.Now().Sub(e.tipAt) < shotTipDelay {
		return
	}
	r := e.tipRect
	sp := ui.Span{Text: e.tip, Font: fontSans, Size: 11}
	w, h := c.MeasureText(224, sp)
	w, h = w+16, h+8
	cx := math.Min(math.Max(float64(r.X+r.W/2), 124), d.W-124)
	tip := ui.Box(c).Absolute().Left(f32(cx)-w/2).Width(w).Padding(4, 8).Radius(8).Background(gray(0, 0.75)).
		Shadow(0, 4, 6, -1, gray(0, 0.1)).PassThrough()
	if float64(r.Y+r.H)+48 < d.H {
		tip.Top(r.Y + r.H + 6)
	} else {
		tip.Top(r.Y - 6 - h)
	}
	tip.Children(func() { text(c, e.tip, 11, 16, 400, colWhite).Wrap() })
}
