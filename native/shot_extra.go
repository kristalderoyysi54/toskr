package main

import (
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"math"
	"os"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/ai"
	"github.com/toskr/native/internal/diag"
	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/shot"
)

// 遮罩上的识别文字面板与图内翻译（ScreenshotView runOcr / translateInImage / erasePatch）。

type shotOCR struct {
	text     string
	busy     bool
	err      string
	copiedAt time.Time
}

// shotTranslateJob：识别出的行（选区像素坐标）与 AI 逐行译文，等下一帧（有排版上下文）再生成覆盖。
type shotTranslateJob struct {
	lines []macos.OCRLine
	out   []string
	pr    shot.Rect
	sel   shot.Rect
	err   string
}

const (
	shotOCRPanelW    = 320.0
	shotOCRPanelMaxH = 420.0
	strokeDiff       = 40 // 与背景色的最大通道差超过此值视为文字笔画
)

// update：后台结果回到主线程（无窗口的测试里直接执行）。
func (d *shotDisplay) update(fn func()) {
	if d.win != nil {
		d.win.Update(fn)
		return
	}
	fn()
}

// crop：选区按冻结帧像素裁出（不含标注）。
func (d *shotDisplay) crop(sel shot.Rect) (*image.RGBA, shot.Rect) {
	pr := shot.ToPixelRect(sel, d.sx, d.sy, float64(d.pxW), float64(d.pxH))
	if pr.W < 1 || pr.H < 1 || d.img == nil {
		return nil, pr
	}
	sub := d.img.SubImage(image.Rect(int(pr.X), int(pr.Y), int(pr.X+pr.W), int(pr.Y+pr.H))).(*image.RGBA)
	out := image.NewRGBA(image.Rect(0, 0, sub.Rect.Dx(), sub.Rect.Dy()))
	for y := range out.Rect.Dy() {
		copy(out.Pix[y*out.Stride:y*out.Stride+out.Rect.Dx()*4], sub.Pix[y*sub.Stride:])
	}
	return out, pr
}

// ocrImage：Vision 逐行识别（简中 + 英文），框为图片像素坐标。
func ocrImage(img *image.RGBA) ([]macos.OCRLine, error) {
	f, err := os.CreateTemp("", "toskr-ocr-*.png")
	if err != nil {
		return nil, err
	}
	defer os.Remove(f.Name())
	err = (&png.Encoder{CompressionLevel: png.BestSpeed}).Encode(f, img)
	f.Close()
	if err != nil {
		return nil, err
	}
	return macos.OCRLines(f.Name(), img.Rect.Dx(), img.Rect.Dy())
}

func (a *app) shotRunOCR(c *ui.Context, d *shotDisplay) {
	e := &d.ed
	if e.sel == nil {
		return
	}
	img, _ := d.crop(*e.sel)
	if img == nil {
		return
	}
	e.commitEditing()
	e.tool = ""
	o := &shotOCR{busy: true}
	e.ocr = o
	go func() {
		lines, err := ocrImage(img)
		d.update(func() {
			if e.ocr != o {
				return
			}
			o.busy = false
			if err != nil {
				diag.Push("截图识别失败：%v", err)
				o.err = tr("识别失败")
				return
			}
			texts := make([]string, len(lines))
			for i, l := range lines {
				texts[i] = l.Text
			}
			o.text = strings.Join(texts, "\n")
			if strings.TrimSpace(o.text) == "" {
				o.err = tr("未识别到文字")
			}
		})
	}()
}

// shotOCRPanel：识别结果（可改）+ 复制 / 存入「剪贴」；贴选区右侧，放不下换左侧或内侧。
func (a *app) shotOCRPanel(c *ui.Context, d *shotDisplay, pal shotPalette) {
	e := &d.ed
	o, s := e.ocr, e.sel
	top := math.Min(math.Max(s.Y, 8), math.Max(8, d.H-shotOCRPanelMaxH-8))
	left := s.X + s.W + 12
	if left+shotOCRPanelW > d.W {
		left = s.X - 12 - shotOCRPanelW
		if left < 0 {
			left = math.Max(8, s.X+s.W-shotOCRPanelW-8)
		}
	}
	st := stok(c)
	panel := ui.Column(c).Absolute().Left(f32(left)).Top(f32(top)).Width(shotOCRPanelW).MaxHeight(shotOCRPanelMaxH).Padding(8).Gap(8).Radius(8).
		Cursor(ui.CursorDefault).Key("shot-ocr")
	pal.float(panel).Children(func() {
		ui.Row(c).AlignItems(ui.Center).Justify(ui.SpaceBetween).Children(func() {
			title := tr("识别结果")
			if o.busy {
				title = tr("识别中…")
			}
			text(c, title, 11, 16, 400, pal.muted)
			x := ui.Box(c).Size(20, 20).Radius(8).Center().Label(tr("关闭（Esc）")).Role(ui.RoleButton)
			if x.Hovered() {
				x.Background(pal.hover)
			}
			x.Children(func() { licon(c, "x", 12, pal.muted) })
			if x.Clicked() {
				e.ocr = nil
			}
		})
		if e.ocr == nil {
			return
		}
		ui.TextAreaBase(c, &o.text).Grow(1).Lines(5, 18).Padding(6).Radius(6).Border(1, pal.border).Background(st.input).
			Font(fontSans).FontSize(12).FixedLineHeight(17).TextColor(pal.fg).ReadOnly(o.busy).Focus()
		if o.err != "" {
			text(c, o.err, 11, 16, 400, pal.k.amberText)
		}
		ui.Row(c).Gap(6).Justify(ui.End).Children(func() {
			empty := strings.TrimSpace(o.text) == ""
			label := tr("复制")
			if !o.copiedAt.IsZero() && c.Now().Sub(o.copiedAt) < 900*time.Millisecond {
				label = tr("已复制")
			}
			if shotTextButton(c, st, label, empty) {
				a.sys.Write([]macos.Item{{macos.TypeString: []byte(o.text)}}, false)
				o.copiedAt = c.Now()
				c.After(900 * time.Millisecond)
			}
			if shotTextButton(c, st, tr("存入「剪贴」"), empty) {
				a.saveShotText(o.text)
			}
		})
	})
}

