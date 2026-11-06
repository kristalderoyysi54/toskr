package main

import (
	"fmt"
	"slices"
	"strings"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// 发送方案（同 Tauri TargetLensBar 展开区 + TargetProfileQuickSwitch）：目标条 chevron 展开「方案 [名称 ▾] 自动匹配 / 临时指定」，
// 名称处弹快速切换：前 3 个候选方案（与当前的差异摘要）、本次生效规则台账（前四项可本次覆盖）、以后都用此方案、恢复自动匹配、编辑方案。

type opt struct{ v, label string }

var (
	outputModeOpts = []opt{{"plain", "原文"}, {"strip-markdown", "无 Markdown"}, {"code", "代码块"}}
	enterOpts      = []opt{{"never", "从不按回车"}, {"confirm", "每次发送前确认"}, {"allow", "自动按回车 · 高风险"}}
	privacyOpts    = []opt{{"requireRedaction", "要求逐项处理"}, {"confirmRaw", "提示项原文需确认"}, {"allowRaw", "允许原文（高风险二次确认）"}}
)

func optLabel(os []opt, v string) string {
	for _, o := range os {
		if o.v == v {
			return tr(o.label)
		}
	}
	return v
}

func profileName(p store.TargetProfile) string {
	if p.Name == "" {
		return tr("未命名方案")
	}
	return tr(p.Name) // 内置方案名走翻译，用户自建原样
}

// targetKey：目标身份（进程 + bundle）；临时方案与规则覆盖只对同一身份有效，换目标即失效。
func (a *app) targetKey() string {
	if a.target.PID == 0 {
		return ""
	}
	return fmt.Sprintf("%d|%s", a.target.PID, a.target.BundleID)
}

// resolution 是当前目标实际生效的方案；stale 表示原临时方案因换目标已暂停。
func (a *app) resolution() (r store.ProfileResolution, stale bool) {
	groups, profiles, def := a.store.Settings().ProfileConfig()
	key := a.targetKey()
	temp := ""
	if a.tempProfile != "" {
		if a.tempFor == key && key != "" {
			temp = a.tempProfile
		} else {
			stale = true
		}
	}
	var ov *store.RuleOverrides
	if key != "" && a.ruleFor == key {
		ov = &a.ruleOv
	}
	bundle := ""
	if a.target.PID != 0 {
		bundle = a.target.BundleID
	}
	return store.ResolveProfile(bundle, groups, profiles, def, temp, stale, ov), stale
}

func (a *app) automaticResolution() store.ProfileResolution {
	groups, profiles, def := a.store.Settings().ProfileConfig()
	bundle := ""
	if a.target.PID != 0 {
		bundle = a.target.BundleID
	}
	return store.ResolveProfile(bundle, groups, profiles, def, "", false, nil)
}

func (a *app) matchReason(r store.ProfileResolution, stale bool) string {
	switch {
	case a.target.PID == 0:
		return tr("尚未识别发送目标，发送已锁定")
	case stale:
		return tr("原临时发送方案已暂停，当前已按目标重新选择")
	case r.Source == "temporary":
		return tr("仅本次手动选择")
	case r.Source == "conflict":
		return fmt.Sprintf(tr("存在重复应用绑定，当前稳定使用 %s"), profileName(r.Profile))
	case r.Source == "exact":
		return fmt.Sprintf(tr("已为 %s 指定"), a.target.Name)
	}
	return tr("未匹配具体应用，使用默认方案")
}

func diffSummary(p, cur store.TargetProfile, groups []store.PromptGroup) []string {
	var out []string
	gname := func(id string) string {
		if i := slices.IndexFunc(groups, func(g store.PromptGroup) bool { return g.ID == id }); i >= 0 {
			return tr(groups[i].Name)
		}
		return tr("通用")
	}
	if gname(p.PromptGroupID) != gname(cur.PromptGroupID) {
		out = append(out, fmt.Sprintf(tr("提示词组改为%s"), gname(p.PromptGroupID)))
	}
	if p.OutputMode() != cur.OutputMode() {
		out = append(out, fmt.Sprintf(tr("输出改为%s"), optLabel(outputModeOpts, p.OutputMode())))
	}
	if p.EnterPolicy != cur.EnterPolicy {
		out = append(out, fmt.Sprintf(tr("粘贴后改为%s"), optLabel(enterOpts, p.EnterPolicy)))
	}
	if p.KeepPanel != cur.KeepPanel {
		if p.KeepPanel {
			out = append(out, tr("完成后保持打开"))
		} else {
			out = append(out, tr("完成后关闭面板"))
		}
	}
	return out
}

func (a *app) selectTempProfile(id string) {
	a.tempProfile, a.tempFor = id, a.targetKey()
	a.ruleOv, a.ruleFor = store.RuleOverrides{}, ""
}

func (a *app) restoreAutomatic() {
	a.tempProfile, a.tempFor = "", ""
	a.ruleOv, a.ruleFor = store.RuleOverrides{}, ""
}

// makePermanent：把临时方案绑定到当前应用（从其他方案移除该 bundle），并清掉临时指定。
func (a *app) makePermanent() {
	bundle, id := a.target.BundleID, a.tempProfile
	if bundle == "" || id == "" {
		return
	}
	st := a.store.Settings()
	groups, profiles, def := st.ProfileConfig()
	for i := range profiles {
		profiles[i].BundleIDs = slices.DeleteFunc(profiles[i].BundleIDs, func(b string) bool { return b == bundle })
		if profiles[i].ID == id {
			profiles[i].BundleIDs = append(profiles[i].BundleIDs, bundle)
		}
	}
	st.PromptGroups, st.TargetProfiles, st.DefaultProfileID = groups, profiles, def
	_ = a.store.SetSettings(st)
	a.restoreAutomatic()
	a.showHUD("ok", fmt.Sprintf(tr("以后发给 %s 都使用此方案"), a.target.Name))
}

func (a *app) setRule(fn func(*store.RuleOverrides)) {
	if key := a.targetKey(); a.ruleFor != key {
		a.ruleOv, a.ruleFor = store.RuleOverrides{}, key
	}
	fn(&a.ruleOv)
}

// lensChevron：目标条的展开钮（展开发送详情）。
func (a *app) lensChevron(c *ui.Context, k tokens) {
	icon := "chevron-down"
	if a.lensOpen {
		icon = "chevron-up"
	}
	tip := tr("展开发送详情")
	if a.lensOpen {
		tip = tr("收起发送详情")
	}
	if a.iconButton(c, k, icon, 20, 12, tip) {
		a.lensOpen = !a.lensOpen
		a.quickOpen = false
	}
}

// lensDetail：展开区「方案 [名称 ▾] 自动匹配 / 临时指定」+ 失效原因 / 暂停的临时方案确认。
func (a *app) lensDetail(c *ui.Context, k tokens) {
	r, stale := a.resolution()
	ui.Column(c).Margin(4, 0, 0, 0).Padding(6, 8).Radius(10).Background(k.track.Alpha(0.6)).Gap(4).Key("lens-detail").Children(func() {
		ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
			text(c, tr("方案"), 10, 14, 400, k.muted)
			name := profileName(r.Profile)
			border := k.inputBorder
			fg := k.fg
			if r.Source == "temporary" {
				border, fg = stok(c).primary.Alpha(0.5), stok(c).primary
			}
			btn := ui.Row(c).Gap(4).Padding(1, 6).Radius(6).Border(1, border).AlignItems(ui.Center).MaxWidth(160).
				Key("profile-btn").Role(ui.RoleButton).Label(fmt.Sprintf(tr("本次发送方案：%s，点击查看与切换"), name)).Tooltip(name)
			if btn.Hovered() {
				btn.Background(k.hoverBg)
			}
			btn.Children(func() {
				text(c, name, 11, 16, 500, fg).SingleLine()
				licon(c, "chevron-down", 10, k.muted)
			})
			if btn.Clicked() {
				a.quickOpen = !a.quickOpen
			}
			ui.PopoverBase(c, btn, &a.quickOpen, func(p ui.Element) {
				floatSurface(p.Width(300).Padding(8).Radius(12), k).Key("quick-switch").Label(fmt.Sprintf(tr("发送到 %s，快速切换发送方案"), a.target.Name)).
					Children(func() { a.quickSwitch(c, k) })
			})
			src := tr("自动匹配")
			if r.Source == "temporary" {
				src = tr("临时指定")
			}
			text(c, src, 10, 14, 400, k.muted)
		})
		if r.Source == "conflict" || stale || a.target.PID == 0 {
			ui.Column(c).Gap(2).Children(func() {
				text(c, a.matchReason(r, stale), 10, 14, 400, k.amberText).Wrap()
				if stale && a.target.PID != 0 {
					_, profiles, _ := a.store.Settings().ProfileConfig()
					old := tr("原方案")
					if i := slices.IndexFunc(profiles, func(p store.TargetProfile) bool { return p.ID == a.tempProfile }); i >= 0 {
						old = profileName(profiles[i])
					}
					if footLink(c, k, fmt.Sprintf(tr("将 %s 用于当前目标"), old), "lens-confirm") {
						a.tempFor = a.targetKey()
					}
				}
			})
		}
	})
}

