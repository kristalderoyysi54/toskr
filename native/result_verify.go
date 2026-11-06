package main

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/core"
	"github.com/toskr/native/internal/diag"
	"github.com/toskr/native/internal/store"
)

// 回复检查（同 Tauri ResultVerificationDialog）：对关联了某次发送的回复卡，先用本地规则查遗漏与格式问题
// （core.VerifyResult），需要时再让 AI 对照（发出前本地替换敏感项，可取消）。报告可存为笔记，待确认问题可进预检继续发。

type verifyState struct {
	noteID           string
	format           string // auto | text | json
	sections, fields string
	report           *core.VerifyReport
	aiText           string
	aiBusy           bool
	aiCancel         context.CancelFunc
}

func (a *app) openVerify(n store.Note) {
	if n.Provenance == nil {
		return
	}
	a.cancelVerifyAI()
	a.verify = verifyState{noteID: n.ID, format: "auto"}
}

func (a *app) closeVerify() {
	a.cancelVerifyAI()
	a.verify = verifyState{}
}

func (a *app) cancelVerifyAI() {
	if a.verify.aiCancel != nil {
		a.verify.aiCancel()
	}
	a.verify.aiBusy, a.verify.aiCancel = false, nil
}

// verifyContext：回复卡 + 它关联的发送 → 核验上下文与已知占位符次数（nil = 本次运行里没有这次发送的映射）。
func (a *app) verifyContext(n store.Note) (core.VerifyContext, map[string]int) {
	ctx := core.VerifyContext{ResultText: n.Text, ResultImages: len(n.MediaFiles())}
	ids := n.Provenance.SourceIDs
	for _, d := range a.store.Deliveries() {
		if d.ID == n.Provenance.DeliveryID && len(d.SourceIDs) > 0 {
			ids = d.SourceIDs
		}
	}
	var texts []string
	for _, id := range ids {
		src, ok := a.store.Note(id)
		if !ok {
			ctx.MissingSources = append(ctx.MissingSources, id)
			continue
		}
		ctx.Sources++
		ctx.SourceImages += len(src.MediaFiles())
		if src.Kind != "image" {
			texts = append(texts, src.Text)
		}
	}
	if len(texts) > 0 {
		ctx.SourceText = sendText(texts)
	}
	var counts map[string]int
	if s := a.redactionSessionOf(n.Provenance.DeliveryID); s != nil {
		counts = s.counts
	}
	return ctx, counts
}

func (a *app) runVerify() {
	n, ok := a.store.Note(a.verify.noteID)
	if !ok || n.Provenance == nil {
		a.closeVerify()
		return
	}
	ctx, counts := a.verifyContext(n)
	exp := core.VerifyExpectation{Format: a.verify.format, Sections: lines(a.verify.sections), JSONFields: lines(a.verify.fields), Placeholders: counts}
	r := core.VerifyResult(ctx, exp, a.now())
	a.verify.report, a.verify.aiText = &r, ""
	a.store.RecordOutcome(store.OutcomeEvent{DeliveryID: n.Provenance.DeliveryID, Type: store.OutVerified, Verify: string(r.Status)})
	diag.Push("回复检查: 状态=%s 检查 %d 项 缺失 %d", r.Status, len(r.Checks), len(r.Missing))
}

// redactForAI：发给 AI 前按隐私检查把敏感项换成占位符（同 Tauri prepareVerificationAiInput）。
func (a *app) redactForAI(text string, ph map[string]string) (string, int) {
	fs := core.Scan(text, a.scanRules())
	if len(fs) == 0 {
		return text, 0
	}
	return core.ReplaceWithPlaceholders(text, fs, ph), len(fs)
}

func (a *app) runVerifyAI() {
	n, ok := a.store.Note(a.verify.noteID)
	if !ok || a.verify.report == nil || a.verify.aiBusy {
		return
	}
	cfg := a.aiConfig()
	ctx, _ := a.verifyContext(n)
	ph := map[string]string{}
	src, k1 := a.redactForAI(ctx.SourceText, ph)
	res, k2 := a.redactForAI(ctx.ResultText, ph)
	system := "你是结果核验助手。对照「发送内容」检查「回复」是否完整回应、是否有遗漏、编造或与要求不符之处。只列证据充分的问题，按「遗漏 / 新增假设 / 风险 / 待确认问题」分组，用简体中文、条目式输出；没问题就明确说没发现。占位符（如 [EMAIL_01]）是本地脱敏，不算问题。"
	user := "## 发送内容\n" + src + "\n\n## 回复\n" + res + "\n\n## 本地规则检查\n" + core.FormatVerifyReport(*a.verify.report)
	if s := strings.TrimSpace(a.verify.sections); s != "" {
		user += "\n\n## 用户期望的必要段落\n" + s
	}
	c, cancel := context.WithCancel(context.Background())
	a.verify.aiBusy, a.verify.aiCancel = true, cancel
	id := a.verify.noteID
	if k1+k2 > 0 {
		a.showHUD("info", fmt.Sprintf(tr("%d 项 finding 已本地替换"), k1+k2))
	}
	go func() {
		out, err := aiRewrite(c, cfg, system, user)
		a.onMain(func() {
			if c.Err() != nil || a.verify.noteID != id {
				return // 已取消或换了卡：结果丢弃
			}
			cancel()
			a.verify.aiBusy, a.verify.aiCancel = false, nil
			if err != nil {
				a.aiFailed(err)
				return
			}
			a.verify.aiText = strings.TrimSpace(out)
		})
	}()
}

