package main

import (
	"fmt"
	"slices"
	"strings"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/core"
	"github.com/toskr/native/internal/store"
)

// 设置 → 粘贴与隐私 → 可逆化名（同 Tauri AliasEntitySettings）：总开关、捕获时自动还原、词典（类别 + 原文 → 固定占位符，
// 编辑原文、删除需确认且编号不复用）、自定义类别、试一试替换效果。

type aliasUI struct {
	open                     bool // 添加表单展开
	demoOpen                 bool // 「试一试替换效果」展开
	category, input, issue   string
	editID, editText         string
	confirmDel               string
	catCode, catLabel, catIs string
	catOpen                  bool
	demo                     string
}

func (a *app) aliasRows(c *ui.Context, k tokens, s settingsTokens, st store.Settings) []setRow {
	u := &a.aliasUI
	rows := []setRow{
		{title: tr("可逆化名"), icon: "venetian-mask", hint: tr("发送时把词典里的名称换成占位符（张三 → [USER_01]），收到回复后在本机还原"), control: func() {
			v := !st.AliasOff
			if toggle(c, s, &v) {
				a.patchSettings(func(x *store.Settings) { x.AliasOff = !v })
			}
		}},
	}
	if st.AliasOff { // 同 Tauri：关闭时只留总开关
		return rows
	}
	return append(rows,
		setRow{title: tr("词典"), control: func() {
			ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
				text(c, fmt.Sprintf(tr("%d 条"), len(st.AliasEntities)), 12, 17, 400, k.muted).FontFeatures("tnum")
				if !u.open && linkButton(c, k, "alias-add", tr("+ 添加")) {
					u.open = true
				}
			})
		}, below: func() { a.aliasDictionary(c, k, s, st) }},
		setRow{title: tr("捕获回复时自动还原"), hint: tr("关闭后可在卡片上手动还原"), control: func() {
			v := !st.AliasNoAutoRestore
			if toggle(c, s, &v) {
				a.patchSettings(func(x *store.Settings) { x.AliasNoAutoRestore = !v })
			}
		}},
		setRow{title: tr("试一试替换效果"), control: func() {
			if disclosure(c, k, "alias-demo", "", u.demoOpen) {
				u.demoOpen = !u.demoOpen
			}
		}, below: func() {
			if u.demoOpen {
				a.aliasDemo(c, k, st)
			}
		}},
	)
}

func aliasCategories(st store.Settings) []store.AliasCategory {
	return slices.Concat(core.AliasPresetCategories, st.AliasCategories)
}

func (a *app) aliasDictionary(c *ui.Context, k tokens, s settingsTokens, st store.Settings) {
	u := &a.aliasUI
	cats := aliasCategories(st)
	if u.category == "" {
		u.category = "USER"
	}
	var act func()
	defer func() {
		if act != nil {
			act()
		}
	}()
	ui.Column(c).Gap(6).Children(func() {
		submit := false
		if u.open { // 添加表单：点「+ 添加」才出现，加成功或取消后收起
			ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
				pick := ui.Row(c).Height(32).Padding(0, 8).Gap(4).Radius(rr(10)).Background(s.input).Border(1, s.inputBorder).AlignItems(ui.Center).Key("alias-cat").Role(ui.RoleButton).Label(tr("化名类别"))
				pick.Children(func() {
					text(c, tr(core.AliasCategoryLabel(u.category, st.AliasCategories)), 12, 17, 400, k.fg).SingleLine()
					licon(c, "chevron-down", 12, k.muted)
				})
				pick.Menu(func(m *ui.Menu) {
					for _, cat := range cats {
						if m.Item(tr(cat.Label) + " · " + cat.Code).Radio(cat.Code == u.category).Chosen() {
							u.category = cat.Code
						}
					}
					m.Separator()
					if m.Item(tr("+ 自定义类别")).Chosen() {
						u.catOpen = true
					}
				})
				box := ui.Row(c).Grow(1).Height(32).Padding(0, 8).Radius(rr(10)).Background(s.input).Border(1, s.inputBorder).AlignItems(ui.Center)
				if u.issue != "" {
					box.Border(1, k.danger)
				}
				box.Children(func() {
					in := ui.TextInputBase(c, &u.input).Grow(1).Font(fontSans).FontSize(12).FixedLineHeight(17).TextColor(k.fg).
						PlaceholderColor(k.muted).Placeholder(tr("如：张三 / 商户 12345")).Label(tr("原文（精确匹配，区分大小写）"))
					if in.Changed() {
						u.issue = ""
					}
					submit = in.Submitted()
				})
				submit = button(c, s, "添加") || submit
				if linkButton(c, k, "alias-cancel", tr("取消")) {
					u.open, u.input, u.issue, u.catOpen = false, "", "", false
				}
			})
		}
		if submit {
			v := u.input
			act = func() {
				if u.issue = tr(a.addAliasEntity(u.category, v)); u.issue == "" {
					u.input, u.open = "", false
				}
			}
		}
		if u.issue != "" {
			text(c, u.issue, 11, 16, 400, k.danger).Wrap()
		} else if u.input != "" {
			ph, _ := core.AllocateAliasPlaceholder(u.category, st.AliasNext)
			text(c, fmt.Sprintf(tr("将分配占位符：%s"), ph), 11, 16, 400, k.muted)
		}
		if u.catOpen {
			a.aliasCategoryForm(c, k, s, st, &act)
		}
		if len(st.AliasEntities) == 0 {
			text(c, tr("暂无词典条目。添加后，发送内容里出现的原文会自动换成占位符。"), 11, 16, 400, k.muted).Wrap()
		}
		for _, e := range st.AliasEntities {
			ui.Row(c).Gap(8).Padding(2, 4, 2, 8).Radius(rr(6)).Background(k.track).AlignItems(ui.Center).Key("alias-" + e.ID).Label(tr("化名词典条目")).Children(func() {
				text(c, e.Placeholder, 11, 16, 500, k.muted).Font(fontMono).SingleLine()
				if u.editID == e.ID {
					in := ui.TextInputBase(c, &u.editText).Grow(1).Basis(0).Font(fontSans).FontSize(12).TextColor(k.fg).Focus().Label(fmt.Sprintf(tr("编辑 %s 的原文"), e.Placeholder))
					if in.Submitted() {
						id, v := e.ID, u.editText
						act = func() { a.editAliasEntity(id, v) }
					}
				} else {
					text(c, e.OriginalText, 12, 17, 400, k.fg).Wrap().Grow(1).Basis(0)
					text(c, tr(core.AliasCategoryLabel(e.Category, st.AliasCategories)), 10, 14, 400, k.muted).SingleLine()
					if ghostIconButton(c, k, "alias-edit-"+e.ID, "pencil", tr("编辑原文"), 22, 13, false, true).Clicked() {
						u.editID, u.editText, u.issue = e.ID, e.OriginalText, ""
					}
				}
				if u.confirmDel == e.ID {
					if button(c, s, "删除条目") {
						id := e.ID
						act = func() { a.deleteAliasEntity(id) }
					}
					if button(c, s, "取消") {
						u.confirmDel = ""
					}
				} else if ghostIconButton(c, k, "alias-del-"+e.ID, "trash-2", tr("删除词典条目"), 22, 13, true, true).Clicked() {
					u.confirmDel = e.ID
				}
			})
			if u.confirmDel == e.ID {
				text(c, fmt.Sprintf(tr("删除后 %s 将无法再恢复为「%s」，编号也不会复用。确定删除？"), e.Placeholder, e.OriginalText), 11, 16, 400, k.amberText).Wrap()
			}
		}
	})
}

