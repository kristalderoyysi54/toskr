package main

import (
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/core"
	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/linkmeta"
	"github.com/toskr/native/internal/store"
)

// 详情窗划词工具条（同 Tauri TextSelectionToolbar）：阅读态或编辑态选中文字时浮出——已选 N 字 · 发送选中 · 复制 ·
// （编辑态）粗体 / 斜体 · 处理 ▾（同一组 textOps，就地替换选区并把新选区留在处理结果上）。
// 同 Tauri 按选区定位（TextPreviewView toolbarAnchor）：浮在选区上方，上方放不下（被标题栏挡）翻到下方，
// 纵向夹在标题栏与底部操作坞之间；水平对准选区中心、按工具条实宽钳进窗内（两侧留 6）。
// mygo 没有选区矩形接口——编辑态用同字体排版测出选区行，选词态取选中键帽的并集，阅读态取划选起止的指针
// （随内容滚动；跨行选区水平取正文中心，同 DOM Range 矩形）。工具条只占自身宽度，不挡同一行的键帽 / 正文。
// 拿不到几何（如阅读态 ⌘A 全选）时回落到底部操作坞上方居中。

// selGeom：本帧选区的范围（窗口坐标）与定位所需的窗口 / 标题栏框（均为上一帧的布局）。
type selGeom struct {
	ok                    bool
	left, top, right, bot float32
	win, hdr              ui.Rect
	ptr                   [2]ui.Point // 阅读态划选起止的指针（相对阅读容器，随内容滚动）
	ptrOK, ptrDrag        bool
	layout                *ui.TextLayout // 编辑态选区测量的排版缓存：草稿 + 宽度
	layoutSrc             string
	layoutW               float32
	barX, barY, barW      float32
	floor, pickBot        float32 // 本帧：编辑态标题输入框底边（工具条上限）；选词态键帽区底边（翻到下方时的落点）
}

func (a *app) markSel(r ui.Rect) {
	g := &a.detail.sel
	if !g.ok {
		g.ok, g.left, g.top, g.right, g.bot = true, r.X, r.Y, r.X+r.W, r.Y+r.H
		return
	}
	g.left, g.top, g.right, g.bot = min(g.left, r.X), min(g.top, r.Y), max(g.right, r.X+r.W), max(g.bot, r.Y+r.H)
}

// markEditSelection：编辑器同字体同宽排版，取选区各行矩形的并集。
func (a *app) markEditSelection(box ui.Rect) {
	a.markTextSelection(box, a.detailText, a.detail.editRange)
}

// markTextSelection：按编辑器同字体同宽排版 src，取 rng 选区各行矩形（图文卡的每个文字块也走这里）。
func (a *app) markTextSelection(box ui.Rect, src string, rng [2]int) {
	g := &a.detail.sel
	lo, hi := min(rng[0], rng[1]), max(rng[0], rng[1])
	if lo == hi || box.W <= 0 {
		return
	}
	if g.layout == nil || g.layoutSrc != src || g.layoutW != box.W {
		g.layout = ui.ShapeText(src, ui.Font{Family: fontSans, Size: 13, Weight: 400, LineHeight: 21.125 / 13}, box.W)
		g.layoutSrc, g.layoutW = src, box.W
	}
	r := []rune(src)
	if hi > len(r) {
		return
	}
	for _, rc := range g.layout.SelectionRects(ui.TextInputRange{Start: utf16Len(r[:lo]), End: utf16Len(r[:hi])}) {
		a.markSel(ui.Rect{X: box.X + rc.X, Y: box.Y + rc.Y, W: rc.W, H: rc.H})
	}
}

func utf16Len(r []rune) int {
	n := 0
	for _, c := range r {
		n++
		if c >= 0x10000 {
			n++
		}
	}
	return n
}

