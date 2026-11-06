package main

import (
	"net/url"
	"os/exec"
	"slices"
	"strings"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// 剪贴页按 Tauri 版「票据」卡（NoteCard ticket）与时间分段（lib/cliprow.ts）复刻：
// 段头 28（标签 + 细线，首段右侧带视图切换）→ 卡片 116（时间头 20 · 正文 · 虚线底栏 20），段内间距 4。

var clipViews = []struct{ id, label string }{{"time", "按时间"}, {"source", "按来源"}, {"image", "图片"}}

// clipTimeBand 与 Tauri clipTimeBand 同口径：15 分钟内「刚刚」、1 小时内、今天、昨天、7 天内、更早。
func clipTimeBand(ts, now time.Time) string {
	d := now.Sub(ts)
	switch {
	case d < 15*time.Minute:
		return tr("刚刚")
	case d < time.Hour:
		return tr("1 小时内")
	case sameDay(ts, now):
		return tr("今天")
	case sameDay(ts, now.AddDate(0, 0, -1)):
		return tr("昨天")
	case d < 7*24*time.Hour:
		return tr("7 天内")
	}
	return tr("更早")
}

// arrangeClips 决定剪贴页的展示顺序（键盘选择沿用同一顺序）：置顶在前；按来源时同源相邻；图片视图只留图片。
func arrangeClips(notes []store.Note, view string) []store.Note {
	if view == "image" {
		notes = slices.DeleteFunc(notes, func(n store.Note) bool { return n.Kind != "image" })
	}
	first := map[string]int{}
	for i, n := range notes {
		if _, ok := first[n.SourceApp]; !ok {
			first[n.SourceApp] = i
		}
	}
	slices.SortStableFunc(notes, func(x, y store.Note) int {
		if x.Kept != y.Kept {
			if x.Kept {
				return -1
			}
			return 1
		}
		if view == "source" && !x.Kept {
			return first[x.SourceApp] - first[y.SourceApp]
		}
		return 0
	})
	return notes
}

func (a *app) clipBand(n store.Note) string {
	switch {
	case n.Kept:
		return tr("置顶")
	case a.clipView == "source":
		if n.SourceApp == "" {
			return tr("未知来源")
		}
		return n.SourceApp
	}
	return clipTimeBand(n.CreatedAt, a.now())
}

func (a *app) clipPage(c *ui.Context, k tokens) {
	list := a.clipList
	_, vh := c.Size()
	vis := visWindow{top: a.clipScroll.Y - 600, bottom: a.clipScroll.Y + vh + 600}
	ui.Scroll(c).Grow(1).Scrollbars(false).TrackScroll(&a.clipScroll).Children(func() {
		ui.Column(c).Padding(4, 14, 8, 14).Children(func() {
			if len(list) == 0 {
				a.clipHeader(c, k, "", true)
				a.emptyState(c, k, "clipboard-list", tr("还没有剪贴板记录"), tr("复制任意文字、链接或图片试试，会自动出现在这里。"))
				return
			}
			// 卡片定高（标准 116 / 浓缩 52 / 紧凑行 32，紧凑行间不留缝）：只构建视口附近的卡，其余等高占位（同笔记页）
			layout := a.clipLayout()
			gap := float32(4)
			if layout == clipCompact {
				gap = 0
			}
			y := float32(4)
			for i := 0; i < len(list); {
				band := a.clipBand(list[i])
				j := i
				for j < len(list) && a.clipBand(list[j]) == band {
					j++
				}
				a.clipHeader(c, k, band, i == 0)
				y += 28
				ui.Column(c).Gap(gap).Key("band-" + band).Children(func() {
					skip := float32(0)
					flush := func() {
						if skip > 0 {
							ui.Box(c).Height(skip - gap).Key("gap-" + itoa(int(y)))
							skip = 0
						}
					}
					for _, n := range list[i:j] {
						lay := layout
						if a.editing == n.ID { // 编辑时临时回到标准高度放下输入框
							lay = clipStandard
						}
						h := clipCardH(lay)
						if (y+h < vis.top || y > vis.bottom) && !a.chosen.Has(n.ID) {
							skip += h + gap
						} else {
							flush()
							a.clipCard(c, k, n, lay)
						}
						y += h + gap
					}
					flush()
				})
				y -= gap
				i = j
			}
		})
	})
}

// clipHeader 是分段头：10/14 标签 + 1px 细线；第一段右侧挂视图切换（按时间 / 按来源 / 图片）。
func (a *app) clipHeader(c *ui.Context, k tokens, label string, first bool) {
	top := float32(10)
	if first {
		top = 2
	}
	ui.Row(c).Height(28).Padding(top, 0, 4, 0).Gap(8).AlignItems(ui.Center).Children(func() {
		if label != "" {
			text(c, label, 10, 14, 500, k.muted)
		}
		ui.Box(c).Grow(1).Height(1).Background(k.bandLine)
		if !first {
			return
		}
		ui.Row(c).Height(22).Padding(2).Radius(10).Background(k.track).InsetShadow(0, 1, 2, 0, k.insetShadow).Children(func() {
			for _, v := range clipViews {
				sel := a.clipView == v.id
				b := ui.Box(c).Height(18).Padding(2, 6).Radius(8).Center().Key("cv-" + v.id)
				w, col := 400, k.muted
				if sel {
					w, col = 500, k.fg
				} else if b.Hovered() {
					col = k.fg
				}
				b.Children(func() {
					if sel { // Segmented xs：共享布局滑块，springControl
						thumb := ui.Box(c).Absolute().Top(0).Left(0).Right(0).Bottom(0).Radius(8).Background(k.pill).Shadow(0, 1, 2, 0, k.pillShadow).PassThrough().
							Transition(ui.ElementTransition{Match: layoutID{"clip-view-thumb"}, Animation: &springControl, Position: true, Size: true})
						if !k.dark {
							thumb.InsetShadow(0, 1, 0, 0, k.pillHighlight)
						}
					}
					fg := b.AnimateColor("fg", col, tweenControl)
					overThumb(c, func() { text(c, tr(v.label), 10, 14, w, fg) })
				})
				if b.Clicked() && !sel {
					a.clipView = v.id
					a.selected = 0
					a.reload()
				}
			}
		})
	})
}

func linkHost(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" {
		return raw
	}
	return strings.TrimPrefix(u.Host, "www.") + strings.TrimSuffix(u.EscapedPath(), "/")
}

