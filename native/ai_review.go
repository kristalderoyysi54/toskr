package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/ai"
	"github.com/toskr/native/internal/diag"
	"github.com/toskr/native/internal/store"
)

// AI 改写的核对流程（原生版新增；此前结果整段落成一张新卡，改了哪里要自己逐字比）：
// 请求改为流式，文字边到边显示在详情窗；完成后按行对齐成「改动块」，块内逐字标出删 / 增，
// 每块可单独采纳或还原，⌘⏎ 全部采纳写回原卡（可撤销），另存为新卡 / 全部还原降为文字链接。
// 翻译这类全文替换（或几乎没有共同内容）的结果不做差异，上下并排原文与结果。

var aiRewriteStream = ai.RewriteStream // 测试替换

type reviewSeg struct {
	same     bool
	old, new string
	state    int // 改动块：0 待定 · 1 已采纳 · 2 已还原
}

type aiReview struct {
	noteID  string
	act     aiAction
	orig    string
	buf     string // 已收到的结果
	started time.Time
	done    bool
	dead    bool // 已取消 / 已处理：视图下一帧丢弃
	replace bool // 全文替换：并排显示，不做差异
	segs    []reviewSeg
	cancel  context.CancelFunc
}

// reviewSegments：按行对齐 old → new，相邻的删 / 增并成一个改动块。
func reviewSegments(old, new string) []reviewSeg {
	norm := func(s string) string { return strings.TrimRight(strings.ReplaceAll(s, "\r\n", "\n"), "\n") + "\n" }
	ops, _ := myersOps(splitLines(norm(old)), splitLines(norm(new)), -1)
	var out []reviewSeg
	for _, op := range ops {
		if op.text == "" {
			continue
		}
		same := op.kind == diffEq
		if l := len(out); l == 0 || out[l-1].same != same {
			out = append(out, reviewSeg{same: same})
		}
		cur := &out[len(out)-1]
		switch op.kind {
		case diffEq, diffDel:
			cur.old += op.text
			if same {
				cur.new += op.text
			}
		case diffIns:
			cur.new += op.text
		}
	}
	return out
}

// result：按各块的决定拼出最终文本；待定的块按 pending 处理（1 = 当作采纳，2 = 当作还原）。
func (r *aiReview) result(pending int) string {
	if r.replace {
		return r.buf
	}
	var b strings.Builder
	for _, s := range r.segs {
		st := s.state
		if st == 0 {
			st = pending
		}
		if s.same || st == 2 {
			b.WriteString(s.old)
		} else {
			b.WriteString(s.new)
		}
	}
	return strings.TrimRight(b.String(), "\n")
}

func (r *aiReview) changes() (total, decided int) {
	for _, s := range r.segs {
		if !s.same {
			total++
			if s.state != 0 {
				decided++
			}
		}
	}
	return
}

// finish：流结束后整理成改动块；几乎没有共同内容时退成全文替换视图。
func (r *aiReview) finish(out string) {
	r.buf, r.done = out, true
	r.segs = reviewSegments(r.orig, out)
	keep := 0 // 按字符算保留下来的原文（整行对齐太粗：每行只改几个字也会「没有相同行」）
	for _, s := range textDiff(r.orig, out) {
		if s.kind == diffEq {
			keep += utf8.RuneCountInString(strings.TrimSpace(s.text))
		}
	}
	if total := utf8.RuneCountInString(strings.TrimSpace(r.orig)); r.act.replace || total == 0 || keep*100/total < 15 {
		r.replace = true
	}
}

// aiReviewable：这张卡能走核对流程（纯文字卡；图文混排卡的图片位置没法逐行对齐，仍按旧方式落成新卡）。
func aiReviewable(n store.Note) bool {
	return n.Kind != "image" && !store.HasMixedContent(n.Blocks) && strings.TrimSpace(n.Text) != ""
}