// trackReadPointer 记下阅读态划选的起止指针（按下即起点，拖动 / 抬起更新终点）。
func (a *app) trackReadPointer(ev ui.InputEvent) {
	g := &a.detail.sel
	p := ui.Point{X: ev.X, Y: ev.Y}
	switch {
	case ev.Kind == ui.InputPointerDown && ev.Button == 0:
		g.ptr, g.ptrOK, g.ptrDrag = [2]ui.Point{p, p}, true, true
	case ev.Kind == ui.InputPointerMove && g.ptrDrag:
		g.ptr[1] = p
	case ev.Kind == ui.InputPointerUp && g.ptrDrag:
		g.ptr[1], g.ptrDrag = p, false
	}
}

// markReadSelection：指针所在行按半个行高外扩到整行；同一行取两端指针之间，跨行取正文整宽。
func (a *app) markReadSelection(box ui.Rect, fs float32) {
	g := &a.detail.sel
	if len(a.detail.readSel) == 0 {
		g.ptrOK = false // 选区已清：旧指针不再代表下一次（键盘）选区
		return
	}
	if !g.ptrOK {
		return
	}
	half := fs * 1.625 / 2
	p0, p1 := g.ptr[0], g.ptr[1]
	x0, x1 := min(p0.X, p1.X), max(p0.X, p1.X)
	if p1.Y-p0.Y > half || p0.Y-p1.Y > half {
		x0, x1 = 0, box.W
	}
	y0, y1 := min(p0.Y, p1.Y), max(p0.Y, p1.Y)
	a.markSel(ui.Rect{X: box.X + x0, Y: box.Y + y0 - half, W: x1 - x0, H: y1 - y0 + 2*half})
}

const selBarGap = 6 // 同 Tauri toolbarAnchorStyle 的 top - 6 / bottom + 6

// selBarTop：工具条（高 h）顶边的窗口 y。上方优先，放不下翻到下方，最后夹在 [lo, hi-h] 之内。
func selBarTop(top, bot, h, lo, hi float32) float32 {
	y := top - selBarGap - h
	if y < lo {
		y = bot + selBarGap
	}
	return max(lo, min(y, hi-h))
}

// selBarLeft：工具条（宽 w）左边的窗口 x：对准选区中心，钳进 [lo+6, hi-6]（同 Tauri 实测宽度钳制）。
func selBarLeft(left, right, w, lo, hi float32) float32 {
	x := (left+right)/2 - w/2
	return max(lo+6, min(x, hi-6-w))
}

// detailSelection 返回当前选中的原文区间（rune 偏移）与文字；编辑态读编辑器选区，阅读态把划词选区映射回原文。
func (a *app) detailSelection(src string) (int, int, string) {
	d := a.detail
	if d.edit && d.blocks != nil { // 图文卡编辑：选区在当前文字块里（块内 rune 偏移）
		bt, ok := a.activeBlockText()
		lo, hi := min(d.blkRange[0], d.blkRange[1]), max(d.blkRange[0], d.blkRange[1])
		r := []rune(bt)
		if !ok || lo < 0 || hi > len(r) || lo == hi {
			return 0, 0, ""
		}
		return lo, hi, string(r[lo:hi])
	}
	if d.edit {
		lo, hi := min(d.editRange[0], d.editRange[1]), max(d.editRange[0], d.editRange[1])
		r := []rune(a.detailText)
		if lo < 0 || hi > len(r) || lo == hi {
			return 0, 0, ""
		}
		return lo, hi, string(r[lo:hi])
	}
	if d.pick { // 同 Tauri：选词区间驱动 textSelection，选中工具条照常出现
		if d.pickAnchor < 0 {
			return 0, 0, ""
		}
		segs := a.segments(src)
		lo, hi, at := -1, -1, 0
		for i, seg := range segs {
			n := utf8.RuneCountInString(seg.text)
			if i == min(d.pickAnchor, d.pickEnd) {
				lo = at
			}
			if i == max(d.pickAnchor, d.pickEnd) {
				hi = at + n
			}
			at += n
		}
		if lo < 0 || hi <= lo {
			return 0, 0, ""
		}
		return lo, hi, string([]rune(src)[lo:hi])
	}
	if len(d.readSel) == 0 {
		return 0, 0, ""
	}
	m := mapReadSelection(src, d.readSel)
	r := []rune(src)
	if m[0] < 0 || m[1] > len(r) || m[0] >= m[1] {
		return 0, 0, ""
	}
	return m[0], m[1], string(r[m[0]:m[1]])
}

