package main

import (
	"fmt"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// 收件箱底部抽屉（用户 2026-11-18）：收件箱是中转站，不是分组——从分组列表里拿出来，贴在笔记页底部（输入区上方）。
//   - 身份固定：名字、位置不能改，没有分组菜单（重命名 / 颜色 / 排序 / 上移下移）
//   - 平时一行：图标 · 收件箱 · 条数 · 最新一条；点开向上展开，里面是「按去向分堆」+ 逐条的卡
//   - 空了就让位：收件箱没内容时整条不出现（拖卡回收件箱走分组坞）
// 搜索 / 「只看此组」/ 横版 / 还没有任何用户分组时不走抽屉，收件箱照旧排在列表里。

// inboxDrawer：抽屉总开关。无头测试的既有用例按「收件箱在列表里」写的，testApp 里关掉；抽屉自己的用例再打开。
var inboxDrawer = true

const (
	drawerBarH  = 30
	drawerPileH = 28
)

func (a *app) drawerMode() bool {
	return inboxDrawer && !a.hbar() && a.query == "" && a.noteFilter == "" && len(a.fileTargets()) > 0
}

// inboxDrawerOpen：抽屉展开着（记在设置里，重启后保持）。
func (a *app) inboxDrawerOpen() bool { return a.store.Settings().InboxOpen }

func (a *app) setDrawerOpen(open bool) {
	if a.inboxDrawerOpen() != open {
		a.patchSettings(func(s *store.Settings) { s.InboxOpen = open })
		a.reload() // 键盘上下移动的列表：展开才包含收件箱里的卡
	}
}

func (a *app) inboxGroup() (noteGroup, bool) {
	for _, g := range a.noteGroups {
		if g.sec.ID == store.SectionInbox {
			return g, true
		}
	}
	return noteGroup{}, false
}

// inboxPile：收件箱里建议归到同一个分组的一堆。
type inboxPile struct {
	sec store.Section
	ids []string
	top string // 第一条的标题
}

// inboxPiles：按去向分堆（分组顺序）。只列 2 条以上的去向——单条的建议在卡片自己的小标上点。
func (a *app) inboxPiles(open []store.Note) []inboxPile {
	by := map[string]*inboxPile{}
	for _, n := range open {
		s, ok := a.inboxSug[n.ID]
		if !ok {
			continue
		}
		p := by[s.section]
		if p == nil {
			p = &inboxPile{top: preview(cmpOr(n.Title, cmpOr(firstLine(n.Text), cardTitle(n))), 24)}
			by[s.section] = p
		}
		p.ids = append(p.ids, n.ID)
	}
	var out []inboxPile
	for _, s := range a.fileTargets() {
		if p := by[s.ID]; p != nil && len(p.ids) >= 2 {
			p.sec = s
			out = append(out, *p)
		}
	}
	return out
}

// pillChip：18 高的胶囊小钮（收件箱头部操作、抽屉里的「逐条整理」「归入」）。
func pillChip(c *ui.Context, k tokens, key, icon, label, tip string, primary bool) bool {
	p := stok(c).primary
	b := tipOf(c, ui.Row(c).Height(18).Gap(3).Padding(0, 7).Radius(999).AlignItems(ui.Center).Shrink(0).Key(key).Role(ui.RoleButton).Label(label), tip)
	bg, fg := k.track, k.fg
	if primary {
		bg, fg = p.Alpha(0.12), p
	}
	if b.Hovered() {
		bg, fg = p.Alpha(0.18), p
	}
	b.Background(bg).Children(func() {
		if icon != "" {
			licon(c, icon, 10, fg)
		}
		text(c, label, 10, 14, 500, fg).SingleLine()
	})
	return b.Clicked()
}

// inboxDrawerView：笔记页底部的收件箱抽屉。
func (a *app) inboxDrawerView(c *ui.Context, k tokens) {
	if !a.drawerMode() {
		return
	}
	g, ok := a.inboxGroup()
	if !ok || len(g.open)+len(g.done) == 0 {
		return // 空了就让位
	}
	open := a.inboxDrawerOpen()
	p := stok(c).primary
	wrap := ui.Column(c).Margin(4, 10, 2, 10).Radius(rr(14)).Background(k.card).Border(1, k.inputBorder).Clip().Shrink(0).Key("inbox-drawer")
	elevated(wrap, k, true)
	wrap.Children(func() {
		bar := tipOf(c, ui.Row(c).Height(drawerBarH).Padding(0, 10).Gap(6).AlignItems(ui.Center).Key("inbox-bar").Role(ui.RoleButton).
			Label(map[bool]string{true: tr("收起收件箱"), false: tr("展开收件箱")}[open]), tr("收件箱：还没归类的内容。把卡拖到这里放回收件箱"))
		_, over := ui.DragOver[noteDrag](bar)
		switch {
		case over:
			bar.Background(p.Alpha(0.12))
		case bar.Hovered():
			bar.Background(k.fg.Alpha(0.04))
		}
		if d, ok := ui.Drop[noteDrag](bar); ok {
			if d.quick {
				a.quickMoveOut(d.id, store.SectionInbox, "")
			} else {
				a.moveNotesTo(a.dragNotes(d.id), store.SectionInbox)
			}
		}
		bar.Children(func() {
			licon(c, "inbox", 13, k.fg)
			text(c, tr("收件箱"), 12, 16, 600, k.fg).SingleLine().Shrink(0)
			if n := len(g.open); n > 0 {
				ui.Row(c).Height(15).MinWidth(15).Padding(0, 5).Radius(999).Background(p).Center().Shrink(0).Key("inbox-count").
					Children(func() { text(c, itoa(n), 9.5, 12, 700, ui.RGB(255, 255, 255)).Font(fontMono) })
			}
			if !open && len(g.open) > 0 { // 收起时露出最新一条，知道里面压着什么
				n := g.open[0]
				text(c, preview(cmpOr(n.Title, cmpOr(firstLine(n.Text), cardTitle(n))), 60), 11, 16, 400, k.muted).SingleLine().Grow(1).Basis(0)
			} else {
				ui.Box(c).Grow(1)
			}
			if open && len(g.open) >= 2 && pillChip(c, k, "inbox-triage", "layers", tr("逐条整理"), tr("一条一条看，按数字键归类"), false) {
				a.triageOn, a.triageSkip = true, map[string]bool{}
			}
			ch := licon(c, "chevron-up", 12, k.muted).Shrink(0)
			ch.AnimatePose(ui.Pose{Rotate: map[bool]float32{true: 180}[open]}, tweenTw)
		})
		if bar.Clicked() {
			a.setDrawerOpen(!open)
		}
		if !open {
			return
		}
		piles := a.inboxPiles(g.open)
		content := float32(2 * secPad)
		for _, n := range g.open {
			content += a.noteRowH(c, n)
		}
		sugN := 0 // 有建议分组的条数：2 条以上给「按建议归好」
		for _, n := range g.open {
			if _, ok := a.inboxSug[n.ID]; ok {
				sugN++
			}
		}
		if sugN < 2 {
			sugN = 0
		}
		if len(piles) > 0 || sugN > 0 {
			content += float32(len(piles))*drawerPileH + 6
			if sugN > 0 {
				content += drawerPileH
			}
		}
		_, vh := c.Size()
		limit := min(max(vh*0.45, 160), 420)
		if len(g.done) > 0 {
			content += 18
			if a.doneOpen[g.sec.ID] {
				content = limit // 已完成展开：高度不好预估，直接给到上限
			}
		}
		ui.Column(c).Key("inbox-drawer-body").Transition(foldTransition).Children(func() {
			ui.Box(c).Height(1).Margin(0, 10).Background(k.fg.Alpha(0.06))
			ui.Scroll(c).Height(min(content, limit)).FillWidth().Scrollbars(false).TrackScroll(&a.inboxScroll).Children(func() {
				if len(piles) > 0 || sugN > 0 {
					ui.Column(c).Padding(6, secPad+6, 0, secPad+6).Key("inbox-piles").Children(func() {
						if sugN > 0 { // 全部按建议归好（含只有 1 条的去向）；下面的堆是按去向分开送
							ui.Row(c).Height(drawerPileH).Gap(6).AlignItems(ui.Center).Key("inbox-fileall-row").Children(func() {
								text(c, fmt.Sprintf(tr("%d 条有建议分组"), sugN), 10.5, 16, 400, k.muted).SingleLine().Grow(1).Basis(0)
								if pillChip(c, k, "inbox-fileall", "check", fmt.Sprintf(tr("按建议归好 %d 条"), sugN), tr("把有建议分组的都归过去（可撤销）"), true) {
									a.fileAllSuggested()
								}
							})
						}
						for _, pl := range piles {
							a.inboxPileRow(c, k, pl)
						}
					})
				}
				body := ui.Column(c).Padding(secPad).Key("inbox-drawer-rows")
				body.Children(func() {
					a.rowGlide(c, k, g.sec.ID, ui.Color{}, false)
					rowY := float32(secPad)
					for i, n := range g.open {
						a.rowFirst, a.rowSec, a.rowY = i == 0, g.sec.ID, rowY
						a.noteCard(c, k, n)
						rowY += a.noteRowH(c, n)
					}
					if len(g.done) > 0 {
						a.doneRow(c, k, g)
					}
				})
			})
		})
	})
}

// inboxPileRow：一堆——「→ 分组名 · N 条 · 第一条标题」+「归入」。一次送走整堆（可撤销）。
func (a *app) inboxPileRow(c *ui.Context, k tokens, pl inboxPile) {
	col := stok(c).primary
	if pl.sec.Color != "" {
		col = hexColor(pl.sec.Color)
	}
	ui.Row(c).Height(drawerPileH).Gap(6).AlignItems(ui.Center).Key("pile-" + pl.sec.ID).Children(func() {
		licon(c, "arrow-right", 11, col).Shrink(0)
		text(c, sectionName(pl.sec), 11.5, 16, 600, k.fg).SingleLine().Shrink(0)
		text(c, fmt.Sprintf(tr("%d 条 · %s"), len(pl.ids), pl.top), 10.5, 16, 400, k.muted).SingleLine().Grow(1).Basis(0)
		if pillChip(c, k, "pile-go-"+pl.sec.ID, "", tr("归入"), fmt.Sprintf(tr("把这 %d 条归到「%s」（可撤销）"), len(pl.ids), sectionName(pl.sec)), true) {
			a.fileInbox(pl.ids, func(store.Note) string { return pl.sec.ID }, false)
		}
	})
}
