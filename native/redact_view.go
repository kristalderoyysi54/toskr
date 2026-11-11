package main

import (
	"bytes"
	"errors"
	"fmt"
	"image"
	"image/draw"
	"image/png"
	"math"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/core"
	"github.com/toskr/native/internal/diag"
	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/shot"
	"github.com/toskr/native/internal/store"
)

// 图片打码窗（ImagePreviewView 打码态 + ManualRedactionCanvas + RedactionToolbar）：
// 拖动画框；点框选中后可移动、拖角缩放、⌫ 删除、换样式；方向键微移；滚轮缩放、按住 Space 平移；
// 「识别敏感文字」把 OCR 出的敏感行标成虚线候选框，点一下转为正式框；⌘⏎ 应用写回图片卡（可撤销）。

type redactCandidate struct {
	box   shot.PxBox
	label string
}

type redactGesture struct {
	kind           string // draw | move | resize | pan
	sx, sy, cx, cy float64
	idx            int
	handle         string
	origin         shot.PxBox
	current        shot.PxBox
	vx, vy         float64 // pan 起点视图平移
}

type redactPreview struct {
	region shot.Region
	bm     *ui.Bitmap
}

type redactEditor struct {
	note       store.Note
	file       string // 卡片里正在打码的那张图
	img        *image.RGBA
	bm         *ui.Bitmap
	W, H       int
	past       [][]shot.Region
	present    []shot.Region
	future     [][]shot.Region
	selected   int
	hovered    int
	candidates []redactCandidate
	detecting  bool
	busy       bool  // 应用中（打码后 OCR 复检）
	failed     []int // 复检未通过的框（0 起），任何改动后清除
	view       shot.ZoomView
	gesture    *redactGesture
	space      bool
	lastFill   int // 实色组最近一次的样式下标（1–3）
	previews   map[int]redactPreview
	area       ui.Rect // 画布在窗口里的位置（上一帧）
	win        *mygo.Window
	closed     bool
}

// redactFileFn 可替换（测试里不开窗）。
var redactFileFn = (*app).openRedactorFile

func (a *app) openRedactor(n store.Note) { a.openRedactorFile(n, n.ImageFile) }

// openRedactorFile：卡片里指定的那张图打码（多图 / 图文卡逐张），应用后原位替换。
func (a *app) openRedactorFile(n store.Note, file string) {
	re, err := a.newRedactorFile(n, file)
	if err != nil {
		a.showHUD("warn", err.Error())
		return
	}
	d := mygo.Screen.DisplayNearestPoint(mygo.Screen.CursorScreenPoint())
	wa := d.WorkArea
	scale := math.Max(d.ScaleFactor, 1)
	w := math.Min(math.Max(float64(re.W)/scale+16, 640), float64(wa.Width)*0.85)
	h := math.Min(math.Max(float64(re.H)/scale+16, 420), float64(wa.Height)*0.85)
	re.win = mygo.NewWindow(mygo.WindowOptions{
		Title: tr("图片打码"), Width: int(w), Height: int(h), UseContentSize: true, MinWidth: 560, MinHeight: 360, Hidden: true,
		X: wa.X + (wa.Width-int(w))/2, Y: wa.Y + (wa.Height-int(h))/2, AlwaysOnTop: true,
		Content: ui.View(func(c *ui.Context) { a.redactView(c, re) }),
	})
	re.win.OnClosed(func() { re.closed = true })
	re.win.SetVisibleOnAllWorkspaces(true)
	macos.ActivateSelf()
	re.win.Show()
	re.win.Focus()
}

func (a *app) newRedactor(n store.Note) (*redactEditor, error) {
	return a.newRedactorFile(n, n.ImageFile)
}

func (a *app) newRedactorFile(n store.Note, file string) (*redactEditor, error) {
	raw, err := a.store.LoadImage(file)
	if err != nil {
		return nil, err
	}
	src, err := png.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, errors.New(tr("图片读取失败"))
	}
	img := image.NewRGBA(image.Rect(0, 0, src.Bounds().Dx(), src.Bounds().Dy()))
	draw.Draw(img, img.Rect, src, src.Bounds().Min, draw.Src)
	re := &redactEditor{note: n, file: file, img: img, bm: ui.NewBitmap(img).Pixelated(), W: img.Rect.Dx(), H: img.Rect.Dy(),
		selected: -1, hovered: -1, view: shot.FitView, lastFill: 1, previews: map[int]redactPreview{}}
	if st := a.store.Settings().Shot.RedactStyle; st >= 1 && st <= 3 {
		re.lastFill = st
	}
	return re, nil
}

