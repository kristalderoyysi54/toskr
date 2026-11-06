package main

import (
	"fmt"
	"slices"
	"strings"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/core"
)

// 发送预检（同 Tauri PreflightComposer 的文本部分 + evaluateFirewallPolicy）：命中逐项「替换为占位符 / 保留原文」，
// 同类与一键批量处理，手动重新检测；按发送方案的隐私策略决定能否发送：
//   requireRedaction 每项都要替换或明确保留；confirmRaw 高风险须处理、提示级可整体确认保留；allowRaw 有高风险原文时需再次确认。
// 保留了高风险原文的发送一律不按回车（forcePressEnterOff）。替换只改本次发送的副本，原卡不动。

type pfItem struct {
	note int
	f    core.Finding
	id   string
}

func (it pfItem) block() bool { return !slices.Contains(core.WarnCategories, it.f.Category) }

type preflightState struct {
	items    []pfItem
	kept     map[string]bool
	ph       map[string]string // 原值 → 占位符（本次发送内稳定）
	replaced int
	raw      string // 已确认的整体保留级别：warn | block
	open     bool   // 展开逐项列表
	scanned  bool
	images   []*pfImage
	imgRaw   string // 图片整体确认级别
	auto     bool   // 只为图片检查打开：OCR 干净且无文字命中时自动继续发送
}

func pfID(note int, f core.Finding) string {
	return fmt.Sprintf("%s:%d:%d:%d", f.Rule, note, f.Start, f.End)
}

// pfScan 重新检测当前（可能已替换过的）副本；仍然存在的保留项继续保留，整体确认作废（同 Tauri revision 变化）。
func (a *app) pfScan() {
	p := &a.pf
	rules := a.scanRules()
	var items []pfItem
	for i, n := range a.pending {
		if n.Kind == "image" {
			continue
		}
		for _, f := range core.Scan(n.Text, rules) {
			items = append(items, pfItem{i, f, pfID(i, f)})
		}
	}
	kept := map[string]bool{}
	for _, it := range items {
		if p.kept[it.id] {
			kept[it.id] = true
		}
	}
	p.items, p.kept, p.raw, p.scanned = items, kept, "", true
}

func (a *app) pfReplace(sel func(pfItem) bool) {
	p := &a.pf
	if p.ph == nil {
		p.ph = map[string]string{}
	}
	byNote := map[int][]core.Finding{}
	for _, it := range p.items {
		if sel(it) && !p.kept[it.id] {
			byNote[it.note] = append(byNote[it.note], it.f)
			p.replaced++
		}
	}
	if len(byNote) == 0 {
		return
	}
	notes := slices.Clone(a.pending)
	for i, fs := range byNote {
		notes[i].Text = core.ReplaceWithPlaceholders(notes[i].Text, fs, p.ph)
	}
	a.pending = notes
	a.pfScan()
}

func (a *app) pfKeep(sel func(pfItem) bool) {
	for _, it := range a.pf.items {
		if sel(it) {
			a.pf.kept[it.id] = true
		}
	}
}

type pfEval struct {
	canSend, noEnter bool
	needRaw          string // warn | block：还差一次整体确认
	unresolved       int
	reason           string
}

// pfEvaluate 同 Tauri evaluateFirewallPolicy（ready 状态）。
func (a *app) pfEvaluate(policy string) pfEval {
	p := &a.pf
	var unresolved, unresolvedBlocks, unresolvedWarns int
	rawBlocks := false
	for _, it := range p.items {
		if it.block() {
			rawBlocks = true
		}
		if !p.kept[it.id] {
			unresolved++
			if it.block() {
				unresolvedBlocks++
			} else {
				unresolvedWarns++
			}
		}
	}
	e := pfEval{noEnter: rawBlocks, unresolved: unresolved}
	switch policy {
	case "requireRedaction", "":
		e.canSend = unresolved == 0
		if !e.canSend {
			e.reason = tr("请替换或明确保留全部敏感项")
		}
	case "confirmRaw":
		switch {
		case unresolvedBlocks > 0:
			e.noEnter, e.reason = true, tr("高风险项必须替换或明确保留")
		case unresolvedWarns > 0 && p.raw != "warn":
			e.needRaw, e.reason = "warn", tr("请确认本次保留提示级原文")
		default:
			e.canSend = true
		}
	default: // allowRaw
		if rawBlocks && p.raw != "block" {
			e.needRaw, e.reason = "block", tr("高风险原文需要再次确认")
		} else {
			e.canSend = true
		}
	}
	return e
}