// quickSwitch：快速切换浮层内容。
func (a *app) quickSwitch(c *ui.Context, k tokens) {
	r, stale := a.resolution()
	auto := a.automaticResolution()
	groups, profiles, _ := a.store.Settings().ProfileConfig()
	var cands []store.TargetProfile
	for _, p := range append([]store.TargetProfile{r.Profile, auto.Profile}, profiles...) {
		if !slices.ContainsFunc(cands, func(x store.TargetProfile) bool { return x.ID == p.ID }) {
			cands = append(cands, p)
		}
	}
	cands = cands[:min(3, len(cands))]
	ready := a.target.PID != 0
	if c.Shortcut(0, ui.KeyDown) {
		a.quickIdx = (a.quickIdx + 1) % len(cands)
	}
	if c.Shortcut(0, ui.KeyUp) {
		a.quickIdx = (a.quickIdx - 1 + len(cands)) % len(cands)
	}
	if c.Shortcut(0, ui.KeyEnter) && ready && a.quickIdx < len(cands) && cands[a.quickIdx].ID != r.Profile.ID {
		a.selectTempProfile(cands[a.quickIdx].ID)
	}
	sep := func() { ui.Box(c).Height(1).Margin(10, -8).Background(k.inputBorder.Alpha(0.6)) }
	ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
		ui.Box(c).Size(24, 24).Radius(6).Background(k.chip).Center().Children(func() { licon(c, "app-window", 12, k.muted) })
		ui.Column(c).Grow(1).Basis(0).Children(func() {
			text(c, fmt.Sprintf(tr("发送到 %s"), a.target.Name), 12, 17, 600, k.fg).SingleLine()
			text(c, a.matchReason(r, stale), 10, 14, 400, k.muted).Wrap()
		})
		status, fg := tr("可发送"), k.ok
		if !ready {
			status, fg = tr("未识别"), k.danger
		}
		ui.Row(c).Gap(4).Padding(1, 8).Radius(999).Background(fg.Alpha(0.1)).AlignItems(ui.Center).Children(func() {
			ui.Box(c).Size(6, 6).Radius(3).Background(fg)
			text(c, status, 10, 14, 500, fg)
		})
	})
	sep()
	ui.Row(c).Gap(6).Margin(0, 0, 6, 0).Children(func() {
		text(c, tr("发送方案"), 10, 14, 600, k.muted)
		text(c, tr("↑↓ 移动 · Enter 使用"), 10, 14, 400, k.muted)
	})
	ui.Column(c).Gap(2).Label(tr("选择本次临时发送方案")).Children(func() {
		for i, p := range cands {
			sel := p.ID == r.Profile.ID
			row := ui.Row(c).Gap(8).Padding(6, 8).Radius(6).AlignItems(ui.Center).Key("qp-" + p.ID).Role(ui.RoleButton).Label(profileName(p))
			switch {
			case sel:
				row.Background(stok(c).primary.Alpha(0.1)).Border(1, stok(c).primary.Alpha(0.25))
			case row.Hovered() || i == a.quickIdx:
				row.Background(k.hoverBg)
			}
			if !ready {
				row.Opacity(0.4)
			}
			row.Children(func() {
				col := stok(c).primary
				if !sel {
					col = ui.Transparent
				}
				licon(c, "check", 12, col)
				text(c, profileName(p), 11, 16, 600, k.fg).SingleLine()
				if sel {
					ui.Spacer(c)
					ui.Box(c).Padding(1, 6).Radius(999).Background(stok(c).primary.Alpha(0.15)).Children(func() {
						text(c, tr("当前"), 10, 14, 600, stok(c).primary)
					})
					return
				}
				d := diffSummary(p, r.Profile, groups)
				s, fg := tr("与当前参数相同"), k.muted
				if len(d) > 0 {
					s = strings.Join(d, " · ")
				}
				if p.EnterPolicy == "allow" && r.Profile.EnterPolicy != "allow" {
					fg = k.amberText
				}
				text(c, s, 10, 14, 400, fg).SingleLine().Grow(1).Basis(0).TextAlign(ui.End).Tooltip(s)
			})
			if row.Clicked() && ready && !sel {
				a.selectTempProfile(p.ID)
			}
		}
		if len(cands) == 0 {
			text(c, tr("暂无可切换方案"), 12, 17, 400, k.muted)
		}
	})
	sep()
	text(c, tr("本次生效规则"), 10, 14, 600, k.muted).Margin(0, 0, 6, 0)
	a.ruleLedger(c, k, r, groups, ready)
	if a.tempProfile != "" && !stale && a.target.BundleID != "" && r.Source == "temporary" {
		b := ui.Row(c).Margin(10, 0, 0, 0).Padding(6, 8).Gap(6).Radius(6).Border(1, k.inputBorder).AlignItems(ui.Center).Key("make-permanent").Role(ui.RoleButton).
			Label(fmt.Sprintf(tr("以后发给 %s 都使用此方案"), a.target.Name))
		if b.Hovered() {
			b.Background(k.hoverBg)
		}
		b.Children(func() {
			licon(c, "link-2", 14, k.fg)
			text(c, fmt.Sprintf(tr("以后发给 %s 都使用此方案"), a.target.Name), 12, 17, 400, k.fg).Wrap()
		})
		if b.Clicked() {
			a.makePermanent()
			a.quickOpen = false
		}
	}
	ui.Row(c).Margin(10, 0, 0, 0).Padding(8, 0, 0, 0).BorderWidth(1, 0, 0, 0).BorderColor(k.inputBorder.Alpha(0.6)).AlignItems(ui.Center).Children(func() {
		restore := ui.Row(c).Gap(4).AlignItems(ui.Center).Key("restore-auto").Role(ui.RoleButton).Label(tr("恢复自动匹配")).
			Tooltip(fmt.Sprintf(tr("恢复自动匹配：%s"), profileName(auto.Profile)))
		if a.tempProfile == "" {
			restore.Opacity(0.4)
		}
		restore.Children(func() {
			licon(c, "rotate-ccw", 12, k.muted)
			text(c, tr("恢复自动匹配"), 10, 14, 400, k.muted)
		})
		if restore.Clicked() && a.tempProfile != "" {
			a.restoreAutomatic()
			a.quickOpen = false
		}
		ui.Spacer(c)
		edit := ui.Row(c).Gap(4).AlignItems(ui.Center).Key("edit-profile").Role(ui.RoleButton).Label(tr("编辑方案")).
			Tooltip(fmt.Sprintf(tr("编辑 %s 的发送方案"), a.target.Name))
		edit.Children(func() {
			licon(c, "settings-2", 12, k.muted)
			text(c, tr("编辑方案"), 10, 14, 400, k.muted)
		})
		if edit.Clicked() {
			a.quickOpen = false
			a.editProfileID = r.Profile.ID
			a.openSettingsAt(setPagePaste, 0)
		}
	})
}