func (re *redactEditor) close() {
	if re.closed {
		return
	}
	re.closed = true
	if re.win != nil {
		re.win.Destroy()
	}
}

func (a *app) redactDrawStyle() int {
	return min(max(a.store.Settings().Shot.RedactStyle, 0), 3)
}

func (a *app) setRedactDrawStyle(i int) {
	st := a.store.Settings()
	st.Shot.RedactStyle = i
	_ = a.store.SetSettings(st)
}

// commit：记一步撤销历史并更新框列表。
func (re *redactEditor) commit(next []shot.Region) {
	re.failed = nil
	re.past = append(re.past, re.present)
	re.present, re.future = next, nil
}

func (re *redactEditor) undo() {
	if len(re.past) == 0 {
		return
	}
	re.selected, re.failed = -1, nil
	re.future = append([][]shot.Region{re.present}, re.future...)
	re.present, re.past = re.past[len(re.past)-1], re.past[:len(re.past)-1]
}

func (re *redactEditor) redo() {
	if len(re.future) == 0 {
		return
	}
	re.selected, re.failed = -1, nil
	re.past = append(re.past, re.present)
	re.present, re.future = re.future[0], re.future[1:]
}

func (re *redactEditor) remove(i int) {
	if i < 0 || i >= len(re.present) {
		return
	}
	re.commit(slices.Delete(slices.Clone(re.present), i, i+1))
	re.selected = -1
}

func (re *redactEditor) accept(indices []int, style shot.RedactStyle) {
	next := slices.Clone(re.present)
	var rest []redactCandidate
	for i, c := range re.candidates {
		if slices.Contains(indices, i) {
			next = append(next, shot.Region{PxBox: c.box, Style: style})
		} else {
			rest = append(rest, c)
		}
	}
	if len(next) != len(re.present) {
		re.commit(next)
	}
	re.candidates = rest
}

// shown：画布内（容器坐标）的图片显示框。
func (re *redactEditor) shown() shot.Rect {
	base := shot.FitRect(float64(re.area.W), float64(re.area.H), re.W, re.H)
	return re.view.Transformed(base)
}

// preview：框的打码效果位图（按框与样式缓存）。
func (re *redactEditor) preview(i int, r shot.Region) *ui.Bitmap {
	if p, ok := re.previews[i]; ok && p.region == r {
		return p.bm
	}
	pix := shot.RedactedPixels(re.img, r.PxBox, r.Style)
	bm := ui.NewBitmap(&image.RGBA{Pix: pix, Stride: r.W * 4, Rect: image.Rect(0, 0, r.W, r.H)}).Pixelated()
	re.previews[i] = redactPreview{r, bm}
	return bm
}

func (re *redactEditor) regionAt(x, y float64) int {
	sh := re.shown()
	for i := len(re.present) - 1; i >= 0; i-- {
		v := shot.BoxToView(re.present[i].PxBox, sh, re.W, re.H)
		if x >= v.X && y >= v.Y && x <= v.X+v.W && y <= v.Y+v.H {
			return i
		}
	}
	return -1
}

func (re *redactEditor) handleAt(x, y float64) string {
	if re.selected < 0 || re.selected >= len(re.present) {
		return ""
	}
	v := shot.BoxToView(re.present[re.selected].PxBox, re.shown(), re.W, re.H)
	for _, h := range []string{"nw", "ne", "sw", "se"} {
		hx, hy := v.X, v.Y
		if h[1] == 'e' {
			hx += v.W
		}
		if h[0] == 's' {
			hy += v.H
		}
		if math.Abs(hx-x) <= 6 && math.Abs(hy-y) <= 6 {
			return h
		}
	}
	return ""
}

