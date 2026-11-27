package main

import (
	"fmt"
	"image"
	"strings"
	"time"

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

// 小卡本体 232×32；四周留白给投影（上 6 / 左右 10 / 下 14：环境影 0 4 12 -2 向下最远约 14pt，留少了会在图边切出一条直线）。
const (
	dragPreviewW, dragPreviewH             = 252, 52
	dragPadTop, dragPadSide, dragPadBottom = 6, 10, 14
)

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
		dragPreviewCache.hot = image.Pt(dragPadSide+14, dragPadTop+(dragPreviewH-dragPadTop-dragPadBottom)/2)
	}
	return transfer.DragOptions{Preview: dragPreviewCache.img, Hotspot: dragPreviewCache.hot}
}

// renderDragPreview：离屏画一张小卡（浮层双线边 floatEdge；主题生效时仍是卡片底 + 细边 + 浮起阴影；摘要单行截断，多张时右侧「N 张」主色胶囊）。
func renderDragPreview(first string, count int, dark bool) image.Image {
	tt := ui.NewTester(func(c *ui.Context) {
		registerFonts()
		k := tok(c)
		c.Root().Background(ui.Transparent)
		ui.Row(c).Fill().Padding(dragPadTop, dragPadSide, dragPadBottom, dragPadSide).Children(func() {
			card := ui.Row(c).Fill().Padding(0, 10).Gap(8).Radius(rr(10)).AlignItems(ui.Center)
			if !floatEdge(card, k) {
				card.Background(k.card).Border(1, k.floatBorder).Shadow(0, 2, 6, -2, gray(0, 0.25))
			}
			card.Children(func() {
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

// rowUnified：正在构建的笔记行整行是一个拖动源——里面的正文 / 缩略图不再各自当拖出源（doneText、imageDragOut 据此跳过）。
var rowUnified bool

// rowUnifiedHover：该行此刻被指针悬停（缩略图的停留预览据此判断，见 compactHover）。
var rowUnifiedHover bool

// rowDragNative：笔记行的拖动同时是系统原生拖拽（能拖到别的应用）。无头测试没有系统拖拽会话，关掉走窗内拖动；放下的处理是同一份。
var rowDragNative = true

// rowDragOut：笔记行拖出窗口时交给别的应用的内容——有正文给原文（在多选里是整组，同发送），纯图片卡给原图。
// 模糊卡、秘文、链接卡不给（只能在面板里拖）。图文都有的卡只给文字。跟手的是一张小卡 / 缩略图。
func (a *app) rowDragOut(box ui.Element, k tokens, n store.Note) {
	if !rowDragNative || n.Blur || n.Kind == "secret" || n.Kind == "link" {
		return
	}
	hovered := box.Hovered() // 预览只在悬停时生成（按下前一定悬停过）
	var opts []transfer.DragOptions
	if n.Kind != "image" && n.Text != "" {
		if hovered {
			opts = append(opts, cardDragOptions(cardDragNotes(n), k.dark))
		}
		box.DragDataFrom(func() transfer.Data { return transfer.TextData(cardDragText(cardDragNotes(n))) }, opts...)
		return
	}
	files := n.MediaFiles()
	if len(files) == 0 {
		return
	}
	o := transfer.DragOptions{Done: func(transfer.Result) { time.AfterFunc(time.Minute, cleanImageDragDir) }}
	if hovered {
		if prev := a.dragThumbPreview(files[0]); prev != nil {
			o.Preview, o.Hotspot = prev, image.Pt(prev.Bounds().Dx()/2, prev.Bounds().Dy()/2)
		}
	}
	box.DragDataFrom(func() transfer.Data { return a.imageDragData(files) }, o)
}