const (
	clipStandard  = "standard"
	clipCondensed = "condensed"
	clipCompact   = "compact"
)

// clipLayout：紧凑密度 → 32 高流水行；舒适密度按剪贴卡模板（同 Tauri clipCardTemplate，只在舒适密度生效）。
func (a *app) clipLayout() string {
	st := a.store.Settings()
	switch {
	case st.CardDensity == "compact":
		return clipCompact
	case st.ClipTemplate == "condensed":
		return clipCondensed
	}
	return clipStandard
}

func clipCardH(layout string) float32 {
	switch layout {
	case clipCompact:
		return 32
	case clipCondensed:
		return 52
	}
	return 116
}

// firstLine：首个非空行（浓缩卡摘要）。
func firstLine(s string) string {
	for _, l := range strings.Split(s, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			return l
		}
	}
	return ""
}

// clipCard 是剪贴板「票据」卡：时间头 + 正文（3 行截断 / 链接标题）+ 虚线底栏（来源 · 字数）。
// 浓缩模板：票据头 + 单行摘要（图片=缩略图，链接=标题），无底栏，操作钮挂头行右端。
// 紧凑密度：去卡片化的 32 高流水行（悬停才浮现行底），见 clipRow。
func (a *app) clipCard(c *ui.Context, k tokens, n store.Note, layout string) {
	condensed := layout == clipCondensed
	idx, ok := a.noteIdx[n.ID]
	if !ok || a.page != pageClip {
		idx = -1
	}
	focused := idx >= 0 && idx == a.selected && a.focusList
	checked := a.chosen.Has(n.ID)
	var box ui.Element
	if layout == clipCompact {
		box = ui.Row(c).Height(32).Padding(0, 8).Gap(8).Radius(6).AlignItems(ui.Center).Key(n.ID)
	} else {
		box = ui.Column(c).Height(clipCardH(layout)).Padding(6, 8, 4, 8).Radius(10).Background(k.card).Key(n.ID)
	}
	hovered := box.Hovered()
	lift := float32(0)
	if layout == clipCompact { // 行底：悬停 / 键盘焦点浮现（hover:bg-black/5，暗色 white/6）
		bg := k.fg.Alpha(0)
		if hovered || focused {
			bg = k.fg.Alpha(0.05)
		}
		box.Background(box.AnimateColor("row-bg", bg, tweenTw))
	} else {
		elevated(box, k, hovered || checked || (focused && !checked)) // 同笔记卡：悬停上移 1px + elevation-2，多选内发光
		if hovered {
			lift = -1
		}
	}
	box.AnimatePose(ui.Pose{Y: lift}, tweenTw)
	box.ContextMenu(func(m *ui.Menu) {
		if idx >= 0 {
			a.selected = idx
		}
		a.cardMenu(c, m, max(idx, 0), n)
	})
	isLink := n.Kind == "link"
	box.Children(func() {
		if layout == clipCompact {
			a.clipRow(c, k, n, hovered, isLink)
			if n.Blur {
				blurOverlay(c, k, 12)
			}
			if hovered {
				a.clipActions(c, k, n, isLink, 5)
			}
			a.cardOverlays(c, k, n, checked, true)
			a.quickBadge(c, k, idx, 8)
			return
		}
		ui.Row(c).Height(20).Gap(6).AlignItems(ui.Center).Children(func() {
			text(c, ago(n.CreatedAt, a.now()), 11, 16, 600, k.muted)
			if isLink {
				ui.Box(c).Height(14).Padding(0, 6).Radius(6).Background(k.track).Center().Children(func() {
					text(c, tr("链接"), 10, 10, 500, k.muted)
				})
			}
			ui.Spacer(c)
			if n.Kept { // 票据模板：悬停时淡出给操作钮让位（opacity 150ms）
				pinOp := float32(1)
				if hovered {
					pinOp = 0
				}
				pin := ui.Box(c).Size(12, 12)
				pin.Opacity(pin.AnimateTo("op", pinOp, tweenTw)).Children(func() { liconFilled(c, "pin", 12, amber400) })
			}
		})
		if condensed {
			ui.Row(c).Grow(1).Gap(6).AlignItems(ui.Center).Clip().Children(func() {
				if n.Blur {
					return
				}
				line := firstLine(n.Text)
				switch {
				case n.Kind == "image":
					if img := a.thumb(n.ImageFile); img != nil {
						w, h := ui.ImageSize(img)
						ui.Image(c, img).Size(min(24*w/max(h, 1), 48), 24).Radius(4)
					}
					line = itoa(n.ImageW) + " × " + itoa(n.ImageH)
				case isLink:
					a.linkFavicon(c, n, 16)
					if n.LinkTitle != "" {
						line = n.LinkTitle
					}
				}
				t := text(c, line, 13, 18, 400, k.fg).SingleLine().Grow(1)
				if n.Kind == "code" {
					t.Font(fontMono).FontSize(12)
				}
			})
			if n.Blur {
				blurOverlay(c, k, 20)
			}
			if hovered {
				a.clipActions(c, k, n, isLink, 4)
			}
			a.cardOverlays(c, k, n, checked, false)
			a.quickBadge(c, k, idx, 4)
			return
		}
		ui.Column(c).Grow(1).Margin(4, 0, 0, 0).Clip().Children(func() {
			switch {
			case a.editing == n.ID:
				ui.TextAreaBase(c, &a.editText).Fill().Font(fontSans).FontSize(12).FixedLineHeight(18).TextColor(k.fg).Focus().
					OnTextKey(func(key ui.TextKey) bool {
						switch {
						case key.Key == ui.KeyEnter && key.Mods == ui.Cmd:
							a.commitEdit()
							return true
						case key.Key == ui.KeyEscape:
							a.editing = ""
							return true
						}
						return false
					})
			case n.Blur: // 模糊卡不构建正文
			case n.Kind == "image":
				if img := a.thumb(n.ImageFile); img != nil {
					w, h := ui.ImageSize(img)
					ui.Image(c, img).Size(62*w/max(h, 1), 62).Radius(6)
				}
			case isLink:
				title := n.LinkTitle
				if title == "" {
					title = n.Text
				}
				ui.Column(c).Gap(2).Children(func() {
					ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
						a.linkFavicon(c, n, 16)
						text(c, title, 13, 16.25, 600, k.fg).SingleLine().Grow(1).Basis(0)
					})
					text(c, linkHost(n.Text), 11, 13.75, 400, k.muted).SingleLine()
				})
			case n.Kind == "code":
				a.codeText(c, k, n.Text)
			default:
				text(c, n.Text, 12, 18, 400, k.fg).Wrap().MaxLines(3)
			}
		})
		foot := ui.Row(c).Height(20).Padding(4, 0, 0, 0).Gap(4).AlignItems(ui.Center).
			BorderWidth(1, 0, 0, 0).BorderColor(k.fg.Alpha(0.1)).BorderStyle(ui.BorderDashed)
		foot.Children(func() {
			src := ""
			if n.SourceApp != "" {
				src = tr("来自 ") + n.SourceApp
			}
			text(c, src, 10, 14, 400, k.muted).SingleLine().Grow(1)
			right := itoa(len([]rune(n.Text))) + tr(" 字符")
			switch {
			case n.Kind == "image" && n.ImageW > 0:
				right = itoa(n.ImageW) + " × " + itoa(n.ImageH)
			case isLink:
				right = tr("链接")
			}
			text(c, right, 10, 14, 400, k.muted)
		})
		if n.Blur {
			blurOverlay(c, k, 20)
		}
		if hovered {
			a.clipActions(c, k, n, isLink, -1)
		}
		a.cardOverlays(c, k, n, checked, false)
		a.quickBadge(c, k, idx, 4)
	})
	if box.Clicked() {
		if box.ClickModifiers()&ui.Cmd != 0 {
			if a.chosen.Has(n.ID) {
				a.chosen.Remove(n.ID)
			} else {
				a.chosen.Add(n.ID)
			}
		} else {
			a.chosen.Clear()
		}
		if idx >= 0 {
			a.selected, a.focusList = idx, true
		}
	}
	if box.DoubleClicked() && idx >= 0 {
		a.openDetail(n)
	}
}