// shotTextButton：Button default 变体 xs（h-6 px-2 rounded-lg text-label）。
func shotTextButton(c *ui.Context, s settingsTokens, label string, disabled bool) bool {
	b := ui.Row(c).Height(24).Padding(0, 8).Radius(10).Border(1, s.btnBorder).AlignItems(ui.Center).Key("tb-" + label).Role(ui.RoleButton).Label(label)
	bg := s.btn
	if disabled {
		b.Opacity(0.5)
	} else if b.Hovered() {
		bg = s.btnHover
	}
	fadeColor(b, "bg", bg, tweenControl).Shadow(0, 1, 2, 0, s.btnShadow)
	b.Children(func() { text(c, label, 11, 16, 500, s.btnFg) })
	return b.Clicked() && !disabled
}

// shotTranslate：图内翻译：识别各行 → AI 逐行翻译 → 只抹原文笔画、译文盖回原处。再点一次去掉。
func (a *app) shotTranslate(c *ui.Context, d *shotDisplay) {
	e := &d.ed
	if slices.ContainsFunc(e.hist.Shapes, func(s *shot.Shape) bool { return s.Kind == shot.Translate }) {
		e.hist = shot.CommitShapes(e.hist, slices.DeleteFunc(slices.Clone(e.hist.Shapes), func(s *shot.Shape) bool { return s.Kind == shot.Translate }))
		return
	}
	if e.sel == nil || e.translating {
		return
	}
	img, pr := d.crop(*e.sel)
	if img == nil {
		return
	}
	e.commitEditing()
	e.tool = ""
	e.translating = true
	e.translateGen++
	gen, sel := e.translateGen, *e.sel
	st := a.store.Settings()
	cfg := ai.Config{Endpoint: st.AIEndpoint, Model: st.AIModel}
	go func() {
		job := &shotTranslateJob{pr: pr, sel: sel}
		cfg.Key = aiKey()
		all, err := ocrImage(img)
		for _, l := range all {
			if strings.TrimSpace(l.Text) != "" {
				job.lines = append(job.lines, l)
			}
		}
		switch {
		case err != nil:
			diag.Push("图内翻译识别失败：%v", err)
			job.err = tr("翻译失败")
		case len(job.lines) == 0:
			job.err = tr("未识别到文字")
		default:
			job.out, err = translateLines(cfg, job.lines)
			if err != nil {
				diag.Push("图内翻译失败：%v", err)
				job.err = tr("翻译失败")
				if errors.Is(err, ai.ErrNoKey) {
					job.err = err.Error()
				}
			}
		}
		d.update(func() {
			if e.translateGen != gen {
				return
			}
			e.translating = false
			e.translated = job
		})
	}()
}

// translateLines：JSON 数组进、同长 JSON 数组出（与 Tauri 主窗口代办的提示词一致）。
func translateLines(cfg ai.Config, lines []macos.OCRLine) ([]string, error) {
	target, fallback := "Simplified Chinese", "English"
	if langEN.Load() {
		target, fallback = "English", "Simplified Chinese"
	}
	texts := make([]string, len(lines))
	for i, l := range lines {
		texts[i] = l.Text
	}
	in, _ := json.Marshal(texts)
	system := "The user message is a JSON array of text lines recognized from a screenshot. Translate each line into " + target +
		"; a line already in " + target + " goes into " + fallback +
		". Keep numbers, code, URLs and product names unchanged. Output only a JSON array of strings with exactly the same length and order."
	out, err := ai.Rewrite(context.Background(), cfg, system, string(in))
	if err != nil {
		return nil, err
	}
	return parseLines(out, len(lines))
}