// replaceDetailRange 用 out 替换区间（处理 / 粗体 / 斜体）。
func (a *app) replaceDetailRange(n store.Note, lo, hi int, out string) {
	r := []rune(a.detailSource(n))
	a.applyDetailEdit(n, string(r[:lo])+out+string(r[hi:]), lo, lo+utf8.RuneCountInString(out))
}

// activeBlockText：图文卡编辑态当前文字块（划词工具条作用的块）。
func (a *app) activeBlockText() (string, bool) {
	d := a.detail
	if i := d.blkActive - 1; i >= 0 && i < len(d.blocks) && d.blocks[i].Type != "image" {
		return d.blocks[i].Text, true
	}
	return "", false
}

// detailSource：选区偏移所对应的文本（编辑态是草稿，阅读 / 选词态是卡片原文）。
func (a *app) detailSource(n store.Note) string {
	if a.detail.edit && a.detail.blocks != nil {
		bt, _ := a.activeBlockText()
		return bt
	}
	if a.detail.edit {
		return a.detailText
	}
	return n.Text
}

// applyDetailEdit 同 Tauri applySelectionEdit：编辑态改草稿并选中结果；阅读 / 选词态自动进入编辑再改；
// 图文卡阅读态按原文改写（可撤销的 HUD）。
func (a *app) applyDetailEdit(n store.Note, text string, lo, hi int) {
	if d := &a.detail; d.edit && d.blocks != nil { // 图文卡编辑：改当前文字块，新选区留在结果上
		if i := d.blkActive - 1; i >= 0 && i < len(d.blocks) && d.blocks[i].Type != "image" {
			bs := slices.Clone(d.blocks)
			bs[i].Text = text
			d.blocks, d.blkSet = bs, [3]int{d.blkActive, lo, hi}
		}
		return
	}
	if !a.detail.edit && store.HasMixedContent(n.Blocks) {
		prev := n // 撤销整块还原（图文卡的块与正文一起回去）
		_ = a.store.Update(n.ID, text)
		a.detail.readSel, a.detail.pick, a.detail.pickAnchor, a.detail.pickEnd = nil, false, -1, -1
		a.showHUDUndo("ok", tr("已处理选中内容"), func() { a.store.RestoreContent(prev) })
		return
	}
	if !a.detail.edit {
		a.enterDetailEdit(n)
		a.detail.pickAnchor, a.detail.pickEnd = -1, -1
	}
	a.detailText = text
	a.detail.editSel = [2]int{lo, hi}
}

// wrapped：选区是否已被 mark 包住（选区自身或紧邻两侧），用作 B / I 的按下态。
func wrapped(src string, lo, hi int, mark string) bool {
	r := []rune(src)
	sel := string(r[lo:hi])
	m := len([]rune(mark))
	if len(sel) >= 2*len(mark) && strings.HasPrefix(sel, mark) && strings.HasSuffix(sel, mark) {
		return true
	}
	return lo >= m && hi+m <= len(r) && string(r[lo-m:lo]) == mark && string(r[hi:hi+m]) == mark
}

