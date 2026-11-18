package main

import (
	"strings"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/core"
	"github.com/toskr/native/internal/store"
)

// 竖版列表舒适密度的行（用户 2026-11-18：列表样式只留这一种「卡片 · 大图在下」）：图片和正文在外层直接看到，
// 高度随内容变、有上限；紧凑密度走单行的 listRow。
//   头行（图标 · 标题或类型 · 时间）→ 正文（无图最多 6 行，带图最多 2 行）→ 图片整宽等比（上限随面板宽放宽；长图只露顶部一段）→ 多图时一排小缩略 → 状态行
// 行高在构建前算好（正文用 MeasureText 量折行），分组窗口化、悬停滑动浅底都按它走。

const (
	cardPadY     = 10
	cardHeadH    = 18
	cardLineH    = 18
	cardCodeH    = 16.5
	cardHeroMin  = 72  // 图片最矮
	cardHeroMax  = 132 // 图片最高（窄面板）；宽面板按内宽的一半放宽，见 cardHeroCap
	cardHeroWide = 220 // 图片最高的上限
	cardStripH   = 30  // 多图：大图下面一排小缩略的高
	cardStripGap = 4
	cardMaxH     = 196 // 一行最高（正文行数按它倒推）；图片上限放宽、带小缩略排时相应加高，见 cardLayout.capH
	cardFootH    = 18
)

// cardLayout：一行卡片的排版结果（构建与高度计算共用一份，保证两者一致）。
type cardLayout struct {
	h          float32
	lines      int     // 正文行数（0 = 不显示正文）
	lineH      float32 // 正文行高
	body       string
	media      bool    // 有图片区
	mediaH     float32 // 图片区高
	strip      bool    // 多图：大图下面有一排小缩略
	capH       float32 // 这一行的高度上限
	foot       bool    // 有状态行
	titleFirst bool    // 头行写自定义标题 / 链接标题（否则写类型）
}

// cardBody：卡片正文——链接写网址，图片写备注，其余写全文（自定义标题时也照常显示正文）。
// 只取前 cardPreviewRunes 字：最多排 6 行，超大卡（MB 级）量折行 / 渲染都只碰这一截。
func cardBody(n store.Note) string { return previewCap(cardBodyFull(n)) }

func cardBodyFull(n store.Note) string {
	switch {
	case n.Blur || n.Kind == "secret":
		return ""
	case n.Kind == "link":
		return strings.TrimSpace(cmpOr(n.URL, n.Text))
	case n.Kind == "image":
		if s := strings.TrimSpace(imageNoteText(n)); s != "" && !store.IsImagePlaceholder(s) && s != cardTitle(n) && s != tr("图片") {
			return s
		}
		return ""
	}
	return strings.TrimSpace(previewCap(n.Text))
}

func (a *app) cardHasFoot(n store.Note) bool {
	_, sug := a.inboxSug[n.ID]
	return (sug && n.Section == store.SectionInbox) || n.Kept || n.SendCount > 0 || a.aiBusy == n.ID ||
		n.Provenance != nil || len(n.Tags) > 0 || a.aliasCount(n) > 0
}

// cardKey / cardCached：排版缓存按「卡 + 宽」取，命中再比原文 / 标题 / 图片数——Go 比较同一份字符串
// 先比指针，未改动的卡是 O(1)（此前每帧对每张卡拼串 + 哈希整段正文，150 张卡一帧要 30ms+，用户 2026-11-17 反馈卡顿）。
type cardKey struct {
	id string
	w  int
}

type cardCached struct {
	text, title, link, image string
	media                    int
	blur                     bool
	l                        cardLayout
}

