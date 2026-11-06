package main

import (
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// 提示词模板（同 Tauri「用模板发送」小窗 + 设置「提示词模板」页）：最近使用 → 当前目标推荐（常用）→ 其他模板，末尾管理入口；
// 模板含 {内容} 时注入占位处，否则作为前缀。

// templateMenu 往菜单里加「用模板发送」子菜单；notes 在选中时取要发送的卡。
func (a *app) templateMenu(m *ui.Menu, label string, notes func() []store.Note) {
	st := a.store.Settings()
	r, _ := a.resolution()
	common, rest := store.SnippetsForGroup(st.PromptSnippets, r.Group.ID)
	var recent []store.PromptSnippet
	for _, id := range st.RecentSnippets {
		if i := slices.IndexFunc(st.PromptSnippets, func(s store.PromptSnippet) bool { return s.ID == id }); i >= 0 {
			recent = append(recent, st.PromptSnippets[i])
		}
	}
	isRecent := func(s store.PromptSnippet) bool {
		return slices.ContainsFunc(recent, func(x store.PromptSnippet) bool { return x.ID == s.ID })
	}
	common = slices.DeleteFunc(common, isRecent)
	rest = slices.DeleteFunc(rest, isRecent)
	sections := []struct {
		label string
		items []store.PromptSnippet
	}{{tr("最近使用"), recent}, {tr("当前目标推荐"), common}, {tr("其他模板"), rest}}
	sections = slices.DeleteFunc(sections, func(s struct {
		label string
		items []store.PromptSnippet
	}) bool {
		return len(s.items) == 0
	})
	m.Submenu(label, func(sm *ui.Menu) {
		if len(sections) == 0 {
			if sm.Item(tr("添加模板…")).Chosen() {
				a.openSettingsAt(setPagePaste, 1)
				a.startSnippetAdd()
			}
			return
		}
		for i, sec := range sections {
			if i > 0 {
				sm.Separator()
			}
			if len(sections) > 1 { // 只有一组时不出标题
				sm.Item(sec.label).Disabled(true)
			}
			for _, sn := range sec.items {
				if sm.Item(sn.Label).Chosen() {
					if heldMods != nil && heldMods()&macos.FlagOption != 0 { // 按住 ⌥ 点：先检查再发送（同 Tauri isMenuAltHeld → forcePreflight）
						a.forceCheck = true
					}
					a.sendWithTemplate(notes(), sn)
					a.forceCheck = false
				}
			}
		}
		sm.Separator()
		if sm.Item(tr("管理模板…")).Chosen() {
			a.openSettingsAt(setPagePaste, 1)
		}
		sm.Item(tr("按住 ⌥ 点击：先检查再发送")).Disabled(true)
	})
}

func (a *app) startSnippetAdd() {
	a.snipAdd, a.snipEditID = true, ""
	a.snipLabel, a.snipText, a.snipGroup = "", "", store.GeneralPromptGroup
}

func (a *app) editSnippets(fn func(ss []store.PromptSnippet) []store.PromptSnippet) {
	st := a.store.Settings()
	st.PromptSnippets = fn(slices.Clone(st.PromptSnippets))
	_ = a.store.SetSettings(st)
}

// templateSections：设置「提示词模板」页。
func (a *app) templateSections(c *ui.Context, k tokens, s settingsTokens) []setSection {
	st := a.store.Settings()
	groups, _, _ := st.ProfileConfig()
	groupName := func(id string) string {
		if i := slices.IndexFunc(groups, func(g store.PromptGroup) bool { return g.ID == id }); i >= 0 {
			return tr(groups[i].Name)
		}
		return tr("通用")
	}
	form := func(key string, commit func()) func() {
		return func() {
			ui.Column(c).Gap(8).Padding(8, 0, 4, 0).Key(key).Children(func() {
				ui.Row(c).Gap(12).AlignItems(ui.Center).Children(func() {
					text(c, tr("名称"), 12, 17, 400, k.muted).Width(56)
					textField(c, k, s, &a.snipLabel, 240, tr("如：翻译成英文"), false)
				})
				ui.Row(c).Gap(12).Children(func() {
					text(c, tr("内容"), 12, 17, 400, k.muted).Width(56)
					ui.Column(c).Grow(1).Basis(0).Children(func() { textBox(c, k, s, &a.snipText, 3, 10) })
				})
				text(c, tr("用 {内容} 标出卡片内容插入的位置；不写则把模板放在内容前面"), 11, 16, 400, k.muted).Wrap()
				ui.Row(c).Gap(12).AlignItems(ui.Center).Children(func() {
					text(c, tr("提示词组"), 12, 17, 400, k.muted).Width(56)
					ui.PopoverMenuButton(c, groupName(a.snipGroup), func(m *ui.Menu) {
						for _, g := range groups {
							if m.Item(tr(g.Name)).Checked(g.ID == a.snipGroup).Chosen() {
								a.snipGroup = g.ID
							}
						}
					})
					ui.Spacer(c)
					if button(c, s, "取消") {
						a.snipAdd, a.snipEditID = false, ""
					}
					if button(c, s, "保存") && strings.TrimSpace(a.snipLabel) != "" && strings.TrimSpace(a.snipText) != "" {
						commit()
						a.snipAdd, a.snipEditID = false, ""
					}
				})
			})
		}
	}
	row := func(sn store.PromptSnippet) setRow {
		r := setRow{title: sn.Label, hint: preview(sn.Text, 60) + " · " + groupName(sn.GroupID), control: func() {
			ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
				star := tr("设为常用")
				if sn.IsCommon {
					star = tr("取消常用")
				}
				if button(c, s, star) {
					a.editSnippets(func(ss []store.PromptSnippet) []store.PromptSnippet {
						for i := range ss {
							if ss[i].ID == sn.ID {
								ss[i].IsCommon = !ss[i].IsCommon
							}
						}
						return ss
					})
				}
				if button(c, s, "编辑") {
					a.snipEditID, a.snipAdd = sn.ID, false
					a.snipLabel, a.snipText, a.snipGroup = sn.Label, sn.Text, sn.GroupID
				}
				if a.iconButton(c, k, "trash-2", 24, 14, tr("删除模板")) {
					prev := a.store.Settings().PromptSnippets
					a.editSnippets(func(ss []store.PromptSnippet) []store.PromptSnippet {
						return slices.DeleteFunc(ss, func(x store.PromptSnippet) bool { return x.ID == sn.ID })
					})
					a.showHUDUndo("ok", fmt.Sprintf(tr("已删除模板「%s」"), sn.Label), func() {
						cur := a.store.Settings()
						cur.PromptSnippets = prev
						_ = a.store.SetSettings(cur)
					})
				}
			})
		}}
		if a.snipEditID == sn.ID {
			r.below = form("snip-edit-"+sn.ID, func() {
				a.editSnippets(func(ss []store.PromptSnippet) []store.PromptSnippet {
					for i := range ss {
						if ss[i].ID == sn.ID {
							ss[i].Label, ss[i].Text, ss[i].GroupID = strings.TrimSpace(a.snipLabel), a.snipText, a.snipGroup
						}
					}
					return ss
				})
			})
		}
		return r
	}
	var common, other []setRow
	for _, sn := range st.PromptSnippets {
		if sn.IsCommon {
			common = append(common, row(sn))
		} else {
			other = append(other, row(sn))
		}
	}
	if len(common) == 0 {
		common = []setRow{{title: tr("暂无常用模板，可在“其他模板”中选择“设为常用”。")}}
	}
	if len(other) == 0 {
		other = []setRow{{title: tr("暂无模板")}}
	}
	add := setRow{title: tr("新增模板"), hint: tr("在卡片右键「用模板发送」与批量条里使用"), control: func() {
		if !a.snipAdd && button(c, s, "新增") {
			a.startSnippetAdd()
		}
	}}
	if a.snipAdd {
		add.below = form("snip-add", func() {
			sn := store.PromptSnippet{ID: fmt.Sprintf("snippet-%x", time.Now().UnixNano()), Label: strings.TrimSpace(a.snipLabel), Text: a.snipText, GroupID: a.snipGroup}
			a.editSnippets(func(ss []store.PromptSnippet) []store.PromptSnippet { return append(ss, sn) })
			a.showHUD("ok", fmt.Sprintf(tr("已添加模板「%s」"), sn.Label))
		})
	}
	return []setSection{
		{tr("常用模板"), common},
		{tr("其他模板"), other},
		{tr("添加"), []setRow{add}},
	}
}
