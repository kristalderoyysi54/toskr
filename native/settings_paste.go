package main

import (
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// 设置 → 粘贴与隐私（同 Tauri TargetSection）：粘贴规则 · 隐私保护 · 提示词模板。
// 粘贴规则是主从布局（同 ApplicationRuleInspector）：左列默认规则 + 各应用，右侧卡片改所选项的输出格式 / 回车 / 敏感处理 / 完成后面板；
// 原版有草稿与「应用」按钮，这里改动即时生效（native 设置页其余各项都是即时生效）。

// selfBundle：本应用自己的包标识（粘贴规则里不列自己）。
func selfBundle() string { return bundleID() }

var pasteSubs = []string{"粘贴规则", "隐私保护", "提示词模板"}

// pasteUI：粘贴规则页的编辑态。
type pasteUI struct {
	sel         string   // 选中的应用 bundle；空 = 默认规则
	query       string   // 左列搜索
	extra       []string // 本次会话「选择应用…」加进来、还没有规则的应用
	shared      bool     // 改的是共享方案（否则为仅此应用）
	advOpen     bool     // 「共享方案与高级管理」展开
	showMissing bool     // 展开「未安装的终端」

	tmplOpen   bool   // 右侧卡片「模板排序」展开
	preview    string // 「输出预览」测试内容
	previewSet bool
	targetOpen bool   // 「当前目标与规则检查」展开
	checkMsg   string // 「检查规则」结果
}

var formatDesc = map[string]string{
	"plain":          "保持内容自然排版并保留 Markdown 标记。",
	"strip-markdown": "发送时去除 Markdown 标记；智能预检会先展示结果。",
	"code":           "用代码围栏包裹文本，适合开发工具与终端记录。",
}

var enterDesc = map[string]string{
	"never":   "只完成粘贴，由你在目标应用中检查后提交。",
	"confirm": "发送前询问；确认后才会在粘贴后模拟回车。",
	"allow":   "内容会直接提交或执行，只适合明确可信的目标。",
}

// pasteRuleApps：左列的应用（当前目标、各方案绑定的应用、手动选过的应用），去重、排除本应用。
func (a *app) pasteRuleApps(ps []store.TargetProfile) []string {
	var out []string
	add := func(b string) {
		if b != "" && b != selfBundle() && !slices.Contains(out, b) {
			out = append(out, b)
		}
	}
	add(a.target.BundleID)
	for _, p := range ps {
		for _, b := range p.BundleIDs {
			add(b)
		}
	}
	for _, b := range a.paste.extra {
		add(b)
	}
	add(a.paste.sel)
	return out
}

func ownersOf(ps []store.TargetProfile, bundle string) []store.TargetProfile {
	if bundle == "" {
		return nil
	}
	var out []store.TargetProfile
	for _, p := range ps {
		if slices.Contains(p.BundleIDs, bundle) {
			out = append(out, p)
		}
	}
	return out
}

// applyRule 把改动写进所选项的方案：默认规则改默认方案；共享范围改原方案；
// 仅此应用且原方案还有别的应用（或就是默认方案）时，为它拆出一个独立方案，其他应用不变。
func (a *app) applyRule(bundle string, fn func(p *store.TargetProfile)) {
	groups, ps, def := a.store.Settings().ProfileConfig()
	if bundle == "" {
		a.editProfile(def, fn)
		return
	}
	owners := ownersOf(ps, bundle)
	if len(owners) > 1 {
		return // 重复绑定：先在高级管理里解决
	}
	if len(owners) == 1 {
		p := owners[0]
		if a.paste.shared || (len(p.BundleIDs) == 1 && p.ID != def) {
			a.editProfile(p.ID, fn)
			return
		}
	}
	np := store.ResolveProfile(bundle, groups, ps, def, "", false, nil).Profile
	np.ID = fmt.Sprintf("profile-%x", time.Now().UnixNano())
	np.Name = a.appName(bundle)
	np.BundleIDs = []string{bundle}
	fn(&np)
	a.updateProfiles(func(ps []store.TargetProfile, def string) ([]store.TargetProfile, string) {
		for i := range ps {
			ps[i].BundleIDs = slices.DeleteFunc(ps[i].BundleIDs, func(y string) bool { return y == bundle })
		}
		return append(ps, np), def
	})
	a.paste.shared = false
}

// restoreDefaultRule：解除此应用的规则绑定，改为跟随默认规则；原方案和其他应用不变。
func (a *app) restoreDefaultRule(bundle string) {
	a.updateProfiles(func(ps []store.TargetProfile, def string) ([]store.TargetProfile, string) {
		for i := range ps {
			ps[i].BundleIDs = slices.DeleteFunc(ps[i].BundleIDs, func(y string) bool { return y == bundle })
		}
		return ps, def
	})
	a.showHUD("ok", fmt.Sprintf(tr("%s 已恢复默认规则"), a.appName(bundle)))
}

// pasteRuleSections：「粘贴规则」子页。
func (a *app) pasteRuleSections(c *ui.Context, k tokens, s settingsTokens, st store.Settings) []setSection {
	_, ps, _ := st.ProfileConfig()
	adv := []setRow{{title: tr("共享方案与高级管理"), hint: tr("名称、应用绑定、排序与默认方案"), control: func() {
		if disclosure(c, k, "paste-adv", fmt.Sprintf(tr("%d 个方案"), len(ps)), a.paste.advOpen) {
			a.paste.advOpen = !a.paste.advOpen
		}
	}}}
	if a.paste.advOpen {
		adv = append(adv, a.profileSection(c, k, s)...)
	}
	return []setSection{
		{title: tr("管理应用粘贴规则"), intro: tr("设置内容怎样粘贴、粘贴后是否回车；每个应用可以单独设置。"),
			body: func() { a.pasteRuleInspector(c, k, s, st) }},
		a.currentTargetSection(c, k, s),
		{rows: adv},
		{title: tr("多段粘贴"), rows: []setRow{a.pasteStepRow(c, k, st)}},
	}
}

func (a *app) pasteRuleInspector(c *ui.Context, k tokens, s settingsTokens, st store.Settings) {
	_, ps, _ := st.ProfileConfig()
	apps := a.pasteRuleApps(ps)
	ui.Row(c).Gap(12).AlignItems(ui.Start).Children(func() {
		ui.Column(c).Width(176).Gap(6).Children(func() { a.pasteRuleList(c, k, s, ps, apps) })
		a.pasteRuleCard(c, k, s, st)
	})
}

// pasteRuleList：左列——搜索、默认规则、各应用（名称 + 所用方案）、选择应用…
func (a *app) pasteRuleList(c *ui.Context, k tokens, s settingsTokens, ps []store.TargetProfile, apps []string) {
	u := &a.paste
	ui.Row(c).Height(32).Padding(0, 8).Gap(6).Radius(rr(10)).Background(s.input).Border(1, s.inputBorder).AlignItems(ui.Center).Children(func() {
		licon(c, "search", 14, k.muted)
		ui.TextInputBase(c, &u.query).Grow(1).Font(fontSans).FontSize(12).FixedLineHeight(17).
			TextColor(k.fg).PlaceholderColor(k.muted).Placeholder(tr("搜索应用")).Label(tr("搜索应用或方案"))
	})
	entry := func(key, title, sub string, on bool, icon func()) bool {
		b := tipOf(c, ui.Row(c).Padding(8, 8).Gap(8).Radius(rr(10)).Border(1, s.cardBorder).AlignItems(ui.Center).Key("rule-"+key).
			Role(ui.RoleButton).Label(title).Selected(on), title)
		fg, dim := k.fg, k.muted
		switch {
		case on:
			b.Background(s.navSel).Border(1, s.navSelBorder)
			fg = s.primary
			if _, on, ok := s.th.Highlight(); ok { // 主题的选中项是高亮色底：文字用其上的前景色（主色字压在主色底上看不见）
				fg, dim = on, on
			}
		case b.Hovered():
			b.Background(k.track)
		default:
			b.Background(s.card)
		}
		b.Children(func() {
			icon()
			ui.Column(c).Grow(1).Basis(0).Gap(1).Children(func() {
				text(c, title, 12, 17, 500, fg).SingleLine()
				text(c, sub, 10, 14, 400, dim).SingleLine()
			})
		})
		return b.Clicked()
	}
	if entry("default", tr("默认规则"), tr("未单独设置的应用"), u.sel == "", func() { licon(c, "settings-2", 18, k.muted) }) {
		u.sel, u.shared = "", false
	}
	q := strings.ToLower(strings.TrimSpace(u.query))
	shown := 0
	// 没装的预置终端收成一行，点开才逐个列出；搜索时、或其中某个正被选中时照常显示
	var missing []string
	if q == "" && !u.showMissing {
		for _, b := range apps {
			if slices.Contains(store.TerminalBundleIDs, b) && !a.appInstalled(b) && u.sel != b {
				missing = append(missing, b)
			}
		}
	}
	for _, b := range apps {
		if slices.Contains(missing, b) {
			continue
		}
		name := a.appName(b)
		sub := tr("使用默认规则")
		if o := ownersOf(ps, b); len(o) > 0 {
			sub = profileName(o[0])
			if len(o) > 1 {
				sub = tr("重复绑定")
			}
		}
		if q != "" && !strings.Contains(strings.ToLower(name+" "+b+" "+sub), q) {
			continue
		}
		shown++
		if entry(b, name, sub, u.sel == b, func() {
			ui.Box(c).Size(24, 24).Radius(rr(6)).Background(k.track).Center().Children(func() {
				if img := a.appIcon(b); img != nil {
					ui.Image(c, img).Size(20, 20)
				} else {
					licon(c, "app-window", 14, k.muted)
				}
			})
		}) {
			u.sel, u.shared = b, false
		}
	}
	if len(missing) > 0 {
		shown++
		label := fmt.Sprintf(tr("另有 %d 个未安装的终端"), len(missing))
		row := ui.Row(c).Height(24).Padding(0, 8).Gap(4).Radius(rr(8)).AlignItems(ui.Center).Key("rule-missing").Role(ui.RoleButton).Label(label)
		if row.Hovered() {
			row.Background(k.track)
		}
		row.Children(func() {
			text(c, label, 11, 16, 400, k.muted).SingleLine().Grow(1).Basis(0)
			licon(c, "chevron-down", 12, k.muted)
		})
		if row.Clicked() {
			u.showMissing = true
		}
	}
	if shown == 0 {
		msg := tr("选择一个应用，为它设置粘贴规则。")
		if len(apps) > 0 {
			msg = tr("没有匹配的应用")
		}
		text(c, msg, 11, 16, 400, k.muted).Wrap().Padding(4, 2)
	}
	if pickAppButton(c, k, s, "pick-app", "folder-open", tr("选择应用…")) {
		if b := pickAppBundle(a); b != "" && b != selfBundle() {
			if !slices.Contains(u.extra, b) {
				u.extra = append(u.extra, b)
			}
			u.sel, u.shared = b, false
		}
	}
}

// pickAppButton：占满一行、带图标的次要按钮（白底细描边，同 button）。
func pickAppButton(c *ui.Context, k tokens, s settingsTokens, key, icon, label string) bool {
	b := ui.Row(c).Height(28).Padding(0, 10).Gap(6).Radius(rr(10)).Border(1, s.btnBorder).AlignItems(ui.Center).Justify(ui.Center).Key(key).Role(ui.RoleButton).Label(label)
	bg := s.btn
	if b.Hovered() {
		bg = s.btnHover
	}
	fadeColor(b, "bg", bg, tw(100, easeStandard)).Shadow(0, 1, 2, 0, s.btnShadow)
	b.Children(func() {
		licon(c, icon, 14, s.btnFg)
		text(c, label, 12, 17, 500, s.btnFg).SingleLine()
	})
	return b.Clicked()
}

// ruleSelect：右侧字段的下拉（Tauri SimpleSelect w-56）；disabled 时只显示当前值、不可点。
func ruleSelect(c *ui.Context, k tokens, s settingsTokens, key string, opts []opt, cur string, disabled bool, pick func(string)) {
	b := ui.Row(c).Width(196).Height(32).Padding(0, 8).Gap(4).Radius(rr(10)).Border(1, s.inputBorder).AlignItems(ui.Center).Key(key)
	if disabled {
		b.Opacity(0.55)
	} else if b.Hovered() {
		b.Background(k.track)
	}
	b.Children(func() {
		text(c, tr(optLabel(opts, cur)), 12, 17, 400, k.fg).SingleLine().Grow(1).Basis(0)
		licon(c, "chevron-down", 14, k.muted)
	})
	if disabled {
		return
	}
	b.Menu(func(m *ui.Menu) {
		for _, o := range opts {
			if m.Item(tr(o.label)).Radio(o.v == cur).Chosen() && o.v != cur {
				pick(o.v)
			}
		}
	})
}

// pasteRuleCard：右侧卡片——标题、影响范围说明、四个字段、恢复默认。
func (a *app) pasteRuleCard(c *ui.Context, k tokens, s settingsTokens, st store.Settings) {
	u := &a.paste
	groups, ps, def := st.ProfileConfig()
	sel := u.sel
	owners := ownersOf(ps, sel)
	r := store.ResolveProfile(sel, groups, ps, def, "", false, nil)
	p := r.Profile
	fallback := sel == ""
	conflict := len(owners) > 1
	canShare := len(owners) == 1 && (len(owners[0].BundleIDs) > 1 || owners[0].ID == def)
	if !canShare {
		u.shared = false
	}
	name, subtitle := tr("默认规则"), tr("未绑定应用使用这套默认规则")
	if sel != "" {
		name, subtitle = a.appName(sel), tr("设置此应用以后的粘贴行为")
	}
	card := ui.Column(c).Grow(1).Basis(0).Padding(14).Gap(12).Radius(rr(14)).Background(s.card).Border(1, s.cardBorder).Key("rule-card-" + sel)
	card.Children(func() {
		ui.Row(c).Gap(10).AlignItems(ui.Center).Children(func() {
			if sel == "" {
				licon(c, "settings-2", 24, k.muted)
			} else if img := a.appIcon(sel); img != nil {
				ui.Image(c, img).Size(28, 28)
			} else {
				licon(c, "app-window", 24, k.muted)
			}
			ui.Column(c).Grow(1).Basis(0).Gap(1).Children(func() {
				tipOf(c, text(c, name, 15, 20, 600, k.fg).SingleLine(), sel)
				text(c, subtitle, 11, 16, 400, k.muted).SingleLine()
			})
		})
		// 影响范围：所用方案、共享它的应用、改动会影响谁
		ui.Column(c).Padding(10).Gap(6).Radius(rr(8)).Background(k.track.Alpha(0.6)).Children(func() {
			ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
				ui.Column(c).Grow(1).Basis(0).Gap(1).Children(func() {
					text(c, profileName(p), 12, 17, 600, k.fg).SingleLine()
					switch {
					case sel == "":
					case len(owners) == 0:
						text(c, tr("尚未单独设置，当前使用默认规则"), 10, 14, 400, k.muted)
					default:
						text(c, fmt.Sprintf(tr("共 %d 个应用使用此方案"), len(owners[0].BundleIDs)), 10, 14, 400, k.muted)
					}
				})
				if canShare {
					i := 0
					if u.shared {
						i = 1
					}
					if segmented(c, k, &i, tr("仅此应用"), tr("共享方案")) {
						u.shared = i == 1
					}
				}
			})
			if len(owners) == 1 && len(owners[0].BundleIDs) > 1 {
				ui.Row(c).Wrap().Gap(4).Children(func() {
					for _, b := range owners[0].BundleIDs {
						tipOf(c, ui.Row(c).Height(20).Padding(0, 6).Gap(4).Radius(10).Background(s.card).AlignItems(ui.Center).Key("share-"+b), b).Children(func() {
							if img := a.appIcon(b); img != nil {
								ui.Image(c, img).Size(12, 12)
							}
							text(c, a.appName(b), 10, 14, 400, k.fg).SingleLine()
						})
					}
				})
			}
			var scope string
			switch {
			case sel == "":
				scope = tr("默认规则固定为不自动回车、敏感内容逐项处理；绑定此方案的应用会一起更新格式和面板。")
			case u.shared && owners[0].ID == def:
				scope = tr("修改会同时影响上方全部应用，以及未单独设置应用的默认格式和面板。")
			case u.shared:
				scope = tr("修改会同时影响上方全部应用。")
			case len(owners) == 1 && len(owners[0].BundleIDs) == 1 && owners[0].ID != def:
				scope = tr("这套规则仅用于当前应用。")
			default:
				scope = tr("修改时为当前应用建立独立规则，其他应用保持原设置。")
			}
			text(c, scope, 11, 16, 400, k.muted).Wrap()
		})
		if conflict {
			ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
				licon(c, "triangle-alert", 12, k.amberText)
				text(c, tr("此应用有重复绑定，请在下方「共享方案与高级管理」里只保留一个方案。"), 11, 16, 400, k.amberText).Wrap().Grow(1).Basis(0)
			})
		}
		edit := func(fn func(x *store.TargetProfile)) {
			if !conflict {
				a.applyRule(sel, fn)
			}
		}
		privacy := tr("逐项明确选择替换或保留原文，不会自动全部替换。")
		switch {
		case st.FirewallOff:
			privacy = tr("全局隐私检查已关闭，这项规则暂不生效；开启后使用所选策略。")
		case p.PrivacyPolicy == "confirmRaw":
			privacy = tr("普通提示项保留原文时，发送前需要确认。")
		case p.PrivacyPolicy == "allowRaw":
			privacy = tr("普通提示项允许保留原文；高风险原文仍需二次确认。")
		}
		enter := tr(enterDesc[p.EnterPolicy])
		if fallback {
			enter = tr("默认规则始终只粘贴，不自动回车。")
		}
		fields := ui.Column(c)
		if conflict {
			fields.Opacity(0.55)
		}
		fields.Children(func() {
			field := func(i int, label, desc string, ctl func()) {
				row := ui.Row(c).Padding(10, 0).Gap(16).AlignItems(ui.Center).Key("rule-field-" + label)
				if i > 0 {
					row.BorderWidth(1, 0, 0, 0).BorderColor(s.rowBorder)
				}
				row.Children(func() {
					ui.Column(c).Grow(1).Basis(0).Gap(2).Children(func() {
						tightText(c, label, 13, 18, 400, k.fg)
						text(c, desc, 11, 16, 400, k.muted).Wrap()
					})
					ctl()
				})
			}
			field(0, tr("输出格式"), tr(formatDesc[p.OutputMode()]), func() {
				ruleSelect(c, k, s, "rule-format", outputModeOpts, p.OutputMode(), conflict, func(v string) {
					edit(func(x *store.TargetProfile) { x.SetOutputMode(v) })
				})
			})
			field(1, tr("回车策略"), enter, func() {
				ruleSelect(c, k, s, "rule-enter", enterOpts, p.EnterPolicy, conflict || fallback, func(v string) {
					edit(func(x *store.TargetProfile) { x.EnterPolicy = v })
				})
			})
			field(2, tr("敏感处理"), privacy, func() {
				ruleSelect(c, k, s, "rule-privacy", privacyOpts, p.PrivacyPolicy, conflict || fallback, func(v string) {
					edit(func(x *store.TargetProfile) { x.PrivacyPolicy = v })
				})
			})
			field(3, tr("完成后面板"), tr("粘贴成功后收起或保持打开；钉住时始终打开。"), func() {
				i := 0
				if p.KeepPanel {
					i = 1
				}
				if segmented(c, k, &i, tr("收起面板"), tr("保持打开")) {
					edit(func(x *store.TargetProfile) { x.KeepPanel = i == 1 })
				}
			})
		})
		if p.EnterPolicy == "allow" && !fallback {
			ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
				licon(c, "triangle-alert", 12, k.amberText)
				text(c, tr("自动按回车：内容会直接提交或执行，只适合明确可信的目标。"), 11, 16, 400, k.amberText).Wrap().Grow(1).Basis(0)
			})
		}
		a.ruleTemplateOrder(c, k, s, st, p, conflict, edit)
		a.ruleOutputPreview(c, k, s, p.OutputMode())
		if len(owners) == 1 {
			ui.Row(c).Padding(10, 0, 0, 0).BorderWidth(1, 0, 0, 0).BorderColor(s.rowBorder).AlignItems(ui.Center).Children(func() {
				text(c, tr("改动即时生效"), 10, 14, 400, k.muted).Grow(1)
				if linkButton(c, k, "rule-reset", tr("恢复默认")) {
					a.restoreDefaultRule(sel)
				}
			})
		}
	})
}

// privacySections：「隐私保护」子页（同 Tauri FirewallSettings + AliasEntitySettings），两张无标题卡片。
func (a *app) privacySections(c *ui.Context, k tokens, s settingsTokens, st store.Settings) []setSection {
	alias := setSection{rows: a.aliasRows(c, k, s, st)}
	if !st.AliasOff {
		alias.footer = tr("词典加密保存在本机；导出的完整备份中为明文。删除条目后，它的占位符编号不再复用。")
	}
	return []setSection{
		{intro: tr("发送前在本机检查敏感内容，原始卡片不会被改写。"), rows: a.firewallRows(c, k, s, st),
			footer: tr("本机规则可能漏检，发送前仍可在预检中核对最终内容。")},
		alias,
	}
}