// clipActions 是悬停浮钮组：发送 / 置顶 / 复制 / 收进笔记 / 详情（链接为打开页面）/ 编辑 / 模糊 / 删除。
// top ≥ 0：距顶偏移（浓缩卡挂头行右端、紧凑行垂直居中，元数据悬停让位）；< 0：标准卡挂底栏右端。
func (a *app) clipActions(c *ui.Context, k tokens, n store.Note, isLink bool, top float32) {
	open := "expand"
	if isLink {
		open = "external-link"
	}
	fade := ui.ElementTransition{Duration: 100 * time.Millisecond, Ease: easeTw, Enter: &ui.Motion{}, Exit: &ui.Motion{}} // 悬停浮钮 opacity 100ms
	row := ui.Row(c).Absolute().Right(6).Bottom(4)
	if top >= 0 {
		row = ui.Row(c).Absolute().Right(4).Top(top)
	}
	row.Gap(2).Key("acts").Transition(fade).Children(func() {
		for _, act := range []struct{ icon, tip string }{
			{"send", "发送（⌘↵）"}, {"pin", "置顶"}, {"copy", "复制"}, {"inbox", "收进笔记"},
			{open, "打开"}, {"pencil", "编辑"}, {"eye-off", "模糊内容"}, {"trash-2", "删除"},
		} {
			if act.icon == "eye-off" && n.Blur {
				act.icon, act.tip = "eye", "取消模糊"
			}
			on := act.icon == "pin" && n.Kept
			b := ui.Box(c).Size(22, 22).Radius(8).Center().Border(1, k.floatBorder).
				Shadow(0, 1, 2, 0, k.floatShadowA).Shadow(0, 6, 16, -4, k.floatShadowB).InsetShadow(0, 1, 0, 0, k.floatInset).Tooltip(tr(act.tip))
			col := k.muted
			if on {
				b.Background(k.pressed)
				col = k.fg
			} else {
				b.Background(k.floatBtn)
			}
			b.Children(func() { licon(c, act.icon, 12, col) })
			if !b.Clicked() {
				continue
			}
			switch act.icon {
			case "send":
				a.send([]store.Note{n})
			case "pin":
				_ = a.store.SetKept(n.ID, !n.Kept)
			case "copy":
				mygo.Clipboard.WriteText(n.Text)
				a.showHUD("ok", tr("已复制"))
			case "inbox":
				_ = a.store.MoveTo(n.ID, store.SectionInbox)
				a.showHUD("ok", tr("已收进笔记"))
			case "expand":
				a.openDetail(n)
			case "external-link":
				if u, err := url.Parse(n.Text); err == nil && (u.Scheme == "http" || u.Scheme == "https") {
					_ = exec.Command("/usr/bin/open", u.String()).Start()
				}
			case "pencil":
				a.editing, a.editText = n.ID, n.Text
			case "eye-off", "eye":
				_ = a.store.SetBlur(n.ID, !n.Blur)
			case "trash-2":
				if r, pos, ok := a.store.Delete(n.ID); ok {
					a.showHUDUndo("ok", tr("已删除 · ")+preview(r.Text, 14), func() { _ = a.store.Restore(r, pos) })
				}
			}
			a.reload()
		}
	})
}