func (a *app) clearPending() {
	a.pending, a.pendingTmpl, a.pf = nil, "", preflightState{}
}

// pfCombined：文字与图片两路检查都放行才能发；任一路要求不回车即不回车。
func (a *app) pfCombined(policy string) (pfEval, pfEval) {
	return a.pfEvaluate(policy), a.pfImageEval(policy)
}

// pfSend 按当前副本发出；保留了高风险原文时强制不回车。图片有遮挡时发遮挡副本。
func (a *app) pfSend(e pfEval) {
	notes, tmpl := a.pending, a.pendingTmpl
	a.lastRedactions += a.pf.replaced
	a.sendPNG = nil
	for _, im := range a.pf.images {
		if b := im.maskedPNG(); b != nil && len(notes) == 1 {
			a.sendPNG = b
			for _, v := range im.masked {
				if v {
					a.lastRedactions++
				}
			}
		}
	}
	a.clearPending()
	a.askEnter(notes, e.noEnter, tmpl)
}

func policyHint(policy string) string {
	switch policy {
	case "confirmRaw":
		return tr("高风险须处理；提示级可确认后保留")
	case "allowRaw":
		return tr("允许原文发送；高风险需二次确认")
	}
	return tr("敏感项须替换或明确保留后才能发送")
}

// preflightBar 是面板里的发送预检条。
func (a *app) preflightBar(c *ui.Context) {
	t := c.Theme()
	k := tok(c)
	p := &a.pf
	if !p.scanned {
		a.pfScan()
		a.pfScanImages()
	}
	r, _ := a.resolution()
	policy := r.Profile.PrivacyPolicy
	e, ie := a.pfCombined(policy)
	if p.auto && len(p.items) == 0 && ie.canSend && !slices.ContainsFunc(p.images, func(im *pfImage) bool { return len(im.regions) > 0 }) {
		a.pfSend(pfEval{canSend: true, noEnter: ie.noEnter}) // 图片检查干净：直接继续发送，不打扰
		return
	}
	both := pfEval{canSend: e.canSend && ie.canSend, noEnter: e.noEnter || ie.noEnter, needRaw: e.needRaw, unresolved: e.unresolved + ie.unresolved, reason: cmpOr(e.reason, ie.reason)}
	imgRaw := false
	if both.needRaw == "" && ie.needRaw != "" && e.canSend {
		both.needRaw, imgRaw = ie.needRaw, true
	}
	var texts []string
	for _, n := range a.pending {
		if n.Kind != "image" {
			texts = append(texts, n.Text)
		}
	}
	tone := t.Warning
	if len(p.items) == 0 {
		tone = t.Accent
	}
	ui.Column(c).Padding(10, 12).Gap(8).Radius(12).Background(tone.Alpha(0.12)).Border(1, tone.Alpha(0.45)).Key("preflight").Children(func() {
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			switch {
			case len(p.items) == 0 && p.replaced > 0:
				ui.Icon(c, iconCheck).FontSize(14).TextColor(t.Success)
				ui.Text(c, fmt.Sprintf(tr("已替换 %d 处敏感内容，发往 %s · %s"), p.replaced, a.target.Name, profileName(r.Profile))).FontSize(12).Wrap().Grow(1)
			case len(p.items) == 0:
				ui.Text(c, fmt.Sprintf(tr("发送前检查：发往 %s · %s"), a.target.Name, profileName(r.Profile))).FontSize(12).Wrap().Grow(1)
			default:
				ui.Icon(c, iconWarn).FontSize(14).TextColor(t.Warning)
				ui.Text(c, tr("发送内容含敏感信息：")+pfSummary(p.items)).FontSize(12).Wrap().Grow(1)
			}
			if ghostIconButton(c, k, "pf-rescan", "refresh-cw", tr("重新检测当前文本和原始图片"), 22, 13, false, true).Clicked() {
				a.pfScan()
				a.pfScanImages()
				switch n := len(a.pf.items); {
				case n > 0:
					a.showHUD("info", fmt.Sprintf(tr("重新检测完成，发现 %d 项可能的敏感内容"), n))
				default:
					a.showHUD("ok", tr("重新检测完成，未发现敏感内容"))
				}
			}
		})
		if len(texts) > 0 { // 将要发送的内容（已套模板与输出格式，已替换的显示占位符）
			ui.Text(c, clipRunes(composePayload(texts, a.pendingTmpl, r.Profile.OutputMode()), 400)).FontSize(11).Font(fontMono).Wrap().MaxLines(8).
				Padding(6, 8).Radius(8).Background(t.Background.Alpha(0.6))
		}
		if len(p.items) > 0 {
			a.pfDetails(c, k, e)
		}
		if len(p.images) > 0 && len(p.items) == 0 {
			a.pfImageToggle(c, k)
		}
		a.pfImagesSection(c, k, policy)
		ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
			switch {
			case both.needRaw != "":
				label := tr("确认本次保留提示级原文")
				switch {
				case imgRaw && both.needRaw == "block":
					label = tr("再次确认保留图中高风险原文")
				case imgRaw:
					label = tr("确认保留图中提示级原文")
				case both.needRaw == "block":
					label = tr("再次确认保留高风险原文")
				}
				if ui.Button(c, label).Clicked() {
					if imgRaw {
						p.imgRaw = both.needRaw
						for _, im := range p.images {
							if im.status == "failed" {
								im.rawOK = true
							}
						}
					} else {
						p.raw = both.needRaw
					}
				}
			case both.canSend:
				if ui.Button(c, tr("发送")).Clicked() {
					a.pfSend(both)
				}
			case slices.ContainsFunc(p.images, func(im *pfImage) bool { return im.status == "scanning" }):
				ui.Text(c, tr("本地隐私检测中…")).FontSize(11).TextColor(t.TextMuted)
			default:
				ui.Text(c, fmt.Sprintf(tr("%d 项处理完才能发送"), both.unresolved)).FontSize(11).TextColor(t.TextMuted)
			}
			if ui.Button(c, tr("取消")).Clicked() {
				a.clearPending()
			}
		})
	})
}

