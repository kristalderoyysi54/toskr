package main

import (
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// 详情窗划词工具条（同 Tauri TextSelectionToolbar）：阅读态或编辑态选中文字时浮出——已选 N 字 · 发送选中 · 复制 ·
// （编辑态）粗体 / 斜体 · 处理 ▾（同一组 textOps，就地替换选区并把新选区留在处理结果上）。
// mygo 拿不到选区的屏幕坐标，工具条固定浮在底部操作坞上方居中。

// detailSelection 返回当前选中的原文区间（rune 偏移）与文字；编辑态读编辑器选区，阅读态把划词选区映射回原文。
func (a *app) detailSelection(src string) (int, int, string) {
	d := a.detail
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

// replaceDetailRange 用 out 替换区间：编辑态改草稿并选中结果；阅读态直接改卡片原文（可撤销）。
func (a *app) replaceDetailRange(n store.Note, lo, hi int, out string) {
	if a.detail.edit {
		r := []rune(a.detailText)
		a.detailText = string(r[:lo]) + out + string(r[hi:])
		a.detail.editSel = [2]int{lo, lo + utf8.RuneCountInString(out)}
		return
	}
	if a.detail.pick { // 同 Tauri applySelectionTextOp：选词处理后退出选词模式
		a.detail.pick, a.detail.pickAnchor, a.detail.pickEnd = false, -1, -1
	}
	r := []rune(n.Text)
	next := string(r[:lo]) + out + string(r[hi:])
	prev := n.Text
	_ = a.store.Update(n.ID, next)
	a.detail.readSel = nil
	a.showHUDUndo("ok", tr("已处理选中内容"), func() { _ = a.store.Update(n.ID, prev) })
}

func (a *app) detailSelectionBar(c *ui.Context, k tokens, n store.Note) {
	if n.Kind == "image" {
		return
	}
	lo, hi, sel := a.detailSelection(n.Text)
	if strings.TrimSpace(sel) == "" {
		return
	}
	bar := ui.Row(c).Absolute().Left(0).Right(0).Bottom(56).Justify(ui.Center).Key("selbar").
		Transition(ui.ElementTransition{Duration: 120 * time.Millisecond, Ease: easeStandard, Enter: &ui.Motion{Y: 4, Scale: 0.98}, Exit: &ui.Motion{}})
	bar.Children(func() {
		ui.Row(c).Height(32).Padding(0, 6).Gap(2).Radius(10).Background(k.floatBtn).Border(1, k.floatBorder).
			Shadow(0, 1, 2, 0, k.floatShadowA).Shadow(0, 6, 16, -4, k.floatShadowB).AlignItems(ui.Center).Children(func() {
			text(c, fmt.Sprintf(tr("已选 %d 字"), utf8.RuneCountInString(sel)), 10, 14, 400, k.muted).Padding(0, 6)
			btn := func(icon, label string) bool {
				b := ui.Row(c).Height(24).Padding(0, 6).Gap(4).Radius(6).AlignItems(ui.Center).Key("sb-" + label).Role(ui.RoleButton).Label(label).Tooltip(label)
				col := k.muted
				if b.Hovered() {
					b.Background(k.track)
					col = k.fg
				}
				b.Children(func() {
					licon(c, icon, 12, col)
					if icon == "send" {
						text(c, tr("发送选中"), 11, 16, 500, col)
					}
				})
				return b.Clicked()
			}
			ro := a.detail.virt != nil // 只读合并预览：只能复制（同 Tauri writable=false 不给发送 / 处理）
			if !ro && btn("send", tr("只把选中片段发到当前目标")) {
				a.sendDetailFragment(n, sel)
			}
			if btn("copy", tr("复制选中片段")) {
				a.copyPrivate(sel)
				a.showHUD("ok", tr("已复制"))
			}
			if ro {
				return
			}
			if a.detail.edit {
				sep := func() { ui.Box(c).Size(1, 16).Margin(0, 2).Background(k.fg.Alpha(0.1)) }
				sep()
				if btn("bold", tr("粗体（⌘B）")) {
					a.replaceDetailRange(n, lo, hi, toggleWrap(sel, "**"))
				}
				if btn("italic", tr("斜体（⌘I）")) {
					a.replaceDetailRange(n, lo, hi, toggleWrap(sel, "*"))
				}
			}
			ui.Box(c).Size(1, 16).Margin(0, 2).Background(k.fg.Alpha(0.1))
			ops := ui.Row(c).Height(24).Padding(0, 6).Radius(6).AlignItems(ui.Center).Key("sb-ops").Role(ui.RoleButton).Label(tr("处理选中内容")).Tooltip(tr("处理选中内容"))
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
			})
		})
	})
}

// toggleWrap：选区已被 mark 包住则去掉，否则包上（同 Tauri toggleInlineFormat 的行内语义）。
func toggleWrap(s, mark string) string {
	if len(s) >= 2*len(mark) && strings.HasPrefix(s, mark) && strings.HasSuffix(s, mark) {
		return s[len(mark) : len(s)-len(mark)]
	}
	return mark + s + mark
}
