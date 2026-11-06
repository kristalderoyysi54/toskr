package main

import (
	"fmt"
	"slices"
	"strings"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/core"
	"github.com/toskr/native/internal/store"
)

// 粘贴与隐私 → 发送前隐私检查（同 Tauri FirewallSettings + CustomSensitiveFields）：总开关、提示级检测类别逐项开关、
// 自定义敏感字段（字段名后面的值按高风险检查）。高风险规则（私钥、令牌、密钥、密码字段）始终检测。

type firewallUI struct {
	catsOpen, fieldsOpen bool
	input, issue         string
}

func (a *app) patchSettings(f func(*store.Settings)) {
	cur := a.store.Settings()
	f(&cur)
	_ = a.store.SetSettings(cur)
}

// disclosure 是右侧「值 + 箭头」的展开入口（Tauri DisclosureRow）。
func disclosure(c *ui.Context, k tokens, key, value string, open bool) bool {
	b := ui.Row(c).Gap(4).Padding(2, 6).Radius(6).AlignItems(ui.Center).Key(key).Role(ui.RoleButton).Label(value)
	col := hoverLink(b, k)
	icon := "chevron-right"
	if open {
		icon = "chevron-down"
	}
	b.Children(func() {
		text(c, value, 12, 17, 400, col).SingleLine()
		licon(c, icon, 14, col)
	})
	return b.Clicked()
}

func (a *app) firewallRows(c *ui.Context, k tokens, s settingsTokens, st store.Settings) []setRow {
	f := &a.fw
	on := !st.FirewallOff
	hint := tr("检查文字和图片，发现敏感内容时先让你确认")
	if !on {
		hint = tr("已关闭：发送前不检查；可逆化名不受影响")
	}
	enabled := 0
	for _, cat := range core.WarnCategories {
		if !slices.Contains(st.FirewallDisabledWarn, cat) {
			enabled++
		}
	}
	catVal := tr("全部开启")
	switch {
	case !on:
		catVal = tr("未生效")
	case enabled < len(core.WarnCategories):
		catVal = fmt.Sprintf(tr("已开启 %d/%d"), enabled, len(core.WarnCategories))
	}
	fieldVal := tr("未添加")
	if n := len(st.FirewallCustomFields); n > 0 {
		fieldVal = fmt.Sprintf(tr("%d 个"), n)
	}
	return []setRow{
		{title: tr("发送前隐私检查"), hint: hint, control: func() {
			v := on
			if toggle(c, s, &v) {
				a.patchSettings(func(x *store.Settings) { x.FirewallOff = !v })
			}
		}},
		{title: tr("检测类别"), control: func() {
			if disclosure(c, k, "fw-cats", catVal, f.catsOpen) {
				f.catsOpen = !f.catsOpen
			}
		}, below: func() {
			if f.catsOpen {
				a.firewallCategories(c, k, s, st, on)
			}
		}},
		{title: tr("自定义敏感字段"), control: func() {
			if disclosure(c, k, "fw-fields", fieldVal, f.fieldsOpen) {
				f.fieldsOpen = !f.fieldsOpen
			}
		}, below: func() {
			if f.fieldsOpen {
				a.firewallFields(c, k, s, st, on)
			}
		}},
		{title: tr("发现后如何处理"), hint: tr("按粘贴规则：在面板里确认、遮罩后发送或保留原文（见下方「发送方案」）。本机规则可能漏检，发送前仍可在预检中核对最终内容。")},
	}
}