// ruleLedger：本次生效规则台账（键弱值强）；interactive 时前四行可点开菜单做本次覆盖，隐私检查恒只读。
func (a *app) ruleLedger(c *ui.Context, k tokens, r store.ProfileResolution, groups []store.PromptGroup, interactive bool) {
	over := func(key string) bool { return slices.Contains(r.Overridden, key) }
	row := func(key, val string, warn, overridden bool, menu func(m *ui.Menu)) {
		ui.Row(c).Gap(12).AlignItems(ui.Center).Children(func() {
			text(c, key, 10, 16, 400, k.muted).Width(52).TextAlign(ui.End)
			fg := k.fg
			if warn {
				fg = k.amberText
			}
			v := ui.Row(c).Gap(4).AlignItems(ui.Center).Key("rule-" + key).Role(ui.RoleButton).Label(val)
			v.Children(func() {
				text(c, val, 11, 16, 500, fg)
				if interactive && menu != nil {
					licon(c, "chevron-down", 10, k.muted)
				}
				if overridden {
					ui.Box(c).Padding(0, 6).Radius(999).Background(stok(c).primary.Alpha(0.15)).Children(func() {
						text(c, tr("本次"), 10, 14, 600, stok(c).primary)
					})
				}
			})
			if interactive && menu != nil {
				v.Menu(menu)
			}
		})
	}
	ui.Column(c).Gap(4).Label(tr("本次生效规则")).Children(func() {
		row(tr("提示词组"), tr(r.Group.Name), false, over("promptGroupId"), func(m *ui.Menu) {
			for _, g := range groups {
				if m.Item(tr(g.Name)).Checked(g.ID == r.Profile.PromptGroupID).Chosen() {
					a.setRule(func(o *store.RuleOverrides) { o.PromptGroupID = g.ID })
				}
			}
		})
		row(tr("输出格式"), optLabel(outputModeOpts, r.Profile.OutputMode()), false, over("defaultOutputMode"), func(m *ui.Menu) {
			for _, o := range outputModeOpts {
				if m.Item(tr(o.label)).Checked(o.v == r.Profile.OutputMode()).Chosen() {
					a.setRule(func(ov *store.RuleOverrides) { ov.OutputMode = o.v })
				}
			}
		})
		row(tr("粘贴后"), optLabel(enterOpts, r.Profile.EnterPolicy), r.Profile.EnterPolicy == "allow", over("enterPolicy"), func(m *ui.Menu) {
			for _, o := range enterOpts {
				if m.Item(tr(o.label)).Checked(o.v == r.Profile.EnterPolicy).Chosen() {
					a.setRule(func(ov *store.RuleOverrides) { ov.EnterPolicy = o.v })
				}
			}
		})
		done := tr("关闭面板")
		if r.Profile.KeepPanel {
			done = tr("保持打开")
		}
		row(tr("完成后"), done, false, over("keepPanel"), func(m *ui.Menu) {
			for _, keep := range []bool{false, true} {
				label := tr("关闭面板")
				if keep {
					label = tr("保持打开")
				}
				if m.Item(label).Checked(keep == r.Profile.KeepPanel).Chosen() {
					a.setRule(func(ov *store.RuleOverrides) { ov.KeepPanel = &keep })
				}
			}
		})
		row(tr("隐私检查"), tr("发送时执行")+" · "+optLabel(privacyOpts, r.Profile.PrivacyPolicy), false, false, nil)
	})
	if len(r.Overridden) > 0 && interactive {
		b := ui.Row(c).Margin(6, 0, 0, 0).Gap(4).AlignItems(ui.Center).Key("reset-rules").Role(ui.RoleButton).Label(tr("恢复方案默认规则"))
		b.Children(func() {
			licon(c, "rotate-ccw", 12, k.muted)
			text(c, tr("恢复方案默认规则"), 10, 14, 400, k.muted)
		})
		if b.Clicked() {
			a.ruleOv, a.ruleFor = store.RuleOverrides{}, ""
		}
	}
}
