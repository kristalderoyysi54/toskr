package main

import (
	"time"

	"github.com/egoist/mygo/ui"
)

// 上手教程的图形化步骤（用户 2026-11-07 要求：新手引导少文字、能图形化就图形化）：
// 一行「图标 / 键帽 + 2–4 字标签」的流程条，箭头相连；当前该做的那一格按顺序轮流高亮，提示先后。

type vstep struct {
	icon  string // lucide 图标名；为空时画键帽
	key   string // 键帽文字（如 ⌘V、⇧ ⇧）
	label string
}

func vi(icon, label string) vstep { return vstep{icon: icon, label: label} }
func vk(key, label string) vstep  { return vstep{key: key, label: label} }

var flowEpoch = time.Now()

// flow 画流程条。ReduceMotion 时不轮播高亮。
func flow(c *ui.Context, k tokens, id string, steps ...vstep) {
	hot := -1
	if !c.Preferences().ReduceMotion && len(steps) > 1 {
		hot = int(time.Since(flowEpoch).Milliseconds()/1100) % len(steps)
		c.AnimationFrame()
	}
	p := stok(c).primary
	ui.Row(c).Gap(4).AlignItems(ui.Center).Key("flow-" + id).Children(func() {
		for i, s := range steps {
			if i > 0 {
				licon(c, "chevron-right", 12, k.muted.Alpha(0.6))
			}
			t := ui.Column(c).Grow(1).Basis(0).Padding(6, 2).Gap(4).Radius(8).AlignItems(ui.Center).Key(id + "-" + itoa(i)).Label(tr(s.label))
			on := i == hot
			t.Background(t.AnimateColor("bg", map[bool]ui.Color{true: p.Alpha(0.12), false: k.card}[on], tweenTw))
			t.Border(1, t.AnimateColor("bd", map[bool]ui.Color{true: p.Alpha(0.6), false: k.inputBorder}[on], tweenTw))
			t.Children(func() {
				fg := map[bool]ui.Color{true: p, false: k.fg}[on]
				if s.icon != "" {
					ui.Box(c).Height(22).Center().Children(func() { licon(c, s.icon, 18, fg) })
				} else {
					ui.Row(c).Height(22).Padding(0, 6).Radius(5).Background(k.window).Border(1, k.inputBorder).AlignItems(ui.Center).Children(func() {
						text(c, s.key, 11, 14, 600, fg).SingleLine()
					})
				}
				text(c, tr(s.label), 10, 14, 400, k.muted).SingleLine()
			})
		}
	})
}

// chipSwap：「原文 → 占位符」这类替换的小图示。
func chipSwap(c *ui.Context, k tokens, from, to string, okTo bool) {
	ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
		text(c, from, 11, 16, 500, k.fg).Padding(2, 6).Radius(5).Background(k.card).Border(1, k.inputBorder)
		licon(c, "arrow-right", 12, k.muted)
		col := k.fg
		if okTo {
			col = k.ok
		}
		text(c, to, 11, 16, 600, col).Font(fontMono).Padding(2, 6).Radius(5).Background(col.Alpha(0.12))
	})
}

// noEnterBadge：「不会按回车」图示（⏎ 加禁止号）。
func noEnterBadge(c *ui.Context, k tokens) {
	ui.Row(c).Gap(3).Padding(1, 6).Radius(8).Background(k.track).AlignItems(ui.Center).Tooltip(tr("不会自动按回车")).Label(tr("不会自动按回车")).Children(func() {
		licon(c, "keyboard-off", 10, k.muted)
		text(c, tr("不回车"), 10, 14, 500, k.muted)
	})
}

func (a *app) capKey() string {
	if s := map[string]string{"shift": "⇧", "control": "⌃", "option": "⌥"}[a.store.Settings().TriggerModifier]; s != "" {
		return s
	}
	return "⇧"
}