func pfSummary(items []pfItem) string {
	n := map[string]int{}
	var order []string
	for _, it := range items {
		if n[it.f.Kind] == 0 {
			order = append(order, it.f.Kind)
		}
		n[it.f.Kind]++
	}
	parts := make([]string, len(order))
	for i, kd := range order {
		parts[i] = fmt.Sprintf("%s ×%d", kd, n[kd])
	}
	return strings.Join(parts, "、")
}

// pfDetails：一键处理 + 逐项列表（命中类别 · 遮罩预览 · 替换 / 保留 / 同类）。
func (a *app) pfDetails(c *ui.Context, k tokens, e pfEval) {
	t := c.Theme()
	p := &a.pf
	r, _ := a.resolution()
	all := func(pfItem) bool { return true }
	ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
		if ui.Button(c, tr("一键全部替换")).Tooltip(tr("把本次全部命中一次性替换为占位符")).Clicked() {
			a.pfReplace(all)
		}
		if ui.Button(c, tr("一键保留原文")).Tooltip(tr("确认本次检测到的全部文本敏感项按原文保留，不改变默认脱敏策略")).Clicked() {
			a.pfKeep(all)
		}
	})
	ui.Row(c).Gap(6).AlignItems(ui.Start).Children(func() {
		ui.Text(c, policyHint(r.Profile.PrivacyPolicy)+tr("；仅本次有效，已替换的内容不会恢复。")).FontSize(11).TextColor(t.TextMuted).Wrap().Grow(1).Basis(0)
		label := tr("逐项处理")
		if p.open {
			label = tr("收起列表")
		}
		b := ui.Row(c).Padding(1, 6).Radius(6).Key("pf-toggle").Role(ui.RoleButton).Label(label)
		col := hoverLink(b, k)
		b.Children(func() { text(c, label, 11, 16, 500, col).SingleLine() })
		if b.Clicked() {
			p.open = !p.open
		}
	})
	if !p.open {
		return
	}
	var act func() // 行内操作会改写副本与命中列表：推迟到整张列表画完再执行，否则后续行用旧区间切片会越界
	defer func() {
		if act != nil {
			act()
		}
	}()
	ui.Column(c).Gap(4).Children(func() {
		for _, it := range p.items {
			kept := p.kept[it.id]
			src := a.pending[it.note].Text[it.f.Start:it.f.End]
			ui.Row(c).Gap(6).Padding(4, 6).Radius(8).Background(t.Background.Alpha(0.6)).AlignItems(ui.Center).Key("pf-" + it.id).Children(func() {
				col := k.amberText
				if it.block() {
					col = k.danger
				}
				ui.Text(c, it.f.Kind).FontSize(11).TextColor(col).SingleLine()
				ui.Text(c, core.MaskedPreview(src)).FontSize(11).Font(fontMono).TextColor(k.fg).SingleLine().Grow(1).Basis(0)
				if kept {
					ui.Text(c, tr("已确认保留原文")).FontSize(11).TextColor(t.TextMuted).SingleLine()
					return
				}
				id, cat := it.id, it.f.Category
				if ghostIconButton(c, k, "pf-rep-"+id, "eraser", tr("替换为占位符"), 22, 13, false, true).Clicked() {
					act = func() { a.pfReplace(func(x pfItem) bool { return x.id == id }) }
				}
				if ghostIconButton(c, k, "pf-keep-"+id, "check", tr("保留原文发送"), 22, 13, false, true).Clicked() {
					act = func() { a.pfKeep(func(x pfItem) bool { return x.id == id }) }
				}
				m := ghostIconButton(c, k, "pf-more-"+id, "ellipsis", tr("同类处理"), 22, 13, false, true)
				m.Menu(func(mm *ui.Menu) {
					if mm.Item(tr("同类全部替换")).Chosen() {
						act = func() { a.pfReplace(func(x pfItem) bool { return x.f.Category == cat }) }
					}
					if mm.Item(tr("同类全部保留")).Chosen() {
						act = func() { a.pfKeep(func(x pfItem) bool { return x.f.Category == cat }) }
					}
				})
			})
		}
	})
}

// confirmPending 供快捷路径与测试：redact = 全部替换后发送；否则全部保留原文发送（不回车）。
func (a *app) confirmPending(redact bool) {
	if !a.pf.scanned {
		a.pfScan()
	}
	if redact {
		a.pfReplace(func(pfItem) bool { return true })
	} else {
		a.pfKeep(func(pfItem) bool { return true })
	}
	blocks := slices.ContainsFunc(a.pf.items, pfItem.block)
	a.pfSend(pfEval{canSend: true, noEnter: blocks})
}

// pfImageToggle：只有图片命中时的「逐项处理」开关（文字命中时与文字列表共用开关）。
func (a *app) pfImageToggle(c *ui.Context, k tokens) {
	p := &a.pf
	if !slices.ContainsFunc(p.images, func(im *pfImage) bool { return len(im.regions) > 0 }) {
		return
	}
	label := tr("逐项处理")
	if p.open {
		label = tr("收起列表")
	}
	b := ui.Row(c).Padding(1, 6).Radius(6).Key("pf-itoggle").Role(ui.RoleButton).Label(label)
	col := hoverLink(b, k)
	b.Children(func() { text(c, label, 11, 16, 500, col).SingleLine() })
	if b.Clicked() {
		p.open = !p.open
	}
}
