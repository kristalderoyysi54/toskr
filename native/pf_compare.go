package main

import (
	"fmt"
	"image"
	"maps"
	"slices"
	"strings"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

// 发送前对比窗（用户 2026-11-09）：独立窗口左右两栏，左「原文」右「将发送」。
//   - 文字按行对齐（行级 Myers），同一行内再按字差分：删掉的红底删除线、换上的绿底；未改动的长段落折叠成「省略 N 行」，点开展开；
//   - 预检进行中（实时模式）可直接在窗里处理：改动行悬停出操作——「还原为原文」（占位符 / 词典化名）、「替换 / 保留」（还没处理的命中，
//     右栏以琥珀波浪线标出）；图片左栏原图上的命中框点一下即在「遮挡 ⇄ 保留原文」间切换，右栏实时显示实际发送图；
//   - 发送后在「最近发送」里可再打开当时的对比（快照只在内存，退出即清，同占位符映射；发送记录本身仍不保存正文）。

func init() {
	lucide["columns-2"] = `<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M12 3v18"/>`
	lucide["chevrons-up-down"] = `<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>`
	for k, v := range map[string]string{
		"发送前对比": "Before-send comparison", "对比原文与将发送的内容": "Compare original and what will be sent",
		"原文": "Original", "将发送": "Will send", "已发送": "Sent", "删除": "Removed", "新增": "Added", "待处理": "Pending",
		"文字没有改动": "No text changes", "原图 · 点框切换遮挡": "Original · click a box to toggle masking",
		"原图 · 框为命中区域": "Original · boxes are detected areas",
		"实际发送":        "Actually sent", "%d 处改动": "%d changes", "遮挡 %d 处": "%d masked", "发往 %s": "To %s",
		"点击对比原文与替换后的内容": "Click to compare the original with the replaced text",
		"点击放大对比原图与发送图":  "Click to compare the original image with the one being sent",
		"发送前检查":         "Before sending", "遮挡全部敏感区域": "Mask all sensitive areas", "全部不遮挡": "Mask none",
		"遮挡全部图片里的敏感文字（不可逆纯色，只作用于发送副本）": "Mask sensitive text in all images (solid, irreversible; only the copy being sent)",
		"本次发送已结束": "This send has finished", "图片 %d": "Image %d",
		"省略 %d 行未改动内容": "%d unchanged lines hidden", "收起": "Collapse", "处理这一行": "Act on this line",
		"还原「%s」为原文": "Restore “%s” to the original", "替换「%s」": "Replace “%s”", "保留「%s」原文": "Keep “%s” as is",
		"%s · 已遮挡 · 点击改为保留原文": "%s · masked · click to keep as is", "%s · 保留原文 · 点击遮挡": "%s · kept · click to mask",
		"%s · 待处理 · 点击遮挡": "%s · pending · click to mask",
		"发送记录对比":          "Sent comparison", "快照只保存在内存，退出 Toskr 后清除": "Snapshot is kept in memory only and cleared when Toskr quits",
		"对比": "Compare", "查看这次发送的原文与实际发送内容对比": "Compare the original with what this send actually sent",
		"只看改动": "Changes only", "隐藏全部未改动的行（折叠处仍可点开）": "Hide all unchanged lines (folds can still be opened)",
		"上一处（P）": "Previous (P)", "下一处（N）": "Next (N)",
	} {
		if _, ok := en[k]; !ok {
			en[k] = v
		}
	}
}

// cmpImage：对比窗里的一张图（实时模式 pf 非空，可点框切换遮挡）。
type cmpImage struct {
	pf         *pfImage
	img        *image.RGBA
	orig, sent *ui.Bitmap
	regions    []pfRegion
	masked     map[string]bool
	kept       map[string]bool
	status     string
}

// cmpSnapshot：一次发送当时的对比内容（内存）。
type cmpSnapshot struct {
	target          string
	at              time.Time
	original, final string
	images          []cmpImage
}

const maxCmpSnaps = 50

// rememberCompare：预检发出时按发送 id 记下对比快照（只在内存）。
func (a *app) rememberCompare(id string) {
	if id == "" {
		return
	}
	s := &cmpSnapshot{target: a.target.Name, at: time.Now(), original: a.pfOriginalText(), final: a.pf.final}
	for _, im := range a.pf.images {
		if im.img == nil {
			continue
		}
		s.images = append(s.images, cmpImage{img: im.img, orig: a.pfOrig(im), sent: a.pfThumb(im), regions: slices.Clone(im.regions),
			masked: maps.Clone(im.masked), kept: maps.Clone(im.kept), status: imageStatusLine(im)})
	}
	if a.cmpSnaps == nil {
		a.cmpSnaps = map[string]*cmpSnapshot{}
	}
	a.cmpSnaps[id] = s
	a.cmpOrder = append(a.cmpOrder, id)
	if len(a.cmpOrder) > maxCmpSnaps {
		delete(a.cmpSnaps, a.cmpOrder[0])
		a.cmpOrder = a.cmpOrder[1:]
	}
}

// openPFCompare：打开（或带到前面）实时对比窗。面板保持展开（panel OnBlur 见 cmpWin 不收起）。
func (a *app) openPFCompare() { a.showCompare("") }

// openDeliveryCompare：「最近发送」里打开某次发送的对比快照。
func (a *app) openDeliveryCompare(id string) { a.showCompare(id) }

func (a *app) showCompare(view string) {
	if a.cmpView != view {
		a.cmpExpand, a.cmpCur, a.cmpJump = nil, 0, 0
	}
	a.cmpView = view
	if a.cmpWin != nil {
		a.cmpWin.Invalidate()
		a.cmpWin.Show()
		a.cmpWin.Focus()
		return
	}
	wa := a.detailWorkArea()
	w, h := min(1040, wa.Width-48), min(700, wa.Height-48)
	win := mygo.NewWindow(mygo.WindowOptions{
		Title: tr("发送前对比"), Width: w, Height: h, X: wa.X + (wa.Width-w)/2, Y: wa.Y + (wa.Height-h)/2,
		MinWidth: 560, MinHeight: 360, Hidden: true, AlwaysOnTop: true,
		TitleBarStyle: mygo.TitleBarHidden, TrafficLightPosition: &mygo.Point{X: 12, Y: 13},
		Vibrancy: vibrancyFor(a.store.Settings().Glass), Transparent: true,
		Content: ui.View(a.pfCompareView),
	})
	win.SetVisibleOnAllWorkspaces(true)
	win.OnClose(func(*mygo.CloseEvent) {
		if a.cmpWin == win {
			a.cmpWin = nil
		}
	})
	a.cmpWin = win
	win.Show()
	win.Focus()
}

func (a *app) closePFCompare() {
	if w := a.cmpWin; w != nil {
		a.cmpWin = nil
		w.Destroy()
	}
}

// closeLiveCompare：预检结束（发送 / 取消）时关掉实时对比窗；正在看发送记录快照的不动。
func (a *app) closeLiveCompare() {
	if a.cmpView == "" {
		a.closePFCompare()
	}
}

// pfOriginalText：未经词典化名与隐私替换的自动组装文本（左栏）。
func (a *app) pfOriginalText() string {
	var texts []string
	for _, n := range a.pf.preAlias {
		if n.Kind != "image" {
			texts = append(texts, n.Text)
		}
	}
	if len(texts) == 0 {
		return ""
	}
	r, _ := a.resolution()
	return composePayload(texts, a.pendingTmpl, a.outputMode(r.Profile))
}

// pfRestorePH：把一个已替换成占位符的值还原为原文，并确认本次按原文发出（对比窗「还原为原文」）。
func (a *app) pfRestorePH(orig string) {
	p := &a.pf
	ph, ok := p.ph[orig]
	if !ok {
		return
	}
	delete(p.ph, orig)
	if p.edited {
		p.final = strings.ReplaceAll(p.final, ph, orig)
		a.pfScan()
	} else {
		a.pfReapply()
	}
	p.replaced = max(0, p.replaced-1)
	a.pfKeep(func(it pfItem) bool { return a.pfText(it.note)[it.f.Start:it.f.End] == orig })
}

// ---- 行对齐 ----

type cmpRow struct {
	left, right []diffSeg // nil = 这一侧没有对应行
	ln, rn      int       // 行号（0 = 无）
	changed     bool
	fold        int // >0：折叠行，省略的行数
	foldAt      int // 折叠段在完整行表里的起点（展开状态的 key）
}

const cmpCtx = 2 // 折叠时改动前后保留的上下文行数

// cmpRows：按行对齐 from / to，行内按字差分；改动之间超过上下文的未改动行折叠。返回行表与改动处数。
func cmpRows(from, to string, expand map[int]bool) ([]cmpRow, int) {
	return cmpRowsCtx(from, to, expand, cmpCtx)
}

// cmpRowsCtx：ctx 为改动前后保留的未改动行数（「只看改动」时为 0）。
func cmpRowsCtx(from, to string, expand map[int]bool, ctx int) ([]cmpRow, int) {
	split := func(s string) []string {
		if s == "" {
			return nil
		}
		return strings.Split(s, "\n")
	}
	ops, _ := myersOps(split(from), split(to), -1)
	var rows []cmpRow
	ln, rn, changes := 0, 0, 0
	var dels, ins []string
	flush := func() {
		lone := false
		for i := range max(len(dels), len(ins)) {
			r := cmpRow{changed: true}
			switch {
			case i < len(dels) && i < len(ins):
				ln, rn = ln+1, rn+1
				l, rr, n := diffSides(textDiff(dels[i], ins[i]))
				r.left, r.right, r.ln, r.rn = l, rr, ln, rn
				changes += max(n, 1)
			case i < len(dels):
				ln++
				r.left, r.ln, lone = []diffSeg{{diffDel, dels[i]}}, ln, true
			default:
				rn++
				r.right, r.rn, lone = []diffSeg{{diffIns, ins[i]}}, rn, true
			}
			rows = append(rows, r)
		}
		if lone {
			changes++
		}
		dels, ins = nil, nil
	}
	for _, op := range ops {
		switch op.kind {
		case diffEq:
			flush()
			ln, rn = ln+1, rn+1
			same := []diffSeg{{diffEq, op.text}}
			rows = append(rows, cmpRow{left: same, right: same, ln: ln, rn: rn})
		case diffDel:
			dels = append(dels, op.text)
		case diffIns:
			ins = append(ins, op.text)
		}
	}
	flush()
	if changes == 0 {
		return rows, 0
	}
	var out []cmpRow
	for i := 0; i < len(rows); {
		if rows[i].changed {
			out = append(out, rows[i])
			i++
			continue
		}
		j := i
		for j < len(rows) && !rows[j].changed {
			j++
		}
		head, tail := ctx, ctx
		if i == 0 {
			head = 0
		}
		if j == len(rows) {
			tail = 0
		}
		if (j-i > head+tail+1 || ctx == 0) && !expand[i] { // 只看改动时连单行也折
			out = append(out, rows[i:i+head]...)
			out = append(out, cmpRow{fold: j - i - head - tail, foldAt: i})
			out = append(out, rows[j-tail:j]...)
		} else {
			out = append(out, rows[i:j]...)
		}
		i = j
	}
	return out, changes
}

// cmpAction：改动行上的一个操作（实时模式）。
type cmpAction struct {
	label string
	run   func()
}

// cmpRowActions：这一行能做的处理——还原已替换的占位符 / 词典化名，替换或保留还没处理的命中。
func (a *app) cmpRowActions(r cmpRow) []cmpAction {
	var ins, right strings.Builder
	for _, s := range r.right {
		right.WriteString(s.text)
		if s.kind == diffIns {
			ins.WriteString(s.text)
		}
	}
	var out []cmpAction
	seen := map[string]bool{}
	add := func(label string, run func()) {
		if !seen[label] {
			seen[label] = true
			out = append(out, cmpAction{label, run})
		}
	}
	p := &a.pf
	for _, orig := range slices.Sorted(maps.Keys(p.ph)) {
		if strings.Contains(ins.String(), p.ph[orig]) {
			o := orig
			add(fmt.Sprintf(tr("还原「%s」为原文"), preview(o, 24)), func() { a.pfRestorePH(o) })
		}
	}
	for _, h := range a.pfAliasHits() {
		if ph := h.hit.Entity.Placeholder; ph != "" && strings.Contains(ins.String(), ph) {
			ent := h.hit.Entity
			add(fmt.Sprintf(tr("还原「%s」为原文"), preview(ent.OriginalText, 24)), func() {
				for _, x := range a.pfAliasHits() {
					if x.hit.Entity.Placeholder == ent.Placeholder {
						if a.pf.aliasSkip == nil {
							a.pf.aliasSkip = map[string]bool{}
						}
						a.pf.aliasSkip[aliasKey(x.note, x.hit.Start)] = true
					}
				}
				a.pfReapply()
			})
		}
	}
	for _, src := range a.cmpPending() {
		if strings.Contains(right.String(), src) {
			v := src
			match := func(it pfItem) bool { return a.pfText(it.note)[it.f.Start:it.f.End] == v }
			add(fmt.Sprintf(tr("替换「%s」"), preview(v, 24)), func() { a.pfReplace(match) })
			add(fmt.Sprintf(tr("保留「%s」原文"), preview(v, 24)), func() { a.pfKeep(match) })
		}
	}
	return out
}

// cmpPending：还没处理（未替换也未确认保留）的文字命中原文，长的在前。
func (a *app) cmpPending() []string {
	var out []string
	for _, it := range a.pf.items {
		if src := a.pfText(it.note)[it.f.Start:it.f.End]; !a.pf.kept[it.id] && src != "" && !slices.Contains(out, src) {
			out = append(out, src)
		}
	}
	slices.SortFunc(out, func(x, y string) int { return len(y) - len(x) })
	return out
}

// markPending：把相同片段里出现的待处理命中切出来（返回切好的片段与是否待处理）。
func markPending(segs []diffSeg, needles []string) (out []diffSeg, pending []bool) {
	for _, s := range segs {
		t := s.text
		for t != "" {
			at, n := -1, ""
			if s.kind == diffEq {
				for _, nd := range needles {
					if i := strings.Index(t, nd); i >= 0 && (at < 0 || i < at) {
						at, n = i, nd
					}
				}
			}
			if at < 0 {
				out, pending = append(out, diffSeg{s.kind, t}), append(pending, false)
				break
			}
			if at > 0 {
				out, pending = append(out, diffSeg{s.kind, t[:at]}), append(pending, false)
			}
			out, pending = append(out, diffSeg{s.kind, n}), append(pending, true)
			t = t[at+len(n):]
		}
	}
	return
}

// ---- 视图 ----

func (a *app) pfCompareView(c *ui.Context) {
	registerFonts()
	k, s := tok(c), stok(c)
	bg := s.bg
	if c.Vibrancy() {
		bg = bg.Alpha(0.86)
	}
	c.Root().Background(bg)
	if c.Shortcut(0, ui.KeyEscape) || c.Shortcut(ui.Cmd, ui.KeyW) {
		a.closePFCompare()
		return
	}
	live := a.cmpView == ""
	var snap cmpSnapshot
	switch {
	case live && len(a.pending) == 0:
		ui.Column(c).Fill().Center().Children(func() { text(c, tr("本次发送已结束"), 12, 17, 400, k.muted) })
		return
	case live:
		snap = cmpSnapshot{target: a.target.Name, original: a.pfOriginalText(), final: a.pf.final}
		for _, im := range a.pf.images {
			if im.img != nil {
				snap.images = append(snap.images, cmpImage{pf: im, img: im.img, orig: a.pfOrig(im), sent: a.pfThumb(im),
					regions: im.regions, masked: im.masked, kept: im.kept, status: imageStatusLine(im)})
			}
		}
	default:
		sp := a.cmpSnaps[a.cmpView]
		if sp == nil {
			ui.Column(c).Fill().Center().Children(func() { text(c, tr("快照只保存在内存，退出 Toskr 后清除"), 12, 17, 400, k.muted) })
			return
		}
		snap = *sp
	}
	var act func() // 操作会改写预检状态：整窗画完再执行
	defer func() {
		if act != nil {
			act()
			if a.panel != nil {
				a.panel.Invalidate()
			}
		}
	}()
	dark := c.Theme().Dark
	red, green, amber := ui.RGB(220, 38, 38), ui.RGB(22, 163, 74), ui.RGB(217, 119, 6) // token-exception: diff 红 / 绿 / 待处理琥珀（同 Tauri danger / success / warning 语义）
	redFg, greenFg := ui.RGB(153, 27, 27), ui.RGB(21, 101, 52)
	if dark {
		redFg, greenFg = ui.RGB(252, 165, 165), ui.RGB(134, 239, 172)
	}
	ctx := cmpCtx
	if a.cmpOnly {
		ctx = 0
	}
	rows, changes := cmpRowsCtx(snap.original, snap.final, a.cmpExpand, ctx)
	hunks := cmpHunks(rows) // 每处改动的第一行（行表下标），供 上一处 / 下一处 跳转
	if a.cmpCur >= len(hunks) {
		a.cmpCur = max(len(hunks)-1, 0)
	}
	jump := func(d int) {
		if len(hunks) > 0 {
			a.cmpCur = (a.cmpCur + d + len(hunks)) % len(hunks)
			a.cmpJump = hunks[a.cmpCur] + 1
		}
	}
	switch {
	case c.Shortcut(0, ui.KeyN):
		jump(1)
	case c.Shortcut(ui.Shift, ui.KeyN), c.Shortcut(0, ui.KeyP):
		jump(-1)
	}
	var needles []string
	if live {
		needles = a.cmpPending()
	}
	masked := 0
	for _, im := range snap.images {
		for _, r := range im.regions {
			if im.masked[r.id] {
				masked++
			}
		}
	}
	W, _ := c.Size()
	colW := (W - 32 - 1) / 2
	line := k.fg.Alpha(0.08)

	ui.Column(c).Fill().Children(func() {
		// 标题栏（可拖窗；左侧让出红绿灯）
		ui.Row(c).Height(44).Padding(0, 16, 0, 80).Gap(10).AlignItems(ui.Center).DragWindow().Shrink(0).Children(func() {
			licon(c, "columns-2", 14, k.fg)
			title := tr("发送前对比")
			if !live {
				title = tr("发送记录对比")
			}
			text(c, title, 13, 18, 600, k.fg).Shrink(0)
			sub := fmt.Sprintf(tr("发往 %s"), cmpOr(snap.target, tr("未识别目标")))
			if !live {
				sub += " · " + snap.at.Format("01-02 15:04")
			}
			if snap.final != "" || snap.original != "" {
				sub += " · " + fmt.Sprintf(tr("%d 处改动"), changes)
			}
			if masked > 0 {
				sub += " · " + fmt.Sprintf(tr("遮挡 %d 处"), masked)
			}
			text(c, sub, 11, 16, 400, k.muted).SingleLine().Grow(1).Basis(0)
			if len(hunks) > 0 { // 只看改动 + 上一处 / 下一处（数字格，同设计清单 ③）
				a.cmpNav(c, k, len(hunks), jump)
			}
			legend := func(col ui.Color, label string) {
				ui.Row(c).Gap(5).AlignItems(ui.Center).Shrink(0).Children(func() {
					ui.Box(c).Size(10, 10).Radius(3).Background(col.Alpha(0.28)).Border(1, col.Alpha(0.6))
					text(c, label, 11, 16, 400, k.muted)
				})
			}
			legend(red, tr("删除"))
			legend(green, tr("新增"))
			if len(needles) > 0 {
				legend(amber, tr("待处理"))
			}
		})
		ui.Box(c).Height(1).FillWidth().Background(line)
		ui.Scroll(c).Grow(1).Basis(0).Children(func() {
			ui.Column(c).Padding(14, 16, 20, 16).Gap(18).Children(func() {
				colHead := func(l, r string) {
					ui.Row(c).Gap(1).Children(func() {
						text(c, l, 11, 16, 600, k.muted).Width(colW)
						text(c, r, 11, 16, 600, k.muted).Width(colW).Margin(0, 0, 0, 12)
					})
				}
				if snap.final != "" || snap.original != "" {
					ui.Column(c).Gap(8).Key("cmp-text").Children(func() {
						right := tr("将发送")
						if !live {
							right = tr("已发送")
						}
						colHead(tr("原文"), right)
						if changes == 0 {
							text(c, tr("文字没有改动"), 11, 16, 400, k.muted)
						}
						ui.Column(c).Radius(10).Clip().Border(1, line).Background(k.fg.Alpha(0.02)).Children(func() {
							for i, r := range rows {
								if r.fold > 0 {
									a.cmpFoldRow(c, k, r, line)
									continue
								}
								cur := len(hunks) > 0 && hunks[a.cmpCur] == i
								a.cmpTextRow(c, k, i, r, cur, colW, live, needles, line,
									[3]ui.Color{red, redFg, amber}, [3]ui.Color{green, greenFg, amber}, &act)
							}
						})
					})
				}
				for i, im := range snap.images {
					a.cmpImageBlock(c, k, i, im, colW, live, red, amber, &act)
				}
				if !live {
					text(c, tr("快照只保存在内存，退出 Toskr 后清除"), 10, 14, 400, k.muted)
				}
			})
		})
	})
}

// cmpFoldRow：「省略 N 行未改动内容」，点开展开。
func (a *app) cmpFoldRow(c *ui.Context, k tokens, r cmpRow, line ui.Color) {
	b := ui.Row(c).Height(24).FillWidth().Gap(6).Justify(ui.Center).AlignItems(ui.Center).Key(fmt.Sprintf("cmp-fold-%d", r.foldAt)).
		BorderWidth(1, 0, 1, 0).BorderColor(line).Role(ui.RoleButton).Label(fmt.Sprintf(tr("省略 %d 行未改动内容"), r.fold))
	col := k.muted
	if b.Hovered() {
		b.Background(k.hoverBg)
		col = k.fg
	}
	b.Children(func() {
		licon(c, "chevrons-up-down", 11, col)
		text(c, fmt.Sprintf(tr("省略 %d 行未改动内容"), r.fold), 11, 16, 400, col).FontFeatures("tnum")
	})
	if b.Clicked() {
		if a.cmpExpand == nil {
			a.cmpExpand = map[int]bool{}
		}
		a.cmpExpand[r.foldAt] = true
	}
}

// cmpTextRow：一行对照。tones = {改动底色, 改动字色, 待处理色}。
func (a *app) cmpTextRow(c *ui.Context, k tokens, i int, r cmpRow, cur bool, colW float32, live bool, needles []string, line ui.Color, delTone, insTone [3]ui.Color, act *func()) {
	row := ui.Row(c).AlignItems(ui.Stretch).Key(fmt.Sprintf("cmp-row-%d-%d", r.ln, r.rn))
	hovered := row.Hovered()
	if a.cmpJump == i+1 { // 跳到这一处：滚进视口（只在跳转那一帧）
		row.ScrollIntoView()
		a.cmpJump = 0
	}
	var acts []cmpAction
	if live && (r.changed || len(needles) > 0) {
		acts = a.cmpRowActions(r)
	}
	row.Children(func() {
		if cur { // 当前这一处：左缘 2pt 主色细条（状态色只落小面积）
			ui.Box(c).Absolute().Left(0).Top(0).Bottom(0).Width(2).Background(stok(c).primary).PassThrough()
		}
		cell := func(no int, segs []diffSeg, mark diffKind, tone [3]ui.Color, side string) {
			box := ui.Row(c).Width(colW).Padding(3, 10, 3, 0).Gap(8).AlignItems(ui.Start)
			switch {
			case segs == nil:
				box.Background(k.fg.Alpha(0.035))
			case r.changed:
				box.Background(tone[0].Alpha(0.06))
			}
			box.Children(func() {
				num := ""
				if no > 0 {
					num = itoa(no)
				}
				text(c, num, 10, 21, 400, k.muted.Alpha(0.7)).Font(fontMono).FontFeatures("tnum").Width(32).TextAlign(ui.End).Shrink(0)
				if segs == nil {
					return
				}
				var pend []bool
				if side == "right" {
					segs, pend = markPending(segs, needles)
				}
				spans := make([]ui.Span, 0, len(segs))
				for j, sg := range segs {
					sp := ui.Span{Text: sg.text, Color: k.fg}
					if sg.kind == mark {
						sp.Color, sp.Background = tone[1], tone[0].Alpha(0.22)
						if mark == diffDel {
							sp.Strikethrough, sp.DecorationColor = true, tone[0].Alpha(0.6)
						}
					}
					if j < len(pend) && pend[j] {
						sp.WavyUnderline, sp.DecorationColor = true, tone[2]
					}
					spans = append(spans, sp)
				}
				if len(spans) == 1 && spans[0].Text == "" {
					spans[0].Text = " " // 空行也占一行高
				}
				ui.RichText(c, spans...).Font(fontSans).FontSize(13).FixedLineHeight(21).Wrap().Grow(1).Basis(0)
			})
		}
		cell(r.ln, r.left, diffDel, delTone, "left")
		ui.Box(c).Width(1).Background(line)
		ui.Box(c).Children(func() {
			cell(r.rn, r.right, diffIns, insTone, "right")
			if len(acts) == 0 || !(hovered || a.cmpMenuRow == i+1) {
				return
			}
			m := ghostIconButton(c, k, fmt.Sprintf("cmp-act-%d", i), "ellipsis", tr("处理这一行"), 22, 13, false, true)
			m.Absolute().Top(2).Right(4).Background(k.card)
			m.Menu(func(mm *ui.Menu) {
				a.cmpMenuRow = i + 1
				for _, x := range acts {
					if mm.Item(x.label).Chosen() {
						*act = x.run
					}
				}
			})
			if !m.Hovered() && a.cmpMenuRow == i+1 && !hovered {
				a.cmpMenuRow = 0
			}
		})
	})
}

// cmpImageBlock：一张图的左右对照；实时模式下点左栏的命中框切换「遮挡 ⇄ 保留原文」。
func (a *app) cmpImageBlock(c *ui.Context, k tokens, i int, im cmpImage, colW float32, live bool, red, amber ui.Color, act *func()) {
	ui.Column(c).Gap(8).Key(fmt.Sprintf("cmp-img-%d", i)).Children(func() {
		text(c, fmt.Sprintf(tr("图片 %d"), i+1)+" · "+im.status, 12, 17, 600, k.fg).SingleLine()
		lh := tr("原图 · 框为命中区域")
		if live && len(im.regions) > 0 {
			lh = tr("原图 · 点框切换遮挡")
		}
		ui.Row(c).Gap(16).Children(func() {
			text(c, lh, 11, 16, 600, k.muted).Width(colW)
			text(c, tr("实际发送"), 11, 16, 600, k.muted).Width(colW)
		})
		iw, ih := float32(im.img.Rect.Dx()), float32(im.img.Rect.Dy())
		sc := min((colW-8)/max(iw, 1), 1) // 按栏宽等比缩，小图不放大
		dw, dh := iw*sc, ih*sc
		ui.Row(c).Gap(16).AlignItems(ui.Start).Children(func() {
			ui.Row(c).Width(colW).Children(func() {
				ui.Box(c).Size(dw, dh).Radius(6).Clip().Border(1, k.fg.Alpha(0.1)).Children(func() {
					ui.Image(c, im.orig).Size(dw, dh)
					for _, r := range im.regions {
						col := red
						if !r.block() {
							col = amber
						}
						bx := r.box
						b := ui.Box(c).Absolute().Left(float32(bx.X)*sc).Top(float32(bx.Y)*sc).Size(float32(bx.W)*sc, float32(bx.H)*sc).Radius(2).
							Key("cmp-reg-" + r.id)
						masked, kept := im.masked[r.id], im.kept[r.id]
						tip := fmt.Sprintf(tr("%s · 待处理 · 点击遮挡"), r.kind)
						switch {
						case masked:
							b.Border(1.5, col).Background(ui.RGBA(0, 0, 0, 0.55)) // token-exception: 已遮挡区域的暗罩
							tip = fmt.Sprintf(tr("%s · 已遮挡 · 点击改为保留原文"), r.kind)
						case kept:
							b.Border(1, col.Alpha(0.55))
							tip = fmt.Sprintf(tr("%s · 保留原文 · 点击遮挡"), r.kind)
						default:
							b.Border(1.5, col).Background(col.Alpha(0.14))
						}
						if !live {
							b.PassThrough().Tooltip(r.kind)
							continue
						}
						b.Role(ui.RoleButton).Label(tip).Tooltip(tip).Cursor(ui.CursorPointer)
						if b.Hovered() {
							b.Border(2, col)
						}
						if b.Clicked() {
							target, id, mask := im.pf, r.id, !masked
							*act = func() { a.pfMaskImages(func(y *pfImage, x pfRegion) bool { return y == target && x.id == id }, mask) }
						}
					}
				})
			})
			if im.sent != nil {
				ui.Box(c).Size(dw, dh).Radius(6).Clip().Border(1, k.fg.Alpha(0.1)).Children(func() { ui.Image(c, im.sent).Size(dw, dh) })
			}
		})
	})
}

// pfOrig：原图位图（左栏，按图缓存）。
func (a *app) pfOrig(im *pfImage) *ui.Bitmap {
	if im.orig == nil {
		im.orig = ui.NewBitmap(im.img)
	}
	return im.orig
}

// cmpHunks：每处改动（连续改动行算一处）的第一行下标。
func cmpHunks(rows []cmpRow) []int {
	var out []int
	for i, r := range rows {
		if r.changed && (i == 0 || !rows[i-1].changed) {
			out = append(out, i)
		}
	}
	return out
}

// cmpNav：标题栏右侧「只看改动」开关 + 「‹ 2 / 5 ›」跳转。
func (a *app) cmpNav(c *ui.Context, k tokens, n int, jump func(int)) {
	ui.Row(c).Gap(6).AlignItems(ui.Center).Shrink(0).Children(func() {
		lbl := tr("只看改动")
		t := ui.Row(c).Height(22).Padding(0, 8).Gap(4).Radius(6).AlignItems(ui.Center).Key("cmp-only").Role(ui.RoleButton).
			Label(lbl).Tooltip(tr("隐藏全部未改动的行（折叠处仍可点开）"))
		fg := k.muted
		switch {
		case a.cmpOnly:
			t.Background(k.track)
			fg = k.fg
		case t.Hovered():
			t.Background(k.hoverBg)
			fg = k.fg
		}
		t.Children(func() {
			licon(c, map[bool]string{true: "check", false: "list-filter"}[a.cmpOnly], 11, fg)
			text(c, lbl, 11, 16, 500, fg)
		})
		if t.Clicked() {
			a.cmpOnly, a.cmpExpand = !a.cmpOnly, nil
		}
		ui.Row(c).Height(22).Padding(0, 2).Radius(6).Border(1, k.fg.Alpha(0.1)).AlignItems(ui.Center).Children(func() {
			if ghostIconButton(c, k, "cmp-prev", "chevron-up", tr("上一处（P）"), 18, 12, false, true).Clicked() {
				jump(-1)
			}
			pos := fmt.Sprintf("%d / %d", a.cmpCur+1, n)
			text(c, pos, 11, 16, 500, k.fg).FontFeatures("tnum").MinWidth(numSlot(c, fmt.Sprintf("%d / %d", n, n), 11, 500)).TextAlign(ui.Center).Padding(0, 2)
			if ghostIconButton(c, k, "cmp-next", "chevron-down", tr("下一处（N）"), 18, 12, false, true).Clicked() {
				jump(1)
			}
		})
	})
}
