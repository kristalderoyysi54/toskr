package main

import (
	"fmt"
	"math"
	"net/url"
	"os/exec"
	"slices"
	"strings"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
)

// 截图识别文字的三项扩充（原生版新增）：
//  1. 识别后各行文字在选区上有可点的框——点选 / ⇧ 连选 / 在选区里拖一个框框住几行，只复制选中的行（不必整段全拿）；
//  2. 选区里有二维码时，文字面板里列出内容，网址可直接打开；
//  3. 选中的行排得像表格（≥ 2 行、每行 ≥ 2 格且列对齐）时可复制为 Markdown 表。
// 粒度是 Vision 给的「行」（一格表格、一行文字各是一个框），行内的字级选择仍在面板的文本框里做。

var detectBarcodes = macos.DetectBarcodes // 测试替换

// pickedIdx：选中的行下标（升序）；没选任何行 = 全部。
func (o *shotOCR) pickedIdx() []int {
	var out []int
	for i := range o.lines {
		if o.picked[i] {
			out = append(out, i)
		}
	}
	if len(out) == 0 {
		for i := range o.lines {
			out = append(out, i)
		}
	}
	return out
}

func (o *shotOCR) pickedLines() []macos.OCRLine {
	var out []macos.OCRLine
	for _, i := range o.pickedIdx() {
		out = append(out, o.lines[i])
	}
	return out
}

// syncText：选中的行变了 → 面板文本框换成这些行（手改过的内容会被覆盖，所以只在选择变化时调用）。
func (o *shotOCR) syncText() {
	var ts []string
	for _, l := range o.pickedLines() {
		ts = append(ts, l.Text)
	}
	o.text = strings.Join(ts, "\n")
}

func (o *shotOCR) togglePick(i int, extend bool) {
	if o.picked == nil {
		o.picked = map[int]bool{}
	}
	if extend && o.anchor >= 0 && o.anchor < len(o.lines) { // ⇧：从上次点的那行连选到这行
		lo, hi := min(o.anchor, i), max(o.anchor, i)
		for j := lo; j <= hi; j++ {
			o.picked[j] = true
		}
	} else {
		o.picked[i] = !o.picked[i]
		o.anchor = i
	}
	o.syncText()
}

// lineAt：图片像素坐标 (px, py) 落在哪一行的框里（-1 = 没有）。
func (o *shotOCR) lineAt(px, py float64) int {
	for i, l := range o.lines {
		if px >= l.X && px <= l.X+l.W && py >= l.Y && py <= l.Y+l.H {
			return i
		}
	}
	return -1
}

// pickBand：拖出的框（图片像素）碰到的行全部选中，替换原选择。
func (o *shotOCR) pickBand(x0, y0, x1, y1 float64) {
	x0, x1 = math.Min(x0, x1), math.Max(x0, x1)
	y0, y1 = math.Min(y0, y1), math.Max(y0, y1)
	o.picked = map[int]bool{}
	for i, l := range o.lines {
		if l.X < x1 && l.X+l.W > x0 && l.Y < y1 && l.Y+l.H > y0 {
			o.picked[i] = true
			o.anchor = i
		}
	}
	o.syncText()
}

// shotPickInput：识别结果在场时，选区内的指针归选行——按下 + 拖动拉框，原地点一下切换那一行。返回 true 表示已处理。
func (a *app) shotPickInput(d *shotDisplay, ev ui.InputEvent) bool {
	e := &d.ed
	o := e.ocr
	if o == nil || o.busy || len(o.lines) == 0 || e.sel == nil {
		return false
	}
	x, y := float64(ev.X), float64(ev.Y)
	px, py := (x-e.sel.X)*d.sx, (y-e.sel.Y)*d.sy // 选区内的图片像素
	switch ev.Kind {
	case ui.InputPointerDown:
		if ev.Button != 0 {
			return false
		}
		o.band, o.banding, o.moved = [4]float64{px, py, px, py}, true, false
		return true
	case ui.InputPointerMove:
		if !o.banding {
			return false
		}
		o.band[2], o.band[3] = px, py
		if math.Abs(px-o.band[0]) > 6 || math.Abs(py-o.band[1]) > 6 {
			o.moved = true
		}
		if o.moved {
			o.pickBand(o.band[0], o.band[1], px, py)
		}
		return true
	case ui.InputPointerUp:
		if !o.banding {
			return false
		}
		o.banding = false
		if !o.moved {
			if i := o.lineAt(px, py); i >= 0 {
				o.togglePick(i, ev.Mods&ui.Shift != 0)
			} else if len(o.picked) > 0 { // 点空白处：清掉选择（回到全部）
				o.picked = nil
				o.syncText()
			}
		}
		return true
	}
	return false
}

