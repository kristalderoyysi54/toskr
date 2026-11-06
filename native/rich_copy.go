package main

import (
	"fmt"

	"github.com/toskr/native/internal/core"
	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// copyNoteMedia 同 Tauri copyNoteContent 的图片分支：图文卡写纯文本 + HTML（图片内嵌），单图卡写原生 PNG。
// 纯文字卡返回 false，由调用方按原路径复制文字。
func (a *app) copyNoteMedia(n store.Note) bool {
	bs := n.ContentBlocks()
	imgs := store.ImageBlocks(bs)
	if len(imgs) == 0 {
		return false
	}
	if len(bs) > 1 && (n.Kind != "image" || len(imgs) > 1) {
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