func (a *app) detailSelectionBar(c *ui.Context, k tokens, n store.Note) {
	if n.Kind == "image" {
		return
	}
	lo, hi, sel := a.detailSelection(n.Text)
	if strings.TrimSpace(sel) == "" {
		a.detail.barHover = false
		return
	}
	// 拖选中（按着鼠标）不出工具条，松手后再出：否则字数与位置随拖动每帧变化，工具条跟着抖。
	// 按在工具条 / 它的浮层上不算（点按钮本身就要按下鼠标）。
	if d := a.detail; selDragging() && !d.barHover && !d.linkOn && !d.aliasOn {
		return
	}
	bar := ui.Column(c).Absolute().AlignItems(ui.Center).Key("selbar").
		Transition(ui.ElementTransition{Duration: 120 * time.Millisecond, Ease: easeStandard, Colors: true, Enter: &ui.Motion{Y: 4, Scale: 0.98}, Exit: &ui.Motion{}})
	a.detail.barHover = bar.Hovered()
	g := &a.detail.sel
	if r := bar.Bounds(); r.W > 0 {
		g.barW = r.W // 上一帧实宽（随按钮多少 / 字数变化）
	}
	linkAbove := true // 链接浮层朝远离选区的一侧展开（同 Tauri bottom-full / top-full），工具条自身不因它移动
	if g.ok && g.win.H > 0 {
		const h = 32
		w := g.barW
		if w == 0 {
			w = 316 // 首帧未测：同 Tauri 半宽估值 158
		}
		lo := max(g.hdr.Y+g.hdr.H, g.floor) + 4
		bot := g.bot
		if a.detail.pick && g.pickBot > 0 {
			bot = max(bot, g.pickBot)
		}
		wy := selBarTop(g.top, bot, h, lo, g.win.Y+g.win.H-56)
		linkAbove = wy < g.top && wy-38 >= lo
		y := wy - g.win.Y
		x := selBarLeft(g.left, g.right, w, g.win.X, g.win.X+g.win.W) - g.win.X
		if y != g.barY || x != g.barX { // 几何取自上一帧布局：位置变了再要一帧，滚动停下后收敛到准确位置
			g.barX, g.barY = x, y
			c.Invalidate()
		}
		bar.Left(x).Top(y)
	} else {
		bar.Left(0).Right(0).Bottom(56).PassThrough() // 底部居中：整宽容器透传点击，只有工具条本身接收
	}
	d := &a.detail
	if d.popSel != [2]int{lo, hi} { // 同 Tauri：换选区即收起链接 / 词典浮层
		d.popSel, d.linkOn, d.aliasOn = [2]int{lo, hi}, false, false
	}
	ro := d.virt != nil  // 只读合并预览：不能发送 / 改写（同 Tauri writable=false）
	showAlias := !d.edit // 同 Tauri onAddAlias={editing ? undefined : …}：阅读 / 选词态（含只读预览）可加入词典
	blocked := a.targetBlockedReason()
	bar.Children(func() {
		ui.Row(c).Height(32).Padding(0, 6).Gap(2).Radius(rr(10)).Background(k.floatBtn).Border(1, k.floatBorder).
			Shadow(0, 1, 2, 0, k.floatShadowA).Shadow(0, 6, 16, -4, k.floatShadowB).AlignItems(ui.Center).Children(func() {
			// 字数用等宽数字并按 4 位预留宽度：拖选时数字变化不再让整条工具条伸缩抖动（Tauri 只有 tabular-nums，位数变化仍会跳）
			cnt := utf8.RuneCountInString(sel)
			slot, _ := c.MeasureText(0, ui.Span{Text: fmt.Sprintf(tr("已选 %d 字"), max(cnt, 1000)), Font: fontSans, Size: 10})
			text(c, fmt.Sprintf(tr("已选 %d 字"), cnt), 10, 14, 400, k.muted).FontFeatures("tnum").Padding(0, 6).MinWidth(slot + 14).Key("sb-count")
			btn := func(icon, label string, disabled bool) bool {
				b := tipOf(c, ui.Row(c).Height(24).Padding(0, 6).Gap(4).Radius(rr(6)).AlignItems(ui.Center).Key("sb-" + icon).Role(ui.RoleButton).Label(label), label)
				col := k.muted
				switch {
				case disabled:
					b.Opacity(0.45)
				case b.Hovered():
					b.Background(k.track)
					col = k.fg
				}
				b.Children(func() {
					licon(c, icon, 12, col)
					if icon == "send" {
						text(c, tr("发送选中"), 11, 16, 500, col)
					}
				})
				return b.Clicked() && !disabled
			}
			if !ro {
				tip := tr("只把选中片段发到当前目标")
				if blocked != "" {
					tip = fmt.Sprintf(tr("发送选中不可用：%s"), blocked)
				}
				if btn("send", tip, blocked != "") {
					a.sendDetailFragment(n, sel)
				}
			}
			if btn("copy", tr("复制选中片段"), false) {
				a.copyPrivate(sel)
				a.showHUD("ok", tr("已复制"))
			}
			sep := func() { ui.Box(c).Size(1, 16).Margin(0, 2).Background(k.fg.Alpha(0.1)) }
			toggle := func(icon, label string, on, disabled bool) bool {
				b := tipOf(c, ui.Box(c).Size(24, 24).Radius(rr(6)).Center().Key("sb-" + icon).Role(ui.RoleButton).Label(label), label)
				col := k.muted
				switch {
				case disabled:
					b.Opacity(0.45)
				case on || b.Hovered():
					b.Background(k.track)
					col = k.fg
				}
				b.Children(func() { licon(c, icon, 13, col) })
				return b.Clicked() && !disabled
			}
			if showAlias || !ro {
				sep()
			}
			if showAlias && toggle("venetian-mask", tr("加入化名词典：发出自动替换，收回自动恢复"), d.aliasOn, false) {
				if d.aliasOn = !d.aliasOn; d.aliasOn {
					d.linkOn, d.aliasText, d.aliasCat = false, strings.TrimSpace(sel), core.SuggestAliasCategory(sel)
				}
			}
			if ro {
				return
			}
			src := a.detailSource(n)
			if showAlias {
				sep()
			}
			// 同 Tauri TextSelectionToolbar：链接（⌘K）· 粗体（⌘B）· 斜体（⌘I）· 段落格式菜单（⌥⌘0–7）；阅读态点了自动进编辑
			canLink := !strings.Contains(sel, "\n")
			linkTip := tr("添加链接（⌘K）")
			if !canLink {
				linkTip = tr("链接不支持跨行选区")
			}
			if (toggle("link-2", linkTip, d.linkOn || markdownHrefAt(src, lo, hi) != "", !canLink) || c.Shortcut(ui.Cmd, ui.KeyK)) && canLink {
				if d.linkOn = !d.linkOn; d.linkOn { // 预填：已有链接 → 选中文字本身是链接 → 空（同 Tauri suggestedHref）
					d.aliasOn, d.linkDraft = false, cmpOr(markdownHrefAt(src, lo, hi), linkmeta.Detect(sel))
				}
			}
			if toggle("bold", tr("粗体（⌘B）"), wrapped(src, lo, hi, "**"), false) || c.Shortcut(ui.Cmd, ui.KeyB) {
				a.replaceDetailRange(n, lo, hi, toggleWrap(sel, "**"))
			}
			if toggle("italic", tr("斜体（⌘I）"), wrapped(src, lo, hi, "*") && !wrapped(src, lo, hi, "**"), false) || c.Shortcut(ui.Cmd, ui.KeyI) {
				a.replaceDetailRange(n, lo, hi, toggleWrap(sel, "*"))
			}
			sep()
			cur := blockFormatAt(src, lo, hi)
			fm := ui.Row(c).Height(24).Padding(0, 6).Gap(2).Radius(rr(6)).AlignItems(ui.Center).Key("sb-format").Role(ui.RoleButton).Label(tr("段落格式"))
			if fm.Hovered() {
				fm.Background(k.track)
			}
			fm.Children(func() {
				text(c, tr(blockLabel(cur)), 11, 16, 500, k.fg)
				licon(c, "chevron-down", 11, k.muted)
			})
			apply := func(id string) {
				out, nlo, nhi := applyBlockFormat(src, lo, hi, id)
				if out != src {
					a.applyDetailEdit(n, out, nlo, nhi)
				}
			}
			fm.PopoverMenuButton(func(m *ui.Menu) {
				for i, f := range blockFormats {
					if m.Item(tr(f.label)).Checked(f.id == cur).Shortcut(ui.Cmd|ui.Alt, ui.Key0+ui.Key(i)).Chosen() {
						apply(f.id)
					}
				}
			})
			for i, f := range blockFormats {
				if c.Shortcut(ui.Cmd|ui.Alt, ui.Key0+ui.Key(i)) {
					apply(f.id)
				}
			}
			sep()
			ops := tipOf(c, ui.Row(c).Height(24).Padding(0, 6).Radius(rr(6)).AlignItems(ui.Center).Key("sb-ops").Role(ui.RoleButton).Label(tr("处理选中内容")), tr("处理选中内容"))
			if ops.Hovered() {
				ops.Background(k.track)
			}
			ops.Children(func() { licon(c, "wand-sparkles", 12, k.muted) })
			ops.PopoverMenuButton(func(m *ui.Menu) {
				for _, op := range textOps {
					if m.Item(tr(op.label)).Chosen() {
						out, err := op.apply(sel)
						if err != nil {
							a.showHUD("warn", tr("处理失败：")+err.Error())
							continue
						}
						a.replaceDetailRange(n, lo, hi, out)
					}
				}
				if a.store.Settings().AIOn() { // AI 动作（含自定义）：只改写选中的这一段
					m.Separator()
					for _, act := range a.allAIActions() {
						if m.Item(tr(act.label)).Chosen() {
							a.runAIOnSelection(n, lo, hi, sel, act)
						}
					}
				}
			})
		})
		// 浮层朝远离选区一侧展开（同 Tauri popBelow），工具条本身不动
		pop := func(key string, fn func()) {
			p := ui.Row(c).Absolute().Left(-80).Right(-80).Justify(ui.Center).PassThrough().Key(key)
			if linkAbove {
				p.Bottom(38)
			} else {
				p.Top(38)
			}
			p.Children(func() {
				ui.Column(c).Padding(6).Gap(6).Radius(rr(10)).Background(k.floatBtn).Border(1, k.floatBorder).
					Shadow(0, 1, 2, 0, k.floatShadowA).Shadow(0, 6, 16, -4, k.floatShadowB).Children(fn)
			})
		}
		field := func(v *string, w float32, label, ph string, onEnter func()) {
			ui.Row(c).Height(28).Padding(0, 8).Radius(rr(6)).Background(k.window).Border(1, k.fg.Alpha(0.1)).AlignItems(ui.Center).Width(w).Children(func() {
				ui.TextInputBase(c, v).Grow(1).Font(fontSans).FontSize(12).FixedLineHeight(18).TextColor(k.fg).
					PlaceholderColor(k.muted).Placeholder(ph).Label(label).Focus().OnTextKey(func(key ui.TextKey) bool {
					switch key.Key {
					case ui.KeyEnter:
						onEnter()
						return true
					case ui.KeyEscape:
						d.linkOn, d.aliasOn = false, false
						return true
					}
					return false
				})
			})
		}
		if d.linkOn && !ro { // 同 Tauri 链接表单：粘贴链接地址 · 应用
			src := a.detailSource(n)
			applyLink := func() {
				if strings.TrimSpace(d.linkDraft) == "" {
					return
				}
				out, nlo, nhi := applyMarkdownLink(src, lo, hi, d.linkDraft)
				d.linkOn = false
				if out != src {
					a.applyDetailEdit(n, out, nlo, nhi)
				}
			}
			pop("sb-link-pop", func() {
				ui.Row(c).Gap(6).AlignItems(ui.Center).Label(tr("添加链接")).Children(func() {
					field(&d.linkDraft, 196, tr("链接地址"), tr("粘贴链接地址"), applyLink)
					if btnOf(c, tr("应用")).Disabled(strings.TrimSpace(d.linkDraft) == "").Clicked() {
						applyLink()
					}
				})
			})
		}
		if d.aliasOn && showAlias { // 同 Tauri 加入化名词典表单：原文可改 · 类别 · 加入
			addAlias := func() {
				if strings.TrimSpace(d.aliasText) == "" {
					return
				}
				if a.quickAddAlias(d.aliasText, d.aliasCat) {
					d.aliasOn = false
					d.readSel, d.pickAnchor, d.pickEnd = nil, -1, -1 // 同 Tauri setPick(null) / setTextSelection(null)
					d.readGen++
				}
			}
			pop("sb-alias-pop", func() {
				ui.Column(c).Width(276).Gap(6).Label(tr("加入化名词典")).Children(func() {
					field(&d.aliasText, 276, tr("词条原文"), tr("要化名的原文（可修改）"), addAlias)
					ui.Row(c).Gap(6).AlignItems(ui.End).Children(func() {
						ui.Row(c).Grow(1).Basis(0).Wrap().Gap(4).Label(tr("化名类别")).Children(func() {
							for _, cat := range core.AliasPresetCategories {
								on := d.aliasCat == cat.Code
								ch := ui.Row(c).Height(20).Padding(0, 6).Radius(rr(6)).AlignItems(ui.Center).Key("sb-cat-" + cat.Code).Role(ui.RoleButton).Label(tr(cat.Label)).Selected(on)
								col, w := k.muted, 400
								switch {
								case on:
									ch.Background(stok(c).primary.Alpha(0.15))
									col, w = k.fg, 500
								case ch.Hovered():
									ch.Background(k.track)
									col = k.fg
								default:
									ch.Background(k.track)
								}
								ch.Children(func() { text(c, tr(cat.Label), 10, 14, w, col).SingleLine() })
								if ch.Clicked() {
									d.aliasCat = cat.Code
								}
							}
						})
						if btnOf(c, tr("加入")).Disabled(strings.TrimSpace(d.aliasText) == "").Clicked() {
							addAlias()
						}
					})
				})
			})
		}
	})
}