// cardLayoutOf：按可用宽度算出一行卡片的排版（结果缓存，见 cardKey）。
func (a *app) cardLayoutOf(c *ui.Context, n store.Note) cardLayout {
	w := a.cardInnerW(c)
	key := cardKey{n.ID, int(w)}
	foot := a.cardHasFoot(n)
	media := len(n.Attachments)
	if e, ok := a.cardLayouts[key]; ok && e.text == n.Text && e.title == n.Title && e.link == n.LinkTitle && e.image == n.ImageFile && e.media == media && e.blur == n.Blur {
		l := e.l
		l.foot = foot
		return cardFinish(l)
	}
	body := cardBody(n)
	l := cardLayout{body: body, lineH: cardLineH, titleFirst: strings.TrimSpace(n.Title) != "" || n.LinkTitle != ""}
	if isCode(n) {
		l.lineH = cardCodeH
	}
	files := n.MediaFiles()
	l.media = len(files) > 0 && !n.Blur
	l.capH = cardMaxH
	maxLines := 6
	if l.media {
		maxLines = 2
		hero := cardHeroCap(w)
		l.mediaH = hero
		if img := a.thumb(files[0]); img != nil {
			iw, ih := ui.ImageSize(img)
			l.mediaH = min(max(w*float32(ih)/max(float32(iw), 1), cardHeroMin), hero)
		}
		l.capH += hero - cardHeroMax
		if l.strip = len(files) > 1; l.strip {
			l.capH += cardStripGap + cardStripH
		}
	}
	if l.body != "" && w > 40 {
		sp := ui.Span{Text: l.body, Size: 12}
		one := ui.Span{Text: "国", Size: 12}
		if isCode(n) {
			sp.Font, sp.Size, one.Font, one.Size = fontMono, 11, fontMono, 11
		}
		_, th := c.MeasureText(w, sp)
		_, lh := c.MeasureText(0, one)
		l.lines = min(max(int(th/max(lh, 1)+0.5), 1), maxLines)
	}
	a.cardLayouts[key] = cardCached{text: n.Text, title: n.Title, link: n.LinkTitle, image: n.ImageFile, media: media, blur: n.Blur, l: l}
	l.foot = foot
	return cardFinish(l)
}

// cardFinish：由各部分拼出行高；超过上限时先减正文行数，再压矮图片（不低于 cardHeroMin）。
func cardFinish(l cardLayout) cardLayout {
	calc := func() float32 {
		h := float32(cardPadY*2 + cardHeadH)
		if l.lines > 0 {
			h += 4 + float32(l.lines)*l.lineH
		}
		if l.media {
			h += 8 + l.mediaH
		}
		if l.strip {
			h += cardStripGap + cardStripH
		}
		if l.foot {
			h += 6 + cardFootH
		}
		return h
	}
	l.h = calc()
	for l.h > l.capH && l.lines > 1 {
		l.lines--
		l.h = calc()
	}
	if l.media && l.h > l.capH {
		l.mediaH = max(l.mediaH-(l.h-l.capH), cardHeroMin)
		l.h = calc()
	}
	l.h = min(l.h, l.capH)
	return l
}

// cardHeroCap：图片区最高多少——面板越宽越高（内宽的一半），窄面板保持 132。
func cardHeroCap(w float32) float32 { return min(max(w*0.5, cardHeroMax), cardHeroWide) }

// cardInnerW：卡片内可用于正文的宽（分组框内宽 − 行左右内边距 − 图标列），取上一帧量到的列表宽。
func (a *app) cardInnerW(c *ui.Context) float32 {
	w := a.listBodyW
	if w <= 0 {
		w, _ = c.Size()
		w -= 24
	}
	return max(w-2*secPad-2*listPadX-listIcon-listGap, 60)
}

// noteRowH：一行的高度（舒适密度按内容算，紧凑固定）。
func (a *app) noteRowH(c *ui.Context, n store.Note) float32 {
	if a.rowDragLast == n.ID { // 拖起中：原位收成一行小卡高（下面的行跟着上移）
		return dragRowH
	}
	if a.store.Settings().CardDensity != "compact" {
		return a.cardLayoutOf(c, n).h
	}
	return a.cardHeight()
}