// startAIReview：打开这张卡的详情窗并开始流式改写。
func (a *app) startAIReview(n store.Note, act aiAction) {
	if a.aiBusy != "" {
		return
	}
	st := a.store.Settings()
	cfg := ai.Config{Endpoint: st.AIEndpoint, Key: aiKey(), Model: st.AIModel, Off: !st.AIOn()}
	switch {
	case a.detail.id == n.ID && a.detail.edit: // 正在编辑这张卡：先保存草稿，按保存后的内容改写
		if !a.commitDetailEdit(n) {
			return
		}
		if cur, ok := a.store.Note(n.ID); ok {
			n = cur
		}
	case a.detail.id != n.ID:
		openDetailFn(a, n)
	}
	ctx, cancel := context.WithCancel(context.Background())
	rv := &aiReview{noteID: n.ID, act: act, orig: n.Text, started: time.Now(), cancel: cancel}
	a.detail.review, a.detail.pick, a.detail.findOn = rv, false, false
	a.aiBusy, a.aiCancel, a.aiReviewing = n.ID, cancel, rv
	go func() {
		out, err := aiRewriteStream(ctx, cfg, act.instruction, n.Text, func(d string) {
			a.onMain(func() {
				if !rv.dead && !rv.done {
					rv.buf += d
					a.invalidateAll()
				}
			})
		})
		diag.Push("AI: %s %d→%d 字 流式 err=%v", act.label, len([]rune(n.Text)), len([]rune(out)), err != nil)
		a.onMain(func() {
			if ctx.Err() != nil || rv.dead { // 已取消：结果丢弃
				return
			}
			cancel()
			a.aiBusy, a.aiCancel, a.aiReviewing = "", nil, nil
			if err != nil {
				rv.dead = true
				if errors.Is(err, ai.ErrNoKey) {
					a.openSettings()
				}
				a.showHUD("warn", err.Error())
				a.invalidateAll()
				return
			}
			rv.finish(out)
			if !rv.replace {
				if total, _ := rv.changes(); total == 0 {
					rv.dead = true
					a.showHUD("info", tr("AI 没有改动内容"))
				}
			}
			a.invalidateAll()
		})
	}()
}

// activeReview：当前详情窗里有效的核对；已作废的顺手清掉。
func (a *app) activeReview(n store.Note) *aiReview {
	rv := a.detail.review
	if rv == nil {
		return nil
	}
	if rv.dead || rv.noteID != n.ID || a.detail.edit {
		if !rv.done && !rv.dead { // 进了编辑 / 换了卡：停掉还在跑的请求
			a.cancelAI()
		}
		a.detail.review = nil
		return nil
	}
	return rv
}

func (a *app) closeReview(rv *aiReview) {
	rv.dead = true
	a.detail.review = nil
}

// applyReview：写回原卡（可撤销）。pending 决定还没表态的块怎么算。
func (a *app) applyReview(n store.Note, rv *aiReview, pending int) {
	out := rv.result(pending)
	a.closeReview(rv)
	if strings.TrimSpace(out) == "" || out == n.Text {
		a.showHUD("info", tr("内容无变化"))
		return
	}
	prev := n
	if err := a.store.Update(n.ID, out); err != nil {
		a.showHUD("warn", tr("保存失败：")+err.Error())
		return
	}
	a.detailText = out
	a.showHUDUndo("ok", tr("已采纳 · ")+tr(rv.act.label), func() {
		a.store.RestoreContent(prev)
		a.detailText = prev.Text
	})
}

// saveReviewAsNew：结果另存为新卡，原卡不动（旧行为）。
func (a *app) saveReviewAsNew(n store.Note, rv *aiReview) {
	out := rv.result(1)
	a.closeReview(rv)
	if _, _, err := a.store.Add(store.Note{Section: n.Section, Text: out, SourceApp: "AI · " + tr(rv.act.label)}); err == nil {
		a.selected = 0
		a.showHUD("added", tr(rv.act.label)+tr("完成"))
	}
}

// reviewKeys：⌘⏎ 全部采纳 / 应用，Esc 放弃（生成中 = 停止）。返回 true 表示按键已处理。
func (a *app) reviewKeys(c *ui.Context, n store.Note) bool {
	rv := a.activeReview(n)
	if rv == nil {
		return false
	}
	if c.Shortcut(ui.Cmd, ui.KeyEnter) {
		if rv.done {
			a.applyReview(n, rv, 1)
		}
		return true
	}
	if c.Shortcut(0, ui.KeyEscape) {
		if !rv.done {
			a.cancelAI()
		}
		a.closeReview(rv)
		return true
	}
	return false
}