// aliasDemo：「试一试替换效果」展开内容——输入示例句，看替换与还原结果（只在本机演示）。
func (a *app) aliasDemo(c *ui.Context, k tokens, st store.Settings) {
	u := &a.aliasUI
	ui.Column(c).Gap(6).Children(func() {
		ui.TextArea(c, &u.demo).Lines(1, 4).FontSize(12).Label(tr("化名预演输入")).Placeholder(tr("输入一句包含词典原文的示例，只在本机演示"))
		if strings.TrimSpace(u.demo) != "" {
			out, n := core.ApplyAliases(u.demo, st.AliasEntities)
			back, _ := core.RestoreAliases(out, st.AliasEntities)
			text(c, fmt.Sprintf(tr("① 替换后 · 匹配到的原文变为占位符（%d 处）"), n), 11, 16, 400, k.muted)
			text(c, out, 12, 17, 400, k.fg).Font(fontMono).Wrap()
			text(c, tr("② 恢复原文后"), 11, 16, 400, k.muted)
			text(c, back, 12, 17, 400, k.fg).Wrap()
			if back == u.demo {
				text(c, tr("还原结果与原文一致"), 11, 16, 400, c.Theme().Success)
			}
		}
	})
}

func (a *app) aliasCategoryForm(c *ui.Context, k tokens, s settingsTokens, st store.Settings, act *func()) {
	u := &a.aliasUI
	ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
		ui.TextInputBase(c, &u.catCode).Width(110).Height(30).Padding(0, 8).Radius(rr(8)).Background(s.input).Font(fontSans).FontSize(12).
			Placeholder(tr("如 VENDOR")).Label(tr("自定义类别码"))
		ui.TextInputBase(c, &u.catLabel).Grow(1).Height(30).Padding(0, 8).Radius(rr(8)).Background(s.input).Font(fontSans).FontSize(12).
			Placeholder(tr("如 供应商")).Label(tr("自定义类别显示名"))
		if button(c, s, "添加") {
			code, label := strings.TrimSpace(u.catCode), strings.TrimSpace(u.catLabel)
			*act = func() {
				if !core.ValidAliasCategoryCode(code) || slices.ContainsFunc(aliasCategories(st), func(x store.AliasCategory) bool { return x.Code == code }) {
					u.catIs = tr("类别码需为大写字母开头的英文码，且不与既有/保留类别重复")
					return
				}
				if label == "" {
					label = code
				}
				a.patchSettings(func(x *store.Settings) {
					x.AliasCategories = append(slices.Clone(x.AliasCategories), store.AliasCategory{Code: code, Label: label})
				})
				u.category, u.catCode, u.catLabel, u.catIs, u.catOpen = code, "", "", "", false
			}
		}
	})
	if u.catIs != "" {
		text(c, u.catIs, 11, 16, 400, k.danger).Wrap()
	}
}

func (a *app) editAliasEntity(id, v string) {
	u := &a.aliasUI
	st := a.store.Settings()
	if issue := core.AliasOriginalIssue(v, st.AliasEntities, id); issue != "" {
		u.issue = tr(issue)
		return
	}
	a.patchSettings(func(x *store.Settings) {
		x.AliasEntities = slices.Clone(x.AliasEntities)
		for i := range x.AliasEntities {
			if x.AliasEntities[i].ID == id {
				x.AliasEntities[i].OriginalText = v
				x.AliasEntities[i].UpdatedAtMs = a.now().UnixMilli()
			}
		}
	})
	u.editID, u.editText, u.issue = "", "", ""
}

func (a *app) deleteAliasEntity(id string) {
	a.patchSettings(func(x *store.Settings) {
		x.AliasEntities = slices.DeleteFunc(slices.Clone(x.AliasEntities), func(e store.AliasEntity) bool { return e.ID == id })
	})
	a.aliasUI.confirmDel = ""
}
