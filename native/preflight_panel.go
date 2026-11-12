package main

import (
	"fmt"
	"maps"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/core"
	"github.com/toskr/native/internal/store"
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
	items     []pfItem
	kept      map[string]bool
	ph        map[string]string // 原值 → 占位符（本次发送内稳定）
	replaced  int
	raw       string // 已确认的整体保留级别：warn | block
	open      bool   // 展开逐项列表
	scanned   bool
	images    []*pfImage
	imgRaw    string          // 图片整体确认级别
	auto      bool            // 只为图片检查打开：OCR 干净且无文字命中时自动继续发送
	final     string          // 最终文本：未手动编辑时随自动组装（模板 + 输出格式 + 已替换）刷新（同 Tauri draft.finalText）
	edited    bool            // 用户改过最终文本：之后检测与发送都以它为准（命中的 note = -1）
	keep      bool            // 本次「发送后保留面板」
	keepSet   bool            // 用户在预检里动过上面的勾
	preAlias  []store.Note    // 词典化名前的副本（与 a.pending 一一对应）
	aliasSkip map[string]bool // 本次还原为原文的词典替换（"卡下标:字节起点"）
	aliasOpen bool
	tab       int // 整面板预检的页签：0 概览 / 1 内容
}

// pfSheet：本帧 preflightBar 画成盖住整个面板的对话框（竖栏；同 Tauri PreflightComposer）。横栏仍是内嵌区。
var pfSheet bool

// preflightDialog：竖栏面板的发送预检——整面板对话框：标题栏（概览 / 内容页签、关闭）+ 可滚正文 + 底部操作栏。
func (a *app) preflightDialog(c *ui.Context) {
	if len(a.pending) == 0 {
		return
	}
	pfSheet = true
	defer func() { pfSheet = false }()
	a.preflightBar(c)
}

type pfAliasHit struct {
	note int
	hit  core.AliasHit
}

func aliasKey(note, start int) string { return fmt.Sprintf("%d:%d", note, start) }

// pfAliasHits：本次按词典自动替换的每一处（已还原的不列）。
func (a *app) pfAliasHits() []pfAliasHit {
	p := &a.pf
	st := a.store.Settings()
	if st.AliasOff || len(p.preAlias) != len(a.pending) {
		return nil
	}
	var out []pfAliasHit
	for i, n := range p.preAlias {
		if n.Kind == "secret" || n.Kind == "image" {
			continue
		}
		for _, h := range core.AliasHits(n.Text, st.AliasEntities) {
			if !p.aliasSkip[aliasKey(i, h.Start)] {
				out = append(out, pfAliasHit{i, h})
			}
		}
	}
	return out
}

// pfReapply：从化名前副本重算本次正文——词典替换（跳过已还原项）→ 重放本次的占位符替换 → 重组 / 重新检测。
func (a *app) pfReapply() {
	p := &a.pf
	st := a.store.Settings()
	if len(p.preAlias) != len(a.pending) {
		return
	}
	olds := slices.Collect(maps.Keys(p.ph))
	slices.SortFunc(olds, func(x, y string) int { return len(y) - len(x) }) // 长的先换，免得短值切进长值
	notes := slices.Clone(a.pending)
	for i, n := range p.preAlias {
		if n.Kind == "secret" || n.Kind == "image" {
			continue
		}
		t := n.Text
		if !st.AliasOff {
			t = core.ApplyAliasesSkip(t, st.AliasEntities, func(start int) bool { return p.aliasSkip[aliasKey(i, start)] })
		}
		for _, o := range olds {
			t = strings.ReplaceAll(t, o, p.ph[o])
		}
		notes[i].Text = t
	}
	a.pending = notes
	if !p.edited {
		p.final = a.pfAssembled()
	}
	a.pfScan()
}

// pfRevertAlias 同 Tauri revertAliasFinding：这一处按原文发出（仅本次）。
func (a *app) pfRevertAlias(h pfAliasHit) {
	if a.pf.aliasSkip == nil {
		a.pf.aliasSkip = map[string]bool{}
	}
	a.pf.aliasSkip[aliasKey(h.note, h.hit.Start)] = true
	a.pfReapply()
}

// pfAddFindingAlias 同 Tauri addFindingToAliasDictionary：把命中值升级为词典词条；正文没手改就立即按词典重算。
func (a *app) pfAddFindingAlias(src, category string) {
	if !a.quickAddAlias(src, category) {
		return
	}
	if a.pf.edited {
		a.showHUD("info", tr("词条已保存；本次正文已手工编辑，可点「重新检测」应用替换"))
		return
	}
	a.pfReapply()
}