// cardRow：舒适密度一行的内容。头行左列是 18 小图标；正文、图片都在这一层直接看到，图片在正文下面。
func (a *app) cardRow(c *ui.Context, k tokens, n store.Note, l cardLayout, active bool) {
	files := n.MediaFiles()
	ui.Row(c).Fill().Padding(cardPadY, listPadX).Gap(listGap).AlignItems(ui.Start).Children(func() { // 图标贴头行，不随行高居中
		lead := ui.Box(c).Size(listIcon, listIcon).Shrink(0).Key("row-lead")
		lead.AnimatePose(ui.Pose{Scale: map[bool]float32{true: 1.1, false: 1}[active]}, springControl)
		lead.Children(func() { a.listLead(c, k, n) })
		ui.Column(c).Grow(1).Basis(0).Clip().Children(func() {
			a.cardHead(c, k, n, l, active)
			if l.lines > 0 {
				ui.Column(c).Margin(4, 0, 0, 0).Height(float32(l.lines) * l.lineH).Clip().Children(func() {
					if isCode(n) {
						a.codeText(c, k, n, l.lines)
						return
					}
					doneText(highlightText(c, k, l.body, a.query, 12, cardLineH, k.fg).Wrap().MaxLines(l.lines), k, n)
				})
			}
			if l.media {
				ui.Box(c).Height(8)
				a.cardMedia(c, k, n, files, l)
			}
			if l.foot {
				ui.Row(c).Margin(6, 0, 0, 0).Height(cardFootH).Gap(6).AlignItems(ui.Center).Children(func() {
					a.aiBusyMark(c, k, n.ID)
					if a.bandFor(n.ID) == nil {
						if n.Kept {
							tipOf(c, liconFilled(c, "star", 11, amber400).Shrink(0), tr("常用"))
						}
						a.inboxSugChip(c, k, n)
						a.sentChip(c, k, n)
					}
					a.cardFooterLeadOpt(c, k, n, false)
				})
			}
		})
	})
}

// cardHead：头行——自定义标题 / 链接标题（粗）或类型（灰）+ 来源应用 + 时间（悬停让位给操作条）。
func (a *app) cardHead(c *ui.Context, k tokens, n store.Note, l cardLayout, active bool) {
	ui.Row(c).Height(cardHeadH).Gap(6).AlignItems(ui.Center).Children(func() {
		if a.cardInlineInputOn(c, k, n, k.fg) {
			return
		}
		if l.titleFirst {
			t := strings.TrimSpace(n.Title)
			if t == "" {
				t = n.LinkTitle
			}
			doneText(highlightText(c, k, t, a.query, 12.5, cardHeadH, k.fg).FontWeight(600).SingleLine().Shrink(1), k, n)
		} else {
			text(c, cardTitle(n), 11, cardHeadH, 600, k.muted).SingleLine().Shrink(0)
		}
		if n.SourceApp != "" {
			text(c, "· "+n.SourceApp, 11, cardHeadH, 400, k.muted).SingleLine().Shrink(1)
		}
		ui.Box(c).Grow(1)
		t := text(c, ago(n.CreatedAt, a.now()), 10.5, cardHeadH, 400, k.muted).SingleLine().Shrink(0).Key("row-time")
		op := float32(1)
		if active || a.bandFor(n.ID) != nil {
			op = 0
		}
		t.Opacity(t.AnimateTo("op", op, tweenTw))
	})
}

// cardMedia：图片区。大图整宽放第 1 张：比例合适就等比放全（文字截图也看得清）；长图铺满宽、只露顶部一段，
// 底缘压一道暗影表示下面还有。多图在大图下面排一排小缩略（第 2 张起，放不下的最后一格写 +N）。
// 悬停大图 360ms 弹原图窥视窗（← → 换张）。
func (a *app) cardMedia(c *ui.Context, k tokens, n store.Note, files []string, l cardLayout) {
	bw, bh := a.cardInnerW(c), l.mediaH
	wrap := ui.Box(c).Size(bw, bh).Shrink(0).Radius(rr(10)).Clip().Background(k.track).Border(1, k.fg.Alpha(0.06)).Key("card-media")
	wrap.Children(func() {
		img := a.thumb(files[0])
		if img == nil {
			return
		}
		iw, ih := ui.ImageSize(img)
		full := bw * float32(ih) / max(float32(iw), 1) // 铺满宽时的高
		if cardIsLong(full, bh) {
			ui.Column(c).Fill().Children(func() { ui.Image(c, img).Size(bw, full).Shrink(0) })
			ui.Box(c).Absolute().Left(0).Right(0).Bottom(0).Height(22).Gradient(ui.RGBA(0, 0, 0, 0), ui.RGBA(0, 0, 0, 0.32), 180).PassThrough().Key("card-media-more")
			return
		}
		s := min(bw/max(float32(iw), 1), bh/max(float32(ih), 1))
		ui.Box(c).Fill().Center().Children(func() { ui.Image(c, img).Size(float32(iw)*s, float32(ih)*s) })
	})
	wrap.Label(tr("拖出原图"))
	wrap.AnimatePose(ui.Pose{Scale: map[bool]float32{true: 1.01, false: 1}[wrap.Hovered()]}, springControl)
	a.compactHover(c, wrap, n)
	a.imageDragOut(wrap, n, files)
	if l.strip {
		a.cardStrip(c, k, files[1:], bw)
	}
}