func (re *redactEditor) candidateAt(x, y float64) int {
	sh := re.shown()
	for i, c := range re.candidates {
		v := shot.BoxToView(c.box, sh, re.W, re.H)
		if x >= v.X && y >= v.Y && x <= v.X+v.W && y <= v.Y+v.H {
			return i
		}
	}
	return -1
}

func (a *app) redactInput(re *redactEditor, ev ui.InputEvent) bool {
	if re.busy && (ev.Kind != ui.InputKeyDown || ev.Key != ui.KeyEscape) {
		return true // 复检期间画布只读（同 Tauri disabled），Esc 仍可关窗
	}
	x, y := float64(ev.X), float64(ev.Y)
	sh := re.shown()
	style := shot.RedactStyles[a.redactDrawStyle()].Style
	switch ev.Kind {
	case ui.InputKeyDown:
		return a.redactKey(re, ev)
	case ui.InputKeyUp:
		if ev.Key == ui.KeySpace {
			re.space = false
			return true
		}
		return false
	case ui.InputScroll:
		ax, ay := x-float64(re.area.W)/2, y-float64(re.area.H)/2
		re.view = shot.ZoomAround(re.view, math.Max(1, re.view.Zoom*shot.WheelZoomFactor(float64(ev.DY))), ax, ay)
		return true
	case ui.InputPointerDown:
		if ev.Button != 0 {
			return false
		}
		if ev.Clicks == 2 && re.regionAt(x, y) < 0 {
			re.view = shot.FitView
			return true
		}
		px, py := shot.PointToImage(x, y, sh, re.W, re.H)
		switch {
		case re.space && re.view.Zoom > 1:
			re.gesture = &redactGesture{kind: "pan", sx: x, sy: y, vx: re.view.X, vy: re.view.Y}
		case re.handleAt(x, y) != "":
			r := re.present[re.selected].PxBox
			re.gesture = &redactGesture{kind: "resize", idx: re.selected, handle: re.handleAt(x, y), origin: r, current: r}
		case re.regionAt(x, y) >= 0:
			i := re.regionAt(x, y)
			re.selected = i
			r := re.present[i].PxBox
			re.gesture = &redactGesture{kind: "move", idx: i, sx: px, sy: py, origin: r, current: r}
		case re.candidateAt(x, y) >= 0:
			re.accept([]int{re.candidateAt(x, y)}, style)
		default:
			re.selected = -1
			re.gesture = &redactGesture{kind: "draw", sx: px, sy: py, cx: px, cy: py}
		}
		return true
	case ui.InputPointerMove:
		g := re.gesture
		if g == nil {
			re.hovered = re.regionAt(x, y)
			return true
		}
		px, py := shot.PointToImage(x, y, sh, re.W, re.H)
		switch g.kind {
		case "pan":
			re.view.X, re.view.Y = g.vx+x-g.sx, g.vy+y-g.sy
		case "draw":
			g.cx, g.cy = px, py
		case "move":
			g.current = shot.MoveBox(g.origin, px-g.sx, py-g.sy, re.W, re.H)
		case "resize":
			g.current = shot.ResizeBox(g.origin, g.handle, px, py, re.W, re.H)
		}
		return true
	case ui.InputPointerUp:
		g := re.gesture
		re.gesture = nil
		if g == nil {
			return true
		}
		switch g.kind {
		case "draw":
			if b, ok := shot.BoxFromDrag(g.sx, g.sy, g.cx, g.cy, re.W, re.H); ok && b.W >= 2 && b.H >= 2 {
				re.commit(append(slices.Clone(re.present), shot.Region{PxBox: b, Style: style}))
				re.selected = len(re.present) - 1
			}
		case "move", "resize":
			if g.current != g.origin {
				next := slices.Clone(re.present)
				next[g.idx].PxBox = g.current
				re.commit(next)
			}
		}
		return true
	}
	return false
}