// pfAliasSection 同 Tauri「可逆化名 · 已自动替换 n 处」折叠区：逐项「原文 → 占位符」与「还原为原文」。
func (a *app) pfAliasSection(c *ui.Context, k tokens) {
	hits := a.pfAliasHits()
	if len(hits) == 0 {
		return
	}
	p := &a.pf
	custom := a.store.Settings().AliasCategories
	var act func()
	defer func() {
		if act != nil {
			act()
		}
	}()
	ui.Column(c).Gap(4).Key("pf-alias").Children(func() {
		head := ui.Row(c).Gap(6).AlignItems(ui.Center).Key("pf-alias-head").Role(ui.RoleButton).Label(fmt.Sprintf(tr("可逆化名 · 已自动替换 %d 处"), len(hits)))
		col := hoverLink(head, k)
		head.Children(func() {
			licon(c, "venetian-mask", 12, col)
			text(c, fmt.Sprintf(tr("可逆化名 · 已自动替换 %d 处"), len(hits)), 11, 16, 500, col).SingleLine().Grow(1).Basis(0)
			licon(c, map[bool]string{true: "chevron-down", false: "chevron-right"}[p.aliasOpen], 12, col)
		})
		if head.Clicked() {
			p.aliasOpen = !p.aliasOpen
		}
		if !p.aliasOpen {
			return
		}
		ui.Column(c).Gap(4).Padding(6).Radius(rr(8)).Border(1, k.inputBorder).Children(func() {
			for _, h := range hits {
				ui.Row(c).Gap(6).Padding(4, 6).Radius(rr(6)).Background(c.Theme().Background.Alpha(0.6)).AlignItems(ui.Center).Key("pf-al-" + aliasKey(h.note, h.hit.Start)).Children(func() {
					ui.Row(c).Height(16).Padding(0, 4).Radius(4).Background(k.track).AlignItems(ui.Center).
						Children(func() {
							text(c, tr(core.AliasCategoryLabel(h.hit.Entity.Category, custom)), 10, 14, 500, k.muted).SingleLine()
						})
					text(c, h.hit.Entity.OriginalText+" → "+h.hit.Entity.Placeholder, 10, 14, 400, k.muted).Font(fontMono).SingleLine().Grow(1).Basis(0)
					tip := tr("还原为原文")
					if p.edited {
						tip = tr("正文已手工编辑，先「恢复自动组装」再还原")
					}
					b := tipOf(c, ui.Row(c).Height(20).Padding(0, 6).Radius(rr(6)).AlignItems(ui.Center).Key("pf-al-rv-"+aliasKey(h.note, h.hit.Start)).Role(ui.RoleButton).Label(tr("还原为原文")), tip)
					fg := k.fg
					switch {
					case p.edited:
						b.Opacity(0.45)
					case b.Hovered():
						b.Background(k.track)
					}
					b.Children(func() { text(c, tr("还原为原文"), 10, 14, 500, fg).SingleLine() })
					if b.Clicked() && !p.edited {
						hh := h
						act = func() { a.pfRevertAlias(hh) }
					}
				})
			}
			text(c, tr("已按词典自动替换，发送后可在本机恢复；如需保留原文可逐项还原（仅本次发送有效）"), 10, 14, 400, k.muted).Wrap()
		})
	})
}

// finalNote：最终文本被手动编辑后，命中归到这个虚拟下标。
const finalNote = -1

// pfText：命中所在的文本（卡片副本或已编辑的最终文本）。
func (a *app) pfText(note int) string {
	if note == finalNote {
		return a.pf.final
	}
	return a.pending[note].Text
}

// pfAssembled：自动组装的最终文本（同 deliver 的 composePayload）。
func (a *app) pfAssembled() string {
	var texts []string
	for _, n := range a.pending {
		if n.Kind != "image" {
			texts = append(texts, n.Text)
		}
	}
	if len(texts) == 0 {
		return ""
	}
	r, _ := a.resolution()
	return composePayload(texts, a.pendingTmpl, a.outputMode(r.Profile))
}

// pfRebuild：模板 / 格式改了或「恢复自动组装」——丢弃手动编辑，按新条件重组并重新检测（同 Tauri rebuildPreflightDraft）。
func (a *app) pfRebuild() {
	a.pf.edited = false
	a.pf.final = a.pfAssembled()
	a.pfScan()
}

