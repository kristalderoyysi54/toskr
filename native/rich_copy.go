package main

import (
	"fmt"
	"slices"
	"strings"

	"github.com/toskr/native/internal/core"
	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// copyNoteMedia 同 Tauri copyNoteContent 的图片分支：图文卡写纯文本 + HTML（图片内嵌），单图卡写原生 PNG。
// 纯文字卡返回 false，由调用方按原路径复制文字。
func (a *app) copyNoteMedia(n store.Note) bool {
	bs := copyBlocks(n)
	imgs := store.ImageBlocks(bs)
	if len(imgs) == 0 {
		return false
	}
	if len(bs) > 1 { // 有文字（含图片卡备注）或多张图：文字与图一起写富剪贴板
		plain, doc, cnt, err := core.BuildRichClipboard(bs, a.store.LoadImage)
		if err != nil {
			a.showHUD("warn", tr("复制失败：")+tr(err.Error()))
			return true
		}
		a.sys.Write([]macos.Item{{macos.TypeString: []byte(plain), macos.TypeHTML: []byte(doc)}}, true)
		a.showHUD("ok", fmt.Sprintf(tr("已复制原始图文（%d 张图，未脱敏）"), cnt))
		return true
	}
	raw, err := a.store.LoadImage(imgs[0])
	if err != nil {
		a.showHUD("warn", tr("复制失败：")+tr("图片读取失败"))
		return true
	}
	a.sys.Write([]macos.Item{{macos.TypePNG: raw}}, true)
	a.showHUD("ok", tr("已复制图片"))
	return true
}

// copyBlocks：复制用的内容块——图片卡的真实文字备注接在图后（之前只复制图片，文字丢了）；图片带上说明作替代文字。
func copyBlocks(n store.Note) []store.ContentBlock {
	bs := slices.Clone(n.ContentBlocks())
	for i := range bs {
		if bs[i].Type == "image" && strings.TrimSpace(bs[i].Alt) == "" {
			bs[i].Alt = n.AltOf(bs[i].File)
		}
	}
	if n.Kind == "image" && n.Blocks == nil {
		if cap := strings.TrimSpace(imageNoteText(n)); cap != "" && !store.IsImagePlaceholder(cap) {
			bs = append(bs, store.ContentBlock{Type: "text", Text: n.Text})
		}
	}
	return bs
}

// copyNotesRich：多选复制（⌘C / 批量条「复制为列表」）含图片时，文字与图片一起进剪贴板：多条按编号列表排，
// 每条的图片跟在它的文字后面（同发送的编号规则）。没有图片返回 false，调用方走纯文本。
func (a *app) copyNotesRich(notes []store.Note) bool {
	if !slices.ContainsFunc(notes, func(n store.Note) bool { return len(n.MediaFiles()) > 0 }) {
		return false
	}
	var bs []store.ContentBlock
	for i, n := range notes {
		nb := copyBlocks(n)
		if len(notes) > 1 {
			prefix := fmt.Sprintf("%d. ", i+1)
			if len(nb) > 0 && nb[0].Type != "image" {
				nb[0].Text = prefix + nb[0].Text
			} else {
				nb = append([]store.ContentBlock{{Type: "text", Text: strings.TrimSpace(prefix)}}, nb...)
			}
		}
		if i > 0 {
			bs = append(bs, store.ContentBlock{Type: "text", Text: "\n"})
		}
		bs = append(bs, nb...)
	}
	plain, doc, cnt, err := core.BuildRichClipboard(bs, a.store.LoadImage)
	if err != nil {
		a.showHUD("warn", tr("复制失败：")+tr(err.Error()))
		return true
	}
	a.sys.Write([]macos.Item{{macos.TypeString: []byte(plain), macos.TypeHTML: []byte(doc)}}, true)
	if len(notes) == 1 {
		a.showHUD("ok", fmt.Sprintf(tr("已复制原始图文（%d 张图，未脱敏）"), cnt))
	} else {
		a.showHUD("ok", fmt.Sprintf(tr("已复制 %d 条图文为列表（%d 张图，未脱敏）"), len(notes), cnt))
	}
	return true
}