func (a *app) firewallCategories(c *ui.Context, k tokens, s settingsTokens, st store.Settings, on bool) {
	ui.Column(c).Gap(8).Margin(6, 0, 0, 0).Children(func() {
		cats := core.WarnCategories
		for i := 0; i < len(cats); i += 2 {
			ui.Row(c).Gap(8).Children(func() {
				for _, cat := range cats[i:min(i+2, len(cats))] {
					label := tr(core.CategoryLabel[cat])
					cell := ui.Row(c).Grow(1).Basis(0).Gap(8).Padding(4, 10).Radius(8).Background(k.track).AlignItems(ui.Center).Key("fw-cat-" + cat).Label(label + tr("提示"))
					if !on {
						cell.Opacity(0.5)
					}
					cell.Children(func() {
						text(c, label, 12, 17, 400, k.fg).SingleLine().Grow(1)
						v := !slices.Contains(st.FirewallDisabledWarn, cat)
						var hit bool
						ui.Box(c).Margin(6, 0, 0, 0).Children(func() { hit = toggle(c, s, &v) }) // toggle 盒 24 高、开关 18 贴顶：下补 6 让开关在格内垂直居中
						if hit && on {
							a.patchSettings(func(x *store.Settings) {
								x.FirewallDisabledWarn = slices.DeleteFunc(slices.Clone(x.FirewallDisabledWarn), func(y string) bool { return y == cat })
								if !v {
									x.FirewallDisabledWarn = append(x.FirewallDisabledWarn, cat)
								}
							})
						}
					})
				}
				if len(cats[i:]) == 1 {
					ui.Box(c).Grow(1).Basis(0).Padding(4, 10) // 同格子内边距，否则单格比上面两行宽
				}
			})
		}
		text(c, tr("私钥、授权凭据、密钥、数据库连接、Cookie 等高风险内容始终检测，不能关闭。"), 11, 16, 400, k.muted).Wrap()
	})
}

func (a *app) firewallFields(c *ui.Context, k tokens, s settingsTokens, st store.Settings, on bool) {
	f := &a.fw
	fields := st.FirewallCustomFields
	ui.Column(c).Gap(6).Margin(6, 0, 0, 0).Children(func() {
		if !on {
			text(c, tr("隐私检查已关闭，重新开启后这些字段才会参与检测。"), 11, 16, 400, k.amberText).Wrap()
		}
		submit := false
		ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
			box := ui.Row(c).Grow(1).Height(32).Padding(0, 8).Radius(10).Background(s.input).Border(1, s.inputBorder).AlignItems(ui.Center)
			if f.issue != "" {
				box.Border(1, k.danger)
			}
			box.Children(func() {
				in := ui.TextInputBase(c, &f.input).Grow(1).Font(fontSans).FontSize(12).FixedLineHeight(17).TextColor(k.fg).
					PlaceholderColor(k.muted).Placeholder(tr("字段名，如 内部口令、partner_secret")).Label(tr("敏感字段名"))
				if in.Changed() {
					f.issue = ""
				}
				submit = in.Submitted()
			})
			submit = button(c, s, "添加") || submit
		})
		if submit {
			if f.issue = tr(core.CustomFieldIssue(f.input, fields)); f.issue == "" {
				v := strings.TrimSpace(f.input)
				a.patchSettings(func(x *store.Settings) { x.FirewallCustomFields = append(slices.Clone(x.FirewallCustomFields), v) })
				f.input = ""
			}
		}
		if f.issue != "" {
			text(c, f.issue, 11, 16, 400, k.danger).Wrap()
		} else {
			text(c, tr("字段后面的值会按高风险内容检查，不需要填写真实密钥。"), 11, 16, 400, k.muted).Wrap()
		}
		for _, name := range fields {
			ui.Row(c).Gap(8).Padding(2, 4, 2, 8).Radius(6).Background(k.track).AlignItems(ui.Center).Key("fw-field-" + name).Children(func() {
				text(c, name, 12, 17, 400, k.fg).Wrap().Grow(1).Basis(0)
				if ghostIconButton(c, k, "fw-del-"+name, "trash-2", fmt.Sprintf(tr("删除敏感字段 %s"), name), 22, 13, true, true).Clicked() {
					a.patchSettings(func(x *store.Settings) {
						x.FirewallCustomFields = slices.DeleteFunc(slices.Clone(x.FirewallCustomFields), func(y string) bool { return y == name })
					})
				}
			})
		}
	})
}