// clipRow 是紧凑密度的剪贴流水行（同 Tauri CompactRow 剪贴形态）：缩略图 + 首行（命名过的先标题、摘要淡色跟随，
// 代码等宽）+ 尾部置顶图钉或相对时间；尾部元数据悬停时让位给操作钮。
func (a *app) clipRow(c *ui.Context, k tokens, n store.Note, hovered, isLink bool) {
	if n.Kind == "image" {
		if img := a.thumb(n.ImageFile); img != nil {
			w, h := ui.ImageSize(img)
			ui.Image(c, img).Size(min(24*w/max(h, 1), 40), 24).Radius(4)
		}
	}
	line := firstLine(n.Text)
	switch {
	case n.Blur:
		line = ""
	case n.Kind == "image":
		line = tr("图片") + " " + itoa(n.ImageW) + " × " + itoa(n.ImageH)
	case isLink:
		a.linkFavicon(c, n, 16)
		if n.LinkTitle != "" {
			line = n.LinkTitle
		}
	}
	if title := strings.TrimSpace(n.Title); title != "" && !n.Blur {
		spans := []ui.Span{{Text: title, Weight: 500, Color: k.fg}}
		if line != "" {
			spans = append(spans, ui.Span{Text: " — " + line, Color: k.muted})
		}
		ui.RichText(c, spans...).FontSize(13).FixedLineHeight(18).SingleLine().Grow(1).Basis(0)
	} else {
		t := text(c, line, 13, 18, 400, k.fg).SingleLine().Grow(1).Basis(0)
		if n.Kind == "code" {
			t.Font(fontMono).FontSize(12)
		}
	}
	if hovered {
		return
	}
	if n.Kept {
		liconFilled(c, "pin", 12, amber400)
		return
	}
	text(c, ago(n.CreatedAt, a.now()), 10, 14, 400, k.muted)
}