// redactKey：⌫ 删除选中、方向键微移（⇧ 五倍）、Space 平移、⌘Z / ⇧⌘Z、⌘⏎ 应用、Esc 逐层退出。
func (a *app) redactKey(re *redactEditor, ev ui.InputEvent) bool {
	cmd := ev.Mods&ui.Cmd != 0
	switch {
	case ev.Key == ui.KeySpace:
		re.space = true
	case ev.Key == ui.KeyEscape:
		switch {
		case re.selected >= 0:
			re.selected = -1
		case len(re.candidates) > 0:
			re.candidates = nil
		default:
			re.close()
		}
	case ev.Key == ui.KeyZ && cmd && ev.Mods&ui.Shift != 0:
		re.redo()
	case ev.Key == ui.KeyZ && cmd:
		re.undo()
	case ev.Key == ui.KeyEnter && cmd:
		a.applyRedaction(re)
	case (ev.Key == ui.KeyBackspace || ev.Key == ui.KeyDelete) && re.selected >= 0:
		re.remove(re.selected)
	case re.selected >= 0 && (ev.Key == ui.KeyLeft || ev.Key == ui.KeyRight || ev.Key == ui.KeyUp || ev.Key == ui.KeyDown):
		mul := 1
		if ev.Mods&ui.Shift != 0 {
			mul = 5
		}
		sx, sy := max(1, int(math.Round(float64(re.W)/100)))*mul, max(1, int(math.Round(float64(re.H)/100)))*mul
		dx, dy := 0, 0
		switch ev.Key {
		case ui.KeyLeft:
			dx = -sx
		case ui.KeyRight:
			dx = sx
		case ui.KeyUp:
			dy = -sy
		default:
			dy = sy
		}
		next := slices.Clone(re.present)
		next[re.selected].PxBox = shot.MoveBox(next[re.selected].PxBox, float64(dx), float64(dy), re.W, re.H)
		re.commit(next)
	default:
		return false
	}
	return true
}

// recheckOCR：复检用的识别（测试替换）。
var recheckOCR = ocrImage

// applyRedaction：把各框写进图片副本，对副本重新 OCR 复检（同 Rust verify_redaction）：
// 任何识别框过半落在打码框内即不保存、标红对应框；复检 OCR 本身不可用时不阻断。
// 通过后存成新图换进图片卡（原图保留，气泡可撤销）。
func (a *app) applyRedaction(re *redactEditor) {
	if len(re.present) == 0 || re.busy {
		return
	}
	re.busy, re.selected, re.failed = true, -1, nil
	regions, img, W, H := slices.Clone(re.present), re.img, re.W, re.H
	work := func() {
		out := shot.ApplyRedactions(img, regions)
		var failing []int
		if lines, err := recheckOCR(out); err != nil {
			diag.Push("图片打码复检跳过：复检 OCR 不可用（%v）", err)
		} else {
			boxes := make([]shot.PxBox, len(lines))
			for i, l := range lines {
				boxes[i], _ = shot.BoxFromDrag(l.X, l.Y, l.X+l.W, l.Y+l.H, W, H)
			}
			masks := make([]shot.PxBox, len(regions))
			for i, r := range regions {
				masks[i] = r.PxBox
			}
			if failing = shot.FailingRegions(boxes, masks); len(failing) == 0 {
				diag.Push("图片打码复检通过 regions=%d residual_observations=%d", len(regions), len(boxes))
			}
		}
		var buf bytes.Buffer
		encErr := (&png.Encoder{CompressionLevel: png.BestSpeed}).Encode(&buf, out)
		re.update(func() {
			re.busy = false
			switch {
			case re.closed:
			case len(failing) > 0:
				re.failed = failing
				nums := make([]string, len(failing))
				for i, f := range failing {
					nums[i] = strconv.Itoa(f + 1)
				}
				diag.Push("图片打码复检未通过：第 %s 处", strings.Join(nums, "、"))
				a.showHUD("warn", fmt.Sprintf(tr("遮挡校验未通过：第 %s 处遮挡区域内仍能识别出文字，请扩大后重试"), strings.Join(nums, "、")))
			case encErr != nil:
				a.showHUD("warn", tr("图片打码未保存"))
			default:
				diag.Push("图片打码: %d 处", len(regions))
				re.close()
				a.replaceNoteImage(re.note, re.file, buf.Bytes(), W, H, fmt.Sprintf(tr("已打码 %d 处"), len(regions)))
			}
		})
	}
	if re.win == nil {
		work() // 无窗口（测试）同步跑
		return
	}
	go work()
}

// update：回主线程改状态（无窗口时直接执行）。
func (re *redactEditor) update(fn func()) {
	if re.win != nil {
		re.win.Update(fn)
	} else {
		fn()
	}
}