// shotOCRLines：选区上的行框与拖选框。
func (a *app) shotOCRLines(c *ui.Context, d *shotDisplay) {
	e := &d.ed
	o := e.ocr
	if o == nil || o.busy || len(o.lines) == 0 || e.sel == nil {
		return
	}
	s := stok(c)
	sel := *e.sel
	layer := ui.Box(c).Absolute().Left(f32(sel.X)).Top(f32(sel.Y)).Size(f32(sel.W), f32(sel.H)).Cursor(ui.CursorText).Key("shot-ocr-lines").
		Label(tr("识别出的文字行")).HandleInput(func(ev ui.InputEvent) bool { return a.shotPickInput(d, ev) })
	layer.Children(func() {
		for i, l := range o.lines {
			b := ui.Box(c).Absolute().Left(f32(l.X/d.sx)-1).Top(f32(l.Y/d.sy)-1).Size(f32(l.W/d.sx)+2, f32(l.H/d.sy)+2).Radius(3).PassThrough().
				Key("ocr-line-" + itoa(i)).Label(l.Text)
			if o.picked[i] {
				b.Background(s.primary.Alpha(0.28)).Border(1, s.primary.Alpha(0.8))
			} else {
				b.Border(1, s.primary.Alpha(0.35))
			}
		}
		if o.banding && o.moved {
			x0, x1 := math.Min(o.band[0], o.band[2])/d.sx, math.Max(o.band[0], o.band[2])/d.sx
			y0, y1 := math.Min(o.band[1], o.band[3])/d.sy, math.Max(o.band[1], o.band[3])/d.sy
			ui.Box(c).Absolute().Left(f32(x0)).Top(f32(y0)).Size(f32(x1-x0), f32(y1-y0)).Background(s.primary.Alpha(0.08)).Border(1, s.primary.Alpha(0.6)).PassThrough().Key("ocr-band")
		}
	})
}

// isWebURL：能交给系统打开的网址。
func isWebURL(s string) bool {
	u, err := url.Parse(strings.TrimSpace(s))
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != ""
}

// shotOCRExtras：文字面板里的附加行——选择计数、二维码内容、复制为表格。
func (a *app) shotOCRExtras(c *ui.Context, d *shotDisplay, pal shotPalette) {
	o := d.ed.ocr
	st := stok(c)
	if len(o.lines) > 1 {
		hint := tr("在选区里点选或拖框，只取其中几行")
		if n := len(o.picked); n > 0 {
			cnt := 0
			for _, v := range o.picked {
				if v {
					cnt++
				}
			}
			if cnt > 0 {
				hint = fmt.Sprintf(tr("已选 %d / %d 行"), cnt, len(o.lines))
			}
		}
		text(c, hint, 10, 14, 400, pal.muted)
	}
	for i, q := range o.qr {
		ui.Row(c).Gap(6).AlignItems(ui.Center).Key("ocr-qr-" + itoa(i)).Children(func() {
			licon(c, "scan-text", 12, pal.muted)
			tipOf(c, text(c, q, 11, 16, 400, pal.fg).SingleLine().Grow(1).Basis(0), q)
			if isWebURL(q) {
				if shotTextButton(c, st, tr("打开链接"), false) {
					openURL(q)
				}
			} else if shotTextButton(c, st, tr("复制内容"), false) {
				a.copyShotText(q)
			}
		})
	}
}

var openURL = func(u string) { _ = exec.Command("/usr/bin/open", u).Start() } // 测试替换

// ---- 表格 → Markdown ----

// tableFromLines：把识别出的行按纵向位置分成表格行、按横向位置对齐成列。
// 至少 2 行、至少 2 列，且多数行的格数与列数一致才算表格。
func tableFromLines(lines []macos.OCRLine) (string, bool) {
	if len(lines) < 4 {
		return "", false
	}
	ls := slices.Clone(lines)
	slices.SortStableFunc(ls, func(a, b macos.OCRLine) int {
		if d := (a.Y + a.H/2) - (b.Y + b.H/2); math.Abs(d) > math.Min(a.H, b.H)*0.6 {
			if d < 0 {
				return -1
			}
			return 1
		}
		switch {
		case a.X < b.X:
			return -1
		case a.X > b.X:
			return 1
		}
		return 0
	})
	// 分行：中心纵坐标相差不到半个行高的归一行
	var rows [][]macos.OCRLine
	for _, l := range ls {
		if n := len(rows); n > 0 {
			last := rows[n-1][0]
			if math.Abs((l.Y+l.H/2)-(last.Y+last.H/2)) <= math.Min(l.H, last.H)*0.6 {
				rows[n-1] = append(rows[n-1], l)
				continue
			}
		}
		rows = append(rows, []macos.OCRLine{l})
	}
	if len(rows) < 2 {
		return "", false
	}
	// 列：各格的左缘聚类（相差不到一个字高算同一列）
	var cols []float64
	tol := ls[0].H
	for _, r := range rows {
		slices.SortFunc(r, func(a, b macos.OCRLine) int { return int(a.X - b.X) })
		for _, cell := range r {
			if !slices.ContainsFunc(cols, func(x float64) bool { return math.Abs(x-cell.X) <= tol }) {
				cols = append(cols, cell.X)
			}
		}
	}
	slices.Sort(cols)
	if len(cols) < 2 {
		return "", false
	}
	full := 0
	grid := make([][]string, len(rows))
	for i, r := range rows {
		grid[i] = make([]string, len(cols))
		if len(r) == len(cols) {
			full++
		}
		for _, cell := range r {
			best := 0
			for j, x := range cols {
				if math.Abs(x-cell.X) < math.Abs(cols[best]-cell.X) {
					best = j
				}
			}
			t := strings.ReplaceAll(strings.TrimSpace(cell.Text), "|", "\\|")
			if grid[i][best] != "" {
				t = grid[i][best] + " " + t
			}
			grid[i][best] = t
		}
	}
	if full*2 < len(rows) { // 多数行凑不齐列数：不是表格（多半是普通段落）
		return "", false
	}
	var b strings.Builder
	for i, r := range grid {
		b.WriteString("| " + strings.Join(r, " | ") + " |\n")
		if i == 0 {
			b.WriteString("|" + strings.Repeat(" --- |", len(cols)) + "\n")
		}
	}
	return strings.TrimRight(b.String(), "\n"), true
}