func pfID(note int, f core.Finding) string {
	return fmt.Sprintf("%s:%d:%d:%d", f.Rule, note, f.Start, f.End)
}

// pfScan 重新检测当前（可能已替换过的）副本；仍然存在的保留项继续保留，整体确认作废（同 Tauri revision 变化）。
func (a *app) pfScan() {
	p := &a.pf
	rules := a.scanRules()
	if a.pfRehearsal { // 演练：隐私检查强制开启、全部类别（同 Tauri secureRehearsalDraft）
		rules = core.Rules{CustomFields: rules.CustomFields}
	}
	var items []pfItem
	if p.edited {
		for _, f := range core.Scan(p.final, rules) {
			items = append(items, pfItem{finalNote, f, pfID(finalNote, f)})
		}
	}
	for i, n := range a.pending {
		if n.Kind == "image" || p.edited {
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
		if i == finalNote {
			p.final = core.ReplaceWithPlaceholders(p.final, fs, p.ph)
			continue
		}
		notes[i].Text = core.ReplaceWithPlaceholders(notes[i].Text, fs, p.ph)
	}
	a.pending = notes
	if !p.edited {
		p.final = a.pfAssembled()
	}
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
	if p.edited && strings.TrimSpace(p.final) == "" {
		e.reason = tr("最终文本为空")
		return e
	}
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

// pfPolicy：本次预检的隐私策略（演练固定 requireRedaction）。
func (a *app) pfPolicy() string {
	if a.pfRehearsal {
		return "requireRedaction"
	}
	r, _ := a.resolution()
	return r.Profile.PrivacyPolicy
}

func (a *app) clearPending() {
	a.pending, a.pendingTmpl, a.pf = nil, "", preflightState{}
	a.closeLiveCompare()
}

// cancelPending：用户取消预检，本次的输出格式覆盖一并作废。
func (a *app) cancelPending() {
	a.cancelFanout()
	a.clearPending()
	a.pfRehearsal = false
	a.sendMode, a.draftTarget = "", draftTarget{}
}

// cancelEnterAsk：取消「粘贴后按回车？」——预检留下的遮挡图副本与占位符映射一并作废，不能带进下一次发送。
func (a *app) cancelEnterAsk() {
	a.cancelFanout()
	a.enterAsk, a.sendMode, a.sendPNG, a.sendPH, a.draftTarget, a.sendFinal, a.sendKeep = nil, "", nil, sendRedaction{}, draftTarget{}, "", nil
}

// pfCombined：文字与图片两路检查都放行才能发；任一路要求不回车即不回车。
func (a *app) pfCombined(policy string) (pfEval, pfEval) {
	return a.pfEvaluate(policy), a.pfImageEval(policy)
}

// pfSend 按当前副本发出；保留了高风险原文时强制不回车。图片有遮挡时发遮挡副本。
func (a *app) pfSend(e pfEval) {
	notes, tmpl := a.pending, a.pendingTmpl
	a.lastRedactions += a.pf.replaced
	var sent []string
	for _, n := range a.pending {
		sent = append(sent, n.Text)
	}
	if a.pf.edited {
		sent, a.sendFinal = []string{a.pf.final}, a.pf.final
	}
	if a.pf.keepSet && !a.pfRehearsal {
		keep := a.pf.keep
		a.sendKeep = &keep
	}
	a.sendPH = sendRedaction{maps.Clone(a.pf.ph), core.PlaceholderCounts(strings.Join(sent, "\n"))} // 发送成功后按这次发送记住：回复里可恢复占位符、核验次数
	a.sendPNG = nil
	for _, im := range a.pf.images {
		a.out.findings += len(im.regions) // 图片里的隐私命中也计入「发现敏感内容」
	}
	for _, im := range a.pf.images {
		if b := im.maskedPNG(); b != nil { // 按文件对应：图文 / 多图卡里被遮挡的那张发副本
			if a.sendPNG == nil {
				a.sendPNG = map[string][]byte{}
			}
			a.sendPNG[im.file] = b
			for _, v := range im.masked {
				if v {
					a.lastRedactions++
				}
			}
		}
	}
	a.rememberCompare(a.out.id) // 发送记录里可再打开这次的对比（内存）
	a.clearPending()
	if a.pfRehearsal {
		a.deliver(notes, false, tmpl) // 演练：不回车、不问回车
		return
	}
	if r, _ := a.resolution(); r.Profile.EnterPolicy == "confirm" && !e.noEnter {
		a.deliver(notes, true, tmpl) // 同 Tauri：confirm 方案并入预检，点「发送」即确认回车，不再二次询问
		return
	}
	a.askEnter(notes, e.noEnter, tmpl)
}

// pfSubmit：⌘⏎ 提交预检——文字与图片两路都放行时发送；还差确认 / 处理时提示原因。
func (a *app) pfSubmit() {
	if !a.pf.scanned {
		a.pfScan()
		a.pfScanImages()
	}
	e, ie := a.pfCombined(a.pfPolicy())
	if e.canSend && ie.canSend {
		a.pfSend(pfEval{canSend: true, noEnter: e.noEnter || ie.noEnter})
		return
	}
	a.showHUD("info", cmpOr(cmpOr(e.reason, ie.reason), tr("请先处理预检里的项目")))
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
	policy := a.pfPolicy()
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
	sheet := pfSheet
	pfBox := ui.Column(c).Padding(10, 12).Gap(8).Radius(12).Background(tone.Alpha(0.12)).Border(1, tone.Alpha(0.45)).Key("preflight")
	switch {
	case k.th.PreflightFrame(pfBox, sheet): // 主题自己的容器样式
	case sheet:
		pfBox.Absolute().Top(0).Left(0).Right(0).Bottom(0).Padding(0).Gap(0).Radius(rr(14)).Background(sheetBg(c)).Border(1, k.floatBorder)
	}
	if sheet {
		_ = pfBox.Clicked() // 吃掉落在空白处的点击，不漏给底下的列表
	}
	pfBox.Children(func() {
		head := func() {
			if a.pfRehearsal { // 同 Tauri PreflightComposer safeRehearsal 标题与安全锁
				text(c, tr("检查并粘贴"), 13, 18, 600, k.fg)
				hint := tr("确认正文后，点下方「安全粘贴」。教程不会自动按回车。")
				if len(p.items) > 0 {
					hint = tr("点「一键全部替换」处理示例邮箱，检查正文后点「安全粘贴」。")
				}
				text(c, hint, 11, 16, 400, k.muted).Wrap()
				text(c, tr("演练安全锁：只粘贴，不按回车"), 11, 16, 500, t.Success)
			}
			ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
				switch {
				case len(p.items) == 0 && p.replaced > 0:
					ui.Icon(c, iconCheck).FontSize(14).TextColor(t.Success)
					ui.Text(c, fmt.Sprintf(tr("已替换 %d 处敏感内容，发往 %s · %s"), p.replaced, a.target.Name, profileName(r.Profile))).FontSize(12).Wrap().Grow(1)
				case len(p.items) == 0: // 标题 + 单行副标题（长方案名不再把「方案」挤成单字换行）
					ui.Column(c).Grow(1).Basis(0).Children(func() {
						text(c, tr("发送前检查"), 12, 17, 600, k.fg).SingleLine()
						tipOf(c, text(c, a.target.Name+" · "+profileName(r.Profile), 11, 16, 400, k.muted).SingleLine(), a.target.Name+" · "+profileName(r.Profile))
					})
				default:
					ui.Icon(c, iconWarn).FontSize(14).TextColor(t.Warning)
					ui.Text(c, tr("发送内容含敏感信息：")+pfSummary(p.items)).FontSize(12).Wrap().Grow(1)
				}
				if ghostIconButton(c, k, "pf-compare", "columns-2", tr("对比原文与将发送的内容"), 22, 13, false, true).Clicked() {
					a.openPFCompare()
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
		}
		payload := func() {
			if len(texts) > 0 {
				a.pfSendOptions(c, k, r.Profile, both.noEnter)
				a.pfFinalText(c, k)
			}
		}
		body := func() {
			if len(p.items) > 0 {
				a.pfDetails(c, k, e)
			}
			a.pfAliasSection(c, k)
			if len(p.images) > 0 && len(p.items) == 0 {
				a.pfImageToggle(c, k)
			}
			a.pfImagesSection(c, k, policy)
		}
		actions := func() {
			ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
				cancel := func() {
					if linkButton(c, k, "pf-cancel", tr("取消")) {
						a.cancelPending()
					}
				}
				if sheet { // 对话框底栏：取消在左，主操作在最右
					cancel()
				}
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
					if pfButton(c, k, "pf-raw", label, "", true, false) {
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
					label := tr("发送")
					if a.pfRehearsal {
						label = tr("安全粘贴")
					}
					if pfButton(c, k, "pf-send", label, "", true, false) {
						a.pfSend(both)
					}
				case slices.ContainsFunc(p.images, func(im *pfImage) bool { return im.status == "scanning" }):
					ui.Text(c, tr("本地隐私检测中…")).FontSize(11).TextColor(t.TextMuted)
				default:
					ui.Text(c, fmt.Sprintf(tr("%d 项处理完才能发送"), both.unresolved)).FontSize(11).TextColor(t.TextMuted)
				}
				if !sheet {
					cancel()
				}
			})
		}
		if sheet {
			line := k.inputBorder
			if l, ok := k.th.Line(); ok {
				line = l
			}
			card := func(key string, fn func()) { // 分块卡：细边圆角；主题可改成蚀刻框
				b := ui.Column(c).Padding(10).Gap(8).Radius(rr(10)).Border(1, line).Key("pfc-" + key)
				if !k.th.Etched(b) {
					b.Background(k.card.Alpha(0.6))
				}
				b.Children(fn)
			}
			if len(texts) == 0 {
				p.tab = 0
			}
			ui.Row(c).Padding(10, 12).Gap(8).AlignItems(ui.Center).BorderWidth(0, 0, 1, 0).BorderColor(line).Children(func() {
				ui.Column(c).Grow(1).Basis(0).Children(func() {
					text(c, tr("发送预检"), 13, 18, 600, k.fg).SingleLine()
					text(c, tr("确认目标、内容与粘贴后动作"), 11, 16, 400, k.muted).SingleLine()
				})
				if len(texts) > 0 {
					if v, ok := miniSegmented(c, k, itoa(p.tab), [][2]string{{"0", "概览"}, {"1", "内容"}}); ok {
						p.tab = map[string]int{"0": 0, "1": 1}[v]
					}
				}
				if ghostIconButton(c, k, "pf-close", "x", tr("关闭预检（Esc）"), 22, 14, false, true).Clicked() {
					a.cancelPending()
				}
			})
			ui.Scroll(c).Grow(1).Basis(0).Scrollbars(false).Children(func() {
				ui.Column(c).Padding(12).Gap(10).Children(func() {
					if p.tab == 1 { // 内容：可编辑的最终文本
						a.pfFinalText(c, k)
						return
					}
					card("check", func() {
						head()
						body()
					})
					if len(texts) == 0 {
						return
					}
					card("target", func() {
						ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
							ui.Box(c).Size(28, 28).Radius(rr(8)).Background(k.track).Center().Children(func() { licon(c, "app-window", 14, k.muted) })
							ui.Column(c).Grow(1).Basis(0).Children(func() {
								text(c, cmpOr(a.target.Name, tr("未识别目标")), 12, 17, 600, k.fg).SingleLine()
								text(c, tr("可发送"), 10, 14, 400, k.muted)
							})
							ui.Box(c).Padding(2, 6).Radius(rr(6)).Background(k.track).Children(func() { text(c, profileName(r.Profile), 10, 14, 500, k.fg).SingleLine() })
						})
						a.pfSendOptions(c, k, r.Profile, both.noEnter)
					})
					card("preview", func() { // 将要粘贴的内容：只读预览，「编辑」切到内容页
						if !p.edited {
							p.final = a.pfAssembled()
						}
						ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
							text(c, tr("将要粘贴的内容"), 11, 16, 600, k.fg).Grow(1)
							text(c, fmt.Sprintf(tr("%d 字符"), utf8.RuneCountInString(p.final)), 10, 14, 400, k.muted).FontFeatures("tnum")
							if linkButton(c, k, "pf-edit", tr("编辑")) {
								p.tab = 1
							}
						})
						text(c, p.final, 11, 16, 400, k.fg).Font(fontMono).Wrap().MaxLines(8).Padding(6, 8).Radius(rr(6)).Background(k.track)
					})
				})
			})
			ui.Row(c).Padding(8, 12).Gap(8).AlignItems(ui.Center).BorderWidth(1, 0, 0, 0).BorderColor(line).Children(func() {
				text(c, both.reason, 11, 16, 400, k.amberText).SingleLine().Grow(1).Basis(0)
				actions()
			})
			return
		}
		if a.hbar() { // 横栏（同 Tauri PreflightComposer horizontal）：左 0.9 概览 / 右 1.1 正文并排
			ui.Row(c).Gap(8).AlignItems(ui.Stretch).Children(func() {
				ui.Column(c).Grow(0.9).Basis(0).Gap(8).Children(func() {
					head()
					body()
					actions()
				})
				ui.Scroll(c).Grow(1.1).Basis(0).MaxHeight(180).Scrollbars(false).Children(func() {
					ui.Column(c).Children(payload)
				})
			})
			return
		}
		head()
		payload()
		body()
		actions()
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
		if pfButton(c, k, "pf-repall", tr("一键全部替换"), tr("把本次全部命中一次性替换为占位符"), true, true) {
			a.pfReplace(all)
		}
		if linkButton(c, k, "pf-keepall", tr("一键保留原文")) { // 次操作降为文字链接
			a.pfKeep(all)
		}
	})
	ui.Row(c).Gap(6).AlignItems(ui.Start).Children(func() {
		ui.Text(c, policyHint(r.Profile.PrivacyPolicy)+tr("；仅本次有效，已替换的内容不会恢复。")).FontSize(11).TextColor(t.TextMuted).Wrap().Grow(1).Basis(0)
		label := tr("逐项处理")
		if p.open {
			label = tr("收起列表")
		}
		b := ui.Row(c).Padding(1, 6).Radius(rr(6)).Key("pf-toggle").Role(ui.RoleButton).Label(label)
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
			src := a.pfText(it.note)[it.f.Start:it.f.End]
			ui.Row(c).Gap(6).Padding(4, 6).Radius(rr(8)).Background(t.Background.Alpha(0.6)).AlignItems(ui.Center).Key("pf-" + it.id).Children(func() {
				col := k.amberText
				if it.block() {
					col = k.danger
				}
				ui.Text(c, it.f.Kind).FontSize(11).TextColor(col).SingleLine()
				pv := tipOf(c, ui.Row(c).Grow(1).Basis(0).Key("pf-pv-"+it.id).Role(ui.RoleButton).Label(tr("点击对比原文与替换后的内容")), tr("点击对比原文与替换后的内容"))
				pv.Children(func() {
					ui.Text(c, core.MaskedPreview(src)).FontSize(11).Font(fontMono).TextColor(k.fg).SingleLine()
					if pv.Hovered() {
						licon(c, "columns-2", 11, k.muted).Margin(0, 0, 0, 4)
					}
				})
				if pv.Clicked() {
					a.openPFCompare()
				}
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
				warn := !it.block()
				m.Menu(func(mm *ui.Menu) {
					if mm.Item(tr("同类全部替换")).Chosen() {
						act = func() { a.pfReplace(func(x pfItem) bool { return x.f.Category == cat }) }
					}
					if mm.Item(tr("同类全部保留")).Chosen() {
						act = func() { a.pfKeep(func(x pfItem) bool { return x.f.Category == cat }) }
					}
					if !warn { // 同 Tauri：只有提示级命中可升级为词典实体（高风险密钥类不进词典）
						return
					}
					mm.Separator()
					mm.Item(tr("加入词典")).Disabled(true)
					for _, cc := range slices.Concat(core.AliasPresetCategories, a.store.Settings().AliasCategories) {
						if mm.Item(tr(cc.Label)).Chosen() {
							v, code := src, cc.Code
							act = func() { a.pfAddFindingAlias(v, code) }
						}
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
	b := ui.Row(c).Padding(1, 6).Radius(rr(6)).Key("pf-itoggle").Role(ui.RoleButton).Label(label)
	col := hoverLink(b, k)
	b.Children(func() { text(c, label, 11, 16, 500, col).SingleLine() })
	if b.Clicked() {
		p.open = !p.open
	}
}

// pfSelect：预检里的紧凑下拉（同 Tauri SimpleSelect size="micro"）。
func pfSelect(c *ui.Context, k tokens, key, caption, value string, menu func(*ui.Menu)) {
	ui.Column(c).Grow(1).Basis(0).Gap(3).Children(func() {
		text(c, caption, 10, 14, 400, k.muted).SingleLine()
		b := ui.Row(c).Height(26).Padding(0, 8).Gap(4).Radius(rr(8)).Background(k.window).Border(1, k.inputBorder).AlignItems(ui.Center).
			Key(key).Role(ui.RoleButton).Label(caption)
		if b.Hovered() {
			b.Background(k.track)
		}
		b.Children(func() {
			text(c, value, 11, 16, 500, k.fg).SingleLine().Grow(1).Basis(0)
			licon(c, "chevron-down", 12, k.muted)
		})
		b.Menu(menu)
	})
}

var pfFormats = []struct{ mode, label string }{
	{"plain", "原文（保留 Markdown）"},
	{"strip-markdown", "去 Markdown 后发送"},
	{"code", "代码块 ```"},
}

// enterPolicyLabel 同 Tauri ENTER_POLICY_STATUS_LABEL。
func enterPolicyLabel(p string) string {
	switch p {
	case "never":
		return tr("从不按回车")
	case "confirm":
		return tr("每次发送前确认")
	}
	return tr("自动按回车 · 高风险")
}

// pfSendOptions 同 Tauri PreflightComposer「本次发送」区：提示词模板 · 发送格式 · 粘贴后动作 · 发送后保留面板。
func (a *app) pfSendOptions(c *ui.Context, k tokens, prof store.TargetProfile, noEnter bool) {
	p := &a.pf
	st := a.store.Settings()
	tmplLabel := tr("不使用模板")
	if a.pendingTmpl != "" {
		tmplLabel = tr("自定义模板")
		for _, sn := range st.PromptSnippets {
			if sn.Text == a.pendingTmpl {
				tmplLabel = sn.Label
				break
			}
		}
	}
	mode := a.outputMode(prof)
	modeLabel := mode
	for _, f := range pfFormats {
		if f.mode == mode {
			modeLabel = tr(f.label)
		}
	}
	ui.Column(c).Gap(6).Key("pf-options").Children(func() {
		ui.Row(c).Gap(8).Children(func() {
			pfSelect(c, k, "pf-tmpl", tr("提示词模板"), tmplLabel, func(m *ui.Menu) {
				if m.Item(tr("不使用模板")).Checked(a.pendingTmpl == "").Chosen() {
					a.pendingTmpl = ""
					a.pfRebuild()
				}
				if len(st.PromptSnippets) > 0 {
					m.Separator()
				}
				for _, sn := range st.PromptSnippets {
					if m.Item(sn.Label).Checked(sn.Text == a.pendingTmpl).Chosen() {
						cur := a.store.Settings()
						cur.UseSnippet(sn.ID)
						_ = a.store.SetSettings(cur)
						a.pendingTmpl = sn.Text
						a.pfRebuild()
					}
				}
			})
			pfSelect(c, k, "pf-format", tr("发送格式"), modeLabel, func(m *ui.Menu) {
				for _, f := range pfFormats {
					if m.Item(tr(f.label)).Checked(f.mode == mode).Chosen() {
						a.sendMode = f.mode
						a.pfRebuild()
					}
				}
			})
		})
		if a.pendingTmpl != "" {
			text(c, a.pendingTmpl, 10, 14, 400, k.muted).Font(fontMono).Wrap().MaxLines(3).Padding(4, 6).Radius(rr(6)).Background(k.track)
		}
		decision := tr("本次不按回车")
		switch {
		case a.pfRehearsal || noEnter || prof.EnterPolicy == "never":
		case prof.EnterPolicy == "confirm":
			decision = tr("点击发送即确认，粘贴后按回车")
		default:
			decision = tr("本次会按回车")
		}
		ui.Row(c).Gap(4).AlignItems(ui.Center).Children(func() {
			text(c, fmt.Sprintf(tr("粘贴后动作：%s"), enterPolicyLabel(prof.EnterPolicy)), 11, 16, 500, k.fg).SingleLine()
			text(c, "· "+decision, 11, 16, 400, k.muted).SingleLine().Grow(1).Basis(0)
		})
		if !a.pfRehearsal {
			if !p.keepSet {
				p.keep = prof.KeepPanel
			}
			cb := ui.Row(c).Gap(6).AlignItems(ui.Center).Key("pf-keep").Role(ui.RoleCheckBox).Label(tr("发送后保留面板")).Selected(p.keep)
			cb.Children(func() { // 同 Tauri 原生勾选框：14 圆角 4，勾上填主色 + 白勾
				box := ui.Box(c).Size(14, 14).Radius(4).Center()
				switch {
				case k.th.CheckGlyph(c, box, p.keep): // 主题自己的勾选框
				case p.keep:
					box.Background(stok(c).primary)
					box.Children(func() { licon(c, "check", 10, gray(0.985, 1)) })
				default:
					box.Background(k.window).Border(1, k.inputBorder)
				}
				text(c, tr("发送后保留面板"), 11, 16, 400, k.fg)
			})
			if cb.Clicked() {
				p.keep, p.keepSet = !p.keep, true
			}
		}
	})
}

// pfFinalText 同 Tauri「最终文本」：可直接改（字符数、恢复自动组装）；改过之后检测与发送都以它为准。
func (a *app) pfFinalText(c *ui.Context, k tokens) {
	p := &a.pf
	assembled := a.pfAssembled()
	if !p.edited {
		p.final = assembled
	}
	ui.Column(c).Gap(4).Key("pf-final").Children(func() {
		ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
			text(c, tr("最终文本"), 11, 16, 600, k.fg)
			if p.edited {
				ui.Row(c).Height(16).Padding(0, 5).Radius(8).Background(k.track).AlignItems(ui.Center).
					Children(func() { text(c, tr("已手动编辑"), 9, 12, 500, k.muted) })
			}
			ui.Box(c).Grow(1)
			fc := fmt.Sprintf(tr("%d 字符"), utf8.RuneCountInString(p.final))
			text(c, fc, 10, 14, 400, k.muted).FontFeatures("tnum").MinWidth(numSlot(c, fmt.Sprintf(tr("%d 字符"), 10000), 10, 400)).TextAlign(ui.End) // 编辑最终文本时字数变化不挪动「恢复自动组装」
			b := ui.Row(c).Height(20).Padding(0, 6).Gap(3).Radius(rr(6)).AlignItems(ui.Center).Key("pf-reset").Role(ui.RoleButton).Label(tr("恢复自动组装"))
			col := k.muted
			switch {
			case !p.edited:
				b.Opacity(0.45)
			case b.Hovered():
				b.Background(k.track)
				col = k.fg
			}
			b.Children(func() {
				licon(c, "rotate-ccw", 11, col)
				text(c, tr("恢复自动组装"), 10, 14, 500, col)
			})
			if b.Clicked() && p.edited {
				a.pfRebuild()
			}
		})
		ta := ui.TextAreaBase(c, &p.final).FillWidth().Lines(3, 8).Font(fontMono).FontSize(11).FixedLineHeight(16).TextColor(k.fg).
			Padding(6, 8).Radius(8).Background(c.Theme().Background.Alpha(0.6)).Border(1, k.inputBorder).Label(tr("最终文本"))
		k.th.Well(ta)
		if ta.Changed() && p.final != assembled {
			p.edited = true
			a.pfScan()
		}
	})
}

// pfButton：预检条里的文字按钮，与应用其余文字按钮同款（Button default 变体：白底细描边，同发送钮；蓝色主色只做焦点 / 选中，
// 不铺按钮底）；primary 只加粗字重，主次靠「主操作占满一行、次操作降为文字链接」区分；wide = 占满剩余宽度。
func pfButton(c *ui.Context, k tokens, key, label, tip string, primary, wide bool) bool {
	s := stok(c)
	b := ui.Row(c).Height(26).Padding(0, 10).Radius(rr(8)).Justify(ui.Center).AlignItems(ui.Center).Key(key).Role(ui.RoleButton).Label(label)
	if wide {
		b.Grow(1).Basis(0)
	} else {
		b.Shrink(0)
	}
	if tip != "" {
		tipOf(c, b, tip)
	}
	if fg, w, ok := k.th.PushButton(b); ok { // 主题的推钮
		b.Children(func() { text(c, label, 12, 17, w, fg).SingleLine() })
		return b.Clicked()
	}
	bg, w := s.btn, 500
	if b.Hovered() {
		bg = s.btnHover
	}
	if primary {
		w = 600
	}
	b.Border(1, s.btnBorder).Shadow(0, 1, 2, 0, s.btnShadow)
	fadeColor(b, "bg", bg, tweenControl)
	b.AnimatePose(ui.Pose{Y: pressY(b.Pressed())}, tweenControl)
	b.Children(func() { text(c, label, 12, 17, w, s.btnFg).SingleLine() })
	return b.Clicked()
}

func init() { // 整面板预检新增文案的英文（已有的键不覆盖）
	for k, v := range map[string]string{
		"发送预检": "Send preflight", "确认目标、内容与粘贴后动作": "Confirm the target, content and after-paste action",
		"概览": "Overview", "内容": "Content", "将要粘贴的内容": "Content to paste", "关闭预检（Esc）": "Close preflight (Esc)",
	} {
		if _, ok := en[k]; !ok {
			en[k] = v
		}
	}
}
