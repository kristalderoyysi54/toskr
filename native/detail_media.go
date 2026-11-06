package main

import (
	"bytes"
	"fmt"
	"image/png"
	"slices"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// 详情窗的图文（同 Tauri TextPreviewView 富卡）：阅读态按内容块顺序排文字与图片；编辑态混排卡逐块编辑文字、
// 图片可移除，纯文本 + 图的卡在正文下方列图；⌘V / 拖入图片追加进当前卡（编辑混排卡时先进草稿，保存才落库）。

const detailImgW = 520

// detailBig：详情里的内嵌大图（按文件缓存）。
func (a *app) detailBig(file string) ui.ImageSource {
	if a.bigImgs == nil {
		a.bigImgs = map[string]ui.ImageSource{}
	}
	if img, ok := a.bigImgs[file]; ok {
		return img
	}
	var out ui.ImageSource
	if raw, err := a.store.LoadImage(file); err == nil {
		if src, err := png.Decode(bytes.NewReader(raw)); err == nil {
			out = scaledBitmap(src, detailImgW*2)
		}
	}
	a.bigImgs[file] = out
	return out
}

func (a *app) detailInlineImage(c *ui.Context, k tokens, file string, onRemove func()) {
	img := a.detailBig(file)
	if img == nil {
		text(c, tr("（图片缺失）"), 12, 18, 400, k.danger)
		return
	}
	w, h := ui.ImageSize(img)
	dw := min(w, detailImgW) // 同图片卡：按原始像素当点数，最宽 520
	box := ui.Box(c).Size(dw, h*dw/max(w, 1)).Radius(8).Clip().Key("dimg-" + file)
	box.Children(func() {
		ui.Image(c, img).Size(dw, h*dw/max(w, 1))
		if onRemove != nil && box.Hovered() {
			if ghostIconButton(c, k, "dimg-rm-"+file, "x", tr("移除图片"), 22, 13, false, true).Absolute().Top(6).Right(6).Background(k.floatBtn).Clicked() {
				onRemove()
			}
		}
	})
}

// detailRichRead：阅读态按块顺序渲染。
func (a *app) detailRichRead(c *ui.Context, k tokens, n store.Note, fs float32) {
	for _, b := range n.ContentBlocks() {
		if b.Type == "image" {
			a.detailInlineImage(c, k, b.File, nil)
		} else {
			renderMarkdown(c, k, b.Text, fs)
		}
	}
}

// detailMediaStrip：纯文本 + 图的卡在正文下方列图（编辑态可移除）。
func (a *app) detailMediaStrip(c *ui.Context, k tokens, n store.Note) {
	files := n.MediaFiles()
	if len(files) == 0 || n.Kind == "image" {
		return
	}
	var drop string
	ui.Column(c).Gap(8).Margin(10, 0, 0, 0).Children(func() {
		for _, f := range files {
			var rm func()
			if a.detail.edit {
				rm = func() { drop = f }
			}
			a.detailInlineImage(c, k, f, rm)
		}
	})
	if drop != "" {
		if prev, ok := a.store.RemoveImage(n.ID, drop); ok {
			a.showHUDUndo("ok", tr("已移除图片"), func() { a.store.RestoreContent(prev) })
		}
	}
}

// detailBlocksEdit：混排卡逐块编辑——文字块各一个输入框，图片块可移除；保存时整组写回。
func (a *app) detailBlocksEdit(c *ui.Context, k tokens, n store.Note) {
	drop := -1
	ui.Column(c).Gap(8).Margin(5.85, 0, 0, 0).Children(func() {
		first := true
		for i := range a.detail.blocks {
			b := &a.detail.blocks[i]
			if b.Type == "image" {
				a.detailInlineImage(c, k, b.File, func() { drop = i })
				continue
			}
			c.Key(fmt.Sprintf("dblk-%d", i))
			ta := ui.TextAreaBase(c, &b.Text).FillWidth().Lines(2, 1000).Font(fontSans).FontSize(13).FixedLineHeight(21.125).
				TextColor(k.fg).OnPaste(func(t string) bool { return a.pasteIntoDetail(n, t) })
			if first {
				ta.Focus()
				first = false
			}
		}
	})
	if drop >= 0 {
		a.detail.blocks = slices.Delete(slices.Clone(a.detail.blocks), drop, drop+1)
	}
}

// pasteIntoDetail：详情窗 ⌘V。图片（或剪贴板只有图片文件）追加进卡并吞掉这次粘贴；纯文字照常插入。
func (a *app) pasteIntoDetail(n store.Note, text string) bool {
	if text != "" && !slices.ContainsFunc(clipFilePaths(a.sys.Snapshot()), isImagePath) {
		return false
	}
	imgs, files := a.pasteImages()
	if len(imgs) == 0 && !files && text != "" {
		return false
	}
	a.addImagesToDetail(n, imgs, tr("剪贴板里没有可用图片"))
	return true
}

func (a *app) dropIntoDetail(n store.Note, paths []string) {
	if !slices.ContainsFunc(paths, isImagePath) {
		a.showHUD("info", tr("仅支持图片文件"))
		return
	}
	a.addImagesToDetail(n, a.importImagePaths(paths), tr("没有可导入的图片"))
}

func (a *app) addImagesToDetail(n store.Note, imgs []pastedImage, empty string) {
	if len(imgs) == 0 {
		a.showHUD("info", empty)
		return
	}
	if a.detail.edit && a.detail.blocks != nil { // 编辑混排卡：进草稿，保存时一起落库
		added := 0
		for _, im := range imgs {
			if !slices.ContainsFunc(a.detail.blocks, func(b store.ContentBlock) bool { return b.File == im.file }) {
				a.detail.blocks = append(a.detail.blocks, store.ContentBlock{Type: "image", File: im.file, Width: im.w, Height: im.h})
				added++
			}
		}
		if added == 0 {
			a.showHUD("duplicate", tr("图片已在卡片里"))
		}
		return
	}
	bs := make([]store.ContentBlock, len(imgs))
	for i, im := range imgs {
		bs[i] = store.ContentBlock{File: im.file, Width: im.w, Height: im.h}
	}
	prev, added, err := a.store.AddImages(n.ID, bs)
	switch {
	case err != nil:
		a.showHUD("warn", tr("图片导入失败：")+err.Error())
	case added == 0:
		a.showHUD("duplicate", tr("图片已在卡片里"))
	default:
		if n.Kind == "image" {
			if cur, ok := a.store.Note(n.ID); ok {
				a.detailImageAt(cur, len(cur.MediaFiles())-1)
			}
		}
		a.showHUDUndo("added", fmt.Sprintf(tr("已添加 %d 张图片"), added), func() { a.store.RestoreContent(prev) })
	}
}