// targetBlockedReason 同 Tauri targetBlockMessage：目标未就绪时「发送选中」置灰并以此作提示；空 = 可发送。
func (a *app) targetBlockedReason() string {
	switch {
	case a.target.PID == 0:
		return tr("尚未识别发送目标，请先重新识别")
	case !a.targetReady():
		return tr("目标应用已退出，请重新识别")
	}
	if _, stale := a.resolution(); stale {
		return tr("原临时发送方案已暂停")
	}
	return ""
}

// toggleWrap：选区已被 mark 包住则去掉，否则包上（同 Tauri toggleInlineFormat 的行内语义）。
func toggleWrap(s, mark string) string {
	if len(s) >= 2*len(mark) && strings.HasPrefix(s, mark) && strings.HasSuffix(s, mark) {
		return s[len(mark) : len(s)-len(mark)]
	}
	return mark + s + mark
}

func init() { // 划词工具条新增文案的英文（已有的键不覆盖）
	for k, v := range map[string]string{
		"发送选中不可用：%s":           "Send selection unavailable: %s",
		"尚未识别发送目标，请先重新识别":      "No send target yet — identify one first",
		"目标应用已退出，请重新识别":        "Target app has quit — identify it again",
		"加入化名词典：发出自动替换，收回自动恢复": "Add to alias dictionary: replaced on send, restored on capture",
		"加入化名词典":               "Add to alias dictionary",
		"词条原文":                 "Original text",
		"要化名的原文（可修改）":          "Text to alias (editable)",
		"化名类别":                 "Alias category",
		"加入":                   "Add",
		"添加链接":                 "Add link",
		"粘贴链接地址":               "Paste link address",
		"应用":                   "Apply",
		"无法加入词典：%s":            "Couldn't add to dictionary: %s",
		"无法加入词典：类别无效":          "Couldn't add to dictionary: invalid category",
		"已加入化名词典：%s → %s":      "Added to alias dictionary: %s → %s",
		"已加入词典（%s）；可逆化名总开关当前关闭": "Added (%s); reversible aliasing is currently off",
	} {
		if _, ok := en[k]; !ok {
			en[k] = v
		}
	}
}

// selDragging：鼠标左键按着（拖选中）。测试替换：真实全局鼠标状态会让 headless 测试随运行时的手动操作而失败。
var selDragging = macos.MouseButtonsDown