// saveVerifyNote：报告 / 问题清单存为关联同一次发送的普通笔记（放在回复卡所在分组）。
func (a *app) saveVerifyNote(text, title string) (store.Note, bool) {
	n, ok := a.store.Note(a.verify.noteID)
	if !ok || n.Provenance == nil || text == "" {
		return store.Note{}, false
	}
	p := *n.Provenance
	p.SourceIDs = slices.Clone(p.SourceIDs)
	sec := n.Section
	if sec == store.SectionClipboard {
		sec = store.SectionInbox
	}
	saved, dup, err := a.store.Add(store.Note{Section: sec, Text: text, Title: title, Provenance: &p})
	if err != nil {
		a.showHUD("warn", tr("报告保存失败"))
		return store.Note{}, false
	}
	if dup {
		a.showHUD("duplicate", tr("回复检查报告笔记已存在"))
	}
	return saved, true
}

func verifyIcon(st core.VerifyStatus) (string, func(tokens, ui.Theme) ui.Color) {
	switch st {
	case core.VerifyBlock:
		return "circle-alert", func(k tokens, _ ui.Theme) ui.Color { return k.danger }
	case core.VerifyReview:
		return "triangle-alert", func(k tokens, _ ui.Theme) ui.Color { return k.amberText }
	}
	return "circle-check", func(_ tokens, t ui.Theme) ui.Color { return t.Success }
}

// verifySheet：回复检查浮层（覆盖面板）。
func (a *app) verifySheet(c *ui.Context, k tokens) {
	if a.verify.noteID == "" {
		return
	}
	n, ok := a.store.Note(a.verify.noteID)
	if !ok || n.Provenance == nil {
		a.closeVerify()
		return
	}
	t := c.Theme()
	w, h := c.Size()
	var act func()
	defer func() {
		if act != nil {
			act()
		}
	}()
	ui.Overlay(c, func() {
		ui.Box(c).Absolute().Left(0).Top(0).Size(w, h).Background(ui.RGBA(0, 0, 0, 0.18)).Key("verify-dim") // token-exception: 浮层遮罩
		sheet := floatSurface(ui.Column(c).Absolute().Left(10).Top(40).Width(w-20).Height(h-60).Radius(14).Key("verify-sheet"), k)
		sheet.Children(func() {
			ui.Row(c).Padding(10, 12).Gap(8).AlignItems(ui.Center).Children(func() {
				licon(c, "file-check-corner", 15, k.fg)
				text(c, tr("回复检查"), 13, 18, 600, k.fg).Grow(1)
				if ghostIconButton(c, k, "verify-close", "x", tr("关闭回复检查"), 22, 13, false, true).Clicked() {
					act = a.closeVerify
				}
			})
			ui.Scroll(c).Grow(1).Basis(0).Scrollbars(false).Children(func() {
				ui.Column(c).Padding(0, 12, 12, 12).Gap(8).Children(func() {
					ctx, counts := a.verifyContext(n)
					text(c, tr("先用本地规则查找遗漏和格式问题；需要时再让 AI 对照。"), 11, 16, 400, k.muted).Wrap()
					text(c, fmt.Sprintf(tr("来源 %d 字符 · 结果 %d 字符"), len([]rune(ctx.SourceText)), len([]rune(ctx.ResultText))), 11, 16, 400, k.muted)
					if counts == nil {
						text(c, tr("发送会话映射已失效：无法完整核对占位符，需人工复核。"), 11, 16, 400, k.amberText).Wrap()
					} else if len(counts) > 0 {
						text(c, fmt.Sprintf(tr("已知发送占位符 %d 项。"), len(counts)), 11, 16, 400, k.muted)
					}
					text(c, tr("为保护隐私，发送记录不保存正文。本次比较的是当前发送内容与当前回复；如果原卡后来编辑过，请人工再确认。"), 10, 14, 400, k.muted).Wrap()
					text(c, tr("你希望回复满足什么？"), 12, 17, 600, k.fg)
					ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
						text(c, tr("预期格式"), 11, 16, 400, k.muted)
						for _, f := range [][2]string{{"auto", "自动"}, {"text", "文本"}, {"json", "JSON"}} {
							ui.Radio(c, &a.verify.format, f[0], tr(f[1]))
						}
					})
					text(c, tr("必要标题或段落（每行一个）"), 11, 16, 400, k.muted)
					ui.TextArea(c, &a.verify.sections).Lines(2, 5).FontSize(12).Label(tr("必要标题或段落（每行一个）"))
					if a.verify.format != "text" {
						text(c, tr("JSON 必填字段（每行一个，可用 a.b）"), 11, 16, 400, k.muted)
						ui.TextArea(c, &a.verify.fields).Lines(2, 5).FontSize(12).Label(tr("JSON 必填字段（每行一个，可用 a.b）"))
					}
					ui.Row(c).Gap(6).Children(func() {
						if ui.Button(c, tr("检查回复")).Clicked() {
							act = a.runVerify
						}
						if a.verify.report != nil {
							if a.verify.aiBusy {
								if ui.Button(c, tr("取消检查")).Clicked() {
									act = func() { a.cancelVerifyAI(); a.showHUD("info", tr("AI 检查已取消；回复卡没有被修改")) }
								}
							} else if ui.Button(c, tr("AI 深度检查")).Tooltip(tr("需要时再用 AI 检查")).Clicked() {
								act = a.runVerifyAI
							}
						}
					})
					if r := a.verify.report; r != nil {
						a.verifyReportView(c, k, *t, *r, &act)
					}
				})
			})
		})
	})
}