// detectSensitive：OCR 逐行 + 敏感内容预检，命中的字段按字符比例截出候选框（外扩 2px）。
func (a *app) redactDetect(re *redactEditor) {
	if re.detecting {
		return
	}
	re.detecting = true
	img := re.img
	rules := a.scanRules()
	rules.Off = false // 打码里主动点「识别」不受发送前检查总开关影响；类别与自定义字段照用
	go func() {
		lines, err := ocrImage(img)
		re.update(func() {
			re.detecting = false
			if err != nil {
				a.showHUD("warn", fmt.Sprintf(tr("识别失败：%v"), err))
				return
			}
			found := sensitiveBoxes(lines, re.W, re.H, rules)
			var next []redactCandidate
			seen := map[shot.PxBox]bool{}
			for _, c := range found {
				covered := slices.ContainsFunc(re.present, func(r shot.Region) bool {
					return r.X <= c.box.X && r.Y <= c.box.Y && r.X+r.W >= c.box.X+c.box.W && r.Y+r.H >= c.box.Y+c.box.H
				})
				if !seen[c.box] && !covered {
					seen[c.box] = true
					next = append(next, c)
				}
			}
			re.candidates = next
			if len(next) == 0 {
				msg := tr("没有发现敏感文字，可以手动框选")
				if len(found) > 0 {
					msg = tr("识别到的敏感文字都已遮挡")
				}
				a.showHUD("info", msg)
			}
		})
	}()
}

func sensitiveBoxes(lines []macos.OCRLine, W, H int, rules core.Rules) []redactCandidate {
	var out []redactCandidate
	for _, l := range lines {
		total := utf8.RuneCountInString(l.Text)
		if total == 0 {
			continue
		}
		for _, f := range core.Scan(l.Text, rules) {
			s, e := utf8.RuneCountInString(l.Text[:f.Start]), utf8.RuneCountInString(l.Text[:f.End])
			x0 := l.X + l.W*float64(s)/float64(total) - 2
			x1 := l.X + l.W*float64(e)/float64(total) + 2
			if b, ok := shot.BoxFromDrag(x0, l.Y-2, x1, l.Y+l.H+2, W, H); ok {
				out = append(out, redactCandidate{b, f.Kind})
			}
		}
	}
	return out
}

// ---- 视图 ----

