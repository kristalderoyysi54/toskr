package main

import (
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// 设置 → 粘贴与隐私 →「发送方案」（同 Tauri TargetProfileManager 的精简版）：默认方案、方案列表、逐个编辑（名称、应用、输出格式、
// 粘贴后、隐私、完成后），按预设新建，删除（内置稳妥发送不可删）。

const setPagePaste = 3 // 设置窗「粘贴与隐私」页序号

func (a *app) openSettingsAt(page int) {
	a.openSettings()
	a.setPage, a.setSub, a.setQuery = page, 0, ""
}

var profilePresets = []store.TargetProfile{
	{ID: "safe", Name: "稳妥发送", DefaultFormat: "plain", DefaultMarkdownMode: "preserve", EnterPolicy: "never", PrivacyPolicy: "requireRedaction"},
	{ID: "ai", Name: "AI 对话", DefaultFormat: "plain", DefaultMarkdownMode: "preserve", EnterPolicy: "confirm", PrivacyPolicy: "confirmRaw", KeepPanel: true},
	{ID: "terminal", Name: "终端只粘贴", DefaultFormat: "code", DefaultMarkdownMode: "preserve", EnterPolicy: "never", PrivacyPolicy: "requireRedaction"},
	{ID: "custom", Name: "自定义", DefaultFormat: "plain", DefaultMarkdownMode: "preserve", EnterPolicy: "never", PrivacyPolicy: "requireRedaction"},
}

// updateProfiles 改写方案配置并落盘（首次修改时把内置默认写进设置）。
func (a *app) updateProfiles(fn func(ps []store.TargetProfile, def string) ([]store.TargetProfile, string)) {
	st := a.store.Settings()
	groups, ps, def := st.ProfileConfig()
	st.TargetProfiles, st.DefaultProfileID = fn(ps, def)
	st.PromptGroups = groups
	_ = a.store.SetSettings(st)
}

func (a *app) editProfile(id string, fn func(p *store.TargetProfile)) {
	a.updateProfiles(func(ps []store.TargetProfile, def string) ([]store.TargetProfile, string) {
		if i := slices.IndexFunc(ps, func(p store.TargetProfile) bool { return p.ID == id }); i >= 0 {
			fn(&ps[i])
		}
		return ps, def
	})
}

func profileSummary(p store.TargetProfile) string {
	parts := []string{optLabel(outputModeOpts, p.OutputMode()), optLabel(enterOpts, p.EnterPolicy)}
	if n := len(p.BundleIDs); n > 0 {
		parts = append([]string{fmt.Sprintf(tr("%d 个应用"), n)}, parts...)
	}
	if p.KeepPanel {
		parts = append(parts, tr("完成后保持打开"))
	}
	return strings.Join(parts, " · ")
}

func (a *app) profileSection(c *ui.Context, k tokens, s settingsTokens) []setRow {
	_, ps, def := a.store.Settings().ProfileConfig()
	rows := []setRow{{title: tr("默认方案"), hint: tr("未单独指定的应用使用它；粘贴后动作与隐私策略始终按最稳妥执行"), control: func() {
		i := max(0, slices.IndexFunc(ps, func(p store.TargetProfile) bool { return p.ID == def }))
		ui.PopoverMenuButton(c, profileName(ps[i]), func(m *ui.Menu) {
			for _, p := range ps {
				if m.Item(profileName(p)).Checked(p.ID == def).Chosen() {
					a.updateProfiles(func(ps []store.TargetProfile, _ string) ([]store.TargetProfile, string) { return ps, p.ID })
				}
			}
		}).Key("default-profile")
	}}}
	for _, p := range ps {
		p := p
		title := profileName(p)
		if p.ID == def {
			title += " · " + tr("默认")
		}
		row := setRow{title: title, hint: profileSummary(p), control: func() {
			label := tr("编辑")
			if a.editProfileID == p.ID {
				label = tr("收起")
			}
			if button(c, s, label) {
				if a.editProfileID == p.ID {
					a.editProfileID = ""
				} else {
					a.editProfileID, a.profName = p.ID, p.Name
				}
			}
		}}
		if a.editProfileID == p.ID {
			row.below = func() { a.profileEditor(c, k, s, p, def) }
		}
		rows = append(rows, row)
	}
	rows = append(rows, setRow{title: tr("新建发送方案"), hint: tr("从预设开始，之后可逐项调整"), control: func() {
		ui.PopoverMenuButton(c, tr("新建"), func(m *ui.Menu) {
			for _, pre := range profilePresets {
				if m.Item(tr(pre.Name)).Chosen() {
					np := pre
					np.ID, np.PromptGroupID = fmt.Sprintf("profile-%x", time.Now().UnixNano()), store.GeneralPromptGroup
					a.updateProfiles(func(ps []store.TargetProfile, def string) ([]store.TargetProfile, string) { return append(ps, np), def })
					a.editProfileID, a.profName = np.ID, np.Name
				}
			}
		}).Key("new-profile")
	}})
	return rows
}

func (a *app) profileEditor(c *ui.Context, k tokens, s settingsTokens, p store.TargetProfile, def string) {
	field := func(label string, body func()) {
		ui.Row(c).Gap(12).AlignItems(ui.Center).Children(func() {
			text(c, label, 12, 17, 400, k.muted).Width(72)
			body()
		})
	}
	ui.Column(c).Gap(10).Padding(10, 0, 4, 0).Key("profile-editor-" + p.ID).Children(func() {
		field(tr("名称"), func() {
			if textField(c, k, s, &a.profName, 220, tr("方案名称"), false) && strings.TrimSpace(a.profName) != "" {
				a.editProfile(p.ID, func(x *store.TargetProfile) { x.Name = strings.TrimSpace(a.profName) })
			}
		})
		field(tr("应用"), func() {
			ui.Row(c).Gap(6).Wrap().Grow(1).AlignItems(ui.Center).Children(func() {
				for _, b := range p.BundleIDs {
					ui.Row(c).Gap(4).Padding(2, 8).Radius(999).Background(k.track).AlignItems(ui.Center).Children(func() {
						text(c, b, 11, 16, 400, k.fg).Font(fontMono)
						if a.iconButton(c, k, "x", 16, 10, fmt.Sprintf(tr("从当前发送方案移除 %s"), b)) {
							a.editProfile(p.ID, func(x *store.TargetProfile) {
								x.BundleIDs = slices.DeleteFunc(x.BundleIDs, func(y string) bool { return y == b })
							})
						}
					})
				}
				if len(p.BundleIDs) == 0 {
					text(c, tr("未指定应用"), 11, 16, 400, k.muted)
				}
				if t := a.target; t.BundleID != "" && !slices.Contains(p.BundleIDs, t.BundleID) && button(c, s, fmt.Sprintf(tr("添加 %s"), t.Name)) {
					a.updateProfiles(func(ps []store.TargetProfile, def string) ([]store.TargetProfile, string) {
						for i := range ps { // 一个应用只属于一个方案，避免重复绑定冲突
							ps[i].BundleIDs = slices.DeleteFunc(ps[i].BundleIDs, func(y string) bool { return y == t.BundleID })
							if ps[i].ID == p.ID {
								ps[i].BundleIDs = append(ps[i].BundleIDs, t.BundleID)
							}
						}
						return ps, def
					})
				}
			})
		})
		pick := func(label string, opts []opt, cur string, set func(x *store.TargetProfile, v string)) {
			field(label, func() {
				i := max(0, slices.IndexFunc(opts, func(o opt) bool { return o.v == cur }))
				var labels []string
				for _, o := range opts {
					labels = append(labels, o.label)
				}
				if segmented(c, k, &i, labels...) {
					a.editProfile(p.ID, func(x *store.TargetProfile) { set(x, opts[i].v) })
				}
			})
		}
		pick(tr("输出格式"), outputModeOpts, p.OutputMode(), func(x *store.TargetProfile, v string) { x.SetOutputMode(v) })
		pick(tr("粘贴后"), enterOpts, p.EnterPolicy, func(x *store.TargetProfile, v string) { x.EnterPolicy = v })
		pick(tr("隐私检查"), privacyOpts, p.PrivacyPolicy, func(x *store.TargetProfile, v string) { x.PrivacyPolicy = v })
		field(tr("完成后"), func() {
			keep := p.KeepPanel
			if toggle(c, s, &keep) {
				a.editProfile(p.ID, func(x *store.TargetProfile) { x.KeepPanel = keep })
			}
			text(c, tr("发送后保持面板打开"), 11, 16, 400, k.muted)
		})
		if p.EnterPolicy == "allow" {
			text(c, tr("自动按回车：内容会直接提交或执行，只适合明确可信的目标。"), 11, 16, 400, k.amberText).Wrap()
		}
		if p.ID != store.SafetyProfileID {
			ui.Row(c).Children(func() {
				if button(c, s, "删除此方案") {
					prev := a.store.Settings()
					a.updateProfiles(func(ps []store.TargetProfile, def string) ([]store.TargetProfile, string) {
						ps = slices.DeleteFunc(ps, func(x store.TargetProfile) bool { return x.ID == p.ID })
						if def == p.ID {
							def = ps[0].ID
						}
						return ps, def
					})
					a.editProfileID = ""
					a.showHUDUndo("ok", fmt.Sprintf(tr("已删除方案「%s」"), profileName(p)), func() {
						cur := a.store.Settings()
						cur.PromptGroups, cur.TargetProfiles, cur.DefaultProfileID = prev.PromptGroups, prev.TargetProfiles, prev.DefaultProfileID
						_ = a.store.SetSettings(cur)
					})
				}
			})
		}
	})
}