func (a *app) verifyReportView(c *ui.Context, k tokens, t ui.Theme, r core.VerifyReport, act *func()) {
	icon, col := verifyIcon(r.Status)
	ui.Row(c).Gap(6).AlignItems(ui.Center).Padding(6, 0, 0, 0).Children(func() {
		licon(c, icon, 14, col(k, t))
		text(c, tr(r.Status.Label()), 12, 17, 600, col(k, t))
	})
	text(c, tr("回复检查项"), 11, 16, 600, k.muted)
	for _, ch := range r.Checks {
		ic, cc := verifyIcon(ch.Status)
		ui.Row(c).Gap(6).AlignItems(ui.Start).Key("vchk-" + ch.ID).Children(func() {
			licon(c, ic, 12, cc(k, t)).Margin(2, 0, 0, 0)
			text(c, ch.Message, 11, 16, 400, k.fg).Wrap().Grow(1).Basis(0)
		})
	}
	for _, sec := range []struct {
		title string
		items []string
	}{{"明确缺失", r.Missing}, {"新增假设", r.Assumptions}, {"风险", r.Risks}, {"待确认问题", r.Questions}} {
		if len(sec.items) == 0 {
			continue
		}
		text(c, tr(sec.title), 11, 16, 600, k.muted).Margin(4, 0, 0, 0)
		for _, it := range sec.items {
			text(c, "· "+it, 11, 16, 400, k.fg).Wrap()
		}
	}
	if a.verify.aiBusy {
		ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
			ui.Spinner(c).Size(12, 12)
			text(c, tr("AI 检查进行中"), 11, 16, 400, k.muted)
		})
	}
	if a.verify.aiText != "" {
		text(c, tr("AI 深度检查"), 11, 16, 600, k.muted).Margin(4, 0, 0, 0)
		text(c, a.verify.aiText, 11, 16, 400, k.fg).Wrap().Selectable()
	}
	text(c, tr("核验只呈现规则内证据、遗漏和问题，不代表结果完全正确，也不替代人工审批。"), 10, 14, 400, k.muted).Wrap()
	ui.Row(c).Gap(6).Children(func() {
		if ui.Button(c, tr("保存为笔记")).Clicked() {
			*act = func() {
				body := core.FormatVerifyReport(r)
				if a.verify.aiText != "" {
					body += "\n\n## AI 深度检查\n" + a.verify.aiText
				}
				if _, ok := a.saveVerifyNote(body, tr("结果核验报告")); ok {
					a.reload()
					a.showHUD("ok", tr("回复检查报告已保存为普通笔记"))
				}
			}
		}
		q := core.VerifyQuestionsText(r)
		b := ui.Button(c, tr("问题进入预检"))
		if q == "" {
			b.Disabled(true).Tooltip(tr("当前报告没有可继续发送的问题"))
		}
		if q != "" && b.Clicked() {
			*act = func() {
				if note, ok := a.saveVerifyNote(q, tr("结果核验待确认问题")); ok {
					a.reload()
					a.closeVerify()
					a.checkSend([]store.Note{note})
				}
			}
		}
	})
}
