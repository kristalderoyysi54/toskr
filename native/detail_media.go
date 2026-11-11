package main

import (
	"bytes"
	"fmt"
	"image/png"
	"slices"
	"strings"

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

// detailFiles：看图层与缩略条按哪组图翻页——编辑混排卡用草稿块（可能含未保存的新图），其余用卡片里的图。
func (a *app) detailFiles(n store.Note) []string {
	if a.detail.edit && a.detail.blocks != nil {
		return store.ImageBlocks(a.detail.blocks)
	}
	return n.MediaFiles()
}

// openDetailGallery：点开图文 / 多图卡里的第 i 张图（同 Tauri api.quickLook(files, index)）。
func (a *app) openDetailGallery(n store.Note, file string) {
	i := max(0, slices.Index(a.detailFiles(n), file))
	a.detail.gallery = true
	a.detailImageAt(n, i)
	a.enterGalleryFrame(n)
}

// replaceDetailDraftImage：打码 / 标注写回时，编辑中的混排草稿同步换掉那张图（否则保存时把旧图写回去）。
func (a *app) replaceDetailDraftImage(id, old, file string, w, h int) {
	if a.detail.id != id || a.detail.blocks == nil {
		return
	}
	bs := slices.Clone(a.detail.blocks)
	for i := range bs {
		if bs[i].Type == "image" && bs[i].File == old {
			bs[i].File, bs[i].Width, bs[i].Height = file, w, h
		}
	}
	a.detail.blocks = bs
}

// sendDetailImage 同 Tauri EditableRichImageBlock「发送选中」：只把这一张图发到当前目标。
func (a *app) sendDetailImage(n store.Note, file string) {
	if a.detail.virt != nil || file == "" {
		return
	}
	if a.target.PID == 0 {
		a.showHUD("warn", tr("没有发送目标：从发送钮右侧下拉「发送到…」选一个应用"))
		return
	}
	a.send([]store.Note{{ID: n.ID, Section: n.Section, SourceApp: n.SourceApp, BundleID: n.BundleID, Kind: "image", ImageFile: file}})
	if !a.detail.pinned {
		a.closeDetailWin()
	}
}

// detailInlineImage：正文里的大图（同 Tauri RichImageBlock）——点击看原图（窗内看图层，可打码 / 标注）。
func (a *app) detailInlineImage(c *ui.Context, k tokens, n store.Note, file string) {
	img := a.detailBig(file)
	if img == nil {
		text(c, tr("（图片缺失）"), 12, 18, 400, k.danger)
		return
	}
	w, h := ui.ImageSize(img)
	dw := min(w, detailImgW) // 同图片卡：按原始像素当点数，最宽 520
	alt := n.AltOf(file)
	ui.Column(c).FillWidth().AlignItems(ui.Center).Gap(4).Margin(6, 0).Children(func() {
		tip := tr("查看原图")
		if alt != "" {
			tip = alt + " · " + tip
		}
		box := ui.Box(c).Size(dw, h*dw/max(w, 1)).Radius(8).Clip().Border(1, k.fg.Alpha(0.1)).Key("dimg-" + file).
			Role(ui.RoleButton).Label(tr("查看原图")).Tooltip(tip)
		box.Children(func() { ui.Image(c, img).Size(dw, h*dw/max(w, 1)) })
		if box.Clicked() {
			a.openDetailGallery(n, file)
		}
		if alt != "" { // 图片说明作图注（同 figure caption）
			text(c, alt, 11, 16, 400, k.muted).Wrap().MaxLines(2).TextAlign(ui.Center).MaxWidth(dw)
		}
	})
}

// detailRichRead：阅读态按块顺序渲染（混排卡）。
func (a *app) detailRichRead(c *ui.Context, k tokens, n store.Note, fs float32) {
	a.detailBlocksRead(c, k, n, n.ContentBlocks(), fs, false)
}

// detailBlocksRead：按块渲染文字（Markdown，raw = 等宽原文）与内嵌图（点开看图）。
func (a *app) detailBlocksRead(c *ui.Context, k tokens, n store.Note, bs []store.ContentBlock, fs float32, raw bool) {
	for _, b := range bs {
		switch {
		case b.Type == "image":
			a.detailInlineImage(c, k, n, b.File)
		case raw:
			text(c, b.Text, 13, 21.125, 400, k.fg).Font(fontMono).Wrap()
		default:
			renderMarkdown(c, k, b.Text, fs)
		}
	}
}

// detailStripShown 同 Tauri shownImages：非混排的图文卡（含编辑 / 原文 / 代码视图）在底部常显缩略条。
func (a *app) detailStripShown(n store.Note) bool {
	return n.Kind != "image" && !store.HasMixedContent(n.Blocks) && !(a.detail.edit && a.detail.blocks != nil) && len(n.MediaFiles()) > 0
}

// detailThumbStrip 同 Tauri AttachThumb 条：48pt 缩略横排，点击看原图；可写时悬停右上 ⊗ 从卡片移除（可撤销）。
func (a *app) detailThumbStrip(c *ui.Context, k tokens, n store.Note) {
	if !a.detailStripShown(n) {
		return
	}
	files := n.MediaFiles()
	writable := a.detail.virt == nil
	var drop string
	strip := ui.Column(c).Absolute().Left(0).Right(0).Bottom(48).BorderWidth(1, 0, 0, 0).BorderColor(k.fg.Alpha(0.05)).Key("detail-thumbs")
	strip.Children(func() {
		ui.ScrollHorizontal(c).FillWidth().Scrollbars(false).Children(func() {
			ui.Row(c).Gap(6).Padding(8, 12).Children(func() {
				for _, f := range files {
					cell := ui.Box(c).Size(48, 48).Key("dthumb-" + f)
					hover := cell.Hovered()
					cell.Children(func() {
						b := ui.Box(c).Size(48, 48).Radius(6).Clip().Border(1, k.fg.Alpha(0.1)).Background(k.fg.Alpha(0.04)).
							Key("dthumb-open-" + f).Role(ui.RoleButton).Label(tr("查看图片")).Tooltip(cmpOr(n.AltOf(f), tr("查看图片")))
						b.Children(func() {
							if img := a.thumb(f); img != nil {
								ui.Image(c, img).Size(48, 48).Fit(ui.Cover)
							}
						})
						if b.Clicked() {
							a.openDetailGallery(n, f)
						}
						if !writable {
							return
						}
						x := ui.Box(c).Absolute().Top(-4).Right(-4).Size(16, 16).Radius(8).Center().Key("dthumb-rm-" + f).
							Role(ui.RoleButton).Label(tr("从卡片移除这张图片")).Tooltip(tr("从卡片移除这张图片"))
						if hover || x.Hovered() {
							x.Background(k.fg.Alpha(0.8)).Children(func() { licon(c, "x", 10, c.Theme().Background) })
						} else {
							x.Opacity(0)
						}
						if x.Clicked() {
							drop = f
						}
					})
				}
			})
		})
	})
	if drop != "" {
		if prev, ok := a.store.RemoveImage(n.ID, drop); ok {
			a.showHUDUndo("ok", tr("已移除图片"), func() { a.store.RestoreContent(prev) })
		}
	}
}

// detailBlocksEdit 同 Tauri RichNoteTextEditor：文字块各一个输入框；图片块带「图片 N」头与查看 / 删除，
// 单击选中、双击看原图，选中后可「发送选中」只发这一张。保存时整组写回。
func (a *app) detailBlocksEdit(c *ui.Context, k tokens, n store.Note) {
	drop := -1
	blocked := a.targetBlockedReason()
	ui.Column(c).Gap(8).Margin(5.85, 0, 0, 0).Children(func() {
		first := true
		imgNo := 0
		for i := range a.detail.blocks {
			b := &a.detail.blocks[i]
			if b.Type == "image" {
				imgNo++
				no, file, sel := imgNo, b.File, a.detail.imgSel == i+1
				head, label := fmt.Sprintf(tr("图片 %d"), no), fmt.Sprintf(tr("图片 %d"), no)
				if alt := strings.TrimSpace(b.Alt); alt != "" { // 同 Tauri RichImageBlock：有说明用说明作名
					label = alt
				}
				sec := ui.Column(c).Gap(6).Padding(8).Radius(12).Key(fmt.Sprintf("dblk-img-%d-%s", i, file))
				if sel {
					sec.Background(stok(c).primary.Alpha(0.04)).Border(1, stok(c).primary.Alpha(0.55))
				} else {
					sec.Background(k.track.Alpha(0.4)).Border(1, k.fg.Alpha(0.15))
				}
				sec.Children(func() {
					ui.Row(c).Gap(4).AlignItems(ui.Center).Children(func() {
						text(c, head, 11, 16, 400, k.muted).Shrink(0)
						if label != head {
							text(c, label, 11, 16, 400, k.fg.Alpha(0.75)).SingleLine().Tooltip(label)
						}
						ui.Spacer(c)
						if ghostIconButton(c, k, fmt.Sprintf("dblk-view-%d", i), "maximize-2", fmt.Sprintf(tr("查看%s"), label), 22, 12, false, true).Clicked() {
							a.openDetailGallery(n, file)
						}
						if ghostIconButton(c, k, fmt.Sprintf("dblk-rm-%d", i), "trash-2", fmt.Sprintf(tr("删除%s"), label), 22, 12, false, true).Clicked() {
							drop = i
						}
					})
					img := a.detailBig(file)
					if img == nil {
						text(c, tr("（图片缺失）"), 12, 18, 400, k.danger)
						return
					}
					w, h := ui.ImageSize(img)
					dw := min(w, detailImgW-24)
					ui.Row(c).FillWidth().Justify(ui.Center).Children(func() {
						pic := ui.Box(c).Size(dw, h*dw/max(w, 1)).Radius(8).Clip().Key(fmt.Sprintf("dblk-pic-%d", i)).
							Role(ui.RoleButton).Label(fmt.Sprintf(tr("选择%s"), label)).Tooltip(tr("单击选中，双击查看")).Selected(sel)
						pic.Children(func() { ui.Image(c, img).Size(dw, h*dw/max(w, 1)) })
						if pic.DoubleClicked() {
							a.openDetailGallery(n, file)
						} else if pic.Clicked() {
							a.detail.imgSel = map[bool]int{true: 0, false: i + 1}[sel]
						}
					})
					if !sel {
						return
					}
					ui.Row(c).Justify(ui.End).Children(func() {
						tip := fmt.Sprintf(tr("只发送图片 %d"), no)
						if blocked != "" {
							tip = fmt.Sprintf(tr("发送选中不可用：%s"), blocked)
						}
						sb := ui.Row(c).Height(24).Padding(0, 8).Gap(4).Radius(6).AlignItems(ui.Center).Key(fmt.Sprintf("dblk-send-%d", i)).
							Role(ui.RoleButton).Label(tip).Tooltip(tip)
						fg := k.fg
						switch {
						case blocked != "":
							sb.Opacity(0.45)
						case sb.Hovered():
							sb.Background(k.track)
						}
						sb.Children(func() {
							licon(c, "send", 12, fg)
							text(c, tr("发送选中"), 11, 16, 500, fg)
						})
						if sb.Clicked() && blocked == "" {
							a.sendDetailImage(n, file)
						}
					})
				})
				continue
			}
			wrap := ui.Box(c).FillWidth().Key(fmt.Sprintf("dblk-%d", i))
			var ta ui.Element
			wrap.Children(func() {
				ta = ui.TextAreaBase(c, &b.Text).FillWidth().Lines(2, 1000).Font(fontSans).FontSize(13).FixedLineHeight(21.125).
					TextColor(k.fg).OnPaste(func(t string) bool { return a.pasteIntoDetail(n, t) })
				if r, ok := a.detailDropZone(ta, n, b.Text, i); ok {
					dropCaret(c, r)
				}
			})
			d := &a.detail
			if first && d.blkActive == 0 {
				ta.AutoFocus() // 只聚焦一次，不抢标题框焦点
			}
			first = false
			if d.blkSet[0] == i+1 { // 工具条改写后 / 进编辑定位：选区落回这一块
				ta.Focus().SetTextSelection(d.blkSet[1], d.blkSet[2])
				d.blkSet = [3]int{}
			}
			if ta.Focused() { // 同纯文字卡：当前块的选区驱动划词工具条（发送选中 / 复制 / 链接 / 粗斜体 / 段落格式 / 处理）
				d.blkActive = i + 1
			}
			if d.blkActive == i+1 {
				d.blkRange[0], d.blkRange[1] = ta.TextSelection()
				a.markTextSelection(ta.Bounds(), b.Text, d.blkRange)
			}
		}
	})
	if drop >= 0 {
		a.detail.blocks = slices.Delete(slices.Clone(a.detail.blocks), drop, drop+1)
		a.detail.imgSel = 0
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

// imageAltBar：看图层页脚——张序 · 尺寸 · 图片说明（替代文字）。图文 / 多图卡逐张写说明（纯单图卡的文字在备注条里）；
// 点说明或「添加图片说明」就地编辑，↵ / Esc 保存，留空清除；翻页、返回正文时自动保存。可撤销。
func (a *app) imageAltBar(c *ui.Context, k tokens, n store.Note, file, meta string, editable bool) {
	d := &a.detail
	alt := a.detailAltOf(n, file)
	if d.altEdit && editable {
		ui.Row(c).FillWidth().Shrink(0).Padding(6, 12).Gap(6).AlignItems(ui.Center).BorderWidth(1, 0, 0, 0).BorderColor(k.inputBorder).Key("img-alt-edit").Children(func() {
			licon(c, "message-square-text", 12, k.muted)
			ui.Row(c).Grow(1).Basis(0).Height(26).Padding(0, 8).Radius(6).Background(k.fg.Alpha(0.05)).AlignItems(ui.Center).Children(func() {
				ui.TextInputBase(c, &d.altDraft).Grow(1).Font(fontSans).FontSize(12).FixedLineHeight(18).TextColor(k.fg).PlaceholderColor(k.muted).
					Placeholder(tr("描述这张图，例如「登录页报错截图」")).Label(tr("图片说明")).Focus().OnTextKey(func(key ui.TextKey) bool {
					if key.Key == ui.KeyEnter {
						a.commitImageAlt(n)
						return true
					}
					return false
				})
			})
			cnt := fmt.Sprintf("%d/%d", len([]rune(d.altDraft)), store.ImageAltMax)
			text(c, cnt, 10, 14, 400, k.muted).FontFeatures("tnum").MinWidth(numSlot(c, fmt.Sprintf("%d/%d", store.ImageAltMax, store.ImageAltMax), 10, 400)).TextAlign(ui.End) // 输入时计数位数变化不挤压输入框
			if ghostIconButton(c, k, "img-alt-save", "check", tr("保存说明（↵）；Esc 保存并退出"), 24, 13, false, true).Clicked() {
				a.commitImageAlt(n)
			}
		})
		return
	}
	ui.Row(c).Height(28).FillWidth().Shrink(0).Padding(0, 12).Gap(8).Justify(ui.Center).AlignItems(ui.Center).Children(func() {
		if meta != "" {
			text(c, meta, 11, 16, 400, k.muted).FontFeatures("tnum").Shrink(0).MinWidth(numSlot(c, meta, 11, 400)).TextAlign(ui.Center) // 滚轮缩放时百分比在变：宽度固定，右侧「图片说明」不跟着跳
		}
		if !editable && alt == "" {
			return
		}
		if meta != "" {
			text(c, "·", 11, 16, 400, k.muted.Alpha(0.6))
		}
		label := alt
		if label == "" {
			label = tr("添加图片说明")
		}
		b := ui.Row(c).Height(22).Padding(0, 6).Gap(4).Radius(6).AlignItems(ui.Center).Shrink(1).Key("img-alt").Role(ui.RoleButton)
		if alt != "" {
			b.Label(tr("图片说明：") + alt).Tooltip(alt)
		} else {
			b.Label(label)
		}
		col := k.muted
		if alt != "" {
			col = k.fg.Alpha(0.85)
		}
		if editable && b.Hovered() {
			b.Background(k.fg.Alpha(0.08))
			col = k.fg
		}
		b.Children(func() {
			if editable {
				licon(c, "pencil", 11, col)
			}
			text(c, label, 11, 16, 400, col).SingleLine()
		})
		if editable && b.Clicked() {
			d.altEdit, d.altDraft = true, alt
		}
	})
}

// detailAltOf：编辑中的图文卡读草稿块里的说明，其余读卡片。
func (a *app) detailAltOf(n store.Note, file string) string {
	if d := a.detail; d.edit && d.blocks != nil {
		return store.Note{Blocks: d.blocks, ImageAlts: n.ImageAlts}.AltOf(file)
	}
	return n.AltOf(file)
}

// commitImageAlt：保存当前这张图的说明（看图层），HUD 可撤销；没变化静默退出编辑。
func (a *app) commitImageAlt(n store.Note) {
	d := &a.detail
	file := d.fullFile
	d.altEdit = false
	if file == "" || d.virt != nil {
		return
	}
	if d.blocks != nil && d.edit { // 编辑中的图文卡：写进草稿块，保存时一起落库
		alt := strings.TrimSpace(d.altDraft)
		if r := []rune(alt); len(r) > store.ImageAltMax {
			alt = string(r[:store.ImageAltMax])
		}
		bs := slices.Clone(d.blocks)
		for i := range bs {
			if bs[i].Type == "image" && bs[i].File == file {
				bs[i].Alt = alt
			}
		}
		d.blocks = bs
		return
	}
	prev, changed, err := a.store.SetImageAlt(n.ID, file, d.altDraft)
	switch {
	case err != nil:
		a.showHUD("warn", err.Error())
	case changed && strings.TrimSpace(d.altDraft) == "":
		a.showHUDUndo("ok", tr("已清除图片说明"), func() { a.store.RestoreContent(prev) })
	case changed:
		a.showHUDUndo("ok", tr("已保存图片说明"), func() { a.store.RestoreContent(prev) })
	}
}

func init() { // 多段粘贴间隔、图片说明的英文
	for k, v := range map[string]string{
		"多段粘贴": "Multi-part paste", "多段粘贴间隔": "Multi-part paste interval",
		"图文卡、多图卡按段依次粘贴；网页对话框贴图慢时调大":                                "Text-and-image cards paste part by part; raise this if web chats upload images slowly",
		"文字与每张图分别粘贴，段与段之间等待这段时间让目标应用接收上一段。图片在目标里顺序错乱或缺图时，换成更慢的一档。": "Text and each image are pasted separately, waiting this long between parts. If images arrive out of order or go missing, pick a slower setting.",
		"快 0.2 秒": "Fast 0.2s", "标准 0.35 秒": "Normal 0.35s", "慢 0.6 秒": "Slow 0.6s", "很慢 1 秒": "Very slow 1s",
		"添加图片说明": "Add image description", "图片说明": "Image description", "图片说明：": "Image description: ",
		"描述这张图，例如「登录页报错截图」": "Describe this image, e.g. “login page error screenshot”",
		"保存说明（↵）；Esc 保存并退出": "Save description (↵); Esc saves and exits",
		"已保存图片说明":           "Image description saved", "已清除图片说明": "Image description cleared",
	} {
		if _, ok := en[k]; !ok {
			en[k] = v
		}
	}
}
