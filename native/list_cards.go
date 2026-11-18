package main

import (
	"strings"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/core"
	"github.com/toskr/native/internal/store"
)

// 竖版列表的「卡片」类样式（用户 2026-11-17：剪贴页那种布局，图片和正文在外层直接看到，高度随内容变、有上限，
// 与紧凑模式区分开；行首用右图样式的 18 小图标）。三种：
//   - card  卡片：头行（图标 · 标题或类型 · 时间）+ 正文多行 + 图片条（等比缩放不裁切，文字截图看得清）+ 状态行
//   - side  图文：头行 + 正文在左、图片在右（76 方，等比放进去）
//   - hero  大图：图片整宽在上（等比，最高 132）+ 头行 + 两行正文
// 行高在构建前算好（正文用 MeasureText 量折行），分组窗口化、悬停滑动浅底都按它走。

const (
	listCard = "card"
	listSide = "side"
	listHero = "hero"

	cardPadY    = 10
	cardHeadH   = 18
	cardLineH   = 18
	cardCodeH   = 16.5
	cardStripH  = 72  // 图片条高
	cardSideW   = 76  // 图文样式右侧图片边长
	cardHeroMax = 132 // 大图样式图片最高
	cardMaxH    = 196 // 一行最高（正文行数按它倒推）
	cardFootH   = 18
)

func isCardStyle(s string) bool { return s == listCard || s == listSide || s == listHero }

// cardStyleFor：图文左右样式下没有正文的纯图片行左边会空着，改按图片条排。
func cardStyleFor(n store.Note, style string) string {
	if style == listSide && cardBody(n) == "" {
		return listCard
	}
	return style
}