func reviewBtn(c *ui.Context, k tokens, key, label string) bool {
	s := stok(c)
	b := ui.Row(c).Height(20).Padding(0, 7).Radius(7).Background(s.btn).Border(1, s.btnBorder).AlignItems(ui.Center).Shrink(0).Key(key).Role(ui.RoleButton).Label(label)
	if b.Hovered() {
		b.Background(s.btnHover)
	}
	b.Children(func() { text(c, label, 10, 14, 500, s.btnFg).SingleLine() })
	return b.Clicked()
}

func reviewLink(c *ui.Context, k tokens, key, label string) bool {
	b := ui.Row(c).Padding(2, 4).Radius(4).Shrink(0).Key(key).Role(ui.RoleButton).Label(label)
	col := hoverLink(b, k)
	b.Children(func() { text(c, label, 11, 16, 400, col).Underline().SingleLine() })
	return b.Clicked()
}

// diffSpans：改动块内逐字差异——删掉的划线 + 红底，新增的绿底；红绿只落在被改动的字上。
func diffSpans(k tokens, old, new string) []ui.Span {
	var spans []ui.Span
	for _, s := range textDiff(strings.TrimRight(old, "\n"), strings.TrimRight(new, "\n")) {
		sp := ui.Span{Text: s.text, Color: k.fg}
		switch s.kind {
		case diffDel:
			sp.Color, sp.Background, sp.Strikethrough, sp.Radius = k.danger, k.danger.Alpha(0.12), true, 2
		case diffIns:
			sp.Background, sp.Radius = k.ok.Alpha(0.2), 2
		}
		spans = append(spans, sp)
	}
	return spans
}

// reviewView：详情窗正文位置的核对视图。
func (a *app) reviewView(c *ui.Context, k tokens, n store.Note, rv *aiReview) {
	s := stok(c)
	fs := a.detailFS()
	lh := fs * 1.625
	ui.Column(c).Padding(5.85, 0, 0, 0).Gap(8).Key("ai-review").Children(func() {
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			ui.Row(c).Height(18).Padding(0, 7, 0, 5).Gap(4).Radius(6).Background(s.primary.Alpha(0.1)).AlignItems(ui.Center).Shrink(0).Children(func() {
				licon(c, "sparkles", 11, s.primary)
				text(c, tr(rv.act.label), 10, 14, 500, s.primary).SingleLine()
			})
			status := ""
			switch total, decided := rv.changes(); {
			case !rv.done:
				status = fmt.Sprintf(tr("生成中，已 %d 秒"), int(c.Now().Sub(rv.started).Seconds()))
				c.AnimationFrame()
			case rv.replace:
				status = tr("全文结果，不逐段比对")
			case decided > 0:
				status = fmt.Sprintf(tr("%d 处改动，已处理 %d 处"), total, decided)
			default:
				status = fmt.Sprintf(tr("%d 处改动"), total)
			}
			text(c, status, 10, 14, 400, k.muted).SingleLine().Grow(1).Basis(0)
		})
		switch {
		case !rv.done: // 流式：边到边显示
			body := rv.buf
			if body == "" {
				body = tr("等待 AI 返回…")
			}
			text(c, body+" ▍", fs, lh, 400, k.fg).Wrap().Key("ai-stream")
		case rv.replace:
			ui.Column(c).Padding(8, 10).Radius(8).Background(k.track).Gap(2).Children(func() {
				text(c, tr("原文"), 10, 14, 500, k.muted)
				text(c, rv.orig, fs-1, (fs-1)*1.6, 400, k.muted).Wrap().MaxLines(8)
			})
			ui.Column(c).Gap(2).Children(func() {
				text(c, tr("结果"), 10, 14, 500, k.muted)
				text(c, rv.buf, fs, lh, 400, k.fg).Wrap().Key("ai-result")
			})
		default:
			for i := range rv.segs {
				sg := &rv.segs[i]
				if sg.same {
					if t := strings.Trim(sg.old, "\n"); t != "" {
						text(c, t, fs, lh, 400, k.fg).Wrap().Key("rs-" + itoa(i))
					}
					continue
				}
				row := ui.Row(c).Gap(8).AlignItems(ui.Start).Padding(4, 6, 4, 8).Margin(0, -8).Radius(8).Key("rs-" + itoa(i))
				switch sg.state {
				case 0:
					row.Background(k.fg.Alpha(0.035))
				}
				row.Children(func() {
					switch sg.state {
					case 0:
						ui.RichText(c, diffSpans(k, sg.old, sg.new)...).Font(fontSans).FontSize(fs).FixedLineHeight(lh).Wrap().Grow(1).Basis(0)
						ui.Row(c).Gap(4).Padding(1, 0, 0, 0).Shrink(0).Children(func() {
							if reviewBtn(c, k, "acc-"+itoa(i), tr("采纳")) {
								sg.state = 1
							}
							if reviewBtn(c, k, "rev-"+itoa(i), tr("还原")) {
								sg.state = 2
							}
						})
					default:
						shown, tag := sg.new, tr("已采纳")
						if sg.state == 2 {
							shown, tag = sg.old, tr("已还原")
						}
						if t := strings.Trim(shown, "\n"); t != "" {
							text(c, t, fs, lh, 400, k.fg).Wrap().Grow(1).Basis(0)
						} else {
							text(c, tr("（这一段已删除）"), fs, lh, 400, k.muted).Grow(1).Basis(0)
						}
						ui.Row(c).Gap(4).AlignItems(ui.Center).Padding(3, 0, 0, 0).Shrink(0).Children(func() {
							text(c, tag, 10, 14, 400, k.muted)
							if reviewLink(c, k, "undo-"+itoa(i), tr("撤回")) {
								sg.state = 0
							}
						})
					}
				})
			}
		}
	})
}

