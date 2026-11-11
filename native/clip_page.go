package main

import (
	"fmt"
	"net/url"
	"os/exec"
	"slices"
	"strings"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/core"

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
	slices.SortStableFunc(notes, func(x, y store.Note) int { // 剪贴历史按时间新→旧（同 Tauri insertNoteByTimeWithin）
		return y.CreatedAt.Compare(x.CreatedAt)
	})
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
	defer a.clipPickPopover(c, k)
	list := a.clipList
	_, vh := c.Size()
	vis := visWindow{top: a.clipScroll.Y - 600, bottom: a.clipScroll.Y + vh + 600}
	// 视图切换：外层不再整块重挂（之前连带切换器一起重建，滑块的共享布局动画断掉、新旧两层叠影）；
	// 切换器原地保留滑块动画，分段标签与卡片列按切换方向淡入 + 横移（clipSwapIn）
	ui.Column(c).Grow(1).Children(func() {
		ui.Scroll(c).Grow(1).Scrollbars(false).TrackScroll(&a.clipScroll).Children(func() {
			ui.Column(c).Padding(4, 14, 8, 14).Children(func() {
				if len(list) == 0 {
					if !a.store.Settings().ClipboardWatch && a.query == "" {
						a.clipOffState(c, k)
						return
					}
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
					a.clipHeader(c, k, band, i == 0, list[i:j]...)
					y += 28
					if a.clipView == "source" && a.clipSrcCollapsed[band] { // 同 Tauri clipSourceCollapsed：折叠的来源组只留组头
						i = j
						continue
					}
					if a.clipView == "image" {
						y += a.clipGrid(c, k, list[i:j], band, y, vis)
						i = j
						continue
					}
					ui.Column(c).Gap(gap).Key("band-" + a.clipView + "-" + band).Transition(a.clipSwapIn(c)).Children(func() {
						skip := float32(0)
						flush := func() {
							if skip > 0 {
								ui.Box(c).Height(skip - gap).Key("gap-" + itoa(int(y)))
								skip = 0
							}
						}
						for _, n := range list[i:j] {
							lay := layout
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
	})
}

// clipHeader 是分段头：10/14 标签 + 1px 细线；第一段右侧挂视图切换（按时间 / 按来源 / 图片）。
func (a *app) clipHeader(c *ui.Context, k tokens, label string, first bool, band ...store.Note) {
	top := float32(10)
	if first {
		top = 2
	}
	row := ui.Row(c).Height(28).Padding(top, 0, 4, 0).Gap(8).AlignItems(ui.Center)
	if first { // 首段头挂着视图切换器：固定 key 原地保留，滑块共享布局动画才连得上
		row.Key("clip-hd-first")
	} else {
		row.Key("clip-hd-" + a.clipView + "-" + label).Transition(a.clipSwapIn(c))
	}
	source := a.clipView == "source" && len(band) > 0 && !band[0].Kept
	if source {
		a.clipSourceMenu(row, label, band)
	}
	byApp := a.clipView == "source" && len(band) > 0
	row.Children(func() {
		hd := ui.Row(c).Gap(8).AlignItems(ui.Center).Key("srchd-" + a.clipView + "-" + label).Shrink(1).Transition(a.clipSwapIn(c))
		if byApp {
			hd.Role(ui.RoleButton).Label(label)
			if hd.Clicked() {
				if a.clipSrcCollapsed == nil {
					a.clipSrcCollapsed = map[string]bool{}
				}
				a.clipSrcCollapsed[label] = !a.clipSrcCollapsed[label]
			}
		}
		hd.Children(func() {
			if byApp { // 同 Tauri 来源组头：箭头 · 应用图标（固定组为星标）· 名称 · 条数
				chev := "chevron-right"
				if !a.clipSrcCollapsed[label] {
					chev = "chevron-down"
				}
				licon(c, chev, 12, k.muted).Margin(0, -4, 0, 0)
				if band[0].Kept {
					licon(c, "star", 12, k.muted).Margin(0, -4, 0, 0)
				} else if img := a.appIcon(band[0].BundleID); img != nil {
					ui.Image(c, img).Size(14, 14).Margin(0, -4, 0, 0)
				}
			}
			if label != "" {
				text(c, label, 10, 14, 500, k.muted)
			}
			if byApp {
				text(c, itoa(len(band)), 10, 14, 400, k.muted).Margin(0, 0, 0, -4)
			}
		})
		if source {
			if d, ok := a.store.Settings().ClipAppRetention[store.ClipSourceKey(band[0])]; ok {
				text(c, fmt.Sprintf(tr("· 保留 %s"), formatRetention(d)), 10, 14, 400, k.muted).SingleLine()
			}
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
					from := slices.IndexFunc(clipViews, func(x struct{ id, label string }) bool { return x.id == a.clipView })
					to := slices.IndexFunc(clipViews, func(x struct{ id, label string }) bool { return x.id == v.id })
					a.clipSwapAt, a.clipSwapDX = c.Now(), 10*sign(to-from)
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
	a.bandHover(n.ID, hovered)
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
			a.clipRow(c, k, n, hovered, isLink, a.compactHover(c, box, n))
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
			text(c, ago(n.CreatedAt, a.now()), 11, 16, 600, k.muted).Shrink(0)
			// 同 Tauri 票据头：有标题显示标题，否则非纯文本显示类型徽标（图片 / 图文 ×N / 代码语言 / 链接）；点击就地重命名
			ui.Row(c).Grow(1).Basis(0).AlignItems(ui.Center).Clip().Children(func() {
				if a.cardInlineInputOn(c, k, n, k.fg) {
					return
				}
				title, typ := strings.TrimSpace(n.Title), cardTitle(n)
				if title == "" && typ == tr("文本") {
					return
				}
				b := ui.Row(c).Height(14).Radius(3).AlignItems(ui.Center).Key("clip-title-" + n.ID).Role(ui.RoleButton).Label(cmpOr(title, typ)).Tooltip(tr("点击重命名"))
				if title != "" {
					b.Children(func() { text(c, title, 11, 16, 500, k.fg).SingleLine() })
				} else {
					b.Padding(0, 6).Background(k.track).InsetShadow(0, 1, 2, 0, k.insetShadow).Children(func() { text(c, typ, 10, 10, 500, k.muted).SingleLine() })
				}
				if b.Clicked() {
					a.titleEditID, a.titleText = n.ID, n.Title
				}
			})
			if n.Kept { // 同 Tauri：标准票据悬停时图钉常显，只有浓缩模板淡出让位（opacity 150ms）
				pinOp := float32(1)
				if hovered && condensed {
					pinOp = 0
				}
				pin := ui.Box(c).Size(12, 12)
				pin.Opacity(pin.AnimateTo("op", pinOp, tweenTw)).Children(func() { liconFilled(c, "pin", 12, amber400) })
			}
			if img := a.appIcon(n.BundleID); img != nil { // 来源应用图标（同 Tauri 票据头右端）；浓缩模板悬停让位给操作钮
				op := float32(1)
				if hovered && condensed {
					op = 0
				}
				ic := ui.Box(c).Size(16, 16)
				ic.Opacity(ic.AnimateTo("icon-op", op, tweenTw)).Children(func() { ui.Image(c, img).Size(16, 16) })
			}
		})
		if condensed {
			ui.Row(c).Grow(1).Gap(6).AlignItems(ui.Center).Clip().Children(func() {
				if n.Blur {
					return
				}
				line := firstLine(n.Text)
				switch {
				case n.Kind == "image": // 同 Tauri 浓缩模板：缩略 + 张数 / 尺寸
					if img := a.thumb(n.ImageFile); img != nil {
						w, h := ui.ImageSize(img)
						ui.Image(c, img).Size(min(24*w/max(h, 1), 48), 24).Radius(4)
					}
					line = cardImageMeta(n)
					if files := n.MediaFiles(); len(files) > 1 {
						line = cardTitle(n)
					}
				case len(n.MediaFiles()) > 0: // 图文：首图缩略 + 首行
					if img := a.thumb(n.MediaFiles()[0]); img != nil {
						w, h := ui.ImageSize(img)
						ui.Image(c, img).Size(min(24*w/max(h, 1), 48), 24).Radius(4)
					}
				case isLink:
					a.linkFavicon(c, n, 16)
					if n.LinkTitle != "" {
						line = n.LinkTitle
					}
				}
				t := doneText(highlightText(c, k, line, a.query, 13, 18, k.fg).SingleLine().Grow(1), k, n) // 同 Tauri：浓缩摘要也高亮命中
				if isCode(n) {
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
			case n.Blur: // 模糊卡不构建正文
			case n.Kind == "image": // 同 Tauri：多张并排 3 张 +N，真实备注一行
				files, h := n.MediaFiles(), float32(62)
				if s := strings.TrimSpace(imageNoteText(n)); s != "" && !store.IsImagePlaceholder(s) {
					h -= 20
				}
				a.cardImages(c, k, files, 0, h)
				cardImageCaption(c, k, n)
			case len(n.MediaFiles()) > 0: // 图文组合卡：正文 + 下方缩略条
				doneText(highlightText(c, k, n.Text, a.query, 12, 18, k.fg).Wrap().MaxLines(1), k, n) // 留出缩略条后只放整行
				a.cardThumbStrip(c, k, n.MediaFiles())
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
			case isCode(n):
				a.codeText(c, k, n, 3)
			default:
				doneText(highlightText(c, k, n.Text, a.query, 12, 18, k.fg).Wrap().MaxLines(3), k, n)
			}
		})
		foot := ui.Row(c).Height(20).Padding(4, 0, 0, 0).Gap(4).AlignItems(ui.Center).
			BorderWidth(1, 0, 0, 0).BorderColor(k.fg.Alpha(0.1)).BorderStyle(ui.BorderDashed)
		foot.Children(func() {
			a.cardFooterLead(c, k, n)
			if right := clipFootMeta(n); right != "" {
				text(c, right, 10, 14, 400, k.muted).SingleLine().Shrink(0).MaxWidth(150)
			}
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
	clk, dbl, mods := cardPressed(box, n.ID) // 正文是拖出源，点在正文上也算点卡片
	if clk && !(mods&ui.Shift != 0 && a.rangeSelect(n.ID)) {
		a.cardClick(n.ID, idx, mods)
	}
	if dbl && idx >= 0 {
		a.cardDoubleClick(n, idx, true)
	}
}

// clipActions 是悬停浮钮组：发送 / 置顶 / 复制 / 收进笔记 / 详情（链接为打开页面）/ 编辑 / 模糊 / 删除。
// top ≥ 0：距顶偏移（浓缩卡挂头行右端、紧凑行垂直居中，元数据悬停让位）；< 0：标准卡挂底栏右端。
func (a *app) clipActions(c *ui.Context, k tokens, n store.Note, isLink bool, top float32, grid ...bool) {
	open := "expand"
	if isLink {
		open = "external-link"
	}
	fade := ui.ElementTransition{Duration: 100 * time.Millisecond, Ease: easeTw, Enter: &ui.Motion{}, Exit: &ui.Motion{}} // 悬停浮钮 opacity 100ms
	row := ui.Row(c).Absolute().Right(6).Bottom(4 + a.bandLift(n.ID, false))
	if top >= 0 {
		row = ui.Row(c).Absolute().Right(4).Top(top)
	}
	row.Gap(2).Key("acts").Transition(fade).Children(func() {
		alias := core.AliasOccurrences(n.Text, a.store.Settings().AliasEntities) > 0
		openTip := "预览（Space）"
		if isLink {
			openTip = "打开页面（Space）"
		}
		// 同 Tauri 顺序与提示：发送 · 置顶 · 复制 · 移入笔记 · [恢复化名] · 预览 · 编辑 · 模糊 · 删除
		for _, act := range []struct{ icon, tip string }{
			{"send", "发送 / 添加（双击卡片同效）"}, {"pin", "置顶（固定不清理）"}, {"copy", "复制原文（不脱敏）"}, {"inbox", "移入笔记（长按选择分类）"},
			{"venetian-mask", "恢复化名"}, {open, openTip}, {"pencil", "编辑"}, {"eye-off", "模糊内容"}, {"trash-2", "删除"},
		} {
			if act.icon == "venetian-mask" && !alias {
				continue
			}
			if act.icon == "pin" && n.Kept {
				act.tip = "取消置顶"
			}
			if len(grid) > 0 && grid[0] && !slices.Contains([]string{"send", "copy", open, "trash-2"}, act.icon) {
				continue // 图片网格瓷砖只留 4 个（同 Tauri NoteCard grid：发送 / 复制 / 预览 / 删除）
			}
			if act.icon == "pencil" && n.Kind == "image" { // 同 Tauri：图片卡是文字备注
				act.tip = "添加文字备注"
				if imageNoteText(n) != "" {
					act.tip = "编辑文字备注"
				}
			}
			if act.icon == "eye-off" && n.Blur {
				act.icon, act.tip = "eye", "取消模糊"
			}
			glyph := act.icon
			if act.icon == "send" && a.insertsIntoOpenCard(a.clipMoveTargets(n)) { // 目的地如实：详情窗开着时进那张卡，不外发
				glyph, act.tip = "text-cursor-input", "添加到打开的卡片光标处（双击卡片同效）"
			}
			b := floatIconButton(c, k, "ca-"+act.icon, glyph, tr(act.tip), act.icon == "trash-2", act.icon == "pin" && n.Kept)
			if act.icon == "inbox" {
				a.clipInboxButton(b, n)
				continue
			}
			if !b.Clicked() {
				continue
			}
			switch act.icon {
			case "venetian-mask":
				a.restoreCardAliases(n)
			case "send":
				a.sendFromList(a.clipMoveTargets(n)) // 同 Tauri sendSelfOrChecked：当前卡在多选里就发整组
			case "pin":
				_ = a.store.SetKept(n.ID, !n.Kept)
			case "copy":
				if a.copyNoteMedia(n) {
					break
				}
				mygo.Clipboard.WriteText(n.Text)
				a.showHUD("ok", tr("已复制"))
			case "expand":
				a.openDetail(n)
			case "external-link":
				if u, err := url.Parse(n.Text); err == nil && (u.Scheme == "http" || u.Scheme == "https") {
					_ = exec.Command("/usr/bin/open", u.String()).Start()
				}
			case "pencil":
				a.editInDetail(n)
			case "eye-off", "eye":
				_ = a.store.SetBlur(n.ID, !n.Blur)
			case "trash-2":
				a.deleteSelfOrChosen(n)
			}
			a.reload()
		}
	})
}

// clipRow 是紧凑密度的剪贴流水行（同 Tauri CompactRow 剪贴形态）：缩略图 + 首行（命名过的先标题、摘要淡色跟随，
// 代码等宽）+ 尾部置顶图钉或相对时间；尾部元数据悬停时让位给操作钮。
func (a *app) clipRow(c *ui.Context, k tokens, n store.Note, hovered, isLink, active bool) {
	if !(isLink && a.favicon(n.LinkIcon) != nil) {
		a.sourceIcon(c, n, 20)
	}
	if files := n.MediaFiles(); len(files) > 0 && !n.Blur { // 带图行（图片 / 图文）首图缩略
		if img := a.thumb(files[0]); img != nil {
			w, h := ui.ImageSize(img)
			ui.Image(c, img).Size(min(24*w/max(h, 1), 40), 24).Radius(4)
		}
	}
	line := firstLine(n.Text)
	switch {
	case n.Blur:
		line = ""
	case n.Kind == "image": // 同 Tauri imageListLabel：真实备注优先，否则「图片 ×N」/「图片」
		line = cardTitle(n)
		if s := strings.TrimSpace(imageNoteText(n)); s != "" && !store.IsImagePlaceholder(s) {
			line = s
		}
	case isLink:
		a.linkFavicon(c, n, 16)
		if n.LinkTitle != "" {
			line = n.LinkTitle
		}
	}
	a.marqueeLine(c, n.ID, active, func() ui.Element { // 悬停行文字溢出时跑马灯；正文可拖出（同 Tauri CompactRow）
		if title := strings.TrimSpace(n.Title); title != "" && !n.Blur {
			spans := []ui.Span{{Text: title, Weight: 500, Color: k.fg}}
			if line != "" {
				spans = append(spans, ui.Span{Text: " — " + line, Color: k.muted})
			}
			return doneText(ui.RichText(c, spans...).Font(fontSans).FontSize(11).FixedLineHeight(16), k, n)
		}
		// 紧凑行主文字比 Tauri（12/17）小一号：正文 11/16、代码 10.5/15（用户 2026-11-10 指定，仅主文字行，元数据不变）
		if isCode(n) {
			return doneText(highlightText(c, k, line, a.query, 10.5, 15, k.fg).Font(fontMono), k, n)
		}
		return doneText(highlightText(c, k, line, a.query, 11, 16, k.fg), k, n)
	})
	if hovered {
		return
	}
	if n.Provenance != nil { // 同 Tauri CompactRow：回复卡标链接图标
		licon(c, "link-2", 12, stok(c).primary).Shrink(0)
	}
	if files := n.MediaFiles(); n.Kind != "image" && len(files) > 0 {
		text(c, fmt.Sprintf(tr("%d图"), len(files)), 10, 14, 400, k.muted).Shrink(0)
	}
	if n.Kept {
		liconFilled(c, "pin", 12, amber400)
		return
	}
	text(c, ago(n.CreatedAt, a.now()), 10, 14, 400, k.muted)
}

// clipOffState：剪贴板历史未开启时的空状态（同 Tauri ClipHistoryOff）——说明 + 一键开启 / 调整规则。
func (a *app) clipOffState(c *ui.Context, k tokens) {
	st := a.store.Settings()
	lines := []string{tr("只存在本机，加密保存，不上传")}
	switch {
	case !st.ClipKeepConcealed:
		lines = append(lines, tr("自动忽略密码管理器和标记为隐藏的内容"))
	}
	if st.ClipRetainDays > 0 {
		lines = append(lines, fmt.Sprintf(tr("超过 %d 天自动清理，固定 ★ 的保留"), st.ClipRetainDays))
	}
	ui.Column(c).Padding(48, 24, 40, 24).Gap(8).AlignItems(ui.Center).Children(func() {
		licon(c, "clipboard-list", 24, k.muted.Alpha(0.5))
		text(c, tr("剪贴板历史未开启"), 13, 18, 500, k.muted)
		text(c, tr("开启后，复制过的文字、链接和图片会自动收集到这里"), 11, 16.5, 400, k.muted).TextAlign(ui.Center).Wrap()
		ui.Column(c).Margin(8, 0, 8, 0).Gap(6).Children(func() {
			for _, l := range lines {
				ui.Row(c).Gap(6).AlignItems(ui.Start).Children(func() {
					ui.Box(c).Size(4, 4).Radius(2).Margin(6, 0, 0, 0).Background(k.muted)
					text(c, l, 11, 16, 400, k.muted).Wrap()
				})
			}
		})
		ui.Row(c).Gap(8).Children(func() {
			s := stok(c)
			if button(c, s, "开启剪贴板历史") {
				cur := a.store.Settings()
				cur.ClipboardWatch = true
				_ = a.store.SetSettings(cur)
				a.setClip = true
			}
			if button(c, s, "调整规则") {
				a.openSettingsAt(2, 0) // 设置 → 剪贴板
			}
		})
	})
}

// clipGrid：「图片」视图的方格墙（同 Tauri App.tsx images 视图 grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-1.5）：
// 列数随面板宽度（常见 2～4 列），正方形瓷砖；视口外的行用等高占位。返回这段的高度。
func (a *app) clipGrid(c *ui.Context, k tokens, notes []store.Note, band string, top float32, vis visWindow) float32 {
	const gap, minW = float32(6), float32(104)
	w, _ := c.Size()
	inner := w - 28
	allCols := max(1, int((inner+gap)/(minW+gap))) // auto-fill：列宽按容器算，张数少也不拉宽
	tile := (inner - gap*float32(allCols-1)) / float32(allCols)
	rows := (len(notes) + allCols - 1) / allCols
	ui.Column(c).Gap(gap).Key("grid-" + band).Transition(a.clipSwapIn(c)).Children(func() {
		for r := 0; r < rows; r++ {
			y := top + float32(r)*(tile+gap)
			row := notes[r*allCols : min(len(notes), (r+1)*allCols)]
			visible := y+tile >= vis.top && y <= vis.bottom
			if !visible && !slices.ContainsFunc(row, func(n store.Note) bool { return a.chosen.Has(n.ID) }) {
				ui.Box(c).Height(tile).Key("grow-" + itoa(r))
				continue
			}
			ui.Row(c).Gap(gap).Key("grow-" + itoa(r)).Children(func() {
				for _, n := range row {
					a.clipTile(c, k, n, tile)
				}
			})
		}
	})
	return float32(rows)*(tile+gap) - gap
}

// clipTile：图片网格瓷砖（同 Tauri NoteCard strip grid）——无通栏、正方形、p-1.5，图片区居中等比；
// 底行来源图标 + 尺寸，悬停淡出让位给 4 个操作钮。
func (a *app) clipTile(c *ui.Context, k tokens, n store.Note, size float32) {
	idx, ok := a.noteIdx[n.ID]
	if !ok || a.page != pageClip {
		idx = -1
	}
	checked := a.chosen.Has(n.ID)
	focused := idx >= 0 && idx == a.selected && a.focusList
	box := ui.Column(c).Size(size, size).Padding(6).Gap(4).Radius(10).Background(k.card).Key(n.ID)
	hovered := box.Hovered()
	a.bandHover(n.ID, hovered)
	elevated(box, k, hovered || checked || (focused && !checked))
	lift := float32(0)
	if hovered {
		lift = -1
	}
	box.AnimatePose(ui.Pose{Y: lift}, tweenTw)
	box.ContextMenu(func(m *ui.Menu) {
		if idx >= 0 {
			a.selected = idx
		}
		a.cardMenu(c, m, max(idx, 0), n)
	})
	box.Children(func() {
		if files := n.MediaFiles(); len(files) > 1 { // 同 Tauri 网格瓷砖：多图并排 3 张 +N
			a.cardImages(c, k, files, size-12, size-12-20)
		} else {
			ui.Box(c).Grow(1).Basis(0).FillWidth().Radius(4).Background(k.fg.Alpha(0.04)).Center().Clip().Children(func() {
				if img := a.thumb(n.ImageFile); img != nil {
					iw, ih := ui.ImageSize(img)
					aw, ah := size-12, size-12-20
					sc := min(aw/max(iw, 1), ah/max(ih, 1))
					ui.Image(c, img).Size(iw*sc, ih*sc)
				} else {
					text(c, tr("加载中…"), 10, 14, 400, k.muted)
				}
			})
		}
		meta := ui.Row(c).Height(16).Gap(4).AlignItems(ui.Center)
		meta.Opacity(meta.AnimateTo("meta", map[bool]float32{true: 0, false: 1}[hovered], tweenTw)).Children(func() {
			a.sourceIcon(c, n, 14)
			ui.Spacer(c)
			if n.ImageW > 0 {
				text(c, fmt.Sprintf("%d × %d", n.ImageW, n.ImageH), 10, 14, 400, k.muted).FontFeatures("tnum")
			}
		})
		if n.Blur {
			blurOverlay(c, k, 20)
		}
		if hovered {
			a.clipActions(c, k, n, false, -1, true)
		}
		a.cardOverlays(c, k, n, checked, false)
		a.quickBadge(c, k, idx, 4)
	})
	clk, dbl, mods := cardPressed(box, n.ID) // 正文是拖出源，点在正文上也算点卡片
	if clk && !(mods&ui.Shift != 0 && a.rangeSelect(n.ID)) {
		a.cardClick(n.ID, idx, mods)
	}
	if dbl && idx >= 0 {
		a.cardDoubleClick(n, idx, true)
	}
}

// clipSwapIn：剪贴视图切换后 400ms 内新挂载的分段头 / 卡片列按切换方向（往右切从右侧进）横移 10pt 淡入，
// 180ms ease-standard；不做退场（旧内容直接让位，避免两层叠影）；平时新出现的分段（如新的一天）不带动效。
func (a *app) clipSwapIn(c *ui.Context) ui.ElementTransition {
	if a.clipSwapAt.IsZero() || c.Now().Sub(a.clipSwapAt) > 400*time.Millisecond {
		return ui.ElementTransition{}
	}
	dx := a.clipSwapDX
	if c.Preferences().ReduceMotion {
		dx = 0
	}
	return ui.ElementTransition{Duration: 180 * time.Millisecond, Ease: easeStandard, Colors: true, Enter: &ui.Motion{X: dx}}
}
