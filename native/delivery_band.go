package main

import (
	"fmt"
	"slices"
	"time"

	"github.com/egoist/mygo/ui"
)

// 卡片底缘发送状态带（同 Tauri 案 6 delivery-band）：派发开始「发送中…」（天蓝），回执落定转「✓ 已粘贴 · 已按回车」（绿，
// 有卡被标记完成时带「撤销」）或「发送未完成」（琥珀）。sent 停 3.2s（悬停续 1.5s）、failed 停 2.4s 后收起。
// 状态带在底缘时悬停操作钮整组上移，不压住回执。

type deliveryBand struct {
	ids             []string
	phase           string // sending / sent / failed
	pasted, entered bool
	undoIDs         []string // 本次发送后被标记完成的卡（撤销即恢复）
	gen             int
	hovered         bool // 上一帧有带内卡片被悬停（sent 收起前续时）
}

const (
	bandHoldSent   = 3200 * time.Millisecond
	bandHoldFailed = 2400 * time.Millisecond
	bandHoverMore  = 1500 * time.Millisecond
)

func (a *app) bandFor(id string) *deliveryBand {
	if b := a.band; b != nil && slices.Contains(b.ids, id) {
		return b
	}
	return nil
}

func (a *app) beginBand(ids []string) {
	gen := 1
	if a.band != nil {
		gen = a.band.gen + 1
	}
	a.band = &deliveryBand{ids: slices.Clone(ids), phase: "sending", gen: gen}
}

// settleBand：回执落定后按停留时长收起；期间又开始新发送（gen 变了）就不动它。
func (a *app) settleBand(failed, pasted, entered bool, undo []string) {
	b := a.band
	if b == nil || b.phase != "sending" {
		return
	}
	b.phase, b.pasted, b.entered, b.undoIDs = "sent", pasted, entered, undo
	hold := bandHoldSent
	if failed {
		b.phase, hold = "failed", bandHoldFailed
	}
	gen := b.gen
	var collapse func()
	collapse = func() {
		if a.panel == nil { // 无界面（测试）：不收起
			return
		}
		a.panel.Update(func() {
			if a.band == nil || a.band.gen != gen {
				return
			}
			if a.band.phase == "sent" && a.band.hovered {
				a.band.hovered = false
				time.AfterFunc(bandHoverMore, collapse)
				return
			}
			a.band = nil
		})
	}
	time.AfterFunc(hold, collapse)
}

// undoBandCompletion 同 Tauri undoDeliveryBandCompletion：把本次发送后标记完成的卡恢复为未完成并收起状态带。
func (a *app) undoBandCompletion() {
	if a.band == nil || len(a.band.undoIDs) == 0 {
		return
	}
	ids := a.band.undoIDs
	a.band = nil
	for _, id := range ids {
		_ = a.store.SetDone(id, false)
	}
	a.showHUD("undone", fmt.Sprintf(tr("已恢复 %d 张卡为未完成"), len(ids)))
}

// bandHover：卡片渲染时报告悬停（sent 回执悬停期间续停留）。
func (a *app) bandHover(id string, hovered bool) {
	if b := a.bandFor(id); b != nil && hovered {
		b.hovered = true
	}
}

// bandLift：状态带在底缘时悬停钮上移的距离（同 Tauri bottom-7）。
func (a *app) bandLift(id string, compact bool) float32 {
	if compact || a.bandFor(id) == nil {
		return 0
	}
	return 24
}

func bandTone(c *ui.Context, phase string) ui.Color {
	dark := c.Theme().Dark
	switch { // token-exception: 同 Tauri --info / --success / --warning（明暗两值）
	case phase == "sent":
		return oklch(0.696, 0.17, 162.48, 1)
	case phase == "failed" && dark:
		return oklch(0.828, 0.189, 84.429, 1)
	case phase == "failed":
		return oklch(0.666, 0.179, 58.318, 1)
	case dark:
		return oklch(0.746, 0.16, 232.66, 1)
	}
	return oklch(0.588, 0.158, 241.97, 1)
}

// deliveryBandOverlay：卡面之上的底缘带（同 .delivery-band：底 2px 实线 + 自下而上渐隐的色晕，紧凑行只留 12pt 细带不放文字）。
func (a *app) deliveryBandOverlay(c *ui.Context, k tokens, id string, compact bool) {
	b := a.bandFor(id)
	if b == nil {
		return
	}
	tone := bandTone(c, b.phase)
	h := float32(22)
	if compact {
		h = 12
	}
	in := ui.ElementTransition{Duration: 180 * time.Millisecond, Ease: easeStandard, Enter: &ui.Motion{Y: h}, Exit: &ui.Motion{Y: h}}
	r := float32(10)
	if k.pt {
		r = 0
	}
	// 色晕与底线整体穿透点击（同 pointer-events-none）；文字胶囊另起一层，只有「撤销」接收点击
	ui.Box(c).Absolute().Left(0).Right(0).Bottom(0).Height(h+14).Radius(0, 0, r, r).Clip().PassThrough().Key("delivery-band").Transition(in).
		LinearGradient(ui.LinearGradient{From: tone.Alpha(0.22), To: tone.Alpha(0), Angle: 0, Start: 0, End: 1}).
		Children(func() { ui.Box(c).Absolute().Left(0).Right(0).Bottom(0).Height(2).Background(tone).PassThrough() })
	if compact {
		return
	}
	func() {
		label := tr("发送中…")
		switch {
		case b.phase == "failed":
			label = tr("发送未完成")
		case b.phase == "sent":
			label = "✓ " + map[bool]string{true: tr("已粘贴"), false: tr("粘贴未确认")}[b.pasted] + " · " +
				map[bool]string{true: tr("已按回车"), false: tr("未按回车")}[b.entered]
		}
		ui.Row(c).Absolute().Right(6).Bottom(4).Height(18).Padding(0, 6).Radius(9).Gap(6).AlignItems(ui.Center).Key("delivery-band-label").
			Transition(ui.ElementTransition{Duration: 120 * time.Millisecond, Ease: easeStandard, Enter: &ui.Motion{}, Exit: &ui.Motion{}}).
			Background(k.card.Alpha(0.88)).Children(func() {
			text(c, label, 10, 14, 500, tone).SingleLine()
			if b.phase != "sent" || len(b.undoIDs) == 0 {
				return
			}
			u := ui.Row(c).Key("band-undo").Role(ui.RoleButton).Label(tr("撤销")).Tooltip(fmt.Sprintf(tr("把这 %d 张卡恢复为未完成"), len(b.undoIDs)))
			u.Children(func() {
				text(c, tr("撤销"), 10, 14, 600, tone).Underline()
			})
			if u.Clicked() {
				a.undoBandCompletion()
			}
		})
	}()
}

func init() {
	for k, v := range map[string]string{
		"发送中…": "Sending…", "发送未完成": "Not delivered", "已粘贴": "Pasted", "粘贴未确认": "Paste unconfirmed",
		"已按回车": "Enter pressed", "未按回车": "Enter not pressed", "把这 %d 张卡恢复为未完成": "Mark these %d cards as not done",
		"已恢复 %d 张卡为未完成":       "Restored %d cards to not done",
		"拖出原文（不脱敏，目标由拖放位置决定）": "Drag out the original text (not redacted; the drop target decides where it goes)",
	} {
		if _, ok := en[k]; !ok {
			en[k] = v
		}
	}
}