func (a *app) redactView(c *ui.Context, re *redactEditor) {
	k := tok(c)
	pal := shotColors(c)
	warn := k.amberText
	bg := gray(1, 1)
	if k.dark {
		bg = gray(0.145, 1)
	}
	c.Root().Background(bg)
	if re.closed {
		return
	}
	cursor := ui.CursorCrosshair
	switch {
	case re.gesture != nil && re.gesture.kind == "move":
		cursor = ui.CursorGrabbing
	case re.space && re.view.Zoom > 1:
		cursor = ui.CursorGrab
	case re.detecting || re.busy:
		cursor = ui.CursorDefault
	}
	var canvas ui.Element
	ui.Box(c).Fill().Padding(8).Children(func() { canvas = ui.Box(c).Fill().Clip() })
	canvas.Cursor(cursor).Focusable().Focus().FocusRing(false).
		Label(tr("手动打码画布，拖动框选要遮挡的区域，点击已有框可移动或调整大小")).
		HandleInput(func(ev ui.InputEvent) bool { return a.redactInput(re, ev) })
	re.area = canvas.LayoutBounds()
	canvas.Draw(func(p *ui.Painter, r ui.Rect) {
		re.area.W, re.area.H = r.W, r.H
		sh := re.shown()
		off := func(v shot.Rect) ui.Rect {
			return ui.Rect{X: r.X + f32(v.X), Y: r.Y + f32(v.Y), W: f32(v.W), H: f32(v.H)}
		}
		p.ImageRegion(re.bm, ui.Rect{}, off(sh), ui.ImageOptions{})
		regions := slices.Clone(re.present)
		if g := re.gesture; g != nil && (g.kind == "move" || g.kind == "resize") && g.idx < len(regions) {
			regions[g.idx].PxBox = g.current
		}
		for i, rg := range regions {
			p.ImageRegion(re.preview(i, rg), ui.Rect{}, off(shot.BoxToView(rg.PxBox, sh, re.W, re.H)), ui.ImageOptions{})
		}
		if g := re.gesture; g != nil && g.kind == "draw" {
			if b, ok := shot.BoxFromDrag(g.sx, g.sy, g.cx, g.cy, re.W, re.H); ok {
				rg := shot.Region{PxBox: b, Style: shot.RedactStyles[a.redactDrawStyle()].Style}
				pix := shot.RedactedPixels(re.img, b, rg.Style)
				p.ImageRegion(ui.NewBitmap(&image.RGBA{Pix: pix, Stride: b.W * 4, Rect: image.Rect(0, 0, b.W, b.H)}).Pixelated(), ui.Rect{}, off(shot.BoxToView(b, sh, re.W, re.H)), ui.ImageOptions{})
			}
		}
		for i, rg := range regions {
			v := off(shot.BoxToView(rg.PxBox, sh, re.W, re.H))
			o := ui.Rect{X: v.X - 2.5, Y: v.Y - 2.5, W: v.W + 5, H: v.H + 5}
			switch {
			case i == re.selected:
				p.Stroke(o, pal.primary, 2, 1.5)
				for _, h := range [][2]float32{{v.X, v.Y}, {v.X + v.W, v.Y}, {v.X, v.Y + v.H}, {v.X + v.W, v.Y + v.H}} {
					hr := ui.Rect{X: h[0] - 4, Y: h[1] - 4, W: 8, H: 8}
					p.Fill(hr, bg, 2)
					p.Stroke(hr, pal.primary, 2, 1.5)
				}
			case slices.Contains(re.failed, i):
				p.Stroke(ui.Rect{X: v.X - 3, Y: v.Y - 3, W: v.W + 6, H: v.H + 6}, pal.k.danger, 2, 2)
			case i == re.hovered && re.gesture == nil:
				p.Stroke(o, gray(1, 0.8), 2, 1.5)
			}
		}
		for _, cd := range re.candidates {
			v := off(shot.BoxToView(cd.box, sh, re.W, re.H))
			p.Fill(v, warn.Alpha(0.1), 1)
			p.StrokeDashed(v, warn, 1, 1.5)
			sp := ui.Span{Text: cd.label, Font: fontSans, Size: 10, Weight: 600, Color: colBlack}
			tw, _ := p.MeasureText(0, sp)
			tag := ui.Rect{X: v.X, Y: v.Y - 16, W: tw + 8, H: 16}
			p.Fill(tag, warn, 3)
			p.RichText(tag.X+4, tag.Y+1, 0, sp)
		}
	})
	if re.selected >= 0 && re.selected < len(re.present) && re.gesture == nil {
		a.redactRegionBar(c, re, pal)
	}
	if len(re.candidates) > 0 {
		a.redactBanner(c, re, pal, warn)
	}
	a.redactToolbar(c, re, pal, warn)
}

// redactGlyph：样式小图标：马赛克 / 色块 / 吸管。
func redactGlyph(c *ui.Context, pal shotPalette, i int) {
	st := shot.RedactStyles[i].Style
	switch st.Kind {
	case shot.RedactMosaic:
		licon(c, "grid-3x3", 14, pal.fg)
	case shot.RedactPick:
		licon(c, "pipette", 14, pal.fg)
	default:
		ui.Box(c).Size(12, 12).Radius(3).Background(ui.RGB(st.Color[0], st.Color[1], st.Color[2])).Border(1, pal.fg.Alpha(0.25))
	}
}

