package main

import (
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/toskr/native/internal/store"
)

// 剪贴页「添加到打开的卡片」（同 Tauri insertClipboardNotesIntoOpenEditor）：详情窗开着时，剪贴页的发送改为把所选剪贴卡
// 的文字（多条为编号列表）与图片追加进那张卡——在编辑就进编辑草稿（光标落末尾），否则直接写进卡片（可撤销）。不外发。

var detailVisible = func(a *app) bool { return a.detailWin != nil && a.detailWin.IsVisible() } // 测试替换

// openCardID：可见详情窗正在看的卡（当前窗）；没有返回空。
func (a *app) openCardID() string {
	if a.detail.id == "" || !detailVisible(a) {
		return ""
	}
	return a.detail.id
}

// sendFromList：面板列表里的发送入口（双击卡片、卡片发送钮、⌘⏎、⌘1…9）统一走这里——详情窗开着且发的全是剪贴卡时，
// 内容追加进那张卡（编辑中进草稿），不外发；否则照常发送。详情窗自己的发送不走这里（同 Tauri sendsExternal 豁免）。
func (a *app) sendFromList(notes []store.Note) {
	if a.insertsIntoOpenCard(notes) {
		a.addToOpenCard(notes)
		return
	}
	a.send(notes)
}

// insertsIntoOpenCard：同 Tauri insertClipboardNotesIntoOpenEditor 的入口条件——有可见详情窗、所选全是剪贴卡。
func (a *app) insertsIntoOpenCard(notes []store.Note) bool {
	if len(notes) == 0 || a.openCardID() == "" {
		return false
	}
	for _, n := range notes {
		if n.Section != store.SectionClipboard {
			return false
		}
	}
	return true
}

// appendPreviewContent 同 Tauri：两段之间补到恰好一个空行。
func appendPreviewContent(cur, incoming string) string {
	in := strings.TrimSpace(incoming)
	switch {
	case in == "":
		return cur
	case strings.TrimSpace(cur) == "", strings.HasSuffix(cur, "\n\n"):
		return cur + in
	case strings.HasSuffix(cur, "\n"):
		return cur + "\n" + in
	}
	return cur + "\n\n" + in
}

func (a *app) addToOpenCard(notes []store.Note) {
	id := a.openCardID()
	incoming, imgs, sources := cardIncoming(notes, id)
	if sources == 0 {
		a.showHUD("warn", tr("不能把卡片内容添加到自身"))
		return
	}
	target, ok := a.store.Note(id)
	if !ok {
		a.showHUD("warn", tr("卡片编辑器内容已失效，请重新打开目标卡片"))
		return
	}
	a.chosen.Clear()
	if a.detail.edit { // 编辑中：放到光标处（有选区就替换选区），保存时一起落库；气泡可撤销
		replace := false
		if d := a.detail; d.blocks != nil {
			replace = d.blkRange[0] != d.blkRange[1]
		} else {
			replace = d.editRange[0] >= 0 && d.editRange[0] != d.editRange[1]
		}
		a.insertWithUndo(id, incoming, imgs, replace)
		return
	}
	if lo, hi, sel := a.detailSelection(target.Text); sel != "" && incoming != "" && !a.detail.pick && !store.HasMixedContent(target.Blocks) { // 阅读态有划词选区：替换选区（进编辑，可继续改）
		snap := a.draftSnapshot(id)
		snap.reading = true
		a.replaceDetailRange(target, lo, hi, incoming)
		if len(imgs) > 0 {
			_, _, _ = a.store.AddImages(id, imgs)
		}
		a.invalidateDetail()
		a.showHUDUndo("ok", tr("已替换选中内容"), func() { a.undoDraft(snap) })
		return
	}
	prev := target
	prev.Blocks, prev.Attachments = append([]store.ContentBlock(nil), target.Blocks...), append([]string(nil), target.Attachments...)
	if store.HasMixedContent(target.Blocks) {
		bs := append([]store.ContentBlock(nil), target.Blocks...)
		if incoming != "" {
			bs = append(bs, store.ContentBlock{Type: "text", Text: incoming})
		}
		_, _ = a.store.SetBlocks(id, append(bs, imgs...))
	} else {
		if incoming != "" {
			_ = a.store.Update(id, appendPreviewContent(target.Text, incoming))
		}
		if len(imgs) > 0 {
			_, _, _ = a.store.AddImages(id, imgs)
		}
	}
	if cur, _ := a.store.Note(id); a.detailText == target.Text {
		a.detailText = cur.Text
	}
	a.showHUDUndo("ok", tr("已添加到打开的卡片"), func() { a.store.RestoreContent(prev) })
}

// cardIncoming：要放进卡片的内容——文字（多条为编号列表）与图片块；跳过目标卡自身。sources 为实际来源张数。
func cardIncoming(notes []store.Note, self string) (incoming string, imgs []store.ContentBlock, sources int) {
	var texts []string
	for _, n := range notes {
		if n.ID == self {
			continue
		}
		sources++
		if n.Kind != "image" && strings.TrimSpace(n.Text) != "" {
			texts = append(texts, n.Text)
		}
		for _, f := range n.MediaFiles() {
			imgs = append(imgs, store.ContentBlock{Type: "image", File: f})
		}
	}
	if len(texts) > 0 {
		incoming = sendText(texts)
	}
	return
}