// parseLines：取回复里的 JSON 字符串数组（容忍代码块包裹），行数须与原文一致。
func parseLines(out string, n int) ([]string, error) {
	out = strings.TrimSpace(out)
	if i, j := strings.Index(out, "["), strings.LastIndex(out, "]"); i >= 0 && j > i {
		out = out[i : j+1]
	}
	var res []string
	if json.Unmarshal([]byte(out), &res) != nil || len(res) != n {
		return nil, errors.New("译文行数不符")
	}
	return res, nil
}

// applyTranslation：在构建期（有排版上下文量字宽）把译文变成图内翻译图形。
func (a *app) applyTranslation(c *ui.Context, d *shotDisplay) {
	e := &d.ed
	job := e.translated
	e.translated = nil
	if job.err != "" {
		e.flash(c, job.err)
		return
	}
	pad := math.Round(shot.TranslatePad * d.sx)
	var items []shot.TranslatedLine
	for i, l := range job.lines {
		patch, bg := erasePatch(d.img, job.pr.X+l.X, job.pr.Y+l.Y, l.W, l.H, pad)
		w, h := l.W/d.sx, l.H/d.sy
		txt := job.out[i]
		items = append(items, shot.TranslatedLine{
			X: job.sel.X + l.X/d.sx, Y: job.sel.Y + l.Y/d.sy, W: w, H: h, Text: txt, Patch: patch,
			FG: shot.ContrastText(float64(bg[0]), float64(bg[1]), float64(bg[2])),
			FontSize: shot.FitFontSize(w, h, func(size float64) float64 {
				tw, _ := c.MeasureText(0, ui.Span{Text: txt, Font: shotFont, Size: f32(size), Weight: 500})
				return float64(tw)
			}),
		})
	}
	e.hist = shot.PushShape(e.hist, &shot.Shape{Kind: shot.Translate, Items: items})
}

// erasePatch：只抹掉文字笔画：识别框外扩 pad 像素，取外圈亮度中位数的像素色当背景，
// 与背景差异明显的像素（再外扩 1px 吃掉抗锯齿边）换成背景色，其余原样保留。
func erasePatch(src *image.RGBA, x, y, w, h, pad float64) (*image.RGBA, [3]uint8) {
	cw, ch := max(1, int(math.Round(w+pad*2))), max(1, int(math.Round(h+pad*2)))
	ox, oy := int(math.Round(x-pad)), int(math.Round(y-pad))
	out := image.NewRGBA(image.Rect(0, 0, cw, ch))
	for yy := range ch {
		sy := oy + yy
		if sy < 0 || sy >= src.Rect.Dy() {
			continue
		}
		for xx := range cw {
			sx := ox + xx
			if sx < 0 || sx >= src.Rect.Dx() {
				continue
			}
			copy(out.Pix[yy*out.Stride+xx*4:yy*out.Stride+xx*4+4], src.Pix[sy*src.Stride+sx*4:])
		}
	}
	d := out.Pix
	type ring struct {
		l       float64
		r, g, b uint8
	}
	var rs []ring
	for yy := range ch {
		for xx := range cw {
			if yy >= 1 && yy < ch-1 && xx >= 1 && xx < cw-1 {
				continue
			}
			i := yy*out.Stride + xx*4
			rs = append(rs, ring{0.299*float64(d[i]) + 0.587*float64(d[i+1]) + 0.114*float64(d[i+2]), d[i], d[i+1], d[i+2]})
		}
	}
	sort.SliceStable(rs, func(i, j int) bool { return rs[i].l < rs[j].l })
	bg := [3]uint8{255, 255, 255}
	if len(rs) > 0 {
		m := rs[len(rs)/2]
		bg = [3]uint8{m.r, m.g, m.b}
	}
	diff := func(v, b uint8) int { return int(math.Abs(float64(int(v) - int(b)))) }
	stroke := make([]bool, cw*ch)
	for i := range cw * ch {
		k := i * 4
		if max(diff(d[k], bg[0]), diff(d[k+1], bg[1]), diff(d[k+2], bg[2])) > strokeDiff {
			stroke[i] = true
		}
	}
	for yy := range ch {
		for xx := range cw {
			hit := false
			for dy := -1; dy <= 1 && !hit; dy++ {
				for dx := -1; dx <= 1 && !hit; dx++ {
					ny, nx := yy+dy, xx+dx
					hit = ny >= 0 && ny < ch && nx >= 0 && nx < cw && stroke[ny*cw+nx]
				}
			}
			if hit {
				k := yy*out.Stride + xx*4
				d[k], d[k+1], d[k+2] = bg[0], bg[1], bg[2]
			}
		}
	}
	return out, bg
}

// patchBitmap：图内翻译补丁的位图缓存（已入历史的补丁不变）。
func (e *shotEditor) patchBitmap(img *image.RGBA) *ui.Bitmap {
	if bm, ok := e.patches[img]; ok {
		return bm
	}
	if e.patches == nil {
		e.patches = map[*image.RGBA]*ui.Bitmap{}
	}
	bm := ui.NewBitmap(img)
	e.patches[img] = bm
	return bm
}
