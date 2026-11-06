package main

import (
	"bytes"
	"fmt"
	"image/png"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/core"
	"github.com/toskr/native/internal/diag"
	"github.com/toskr/native/internal/macos"
)

// 粘贴 / 拖入图片入库（同 Tauri paste_images_from_clipboard / import_image_files）：
// 剪贴板里有本地图片文件就只走文件分支（Finder 复制文件时附带的图标位图不收），否则读位图；
// 非图片 / 坏文件跳过，统一转 PNG 按像素哈希入库。

type pastedImage struct {
	file string
	w, h int
}

const maxImportImage = 64 << 20

var (
	imageExts = []string{".png", ".jpg", ".jpeg", ".gif", ".heic", ".heif", ".tif", ".tiff", ".webp", ".bmp"}
	toPNG     = macos.ImageToPNG // 测试替换
)

func isImagePath(p string) bool { return slices.Contains(imageExts, strings.ToLower(filepath.Ext(p))) }

// clipFilePaths：剪贴板各项里的本地文件路径。
func clipFilePaths(items []macos.Item) []string {
	var out []string
	for _, it := range items {
		if u, err := url.Parse(strings.TrimSpace(string(it[macos.TypeFileURL]))); err == nil && u.Scheme == "file" && u.Path != "" {
			out = append(out, u.Path)
		}
	}
	return out
}

func (a *app) savePNG(raw []byte) (pastedImage, bool) {
	cfg, err := png.DecodeConfig(bytes.NewReader(raw))
	if err != nil {
		return pastedImage{}, false
	}
	name, err := a.store.SaveImage(raw)
	if err != nil {
		return pastedImage{}, false
	}
	return pastedImage{name, cfg.Width, cfg.Height}, true
}

// importImagePaths：本地图片文件入库，非图片 / 过大 / 坏文件跳过。
func (a *app) importImagePaths(paths []string) []pastedImage {
	var out []pastedImage
	for _, p := range paths {
		if !isImagePath(p) {
			continue
		}
		if fi, err := os.Stat(p); err != nil || !fi.Mode().IsRegular() || fi.Size() > maxImportImage {
			continue
		}
		raw, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		if !bytes.HasPrefix(raw, []byte("\x89PNG")) {
			raw = toPNG(raw)
		}
		if im, ok := a.savePNG(raw); ok && !slices.ContainsFunc(out, func(x pastedImage) bool { return x.file == im.file }) {
			out = append(out, im)
		}
	}
	return out
}

// pasteImages：读剪贴板里的图片。files 报告剪贴板是否带本地图片文件（带了就不回退位图）。
func (a *app) pasteImages() (imgs []pastedImage, files bool) {
	items := a.sys.Snapshot()
	paths := clipFilePaths(items)
	if slices.ContainsFunc(paths, isImagePath) {
		imgs = a.importImagePaths(paths)
		diag.Push("粘贴入库: 本地图片文件 ×%d", len(imgs))
		return imgs, true
	}
	if ev, ok := core.ClipImage(items); ok {
		if im, ok := a.savePNG(ev.PNG); ok {
			diag.Push("粘贴入库: 图片 %d×%d", im.w, im.h)
			return []pastedImage{im}, false
		}
	}
	return nil, false
}

// pasteIntoDraft：输入区 ⌘V。剪贴板带图片文件或只有位图时收为草稿图并吞掉这次粘贴；纯文字照常插入。
func (a *app) pasteIntoDraft(text string) bool {
	if text != "" && !slices.ContainsFunc(clipFilePaths(a.sys.Snapshot()), isImagePath) {
		return false // 有文字又不是图片文件：照常插入文字
	}
	imgs, files := a.pasteImages()
	if len(imgs) == 0 && !files {
		return false
	}
	a.addDraftImages(imgs, tr("剪贴板里没有可用图片"))
	return true
}

func (a *app) addDraftImages(imgs []pastedImage, empty string) {
	if len(imgs) == 0 {
		a.showHUD("info", empty)
		return
	}
	for _, im := range imgs {
		if !slices.ContainsFunc(a.draftImgs, func(x pastedImage) bool { return x.file == im.file }) {
			a.draftImgs = append(a.draftImgs, im)
		}
	}
}

// draftImageChips：输入框左侧的暂存图缩略（点击移除）。
func (a *app) draftImageChips(c *ui.Context, k tokens) {
	if len(a.draftImgs) == 0 {
		return
	}
	drop := -1
	ui.Row(c).Gap(4).AlignItems(ui.Center).Children(func() {
		for i, im := range a.draftImgs {
			if i == 3 {
				text(c, fmt.Sprintf("+%d", len(a.draftImgs)-3), 10, 14, 500, k.muted)
				break
			}
			b := ui.Box(c).Size(26, 26).Radius(6).Clip().Key("draft-img-"+im.file).Role(ui.RoleButton).
				Label(tr("移除图片")).Tooltip(tr("移除图片")).Border(1, k.inputBorder)
			b.Children(func() {
				if img := a.thumb(im.file); img != nil {
					ui.Image(c, img).Size(26, 26).Fit(ui.Cover)
				}
				if b.Hovered() {
					ui.Box(c).Absolute().Left(0).Top(0).Size(26, 26).Background(ui.RGBA(0, 0, 0, 0.45)).Center().Children(func() { // token-exception: 缩略图上的暗罩
						licon(c, "x", 12, ui.RGB(255, 255, 255))
					})
				}
			})
			if b.Clicked() {
				drop = i
			}
		}
	})
	if drop >= 0 {
		a.draftImgs = slices.Delete(slices.Clone(a.draftImgs), drop, drop+1)
	}
}

// cardThumb：组合卡右侧首图缩略，多图角标张数。
func (a *app) cardThumb(c *ui.Context, k tokens, files []string) {
	img := a.thumb(files[0])
	if img == nil {
		return
	}
	ui.Box(c).Size(54, 54).Radius(6).Clip().Border(1, k.inputBorder).Tooltip(fmt.Sprintf(tr("%d 张图片"), len(files))).Children(func() {
		ui.Image(c, img).Size(54, 54).Fit(ui.Cover)
		if len(files) > 1 {
			ui.Box(c).Absolute().Right(2).Bottom(2).Padding(0, 4).Radius(4).Background(ui.RGBA(0, 0, 0, 0.55)).Children(func() { // token-exception: 缩略图角标暗底
				text(c, itoa(len(files)), 9, 12, 600, ui.RGB(255, 255, 255))
			})
		}
	})
}