// cardIsLong：铺满宽后的高超过图片区 2 倍（等比放全只占不到一半宽）算长图，裁顶部；否则等比放全。
func cardIsLong(full, boxH float32) bool { return full > boxH*2 }

// cardStripCells：小缩略排里各格的宽（按比例，24–54），以及放不下而没列出的张数。
func cardStripCells(ratios []float32, w float32) (ws []float32, rest int) {
	used := float32(0)
	for i, r := range ratios {
		cw := min(max(cardStripH*r, 24), 54)
		if used+cw > w {
			return ws, len(ratios) - i
		}
		ws = append(ws, cw)
		used += cw + cardStripGap
	}
	return ws, 0
}

// cardStrip：多图卡大图下面的一排小缩略（铺满裁切）。点它等同点这一行。
func (a *app) cardStrip(c *ui.Context, k tokens, files []string, w float32) {
	ratios := make([]float32, len(files))
	for i, f := range files {
		ratios[i] = 1
		if img := a.thumb(f); img != nil {
			iw, ih := ui.ImageSize(img)
			ratios[i] = float32(iw) / max(float32(ih), 1)
		}
	}
	ws, rest := cardStripCells(ratios, w)
	ui.Row(c).Margin(cardStripGap, 0, 0, 0).Height(cardStripH).Gap(cardStripGap).PassThrough().Key("card-strip").Children(func() {
		for i, cw := range ws {
			cell := ui.Box(c).Size(cw, cardStripH).Shrink(0).Radius(rr(6)).Clip().Center().Background(k.track).Border(1, k.fg.Alpha(0.06)).PassThrough()
			last := rest > 0 && i == len(ws)-1
			cell.Children(func() {
				if img := a.thumb(files[i]); img != nil {
					iw, ih := ui.ImageSize(img)
					s := max(cw/max(float32(iw), 1), cardStripH/max(float32(ih), 1))
					ui.Image(c, img).Size(float32(iw)*s, float32(ih)*s).Shrink(0)
				}
				if last { // 这一格和后面没列出的都算进 +N
					ui.Box(c).Absolute().Left(0).Top(0).Right(0).Bottom(0).Background(ui.RGBA(0, 0, 0, 0.5)).Center().PassThrough().
						Children(func() { text(c, "+"+itoa(rest+1), 10.5, 14, 600, ui.RGB(255, 255, 255)) })
				}
			})
		}
	})
}

// aliasHit：一张卡的别名占位命中数缓存（原文 + 字典不变就不重扫；字典按长度 + 首元素地址认同一份）。
type aliasHit struct {
	text string
	dict *store.AliasEntity
	dn   int
	n    int
}

// aliasCount：卡里命中的别名占位数。列表逐帧逐卡都要问（页脚是否显示、操作条按钮数），正则全文扫描只在原文或字典变了时做。
func (a *app) aliasCount(n store.Note) int {
	dict := a.store.Settings().AliasEntities
	if len(dict) == 0 || n.Text == "" {
		return 0
	}
	if a.aliasHits == nil {
		a.aliasHits = map[string]aliasHit{}
	}
	if h, ok := a.aliasHits[n.ID]; ok && h.text == n.Text && h.dict == &dict[0] && h.dn == len(dict) {
		return h.n
	}
	c := core.AliasOccurrences(n.Text, dict)
	a.aliasHits[n.ID] = aliasHit{text: n.Text, dict: &dict[0], dn: len(dict), n: c}
	return c
}
