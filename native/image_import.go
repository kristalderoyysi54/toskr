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

	"github.com/toskr/native/internal/codehl"
	"github.com/toskr/native/internal/core"
	"github.com/toskr/native/internal/diag"
	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
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

// draftImageChips：输入框左侧的暂存图缩略（同 Tauri DraftImageChip：点击查看或编辑，悬停右上角 ✕ 移除）。
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
			chip := ui.Box(c).Size(26, 26).Radius(rr(6)).Clip().Key("draft-img-"+im.file).Border(1, k.inputBorder)
			hover := chip.Hovered()
			chip.Children(func() {
				b := tipOf(c, ui.Box(c).Size(26, 26).Key("draft-open-"+im.file).Role(ui.RoleButton).Label(tr("查看或编辑这张草稿图片")), tr("查看或编辑这张草稿图片"))
				b.Children(func() {
					if img := a.thumb(im.file); img != nil {
						ui.Image(c, img).Size(26, 26).Fit(ui.Cover)
					}
				})
				if b.Clicked() {
					f := im.file
					a.onMain(func() { a.openDraftImage(f) })
				}
				x := tipOf(c, ui.Box(c).Absolute().Top(0).Right(0).Size(12, 12).Radius(0, 0, 0, 5).Center().Key("draft-rm-"+im.file).
					Role(ui.RoleButton).Label(tr("移除这张图片")), tr("移除这张图片"))
				if hover || x.Hovered() {
					x.Background(ui.RGBA(0, 0, 0, 0.55)) // token-exception: 缩略图上的移除角标底
					x.Children(func() { licon(c, "x", 8, ui.RGB(255, 255, 255)) })
				} else {
					x.Opacity(0) // 同 Tauri opacity-0 仍可点：角标只占缩略图右上 12pt，不盖其他控件
				}
				if x.Clicked() {
					drop = i
				}
			})
		}
	})
	if drop >= 0 {
		a.draftImgs = slices.Delete(slices.Clone(a.draftImgs), drop, drop+1)
	}
}

// cardImages 同 Tauri NoteCard 图片卡卡面：一张时等比居中；多张时并排最多 3 张（cover），第 3 张盖「+N」（N = 余下张数）。
// h 为图片区高度；w 为可用宽度（0 = 按单图自身比例）。
func (a *app) cardImages(c *ui.Context, k tokens, files []string, w, h float32) {
	if len(files) == 0 || h <= 0 {
		return
	}
	if len(files) == 1 {
		ui.Row(c).Height(h).FillWidth().Radius(3).Background(k.fg.Alpha(0.04)).Justify(ui.Center).AlignItems(ui.Center).Clip().Children(func() {
			img := a.thumb(files[0])
			if img == nil {
				text(c, tr("加载中…"), 10, 14, 400, k.muted)
				return
			}
			iw, ih := ui.ImageSize(img)
			sc := h / max(ih, 1)
			if w > 0 {
				sc = min(sc, w/max(iw, 1))
			}
			ui.Image(c, img).Size(iw*sc, ih*sc)
		})
		return
	}
	ui.Row(c).Height(h).FillWidth().Gap(4).Key("card-imgs").Children(func() {
		for i, f := range files[:min(3, len(files))] {
			cell := ui.Box(c).Grow(1).Basis(0).FillHeight().Radius(3).Clip().Background(k.fg.Alpha(0.04)).Center().Key("ci-" + f)
			cell.Children(func() {
				if img := a.thumb(f); img != nil {
					ui.Image(c, img).Fill().Fit(ui.Cover)
				} else {
					text(c, "…", 10, 14, 400, k.muted)
				}
				if i == 2 && len(files) > 3 {
					ui.Box(c).Absolute().Left(0).Top(0).Right(0).Bottom(0).Background(ui.RGBA(0, 0, 0, 0.45)).Center().Children(func() { // token-exception: 缩略图上的「+N」暗罩（同 Tauri bg-black/45）
						text(c, fmt.Sprintf("+%d", len(files)-3), 13, 18, 500, ui.RGB(255, 255, 255))
					})
				}
			})
		}
	})
}

// cardImageCaption 同 Tauri：图片卡真实文字备注（占位标题不显示）卡面一行截断。
func cardImageCaption(c *ui.Context, k tokens, n store.Note) bool {
	cap := strings.TrimSpace(imageNoteText(n))
	if cap == "" || store.IsImagePlaceholder(cap) {
		return false
	}
	t := text(c, cap, 11, 16, 400, k.muted).SingleLine().Shrink(0)
	if n.Done {
		t.Opacity(0.6)
	}
	return true
}

// cardThumbStrip 同 Tauri 组合卡（图文）：正文下方一排最多 4 张 32pt 小缩略（等比），更多以「+N」标示。
func (a *app) cardThumbStrip(c *ui.Context, k tokens, files []string) {
	tipOf(c, ui.Row(c).Height(32).Gap(4).Shrink(0).AlignItems(ui.Center).Key("card-strip"), fmt.Sprintf(tr("%d 张图片"), len(files))).Children(func() {
		for _, f := range files[:min(4, len(files))] {
			ui.Box(c).Size(32, 32).Radius(3).Clip().Background(k.fg.Alpha(0.05)).Center().Key("cs-" + f).Children(func() {
				if img := a.thumb(f); img != nil {
					iw, ih := ui.ImageSize(img)
					sc := min(32/max(iw, 1), 32/max(ih, 1))
					ui.Image(c, img).Size(iw*sc, ih*sc)
				}
			})
		}
		if len(files) > 4 {
			text(c, fmt.Sprintf("+%d", len(files)-4), 10, 14, 400, k.muted)
		}
	})
}

// cardImageMeta 同 Tauri 卡片页脚右端：图片卡「W × H」、图文卡「N 字符 · N 图」、其余「N 字符」。
func cardImageMeta(n store.Note) string {
	files := n.MediaFiles()
	switch {
	case n.Kind == "image" && n.ImageW > 0:
		return itoa(n.ImageW) + " × " + itoa(n.ImageH)
	case n.Kind == "image":
		return fmt.Sprintf(tr("%d 张"), len(files))
	case n.Kind != "image" && len(files) > 0:
		return fmt.Sprintf(tr("%d 字符 · %d 图"), len([]rune(n.Text)), len(files))
	}
	return fmt.Sprintf(tr("%d 字符"), len([]rune(n.Text)))
}

// clipFootMeta：剪贴卡 / 横栏卡页脚右端按内容类型给最有用的一项（有意偏离 Tauri 的一律「N 字符」）：
// 链接 → 域名，代码 → 语言 · 行数，图片 / 图文 → 同 cardImageMeta，多行文字 → 行数，很长的单行 → 字符数，短单行不显示。
func clipFootMeta(n store.Note) string {
	lines := strings.Count(strings.TrimRight(n.Text, "\n"), "\n") + 1
	switch {
	case n.Kind == "link":
		if u, err := url.Parse(strings.TrimSpace(cmpOr(n.URL, n.Text))); err == nil && u.Host != "" {
			return strings.TrimPrefix(u.Host, "www.")
		}
		return tr("链接")
	case n.Kind == "image" || len(n.MediaFiles()) > 0:
		return cardImageMeta(n)
	case isCode(n):
		return tr(codehl.Label(n.CodeLang)) + " · " + fmt.Sprintf(tr("%d 行"), lines)
	case lines > 1:
		return fmt.Sprintf(tr("%d 行"), lines)
	case len([]rune(n.Text)) >= clipLongRunes:
		return fmt.Sprintf(tr("%d 字符"), len([]rune(n.Text)))
	}
	return ""
}

const clipLongRunes = 200