// redactRegionBar：选中框浮条：四种样式 + 删除。
func (a *app) redactRegionBar(c *ui.Context, re *redactEditor, pal shotPalette) {
	v := shot.BoxToView(re.present[re.selected].PxBox, re.shown(), re.W, re.H)
	const barW, barH = 4*26 + 9 + 26 + 4, 30.0
	x := math.Min(math.Max(v.X+v.W/2-barW/2+8, 8), float64(re.area.W)-barW+8)
	y := v.Y - barH - 6 + 8
	if y < 8 {
		y = v.Y + v.H + 6 + 8
	}
	bar := ui.Row(c).Absolute().Left(f32(x)).Top(f32(y)).Padding(2).Gap(2).Radius(10).AlignItems(ui.Center).Key("redact-bar")
	pal.float(bar).Children(func() {
		cur := re.present[re.selected].Style
		for i, opt := range shot.RedactStyles {
			b := ui.Box(c).Size(26, 26).Radius(8).Center().Key(fmt.Sprintf("rs-%d", i)).Role(ui.RoleButton).Label(fmt.Sprintf(tr("改为%s"), tr(opt.Label))).Tooltip(tr(opt.Label))
			if opt.Style == cur || b.Hovered() {
				b.Background(pal.hover)
			}
			b.Children(func() { redactGlyph(c, pal, i) })
			if b.Clicked() && opt.Style != cur {
				next := slices.Clone(re.present)
				next[re.selected].Style = opt.Style
				re.commit(next)
			}
		}
		ui.Box(c).Size(1, 16).Margin(0, 2).Background(pal.border)
		del := ui.Box(c).Size(26, 26).Radius(8).Center().Role(ui.RoleButton).Label(tr("删除这个框（⌫）")).Tooltip(tr("删除这个框（⌫）"))
		fg := pal.muted
		if del.Hovered() {
			del.Background(pal.k.danger.Alpha(0.1))
			fg = pal.k.danger
		}
		del.Children(func() { licon(c, "trash-2", 14, fg) })
		if del.Clicked() {
			re.remove(re.selected)
		}
	})
}

// redactBanner：识别结果提示条：全部打码 / 忽略。
func (a *app) redactBanner(c *ui.Context, re *redactEditor, pal shotPalette, warn ui.Color) {
	st := stok(c)
	ui.Row(c).Absolute().Top(16).Left(0).Right(0).Justify(ui.Center).PassThrough().Children(func() {
		bar := ui.Row(c).Padding(4, 4, 4, 12).Gap(8).Radius(10).AlignItems(ui.Center)
		pal.float(bar).Children(func() {
			ui.Box(c).Size(8, 8).Radius(4).Background(warn)
			text(c, fmt.Sprintf(tr("识别到 %d 处敏感文字，点虚线框逐个打码"), len(re.candidates)), 11, 16, 400, pal.fg)
			if shotTextButton(c, st, tr("全部打码"), false) {
				all := make([]int, len(re.candidates))
				for i := range all {
					all[i] = i
				}
				re.accept(all, shot.RedactStyles[a.redactDrawStyle()].Style)
			}
			if ghostButton(c, pal, tr("忽略"), false) {
				re.candidates = nil
			}
		})
	})
}

func ghostButton(c *ui.Context, pal shotPalette, label string, disabled bool) bool {
	b := ui.Row(c).Height(24).Padding(0, 8).Radius(10).AlignItems(ui.Center).Key("gb-" + label).Role(ui.RoleButton).Label(label)
	if disabled {
		b.Opacity(0.5)
	} else if b.Hovered() {
		b.Background(pal.hover)
	}
	b.Children(func() { text(c, label, 11, 16, 500, pal.fg) })
	return b.Clicked() && !disabled
}

