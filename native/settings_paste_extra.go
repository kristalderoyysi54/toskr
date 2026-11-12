package main

import (
	"fmt"
	"slices"
	"strings"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// 粘贴规则右侧卡片的「模板排序」「输出预览」与下方「当前目标与规则检查」（同 Tauri ApplicationRuleFields / ProfileOutputPreview / CurrentTargetPreview）。

const previewMaxRunes = 4000

func defaultPreviewText() string {
	return strings.Join([]string{tr("# 项目更新"), "", tr("- **完成**：修复发送"), tr("- [查看文档](https://example.com)")}, "\n")
}

// groupSummary：提示词组「N 条 · 前两条标签」（同 Tauri formatPromptGroupOption）。
func groupSummary(g store.PromptGroup, snippets []store.PromptSnippet) (int, string) {
	var labels []string
	n := 0
	for _, sn := range snippets {
		if sn.GroupID != g.ID {
			continue
		}
		n++
		if len(labels) < 2 {
			if l := strings.TrimSpace(sn.Label); l != "" {
				labels = append(labels, l)
			} else if t := strings.TrimSpace(sn.Text); t != "" {
				labels = append(labels, firstLine(t))
			}
		}
	}
	if len(labels) == 0 {
		return n, tr("暂无提示词")
	}
	return n, strings.Join(labels, tr("、"))
}

// ruleFold：卡片内细边折叠块（同 Tauri <details className="rounded-lg border px-3 py-2">）。
func ruleFold(c *ui.Context, k tokens, s settingsTokens, key, title string, open *bool, body func()) {
	ui.Column(c).Padding(8, 12).Radius(rr(8)).Border(1, s.rowBorder).Key(key).Children(func() {
		h := ui.Row(c).Gap(4).AlignItems(ui.Center).Role(ui.RoleButton).Label(title).Key(key + "-head")
		col := k.muted
		if h.Hovered() {
			col = k.fg
		}
		h.Children(func() {
			icon := "chevron-right"
			if *open {
				icon = "chevron-down"
			}
			licon(c, icon, 14, col)
			text(c, title, 11, 16, 500, col)
		})
		if h.Clicked() {
			*open = !*open
		}
		if *open {
			ui.Column(c).Margin(10, 0, 2, 0).Gap(6).Children(body)
		}
	})
}

// ruleTemplateOrder：「模板排序」——该方案的提示词组（只影响「其他模板」的顺序）。
func (a *app) ruleTemplateOrder(c *ui.Context, k tokens, s settingsTokens, st store.Settings, p store.TargetProfile, disabled bool, edit func(func(*store.TargetProfile))) {
	groups, _, _ := st.ProfileConfig()
	groups = slices.Clone(groups)
	slices.SortStableFunc(groups, func(x, y store.PromptGroup) int { return x.Order - y.Order })
	ruleFold(c, k, s, "rule-tmpl", tr("模板排序"), &a.paste.tmplOpen, func() {
		text(c, tr("「其他模板」里优先显示"), 11, 16, 400, k.muted)
		cur := slices.IndexFunc(groups, func(g store.PromptGroup) bool { return g.ID == p.PromptGroupID })
		label := tr("已删除的提示词组 · 请选择替代项")
		n, sum := 0, ""
		if cur >= 0 {
			label = tr(groups[cur].Name)
			n, sum = groupSummary(groups[cur], st.PromptSnippets)
		}
		b := ui.Row(c).Width(260).Height(32).Padding(0, 8).Gap(4).Radius(rr(10)).Border(1, s.inputBorder).AlignItems(ui.Center).Key("rule-group").
			Role(ui.RoleButton).Label(tr("提示词组"))
		if disabled {
			b.Opacity(0.55)
		} else if b.Hovered() {
			b.Background(k.track)
		}
		b.Children(func() {
			text(c, label, 12, 17, 400, k.fg).SingleLine().Grow(1).Basis(0)
			licon(c, "chevron-down", 14, k.muted)
		})
		if !disabled {
			b.Menu(func(m *ui.Menu) {
				for _, g := range groups {
					cnt, gs := groupSummary(g, st.PromptSnippets)
					if m.Item(fmt.Sprintf(tr("%s · %d 条 · %s"), tr(g.Name), cnt, gs)).Radio(g.ID == p.PromptGroupID).Chosen() && g.ID != p.PromptGroupID {
						id := g.ID
						edit(func(x *store.TargetProfile) { x.PromptGroupID = id })
					}
				}
			})
		}
		if cur >= 0 {
			text(c, fmt.Sprintf(tr("%d 条提示词 · %s"), n, sum), 10, 14, 400, k.muted).SingleLine()
		}
		text(c, tr("只影响「其他模板」的顺序，不会自动套用模板。"), 11, 16, 400, k.muted).Wrap()
	})
}

// ruleOutputPreview：「输出预览」——示例内容按所选输出格式转换（与发送链路同一个 FormatForDelivery），不碰卡片、剪贴板，也不粘贴。
func (a *app) ruleOutputPreview(c *ui.Context, k tokens, s settingsTokens, mode string) {
	u := &a.paste
	if !u.previewSet {
		u.preview, u.previewSet = defaultPreviewText(), true
	}
	if r := []rune(u.preview); len(r) > previewMaxRunes {
		u.preview = string(r[:previewMaxRunes])
	}
	out := store.FormatForDelivery(u.preview, mode)
	modeLabel := tr(optLabel(outputModeOpts, mode))
	ui.Column(c).Padding(12, 0, 0, 0).Gap(2).BorderWidth(1, 0, 0, 0).BorderColor(s.rowBorder).Key("rule-preview").Children(func() {
		tightText(c, tr("输出预览"), 13, 18, 400, k.fg)
		text(c, tr("用示例内容预览输出格式，不做隐私处理，也不会真实粘贴或回车。"), 11, 16, 400, k.muted).Wrap()
		ui.Row(c).Margin(8, 0, 0, 0).Padding(8).Gap(8).Radius(rr(8)).Border(1, s.rowBorder).AlignItems(ui.Stretch).Children(func() {
			ui.Column(c).Grow(1).Basis(0).Gap(4).Children(func() {
				text(c, tr("测试内容（可编辑，最多 4000 字符）"), 10, 14, 500, k.muted).SingleLine()
				box := ui.Column(c).Grow(1).Padding(6, 8).Radius(rr(8)).Background(s.input).Border(1, s.inputBorder)
				box.Children(func() {
					ui.TextAreaBase(c, &u.preview).FillWidth().Lines(5, 10).Font(fontMono).FontSize(10).FixedLineHeight(16).
						TextColor(k.fg).Label(tr("输出方式预览测试内容"))
				})
			})
			ui.Column(c).Grow(1).Basis(0).Gap(4).Children(func() {
				text(c, fmt.Sprintf(tr("格式预览 · %s"), modeLabel), 10, 14, 500, k.muted).SingleLine()
				shown, col := out, k.fg
				if strings.TrimSpace(out) == "" {
					shown, col = tr("（空内容不会发送）"), k.muted
				}
				ui.Column(c).Grow(1).Padding(6, 8).Radius(rr(8)).Background(k.track.Alpha(0.6)).Key("rule-preview-out").
					Label(fmt.Sprintf(tr("%s格式预览结果"), modeLabel)).Children(func() {
					text(c, shown, 10, 16, 400, col).Font(fontMono).Wrap()
				})
			})
		})
	})
}

// currentTargetSection：「当前目标与规则检查」——当前粘贴目标、状态、生效方案与来源；检查只重算并说明，不粘贴不回车。
func (a *app) currentTargetSection(c *ui.Context, k tokens, s settingsTokens) setSection {
	u := &a.paste
	rows := []setRow{{title: tr("当前目标与规则检查"), hint: tr("看看现在会粘贴到哪里、用哪套规则"), control: func() {
		val := tr("未识别")
		if a.target.PID != 0 {
			val = a.appName(a.target.BundleID)
		}
		if disclosure(c, k, "paste-target", val, u.targetOpen) {
			u.targetOpen = !u.targetOpen
		}
	}}}
	if !u.targetOpen {
		return setSection{rows: rows, key: "paste-target"}
	}
	r, stale := a.resolution()
	bundle := a.target.BundleID
	known := a.target.PID != 0 && bundle != ""
	name := tr("未识别目标")
	if known {
		name = a.appName(bundle)
	}
	status, tone := tr("尚未识别"), k.muted
	switch {
	case known && a.targetReady():
		status, tone = tr("可粘贴"), k.ok
	case known:
		status, tone = tr("应用已退出"), k.danger
	}
	rows[0].below = func() {
		ui.Column(c).Margin(4, 0, 0, 0).Gap(8).Key("paste-target-body").Children(func() {
			ui.Row(c).Gap(10).AlignItems(ui.Center).Children(func() {
				ui.Box(c).Size(32, 32).Radius(rr(8)).Background(k.track).Center().Children(func() {
					var img ui.ImageSource
					if known {
						img = a.appIcon(bundle)
					}
					if img != nil {
						ui.Image(c, img).Size(24, 24)
					} else {
						licon(c, "app-window", 16, k.muted)
					}
				})
				ui.Column(c).Grow(1).Basis(0).Gap(1).Children(func() {
					text(c, tr("当前粘贴目标"), 10, 14, 500, k.muted)
					ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
						tipOf(c, text(c, name, 13, 18, 600, k.fg).SingleLine(), bundle)
						ui.Row(c).Height(18).Padding(0, 6).Radius(9).Background(tone.Alpha(0.12)).AlignItems(ui.Center).Children(func() {
							text(c, status, 10, 14, 500, tone).SingleLine()
						})
					})
				})
				if known && linkButton(c, k, "paste-target-edit", tr("调整粘贴规则")) {
					a.editTargetRule()
				}
			})
			if !known {
				text(c, tr("请先点目标应用的输入框，再唤出 Toskr。位置未确认前不会粘贴。"), 11, 16, 400, k.muted).Wrap()
			}
			ui.Column(c).Padding(8, 10).Gap(3).Radius(rr(8)).Background(k.track.Alpha(0.6)).Children(func() {
				text(c, fmt.Sprintf(tr("使用方案：%s"), profileName(r.Profile)), 11, 16, 500, k.fg).SingleLine()
				text(c, fmt.Sprintf(tr("规则来源：%s"), a.matchReason(r, stale)), 11, 16, 400, k.muted).Wrap()
				text(c, fmt.Sprintf(tr("其他模板优先显示「%s」组；不会自动套用模板。"), tr(r.Group.Name)), 11, 16, 400, k.muted).Wrap()
			})
			ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
				if button(c, s, "检查规则") {
					u.checkMsg = a.checkTargetRule()
				}
				if linkButton(c, k, "paste-target-refresh", tr("重新识别目标")) {
					a.refreshTargetFromFront()
					u.checkMsg = ""
				}
			})
			if u.checkMsg != "" {
				text(c, u.checkMsg, 11, 16, 400, k.muted).Wrap()
			}
		})
	}
	return setSection{rows: rows, key: "paste-target"}
}

// checkTargetRule：重新计算当前目标的规则并说明结果（同 Tauri testCurrentTarget），不执行粘贴或回车。
func (a *app) checkTargetRule() string {
	r, _ := a.resolution()
	avail := tr("尚未识别粘贴目标")
	switch {
	case a.target.PID != 0 && a.targetReady():
		avail = tr("已识别目标应用，输入位置未确认")
	case a.target.PID != 0:
		avail = tr("请重新选择目标输入框")
	}
	return fmt.Sprintf(tr("规则已重新计算：%s · %s。未执行粘贴或回车。"), profileName(r.Profile), avail)
}

// editTargetRule：左列选中当前目标应用，右侧卡片就是它的规则。
func (a *app) editTargetRule() {
	b := a.target.BundleID
	if b == "" || b == selfBundle() {
		return
	}
	a.paste.sel, a.paste.shared = b, false
}