// reviewDock：核对期间的操作坞——一个主按钮，其余降为文字链接。
func (a *app) reviewDock(c *ui.Context, k tokens, n store.Note, rv *aiReview) {
	if !rv.done {
		if dockButton(c, k, "x", tr("停止"), false).Clicked() {
			a.cancelAI()
			a.closeReview(rv)
		}
		return
	}
	if reviewLink(c, k, "rv-new", tr("另存为新卡")) {
		a.saveReviewAsNew(n, rv)
		return
	}
	if reviewLink(c, k, "rv-drop", tr("全部还原")) {
		a.closeReview(rv)
		return
	}
	ui.Box(c).Width(8)
	label := tr("全部采纳 ⌘⏎")
	switch _, decided := rv.changes(); {
	case rv.replace:
		label = tr("替换原文 ⌘⏎")
	case decided > 0:
		label = tr("应用 ⌘⏎")
	}
	if dockButton(c, k, "check-check", label, true).Clicked() {
		a.applyReview(n, rv, 1)
	}
}

// runAIOnSelection：划词工具条里的 AI 动作——只改写选中的一段，完成后就地替换（选区期间变了就不替换）。
func (a *app) runAIOnSelection(n store.Note, lo, hi int, sel string, act aiAction) {
	if a.aiBusy != "" || strings.TrimSpace(sel) == "" {
		return
	}
	st := a.store.Settings()
	cfg := ai.Config{Endpoint: st.AIEndpoint, Key: aiKey(), Model: st.AIModel, Off: !st.AIOn()}
	ctx, cancel := context.WithCancel(context.Background())
	a.aiBusy, a.aiCancel = n.ID, cancel
	a.showHUD("info", tr("AI 处理选中内容…"))
	go func() {
		out, err := aiRewrite(ctx, cfg, act.instruction, sel)
		a.onMain(func() {
			if ctx.Err() != nil {
				return
			}
			cancel()
			a.aiBusy, a.aiCancel = "", nil
			if err != nil {
				a.showHUD("warn", err.Error())
				return
			}
			cur, ok := a.store.Note(n.ID)
			r := []rune(a.detailSource(cur))
			if !ok || a.detail.id != n.ID || lo < 0 || hi > len(r) || lo > hi || string(r[lo:hi]) != sel {
				a.showHUD("warn", tr("选中的内容已变化，没有替换"))
				return
			}
			a.replaceDetailRange(cur, lo, hi, out)
			a.showHUD("ok", tr("已处理选中内容 · ")+tr(act.label))
		})
	}()
}
