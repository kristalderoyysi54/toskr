package main

import (
	"slices"
	"strings"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// 详情窗能力卡（用户 2026-11-25 选定）：内容较短、正文下方空着时，列出这扇窗还能做的几件事，各带入口提示。
// 「选词发送」「一稿多投」点了直达；另两张要先划选文字，点了给气泡提示。内容超过一屏、编辑 / 选词 / 查找中、
// 只读预览、隐身模式都不出现；「不再提示」写进设置（设置 → 窗口与外观 可重新打开）。

type detailCap struct{ id, icon, title, desc, hint string }

var detailCapList = []detailCap{
	{"select", "wand-sparkles", "划词即改", "选中文字改写、只发这段", "划选"},
	{"pick", "scan-text", "选词发送", "点选词或段拼成片段", "W"},
	{"fanout", "layers", "一稿多投", "发到多个应用，对比回复", "发送 ▾"},
	{"alias", "venetian-mask", "化名保护", "发出替换、收回恢复", "划选"},
}

const (
	capH, capGap = 46, 6
	capsTop      = 18  // 与正文的间距
	capsHeadH    = 14  // 小标题行
	capsTwoCols  = 460 // 内容区不到这个宽度改单列（两列时说明文字会被截断）
)

// detailCaps：这张卡此刻列哪些能力卡（nil = 不显示）。
func (a *app) detailCaps(n store.Note) []detailCap {
	st, d := a.store.Settings(), a.detail
	if st.DetailTipsOff || st.Stealth || d.virt != nil || d.findOn || strings.TrimSpace(n.Text) == "" {
		return nil
	}
	if st.AliasOff { // 化名总开关关着：不提它
		return slices.DeleteFunc(slices.Clone(detailCapList), func(c detailCap) bool { return c.id == "alias" })
	}
	return detailCapList
}

// detailCapsView 画在阅读态正文下方。w = 内容区宽度，room = 正文与操作坞之间还剩的高度；整块放不下就不画。
func (a *app) detailCapsView(c *ui.Context, k tokens, n store.Note, w, room float32) {
	caps := a.detailCaps(n)
	if len(caps) == 0 {
		return
	}
	cols := 2
	if w < capsTwoCols {
		cols = 1
	}
	rows := (len(caps) + cols - 1) / cols
	if room < capsTop+capsHeadH+float32(rows)*(capH+capGap) {
		return
	}
	ui.Column(c).Margin(capsTop, 0, 0, 0).Gap(capGap).Key("detail-caps").Children(func() {
		ui.Row(c).Height(capsHeadH).AlignItems(ui.Center).Children(func() {
			text(c, tr("这条内容还能"), 10, 14, 400, k.muted).SingleLine().Grow(1).Basis(0)
			off := ui.Row(c).Shrink(0).Key("caps-off").Role(ui.RoleButton).Label(tr("不再提示"))
			col := k.muted.Alpha(0.75)
			if off.Hovered() {
				col = k.fg
			}
			off.Children(func() { text(c, tr("不再提示"), 10, 14, 400, col).SingleLine() })
			if off.Clicked() {
				a.patchSettings(func(s *store.Settings) { s.DetailTipsOff = true })
				a.showHUDUndo("ok", tr("已关闭能力提示 · 设置 → 窗口与外观可重开"), func() {
					a.patchSettings(func(s *store.Settings) { s.DetailTipsOff = false })
				})
			}
		})
		for i := 0; i < len(caps); i += cols {
			ui.Row(c).Gap(capGap).Key("caps-row-" + itoa(i)).Children(func() {
				for j := i; j < i+cols; j++ {
					if j >= len(caps) { // 奇数张：最后一行补一格空位，卡片不被拉成整行。内边距同卡片：伸展是按「去掉内边距后」平分的，不带的话这张卡会比上一排宽 9
						ui.Box(c).Grow(1).Basis(0).Padding(0, 9)
						continue
					}
					a.detailCapCard(c, k, caps[j])
				}
			})
		}
	})
}

func (a *app) detailCapCard(c *ui.Context, k tokens, cp detailCap) {
	title, desc := tr(cp.title), tr(cp.desc)
	card := tipOf(c, ui.Row(c).Grow(1).Basis(0).Height(capH).Padding(0, 9).Gap(9).Radius(rr(10)).AlignItems(ui.Center).
		Key("cap-"+cp.id).Role(ui.RoleButton).Label(title), desc)
	bg := k.track
	if card.Hovered() {
		bg = k.fg.Alpha(0.08)
	}
	fadeColor(card, "bg", bg, tweenControl)
	card.AnimatePose(ui.Pose{Scale: pressScale(card.Pressed(), 0.98)}, tweenControl)
	card.Children(func() {
		ui.Box(c).Size(30, 30).Radius(rr(8)).Background(k.card).Border(1, k.inputBorder).Center().Shrink(0).
			Children(func() { licon(c, cp.icon, 15, k.fg) })
		ui.Column(c).Grow(1).Basis(0).Children(func() {
			text(c, title, 12, 17, 600, k.fg).SingleLine()
			text(c, desc, 10.5, 15, 400, k.muted).SingleLine()
		})
		kbdHint(c, tr(cp.hint), k.muted)
	})
	if !card.Clicked() {
		return
	}
	d := &a.detail
	switch cp.id {
	case "pick":
		d.pick, d.pickAnchor, d.pickEnd = true, -1, -1
	case "fanout":
		d.fanOpen = true
	case "select":
		a.showHUD("info", tr("在正文里划选一段文字"))
	case "alias":
		a.showHUD("info", tr("划选要保护的词，再点工具条上的面具"))
	}
}

func init() { // 能力卡与极简标题栏新增文案的英文（已有的键不覆盖）
	for k, v := range map[string]string{
		"这条内容还能": "You can also", "不再提示": "Don't show again",
		"划词即改": "Edit a selection", "选中文字改写、只发这段": "Rewrite it, or send just that",
		"选词发送": "Pick words", "点选词或段拼成片段": "Tap words to build a snippet",
		"一稿多投": "Send to several", "发到多个应用，对比回复": "Fan out, compare replies",
		"化名保护": "Aliases", "发出替换、收回恢复": "Masked out, restored back",
		"划选": "Select", "发送 ▾": "Send ▾",
		"已关闭能力提示 · 设置 → 窗口与外观可重开": "Tips off · turn back on in Settings → Window & appearance",
		"在正文里划选一段文字":              "Select some text in the note",
		"划选要保护的词，再点工具条上的面具":       "Select a word to protect, then tap the mask in the toolbar",
		"添加标签": "Add tag", "标签": "Tags", "更多操作": "More actions",
		"详情窗能力提示": "Detail window tips", "内容较短时，在正文下方列出划词、选词、多投、化名的入口": "On short notes, list what you can do below the text",
	} {
		if _, ok := en[k]; !ok {
			en[k] = v
		}
	}
}