// cardLayout：一行卡片的排版结果（构建与高度计算共用一份，保证两者一致）。
type cardLayout struct {
	h          float32
	lines      int     // 正文行数（0 = 不显示正文）
	lineH      float32 // 正文行高
	body       string
	media      bool    // 有图片区
	mediaH     float32 // 图片区高（card：条高；side：方块边；hero：大图高）
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

// cardKey / cardCached：排版缓存按「卡 + 样式 + 宽」取，命中再比原文 / 标题 / 图片数——Go 比较同一份字符串
// 先比指针，未改动的卡是 O(1)（此前每帧对每张卡拼串 + 哈希整段正文，150 张卡一帧要 30ms+，用户 2026-11-17 反馈卡顿）。
type cardKey struct {
	id, style string
	w         int
}

type cardCached struct {
	text, title, link, image string
	media                    int
	blur                     bool
	l                        cardLayout
}

// cardLayoutOf：按样式、可用宽度算出一行卡片的排版（结果缓存，见 cardKey）。
func (a *app) cardLayoutOf(c *ui.Context, n store.Note, style string) cardLayout {
	w := a.cardInnerW(c)
	key := cardKey{n.ID, style, int(w)}
	foot := a.cardHasFoot(n)
	media := len(n.Attachments)
	if e, ok := a.cardLayouts[key]; ok && e.text == n.Text && e.title == n.Title && e.link == n.LinkTitle && e.image == n.ImageFile && e.media == media && e.blur == n.Blur {
		l := e.l
		l.foot = foot
		return a.cardFinish(l, style)
	}
	body := cardBody(n)
	l := cardLayout{body: body, lineH: cardLineH, titleFirst: strings.TrimSpace(n.Title) != "" || n.LinkTitle != ""}
	if isCode(n) {
		l.lineH = cardCodeH
	}
	files := n.MediaFiles()
	l.media = len(files) > 0 && !n.Blur
	textW := w
	switch {
	case l.media && style == listSide:
		l.mediaH = cardSideW
		textW = w - cardSideW - 10
	case l.media && style == listHero:
		l.mediaH = cardHeroMax
		if img := a.thumb(files[0]); img != nil {
			iw, ih := ui.ImageSize(img)
			l.mediaH = min(max(w*float32(ih)/max(float32(iw), 1), 72), cardHeroMax)
		}
	case l.media:
		l.mediaH = cardStripH
	}
	maxLines := 6
	switch {
	case style == listHero && l.media:
		maxLines = 2
	case style == listCard && l.media:
		maxLines = 3
	case style == listSide && l.media:
		maxLines = 4
	}
	if l.body != "" && textW > 40 {
		sp := ui.Span{Text: l.body, Size: 12}
		one := ui.Span{Text: "国", Size: 12}
		if isCode(n) {
			sp.Font, sp.Size, one.Font, one.Size = fontMono, 11, fontMono, 11
		}
		_, th := c.MeasureText(textW, sp)
		_, lh := c.MeasureText(0, one)
		l.lines = min(max(int(th/max(lh, 1)+0.5), 1), maxLines)
	}
	a.cardLayouts[key] = cardCached{text: n.Text, title: n.Title, link: n.LinkTitle, image: n.ImageFile, media: media, blur: n.Blur, l: l}
	l.foot = foot
	return a.cardFinish(l, style)
}

// cardFinish：由各部分拼出行高，超过上限时减正文行数。
func (a *app) cardFinish(l cardLayout, style string) cardLayout {
	calc := func() float32 {
		h := float32(cardPadY*2 + cardHeadH)
		body := float32(l.lines) * l.lineH
		switch {
		case l.media && style == listSide:
			h += 6 + max(body, l.mediaH)
		case l.media && style == listHero:
			h += l.mediaH + 8
			if l.lines > 0 {
				h += 4 + body
			}
		default:
			if l.lines > 0 {
				h += 4 + body
			}
			if l.media {
				h += 8 + l.mediaH
			}
		}
		if l.foot {
			h += 6 + cardFootH
		}
		return h
	}
	l.h = calc()
	for l.h > cardMaxH && l.lines > 1 {
		l.lines--
		l.h = calc()
	}
	l.h = min(l.h, cardMaxH)
	return l
}

// cardInnerW：卡片内可用于正文的宽（分组框内宽 − 行左右内边距 − 图标列），取上一帧量到的列表宽。
func (a *app) cardInnerW(c *ui.Context) float32 {
	w := a.listBodyW
	if w <= 0 {
		w, _ = c.Size()
		w -= 24
	}
	return max(w-2*secPad-2*listPadX-listIcon-listGap, 60)
}

// noteRowH：一行的高度（卡片样式按内容算，其余固定）。
func (a *app) noteRowH(c *ui.Context, n store.Note) float32 {
	if a.rowDragLast == n.ID { // 拖起中：原位收成一行小卡高（下面的行跟着上移）
		return dragRowH
	}
	if a.store.Settings().CardDensity != "compact" && isCardStyle(a.listStyle()) {
		return a.cardLayoutOf(c, n, cardStyleFor(n, a.listStyle())).h
	}
	return a.cardHeight()
}

// cardRow：卡片样式一行的内容。头行与右图样式同一套左列小图标；正文、图片都在这一层直接看到。
func (a *app) cardRow(c *ui.Context, k tokens, n store.Note, l cardLayout, style string, active bool) {
	files := n.MediaFiles()
	ui.Row(c).Fill().Padding(cardPadY, listPadX).Gap(listGap).AlignItems(ui.Start).Children(func() { // 图标贴头行，不随行高居中
		lead := ui.Box(c).Size(listIcon, listIcon).Shrink(0).Key("row-lead")
		if style == listHero && l.media {
			lead.Margin(l.mediaH+8, 0, 0, 0) // 与头行对齐（头行在大图下面）
		}
		lead.AnimatePose(ui.Pose{Scale: map[bool]float32{true: 1.1, false: 1}[active]}, springControl)
		lead.Children(func() { a.listLead(c, k, n) })
		ui.Column(c).Grow(1).Basis(0).Clip().Children(func() {
			if style == listHero && l.media {
				a.cardMedia(c, k, n, files, l, style)
				ui.Box(c).Height(8)
			}
			a.cardHead(c, k, n, l, active)
			body := func(w ui.Element) {
				if l.lines == 0 {
					return
				}
				w.Children(func() {
					if isCode(n) {
						a.codeText(c, k, n, l.lines)
						return
					}
					doneText(highlightText(c, k, l.body, a.query, 12, cardLineH, k.fg).Wrap().MaxLines(l.lines), k, n)
				})
			}
			switch {
			case l.media && style == listSide:
				ui.Row(c).Margin(6, 0, 0, 0).Gap(10).AlignItems(ui.Start).Height(max(float32(l.lines)*l.lineH, l.mediaH)).Children(func() {
					body(ui.Column(c).Grow(1).Basis(0).Clip())
					a.cardMedia(c, k, n, files, l, style)
				})
			case l.media && style == listHero:
				body(ui.Column(c).Margin(4, 0, 0, 0).Height(float32(l.lines) * l.lineH).Clip())
			default:
				body(ui.Column(c).Margin(4, 0, 0, 0).Height(float32(l.lines) * l.lineH).Clip())
				if l.media {
					ui.Box(c).Height(8)
					a.cardMedia(c, k, n, files, l, style)
				}
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

// cardMedia：图片区。等比缩放、不裁切（文字截图也看得清）；悬停 360ms 弹原图窥视窗，按住拖出原图。
//   - card：一排等高 72 的图，按比例排到放不下为止，最后一张盖「+N」
//   - side：76 方框里等比放第 1 张，多图右下角标张数
//   - hero：整宽等比放第 1 张，多图右下角标张数
func (a *app) cardMedia(c *ui.Context, k tokens, n store.Note, files []string, l cardLayout, style string) {
	w := a.cardInnerW(c)
	fit := func(b ui.Element, img ui.ImageSource, bw, bh float32) {
		iw, ih := ui.ImageSize(img)
		s := min(bw/max(float32(iw), 1), bh/max(float32(ih), 1))
		b.Children(func() { ui.Image(c, img).Size(float32(iw)*s, float32(ih)*s) })
	}
	countBadge := func() {
		if len(files) > 1 {
			ui.Box(c).Absolute().Right(5).Bottom(5).Height(16).Padding(0, 5).Radius(8).Background(ui.RGBA(0, 0, 0, 0.6)).Center().PassThrough().
				Children(func() { text(c, itoa(len(files))+tr(" 张"), 9.5, 12, 600, ui.RGB(255, 255, 255)) })
		}
	}
	var wrap ui.Element
	switch style {
	case listSide, listHero:
		bw, bh := float32(cardSideW), float32(cardSideW)
		if style == listHero {
			bw, bh = w, l.mediaH
		}
		wrap = ui.Box(c).Size(bw, bh).Shrink(0).Radius(rr(10)).Clip().Background(k.track).Border(1, k.fg.Alpha(0.06)).Key("card-media")
		wrap.Children(func() {
			ui.Box(c).Fill().Center().Children(func() {
				if img := a.thumb(files[0]); img != nil {
					fit(ui.Box(c).Size(bw, bh).Center(), img, bw, bh)
				}
			})
			countBadge()
		})
	default:
		wrap = ui.Row(c).Height(l.mediaH).Gap(6).Clip().Key("card-media")
		wrap.Children(func() {
			used := float32(0)
			for i, f := range files {
				img := a.thumb(f)
				if img == nil {
					continue
				}
				iw, ih := ui.ImageSize(img)
				tw := min(max(l.mediaH*float32(iw)/max(float32(ih), 1), 48), w*0.62)
				last := used+tw+6 > w || i == 5
				if last && i > 0 {
					tw = max(min(w-used, tw), 48)
				}
				cell := ui.Box(c).Size(tw, l.mediaH).Radius(rr(8)).Clip().Background(k.track).Border(1, k.fg.Alpha(0.06)).Shrink(0).Center()
				fit(cell, img, tw, l.mediaH)
				if last && i < len(files)-1 {
					rest := len(files) - i - 1
					cell.Children(func() {
						ui.Box(c).Absolute().Left(0).Top(0).Right(0).Bottom(0).Background(ui.RGBA(0, 0, 0, 0.45)).Center().PassThrough().
							Children(func() { text(c, "+"+itoa(rest), 14, 18, 600, ui.RGB(255, 255, 255)) })
					})
				}
				used += tw + 6
				if last {
					break
				}
			}
		})
	}
	wrap.Label(tr("拖出原图"))
	wrap.AnimatePose(ui.Pose{Scale: map[bool]float32{true: 1.01, false: 1}[wrap.Hovered()]}, springControl)
	a.compactHover(c, wrap, n)
	a.imageDragOut(wrap, n, files)
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
