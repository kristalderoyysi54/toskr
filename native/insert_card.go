package main

import (
	"strings"

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

// editorInsertLikely：剪贴页的发送会落到打开的卡片（按钮文案如实）。
func (a *app) editorInsertLikely() bool { return a.page == pageClip && a.openCardID() != "" }

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
	var texts []string
	var imgs []store.ContentBlock
	sources := 0
	for _, n := range notes {
		if n.ID == id {
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
	if sources == 0 {
		a.showHUD("warn", tr("不能把卡片内容添加到自身"))
		return
	}
	incoming := ""
	if len(texts) > 0 {
		incoming = sendText(texts)
	}
	target, ok := a.store.Note(id)
	if !ok {
		a.showHUD("warn", tr("卡片编辑器内容已失效，请重新打开目标卡片"))
		return
	}
	a.chosen.Clear()
	if a.detail.edit { // 编辑中：进草稿，保存时一起落库
		if a.detail.blocks != nil {
			if incoming != "" {
				a.detail.blocks = append(a.detail.blocks, store.ContentBlock{Type: "text", Text: incoming})
			}
			a.detail.blocks = append(a.detail.blocks, imgs...)
		} else {
			a.detailText = appendPreviewContent(a.detailText, incoming)
			n := len([]rune(a.detailText))
			a.detail.editSel = [2]int{n, n}
			if len(imgs) > 0 {
				_, _, _ = a.store.AddImages(id, imgs)
			}
		}
		a.showHUD("ok", tr("已添加到卡片编辑器"))
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
