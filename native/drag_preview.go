package main

import (
	"fmt"
	"image"
	"strings"

	"github.com/egoist/mygo/transfer"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// 卡片正文拖出（doneText 的拖出源）：在多选里就拖整组（同发送钮 sendSelfOrChecked）；拖动副本换成一张小卡——
// 首条摘要一行 +（多张时）「N 张」胶囊，替代默认的「正文元素截图」（长正文截出来是半截段落，看不出拖的是什么）。

// liveApp：当前运行的 app（doneText 是自由函数，拖出组与预览要读多选与配色）。
var liveApp *app

// cardDragNotes：拖这张卡时实际带走的卡（在多选里 = 整组，按列表顺序）。
func cardDragNotes(n store.Note) []store.Note {
	if liveApp == nil {
		return []store.Note{n}
	}
	return liveApp.clipMoveTargets(n)
}

func noteIDs(ns []store.Note) []string {
	ids := make([]string, len(ns))
	for i, x := range ns {
		ids[i] = x.ID
	}
	return ids
}

// cardDragText：拖到别的应用时的纯文字（多张为编号列表，同发送）。
func cardDragText(ns []store.Note) string {
	if len(ns) == 1 {
		return ns[0].Text
	}
	var texts []string
	for _, x := range ns {
		if strings.TrimSpace(x.Text) != "" {
			texts = append(texts, x.Text)
		}
	}
	return sendText(texts)
}

type dragPreviewKey struct {
	ids  string
	dark bool
	text string
}

var dragPreviewCache struct {
	key dragPreviewKey
	img image.Image
	hot image.Point
}

const dragPreviewW, dragPreviewH = 240, 40

// cardDragOptions：拖出预览（悬停时才生成，按「卡片组 + 首条正文 + 深浅色」缓存，不每帧重画）。
func cardDragOptions(ns []store.Note, dark bool) transfer.DragOptions {
	first := ""
	if len(ns) > 0 {
		first = firstLine(ns[0].Text)
	}
	key := dragPreviewKey{ids: strings.Join(noteIDs(ns), ","), dark: dark, text: first}
	if dragPreviewCache.key != key || dragPreviewCache.img == nil {
		dragPreviewCache.key = key
		dragPreviewCache.img = renderDragPreview(first, len(ns), dark)
		dragPreviewCache.hot = image.Pt(18, dragPreviewH/2)
	}
	return transfer.DragOptions{Preview: dragPreviewCache.img, Hotspot: dragPreviewCache.hot}
}

// renderDragPreview：离屏画一张 240×40 小卡（卡片底 + 细边 + 浮起阴影；摘要单行截断，多张时右侧「N 张」主色胶囊）。
func renderDragPreview(first string, count int, dark bool) image.Image {
	tt := ui.NewTester(func(c *ui.Context) {
		registerFonts()
		k := tok(c)
		c.Root().Background(ui.Transparent)
		ui.Row(c).Fill().Padding(4).Children(func() {
			ui.Row(c).Fill().Padding(0, 10).Gap(8).Radius(rr(10)).Background(k.card).Border(1, k.floatBorder).
				Shadow(0, 2, 6, -2, gray(0, 0.25)).AlignItems(ui.Center).Children(func() {
				licon(c, "file-text", 12, k.muted)
				line := first
				if strings.TrimSpace(line) == "" {
					line = tr("（空）")
				}
				text(c, line, 11, 16, 500, k.fg).SingleLine().Grow(1).Basis(0)
				if count > 1 {
					p := stok(c).primary
					ui.Box(c).Height(18).Padding(0, 7).Radius(9).Background(p).Center().Shrink(0).Children(func() {
						text(c, fmt.Sprintf(tr("%d 张"), count), 10, 14, 600, gray(1, 1)).SingleLine()
					})
				}
			})
		})
	}, dragPreviewW, dragPreviewH)
	tt.SetDark(dark)
	tt.Frame()
	return tt.Image()
}
