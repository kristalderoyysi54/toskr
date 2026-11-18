package main

import (
	"fmt"
	"slices"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// 内容页的「常用」栏、收件箱头部操作（按建议归好 / 逐条整理）、收件箱卡片上的建议分组、逐条整理浮层。

const (
	quickMax    = 12
	quickCardW  = 64 // 常用：方块（用户 2026-11-17：84 → 64，再小些）
	quickCardH  = 64
	quickHeadH  = 18
	quickStripH = quickHeadH + 6 + quickCardH + 6 + 4 // 标题行 + 间距 + 卡片 + 间距 + 位置点
)

// quickStripHeight：常用栏实占高度（折叠时只剩标题行）。
func (a *app) quickStripHeight() float32 {
	if a.store.Settings().QuickCollapsed {
		return quickHeadH
	}
	return quickStripH
}

// quickNotes：常用栏内容（用户 2026-11-17 定）——设为常用（★）的在前按发送次数排，其余按发送次数补满；收件箱、剪贴板、已完成不进。
func quickNotes(all []store.Note) []store.Note {
	var out []store.Note
	for _, n := range all {
		if store.IsSystemSection(n.Section) || n.Done || (!n.Kept && n.SendCount == 0) {
			continue
		}
		out = append(out, n)
	}
	slices.SortStableFunc(out, func(x, y store.Note) int {
		if x.Kept != y.Kept {
			if x.Kept {
				return -1
			}
			return 1
		}
		return y.SendCount - x.SendCount
	})
	return out[:min(len(out), quickMax)]
}

func (a *app) quickStripShown() bool {
	return len(a.quick) > 0 && a.noteFilter == "" && a.query == ""
}

// quickStrip：一排常用卡，点一下发送。纵向滚轮在这里转成横向翻页；滚到头也不交给外层列表（用户 2026-11-17：
// 接着滚整页容易误操作），要滚列表把指针移出这一排即可。不显示滚动条。
func (a *app) quickStrip(c *ui.Context, k tokens) {
	collapsed := a.store.Settings().QuickCollapsed
	ui.Column(c).Height(a.quickStripHeight()).Gap(6).FillWidth().Key("quick-strip").Children(func() {
		// 标题行 = 折叠开关（与分组头同一枚折叠箭头），状态存设置
		head := ui.Row(c).Height(quickHeadH).Gap(4).Padding(0, 4, 0, 2).Radius(rr(6)).AlignItems(ui.Center).Key("quick-head").
			Role(ui.RoleButton).Label(map[bool]string{true: tr("展开常用"), false: tr("折叠常用")}[collapsed])
		if head.Hovered() {
			head.Background(k.fg.Alpha(0.04))
		}
		head.Children(func() {
			ui.Box(c).Size(16, 16).Center().Children(func() { foldChevron(c, k, collapsed) })
			liconFilled(c, "star", 10, k.amberText)
			text(c, tr("常用"), 11, 16, 600, k.muted).LetterSpacing(0.88)
			ui.Box(c).Grow(1)
			text(c, itoa(len(a.quick)), 10.5, 14, 500, k.muted).Font(fontMono).TextAlign(ui.End).MinWidth(18).Shrink(0) // 与分组头条数同一列
		})
		if head.Clicked() {
			cur := a.store.Settings()
			cur.QuickCollapsed = !collapsed
			_ = a.store.SetSettings(cur)
		}
		if collapsed {
			return
		}
		wrap := ui.Box(c).Height(quickCardH).FillWidth().Key("quick-wrap").Transition(foldTransition)
		viewW := wrap.Bounds().W // 上一帧量到的可视宽（位置点按它分页）
		wrap.Children(func() { a.quickScroller(c, k) })
		a.quickDots(c, k, viewW)
	})
}

// quickScroller：横向滚动的卡片排 + 两端渐隐（只在那一侧还有内容时画）。
func (a *app) quickScroller(c *ui.Context, k tokens) {
	sc := ui.ScrollHorizontal(c).Fill().Scrollbars(false).TrackScroll(&a.quickScroll).Key("quick-scroll")
	sc.HandleInput(func(ev ui.InputEvent) bool {
		if ev.Kind != ui.InputScroll || abs32(ev.DY) <= abs32(ev.DX) || a.quickScroll.MaxX <= 0 {
			return false // 触控板横向手势按原生行为走；放得下没得翻时照常滚列表
		}
		a.quickScroll.X = min(max(a.quickScroll.X+ev.DY, 0), a.quickScroll.MaxX) // 到头停住，不交给外层
		return true
	})
	sc.Children(func() {
		ui.Row(c).Gap(6).Padding(0, 1).Children(func() {
			for _, n := range a.quick {
				a.quickCard(c, k, n)
			}
		})
	})
	fade := func(left bool, show bool) {
		b := ui.Box(c).Absolute().Top(0).Size(28, quickCardH).PassThrough().Key(map[bool]string{true: "quick-fade-l", false: "quick-fade-r"}[left])
		if left {
			b.Left(0).Gradient(k.window, k.window.Alpha(0), 90)
		} else {
			b.Right(0).Gradient(k.window.Alpha(0), k.window, 90)
		}
		b.Opacity(b.AnimateTo("op", map[bool]float32{true: 1}[show], tweenTw))
	}
	fade(true, a.quickScroll.X > 1)
	fade(false, a.quickScroll.X < a.quickScroll.MaxX-1)
}

// quickDots：位置点（一页一个，当前页拉长）；只有一页时留空不画。
func (a *app) quickDots(c *ui.Context, k tokens, viewW float32) {
	ui.Row(c).Height(4).Gap(4).Justify(ui.Center).FillWidth().Key("quick-dots").Children(func() {
		if viewW <= 0 || a.quickScroll.MaxX <= 0 {
			return
		}
		pages := int((a.quickScroll.MaxX+viewW)/viewW + 0.99)
		cur := int(a.quickScroll.X/viewW + 0.5)
		if a.quickScroll.X >= a.quickScroll.MaxX-1 {
			cur = pages - 1
		}
		for i := range pages {
			d := ui.Box(c).Height(4).Radius(2).Key("qd-" + itoa(i))
			w, col := float32(4), k.fg.Alpha(0.15)
			if i == cur {
				w, col = 14, k.fg.Alpha(0.4)
			}
			d.Width(d.AnimateTo("w", w, tweenControl)).Background(d.AnimateColor("c", col, tweenControl))
		}
	})
}

// quickCard：常用方块。有图：图片铺满，底部渐暗压标题，停留 360ms 弹原图窥视窗（← → 换张）；
// 无图：标题最多 3 行 + 发送次数。点一下发送；右键更多。
func (a *app) quickCard(c *ui.Context, k tokens, n store.Note) {
	title := cmpOr(n.Title, cmpOr(firstLine(n.Text), cardTitle(n)))
	files := n.MediaFiles()
	var img ui.ImageSource
	if len(files) > 0 && !n.Blur {
		img = a.thumb(files[0])
	}
	b := tipOf(c, ui.Box(c).Size(quickCardW, quickCardH).Radius(rr(10)).Clip().Key("quick-"+n.ID).Role(ui.RoleButton).Label(tr("发送：")+title),
		fmt.Sprintf(tr("%s · 已发送 %d 次 · 点一下发送；右键更多"), preview(title, 24), n.SendCount))
	hovered := b.Hovered()
	if hovered {
		b.Background(k.card)
	} else {
		b.Background(k.track)
	}
	elevated(b, k, hovered)
	b.AnimatePose(ui.Pose{Y: map[bool]float32{true: -2}[hovered], Scale: pressScale(b.Pressed(), 0.96)}, springControl)
	b.ContextMenu(func(m *ui.Menu) {
		if m.Item(tr("在列表中查看")).Chosen() {
			a.focusNote(n)
		}
		label := tr("设为常用")
		if n.Kept {
			label = tr("取消常用")
		}
		if m.Item(label).Chosen() {
			_ = a.store.SetKept(n.ID, !n.Kept)
			a.reload()
		}
	})
	white := ui.RGB(255, 255, 255)
	b.Children(func() {
		if img != nil {
			iw, ih := ui.ImageSize(img)
			sc := quickCardW / max(min(float32(iw), float32(ih)), 1)
			ui.Box(c).Fill().Center().Children(func() {
				im := ui.Image(c, img).Size(float32(iw)*sc, float32(ih)*sc)
				im.AnimatePose(ui.Pose{Scale: map[bool]float32{true: 1.08, false: 1}[hovered]}, springControl) // 悬停：图慢慢推近
			})
			ui.Box(c).Absolute().Left(0).Right(0).Bottom(0).Height(36).Gradient(ui.RGBA(0, 0, 0, 0), ui.RGBA(0, 0, 0, 0.62), 180).PassThrough()
			ui.Column(c).Absolute().Left(6).Right(6).Bottom(5).Gap(0).PassThrough().Children(func() {
				text(c, title, 10, 13, 600, white).SingleLine()
				text(c, fmt.Sprintf(tr("%d 次"), n.SendCount), 9, 12, 500, white.Alpha(0.8)).Font(fontMono)
			})
			if len(files) > 1 {
				ui.Box(c).Absolute().Right(5).Top(5).Height(15).Padding(0, 5).Radius(8).Background(ui.RGBA(0, 0, 0, 0.5)).Center().PassThrough().
					Children(func() { text(c, itoa(len(files)), 9, 12, 600, white) })
			}
		} else {
			ui.Column(c).Fill().Padding(6, 7).Gap(0).Children(func() {
				text(c, title, 10.5, 14, 500, k.fg).Wrap().MaxLines(2)
				ui.Box(c).Grow(1)
				text(c, fmt.Sprintf(tr("%d 次"), n.SendCount), 9, 12, 400, k.muted).Font(fontMono)
			})
		}
		// 右上：常用星标；悬停换成发送图标
		ic := ui.Box(c).Absolute().Right(5).Bottom(5).Size(12, 12).Center().PassThrough()
		if img != nil {
			ic.Top(5).Left(5)
		}
		ic.Children(func() {
			col := k.amberText
			if img != nil {
				col = white
			}
			switch {
			case hovered:
				licon(c, "send", 11, map[bool]ui.Color{true: white, false: stok(c).primary}[img != nil])
			case n.Kept:
				liconFilled(c, "star", 10, col)
			}
		})
	})
	if img != nil {
		a.compactHover(c, b, n) // 停留弹原图（文字截图看得清）
	}
	if b.Clicked() {
		a.sendFromList([]store.Note{n})
	}
}

// inboxHeadActions：收件箱分组头右侧的「按建议归好 N 条」（主题色浅底）与「逐条整理」（灰底）。
func (a *app) inboxHeadActions(c *ui.Context, k tokens, g noteGroup) {
	p := stok(c).primary
	chip := func(key, icon, label, tip string, primary bool) bool {
		b := tipOf(c, ui.Row(c).Height(18).Gap(3).Padding(0, 7).Radius(999).AlignItems(ui.Center).Shrink(0).Key(key).Role(ui.RoleButton).Label(label), tip)
		bg, fg := k.track, k.fg
		if primary {
			bg, fg = p.Alpha(0.12), p
		}
		if b.Hovered() {
			bg, fg = p.Alpha(0.18), p
		}
		b.Background(bg).Children(func() {
			licon(c, icon, 10, fg)
			text(c, label, 10, 14, 500, fg).SingleLine()
		})
		return b.Clicked()
	}
	if n := len(a.inboxSug); n >= 2 && chip("inbox-fileall", "check", fmt.Sprintf(tr("按建议归好 %d 条"), n), tr("把有建议分组的都归过去（可撤销）"), true) {
		a.fileAllSuggested()
	}
	if len(g.open) >= 2 && len(a.fileTargets()) > 0 && chip("inbox-triage", "layers", tr("逐条整理"), tr("一条一条看，按数字键归类"), false) {
		a.triageOn, a.triageSkip = true, map[string]bool{}
	}
}

// inboxSugChip：收件箱卡片通栏上的建议分组——普通建议是主题色虚线描边，按规则得出的是实线浅底。点一下归过去。
func (a *app) inboxSugChip(c *ui.Context, k tokens, n store.Note) {
	sug, ok := a.inboxSug[n.ID]
	if !ok || n.Section != store.SectionInbox {
		return
	}
	p := stok(c).primary
	name := a.sectionLabel(sug.section)
	b := tipOf(c, ui.Row(c).Height(18).Gap(3).Padding(0, 7).Radius(999).AlignItems(ui.Center).Shrink(0).Background(k.card).
		Key("sug-"+n.ID).Role(ui.RoleButton).Label(tr("归到 ")+name), tr("建议：")+sug.why)
	switch {
	case sug.rule:
		b.Background(p.Mix(k.card, 0.88)).Border(1, p)
	case b.Hovered():
		b.Background(p.Mix(k.card, 0.88)).Border(1, p)
	default:
		b.Border(1, p).BorderStyle(ui.BorderDashed)
	}
	b.Children(func() {
		licon(c, "arrow-right", 10, p)
		text(c, name, 10, 14, 500, p).SingleLine()
	})
	if b.Clicked() {
		to := sug.section
		a.fileInbox([]string{n.ID}, func(store.Note) string { return to }, false)
	}
}

// triageQueue：逐条整理还没处理的条目（跳过的排到最后不再出现）。
func (a *app) triageQueue() []store.Note {
	var out []store.Note
	for _, n := range a.store.Section(store.SectionInbox) {
		if !n.Done && !a.triageSkip[n.ID] {
			out = append(out, n)
		}
	}
	return out
}

// triagePanel：逐条整理浮层——一次一条，数字键 1–9 归到对应分组（与「收到哪里」同一套键位），空格跳过，⏎ 归到建议分组，Esc 退出。
func (a *app) triagePanel(c *ui.Context, k tokens) {
	if !a.triageOn || a.page != pageNotes {
		return
	}
	queue := a.triageQueue()
	secs := a.fileTargets()
	if len(queue) == 0 || len(secs) == 0 {
		a.triageOn = false
		if len(queue) == 0 {
			a.showHUD("ok", tr("收件箱整理完了"))
		}
		return
	}
	n := queue[0]
	total := len(queue) + len(a.triageSkip)
	sug, hasSug := a.inboxSug[n.ID]
	p := stok(c).primary
	white := ui.RGB(255, 255, 255)
	file := func(to string) { a.fileInbox([]string{n.ID}, func(store.Note) string { return to }, false) }
	w, h := c.Size()
	ui.Overlay(c, func() {
		if ui.Box(c).Absolute().Left(0).Top(0).Size(w, h).Background(ui.RGBA(0, 0, 0, 0.18)).Key("triage-dim").Clicked() {
			a.triageOn = false
		}
		pw := min(float32(340), w-24)
		pop := floatSurface(ui.Column(c).Absolute().Left((w-pw)/2).Top(max(12, h*0.18)).Width(pw).Padding(14).Gap(10).Radius(rr(14)).Key("triage"), k)
		switch {
		case pop.OverlayShortcut(0, ui.KeyEscape):
			a.triageOn = false
		case pop.OverlayShortcut(0, ui.KeySpace):
			a.triageSkip[n.ID] = true
		case pop.OverlayShortcut(0, ui.KeyEnter) && hasSug:
			file(sug.section)
		default:
			for i, s := range secs {
				if pop.OverlayShortcut(0, digitKeys[i]) {
					file(s.ID)
				}
			}
		}
		pop.Children(func() {
			// 标题 + 进度
			ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
				licon(c, "layers", 13, k.fg)
				text(c, tr("逐条整理"), 12.5, 18, 600, k.fg)
				ui.Box(c).Grow(1)
				text(c, fmt.Sprintf(tr("第 %d / %d 条"), total-len(queue)+1, total), 10.5, 15, 400, k.muted).Font(fontMono)
			})
			done := float32(total-len(queue)) / float32(max(total, 1))
			ui.Box(c).Height(3).FillWidth().Radius(2).Background(k.track).Children(func() {
				ui.Box(c).Absolute().Left(0).Top(0).Bottom(0).Width(max(3, (pw-28)*done)).Radius(2).Background(p)
			})
			// 当前这条
			ui.Column(c).FillWidth().Padding(10, 12).Gap(4).Radius(rr(10)).Background(k.track).Key("triage-item-" + n.ID).Children(func() {
				text(c, cmpOr(n.Title, cardTitle(n)), 10, 14, 500, k.muted).SingleLine()
				body := cmpOr(n.LinkTitle, cmpOr(n.Text, cardImageMeta(n)))
				t := text(c, body, 12.5, 19, 400, k.fg).Wrap().MaxLines(4)
				if isCode(n) {
					t.Font(fontMono).FontSize(11.5)
				}
				src := ago(n.CreatedAt, a.now())
				if n.SourceApp != "" {
					src = n.SourceApp + " · " + src
				}
				text(c, src, 10, 14, 400, k.muted).SingleLine()
			})
			// 分组键（每行 3 个）
			for r := 0; r*3 < len(secs); r++ {
				ui.Row(c).FillWidth().Gap(5).Children(func() {
					for i := r * 3; i < min(len(secs), r*3+3); i++ {
						s := secs[i]
						isSug := hasSug && sug.section == s.ID
						b := ui.Row(c).Height(30).Grow(1).Basis(0).Gap(5).Padding(0, 6).Radius(rr(8)).AlignItems(ui.Center).Justify(ui.Center).
							Background(k.card).Border(1, k.inputBorder).Key("tri-" + s.ID).Role(ui.RoleButton).Label(tr("归到 ") + sectionName(s))
						col := k.fg
						switch {
						case isSug:
							b.Border(1, p).Background(p.Alpha(0.12))
							col = p
						case b.Hovered():
							b.Border(1, p.Alpha(0.6))
						}
						b.AnimatePose(ui.Pose{Scale: pressScale(b.Pressed(), 0.97)}, tweenControl)
						b.Children(func() {
							text(c, itoa(i+1), 9.5, 13, 500, k.muted).Font(fontMono).Shrink(0)
							text(c, sectionName(s), 11.5, 16, 500, col).SingleLine().Shrink(1)
							if isSug {
								text(c, tr("建议"), 8.5, 12, 600, white).Padding(0, 3).Radius(4).Background(p).Shrink(0)
							}
						})
						if b.Clicked() {
							file(s.ID)
						}
					}
					for range r*3 + 3 - min(len(secs), r*3+3) { // 末行不满 3 个：补空位，按钮宽度与上一行一致
						ui.Box(c).Grow(1).Basis(0)
					}
				})
			}
			// 键位提示 + 跳过 / 结束
			ui.Row(c).Gap(5).AlignItems(ui.Center).Children(func() {
				kbdHint(c, fileKeyHint(len(secs)), k.muted)
				text(c, tr("归类"), 10, 14, 400, k.muted)
				if hasSug {
					kbdHint(c, "⏎", k.muted)
					text(c, tr("按建议"), 10, 14, 400, k.muted)
				}
				ui.Box(c).Grow(1)
				skip := ui.Row(c).Gap(4).AlignItems(ui.Center).Key("tri-skip").Role(ui.RoleButton).Label(tr("跳过"))
				skip.Children(func() {
					kbdHint(c, tr("空格"), k.muted)
					text(c, tr("跳过"), 10.5, 15, 500, hoverLink(skip, k)).SingleLine()
				})
				if skip.Clicked() {
					a.triageSkip[n.ID] = true
				}
				end := ui.Row(c).Gap(4).AlignItems(ui.Center).Margin(0, 0, 0, 6).Key("tri-end").Role(ui.RoleButton).Label(tr("结束整理"))
				end.Children(func() {
					kbdHint(c, "Esc", k.muted)
					text(c, tr("结束"), 10.5, 15, 500, hoverLink(end, k)).SingleLine()
				})
				if end.Clicked() {
					a.triageOn = false
				}
			})
		})
	})
}
