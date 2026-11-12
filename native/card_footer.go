package main

import (
	"fmt"

	"github.com/egoist/mygo/transfer"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/core"
	"github.com/toskr/native/internal/store"
)

// 卡片页脚左段（同 Tauri NoteCard footer）：回复卡「来自发送结果」（来源缺失转警示色，点开来源）→ 含词典占位符「含 N 处化名 · 点击恢复」
// → 来源应用；随后最多 3 个 #标签 +N。右段（时间 / 尺寸 / 字数）由调用方画。

// provenanceSources：回复卡关联发送的来源卡（仍在库里的）与来源总数。
func (a *app) provenanceSources(n store.Note) ([]store.Note, int) {
	if n.Provenance == nil {
		return nil, 0
	}
	ids := n.Provenance.SourceIDs
	for _, d := range a.store.Deliveries() {
		if d.ID == n.Provenance.DeliveryID && len(d.SourceIDs) > 0 {
			ids = d.SourceIDs
		}
	}
	var out []store.Note
	for _, id := range ids {
		if src, ok := a.store.Note(id); ok {
			out = append(out, src)
		}
	}
	return out, len(ids)
}

// openProvenanceSource 同 Tauri openProvenanceSource：单张来源开详情，多张开只读合并预览，都缺失时提示。
func (a *app) openProvenanceSource(n store.Note) {
	src, total := a.provenanceSources(n)
	switch {
	case len(src) == 0:
		a.showHUD("info", tr("这次发送的来源卡片已不在库里"))
	case len(src) == 1 && total == 1:
		a.openDetail(src[0])
	default:
		a.openBatchDetail(src, total)
	}
}

// sentChip：发过的卡——绿色小勾 + 次数（状态色只落在这枚小标上）。
func (a *app) sentChip(c *ui.Context, k tokens, n store.Note) {
	cnt := n.SendCount
	if cnt == 0 {
		return
	}
	label := tr("已发送")
	if cnt > 1 {
		label += " ×" + itoa(cnt)
	}
	ui.Row(c).Height(16).Padding(0, 5, 0, 4).Gap(3).Radius(5).Background(k.ok.Alpha(0.14)).AlignItems(ui.Center).Shrink(0).Label(label).Children(func() {
		licon(c, "check", 10, k.ok)
		text(c, label, 10, 14, 500, k.ok).SingleLine()
	})
}

func footLinkButton(c *ui.Context, k tokens, key, icon, label, tip string, col ui.Color) bool {
	b := tipOf(c, ui.Row(c).Gap(3).Radius(4).AlignItems(ui.Center).Shrink(1).Key(key).Role(ui.RoleButton).Label(label), cmpOr(tip, label))
	if b.Hovered() {
		col = k.fg
	}
	b.Children(func() {
		licon(c, icon, 11, col)
		text(c, label, 10, 14, 400, col).SingleLine()
	})
	return b.Clicked()
}

func (a *app) cardFooterLead(c *ui.Context, k tokens, n store.Note) {
	a.cardFooterLeadOpt(c, k, n, true)
}

// cardFooterLeadOpt：withSource 为 false 时不写「来自 X」（笔记卡的来源已在通栏上）。
func (a *app) cardFooterLeadOpt(c *ui.Context, k tokens, n store.Note, withSource bool) {
	ui.Row(c).Grow(1).Basis(0).Gap(4).AlignItems(ui.Center).Clip().Children(func() {
		switch {
		case n.Provenance != nil:
			src, total := a.provenanceSources(n)
			label, col := tr("来自发送结果"), k.muted
			switch {
			case len(src) == 0:
				label, col = tr("发送结果 · 来源缺失"), k.amberText
			case len(src) < total:
				label, col = tr("发送结果 · 部分来源缺失"), k.amberText
			}
			if footLinkButton(c, k, "prov-"+n.ID, "link-2", label, tr("打开这次发送的来源"), col) {
				a.openProvenanceSource(n)
			}
		case core.AliasOccurrences(n.Text, a.store.Settings().AliasEntities) > 0:
			cnt := core.AliasOccurrences(n.Text, a.store.Settings().AliasEntities)
			if footLinkButton(c, k, "alias-"+n.ID, "venetian-mask", fmt.Sprintf(tr("含 %d 处化名 · 点击恢复"), cnt), tr("把词典占位符还原为原文（本机操作，可撤销）"), k.muted) {
				a.restoreCardAliases(n)
			}
		case n.SourceApp != "" && withSource:
			text(c, tr("来自 ")+n.SourceApp, 10, 14, 400, k.muted).SingleLine().Shrink(1)
		}
		for i, t := range n.Tags {
			if i == 3 {
				text(c, fmt.Sprintf("+%d", len(n.Tags)-3), 10, 14, 400, k.muted).Shrink(0)
				break
			}
			ui.Row(c).Height(16).Padding(0, 4).Radius(3).Background(k.track).InsetShadow(0, 1, 2, 0, k.insetShadow).AlignItems(ui.Center).MaxWidth(80).Shrink(0).
				Children(func() { text(c, "#"+t, 10, 14, 400, k.muted).SingleLine() })
		}
	})
}

// doneText 同 Tauri done 卡：正文转弱色 + 删除线 + 60% 透明。卡面正文同时是拖出源（同 Tauri dragOutProps）：
// 抓文字 = 把原文拖到其他应用，抓卡片其余部分 = 拖拽排序。
func doneText(e ui.Element, k tokens, n store.Note) ui.Element {
	if n.Done {
		e.TextColor(k.muted).Strikethrough().Opacity(0.6)
	}
	if n.Kind != "image" && n.Kind != "link" && n.Kind != "secret" && !n.Blur && n.Text != "" { // 模糊卡、秘文不可拖出明文
		group := cardDragNotes(n) // 在多选里拖整组（同发送钮）
		var opts []transfer.DragOptions
		if e.Hovered() { // 拖出预览只在悬停时生成（按下前一定悬停过）
			opts = append(opts, cardDragOptions(group, k.dark))
		}
		tipOf(buildCtx, e.DragDataFrom(func() transfer.Data { return transfer.TextData(cardDragText(group)) }, opts...).
			Drag(cardTextDrag{noteIDs(group)}), tr("拖出原文（不脱敏，目标由拖放位置决定）；拖进详情窗插在落点"))
		// 拖出源会接走按下：单击 / 双击转交给所在卡片（cardPressed）
		if e.Clicked() || e.DoubleClicked() {
			textHit = cardTextHit{id: n.ID, click: e.Clicked(), dbl: e.DoubleClicked(), mods: e.ClickModifiers()}
		}
	}
	return e
}

// cardTextHit：上一次点在卡面正文（拖出源）上的单击 / 双击，由同一帧里卡片的 cardPressed 取走。
type cardTextHit struct {
	id         string
	click, dbl bool
	mods       ui.Modifiers
}

var textHit cardTextHit

// cardPressed：卡片本身或其正文被单击 / 双击（含修饰键）。
func cardPressed(box ui.Element, id string) (click, dbl bool, mods ui.Modifiers) {
	click, dbl, mods = box.Clicked(), box.DoubleClicked(), box.ClickModifiers()
	if h := textHit; h.id == id {
		textHit = cardTextHit{}
		click, dbl, mods = click || h.click, dbl || h.dbl, mods|h.mods
	}
	return
}