// spliceAt 把 in 放进 src 的 [lo, hi)：有选区替换选区，光标在中间就原样插入；光标未知（lo < 0）或在末尾时按
// appendPreviewContent 另起一段（同 Tauri 追加）。返回新文本与插入内容之后的光标。
func spliceAt(src string, lo, hi int, in string) (string, int) {
	r := []rune(src)
	if lo > hi {
		lo, hi = hi, lo
	}
	if lo < 0 || hi > len(r) || lo == hi && lo == len(r) {
		out := appendPreviewContent(src, in)
		return out, utf8.RuneCountInString(out)
	}
	if lo == hi && strings.TrimSpace(in) == "" {
		return src, lo
	}
	out := string(r[:lo]) + in + string(r[hi:])
	return out, lo + utf8.RuneCountInString(in)
}

// insertIntoDraft：编辑中把内容放到光标处——有选区替换选区，光标未知（编辑器还没落过光标）追加到末尾；插入后光标落在内容之后。
// 图文卡插进当前文字块的光标处、图片紧跟其后成独立图块（没有当前文字块就追加到末尾）；纯文字卡的图片照旧进附件。
func (a *app) insertIntoDraft(id, incoming string, imgs []store.ContentBlock) {
	d := &a.detail
	if d.blocks != nil {
		bs := slices.Clone(d.blocks)
		if i := d.blkActive - 1; i >= 0 && i < len(bs) && bs[i].Type != "image" {
			lo, hi := d.blkRange[0], d.blkRange[1]
			if d.blkSet[0] == i+1 { // 本帧刚定过的选区（拖放落点）优先
				lo, hi = d.blkSet[1], d.blkSet[2]
			}
			text, at := spliceAt(bs[i].Text, lo, hi, incoming)
			bs[i].Text = text
			d.blocks, d.blkSet = slices.Insert(bs, i+1, imgs...), [3]int{i + 1, at, at}
			d.blkRange = [2]int{at, at}
		} else {
			if incoming != "" {
				bs = append(bs, store.ContentBlock{Type: "text", Text: incoming})
			}
			d.blocks = append(bs, imgs...)
		}
		a.invalidateDetail()
		return
	}
	lo, hi := d.editRange[0], d.editRange[1]
	if d.editSel[0] >= 0 { // 本帧刚定过的选区（拖放落点）优先
		lo, hi = d.editSel[0], d.editSel[1]
	}
	text, at := spliceAt(a.detailText, lo, hi, incoming)
	a.detailText = text
	d.editSel, d.editRange = [2]int{at, at}, [2]int{at, at}
	if len(imgs) > 0 {
		_, _, _ = a.store.AddImages(id, imgs)
	}
	a.invalidateDetail()
}

// invalidateDetail：详情窗是另一扇窗，草稿 / 选区变了要它重画。
func (a *app) invalidateDetail() {
	if a.detailWin != nil {
		a.detailWin.Invalidate()
	}
}

// draftSnap：插入前的草稿与卡片（撤销用）。reading = 插入前在阅读态（撤销时退回阅读态）。
type draftSnap struct {
	id      string
	text    string
	blocks  []store.ContentBlock
	sel     [2]int
	note    store.Note
	reading bool
}

func (a *app) draftSnapshot(id string) draftSnap {
	d := a.detail
	s := draftSnap{id: id, text: a.detailText, blocks: slices.Clone(d.blocks), sel: d.editRange}
	if d.blocks != nil {
		s.sel = d.blkRange
	}
	s.note, _ = a.store.Note(id)
	s.note.Blocks, s.note.Attachments = slices.Clone(s.note.Blocks), slices.Clone(s.note.Attachments)
	return s
}

// insertWithUndo：插到光标处 / 替换选区，HUD 气泡可撤销（不用回编辑器按 ⌘Z）。
func (a *app) insertWithUndo(id, incoming string, imgs []store.ContentBlock, replace bool) {
	snap := a.draftSnapshot(id)
	a.insertIntoDraft(id, incoming, imgs)
	msg := tr("已添加到卡片编辑器")
	if replace {
		msg = tr("已替换选中内容")
	}
	a.showHUDUndo("ok", msg, func() { a.undoDraft(snap) })
}

// undoDraft：还原插入前。详情窗还在编辑同一张卡就退回草稿与选区；已存盘（关窗 / 退出编辑）则把卡片内容整体还原；
// 插入时直接写进卡片的图片附件一并撤回。
func (a *app) undoDraft(s draftSnap) {
	cur, ok := a.store.Note(s.id)
	if !ok {
		return
	}
	if a.detail.id == s.id && a.detail.edit {
		if s.reading {
			a.detail.edit, a.detail.blocks = false, nil
			a.detailText = s.note.Text
		} else {
			a.detailText, a.detail.blocks = s.text, slices.Clone(s.blocks)
			if s.blocks != nil {
				a.detail.blkSet = [3]int{a.detail.blkActive, s.sel[0], s.sel[1]}
			} else if s.sel[0] >= 0 {
				a.detail.editSel = s.sel
			}
		}
		if len(cur.Attachments) != len(s.note.Attachments) || cur.ImageFile != s.note.ImageFile {
			a.store.RestoreContent(s.note)
		}
	} else {
		a.store.RestoreContent(s.note)
	}
	a.invalidateDetail()
}