// redactToolbar：浮在图片底部：马赛克 | 实色（黑 / 白 / 取色）· 识别敏感文字 · 撤销重做 · N 处 · 帮助 · 取消 · 应用。
func (a *app) redactToolbar(c *ui.Context, re *redactEditor, pal shotPalette, warn ui.Color) {
	cur := a.redactDrawStyle()
	fill := cur != 0
	if fill {
		re.lastFill = cur
	}
	st := stok(c)
	ui.Row(c).Absolute().Bottom(20).Left(0).Right(0).Justify(ui.Center).PassThrough().Children(func() {
		bar := ui.Row(c).Padding(4).Gap(4).Radius(14).AlignItems(ui.Center).Key("redact-toolbar").Label(tr("打码工具"))
		pal.float(bar).Children(func() {
			ui.Row(c).Padding(2).Gap(1).Radius(10).Background(pal.k.track).Children(func() {
				seg := func(label string, active bool, glyph int, pick int) {
					b := ui.Row(c).Height(24).Padding(0, 8).Gap(6).Radius(8).AlignItems(ui.Center).Key("seg-" + label).Role(ui.RoleButton).Label(label)
					fg := pal.muted
					if active {
						b.Background(pal.k.pill).Shadow(0, 1, 2, 0, gray(0, 0.05))
						fg = pal.fg
					} else if b.Hovered() {
						fg = pal.fg
					}
					b.Children(func() {
						redactGlyph(c, pal, glyph)
						text(c, label, 11, 16, 400, fg)
					})
					if b.Clicked() {
						a.setRedactDrawStyle(pick)
					}
				}
				seg(tr("马赛克"), !fill, 0, 0)
				seg(tr("实色"), fill, 1, re.lastFill)
			})
			if fill {
				for i := 1; i <= 3; i++ {
					b := ui.Box(c).Size(26, 26).Radius(8).Center().Key(fmt.Sprintf("fill-%d", i)).Role(ui.RoleButton).Label(tr(shot.RedactStyles[i].Label)).Tooltip(tr(shot.RedactStyles[i].Label))
					if cur == i || b.Hovered() {
						b.Background(pal.hover)
					}
					b.Children(func() { redactGlyph(c, pal, i) })
					if b.Clicked() {
						a.setRedactDrawStyle(i)
					}
				}
			}
			shotSep(c, pal)
			det := ui.Row(c).Height(24).Padding(0, 8).Gap(4).Radius(10).Border(1, warn.Alpha(0.5)).AlignItems(ui.Center).Key("detect").Role(ui.RoleButton)
			label := tr("识别敏感文字")
			if re.detecting {
				label = tr("识别中…")
				det.Opacity(0.5)
			} else if det.Hovered() {
				det.Background(warn.Alpha(0.08))
			}
			det.Label(label).Children(func() {
				if re.detecting {
					licon(c, "loader-circle", 12, warn).Rotate(det.Loop("spin", time.Second, ui.Linear) * 360)
				} else {
					licon(c, "sparkles", 12, warn)
				}
				text(c, label, 11, 16, 500, warn)
			})
			if det.Clicked() && !re.detecting {
				a.redactDetect(re)
			}
			shotSep(c, pal)
			small := func(icon, label string, disabled bool) bool {
				b := ui.Box(c).Size(22, 22).Radius(8).Center().Key("sm-" + icon).Role(ui.RoleButton).Label(label).Tooltip(label)
				fg := pal.muted
				if disabled {
					b.Opacity(0.45)
				} else if b.Hovered() {
					b.Background(pal.hover)
					fg = pal.fg
				}
				b.Children(func() { licon(c, icon, 14, fg) })
				return b.Clicked() && !disabled
			}
			if small("undo-2", tr("撤销（⌘Z）"), len(re.past) == 0) {
				re.undo()
			}
			if small("redo-2", tr("重做（⌘⇧Z）"), len(re.future) == 0) {
				re.redo()
			}
			text(c, fmt.Sprintf(tr("%d 处"), len(re.present)), 10, 14, 400, pal.muted).FontFeatures("tnum").MinWidth(32).TextAlign(ui.Center)
			small("circle-question-mark", tr("拖动画框 · 点框选中后可移动、拖角缩放、⌫ 删除 · 方向键微移（⇧ 加大步长）· 滚轮缩放 · 按住 Space 平移 · ⌘⏎ 应用 · Esc 逐层退出"), false)
			if ghostButton(c, pal, tr("取消"), false) {
				re.close()
				return
			}
			apply := tr("应用")
			if re.busy {
				apply = tr("复检中…")
			}
			if primaryButton(c, st, apply, len(re.present) == 0 || re.busy) {
				a.applyRedaction(re)
			}
		})
	})
}

// primaryButton：Button default 变体里的主操作（xs）。
func primaryButton(c *ui.Context, s settingsTokens, label string, disabled bool) bool {
	b := ui.Row(c).Height(24).Padding(0, 8).Radius(10).AlignItems(ui.Center).Key("pb-" + label).Role(ui.RoleButton).Label(label)
	bg := s.primary
	if disabled {
		b.Opacity(0.5)
	} else if b.Hovered() {
		bg = s.primary.Alpha(0.9)
	}
	b.Background(bg).Children(func() { text(c, label, 11, 16, 500, colWhite) })
	return b.Clicked() && !disabled
}
