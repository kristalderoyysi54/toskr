package main

import (
	"bytes"
	"image/png"
	"strings"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// openDetail 在独立窗口打开一条笔记：长文编辑（⌘S 保存，关窗自动保存），图片看原图。
// 对应 Tauri 版详情窗；块级图文混排编辑未移植（mygo 富文本只有行内附件）。
func (a *app) openDetail(n store.Note) {
	a.saveDetail()
	a.detailID, a.detailText = n.ID, n.Text
	var full ui.ImageSource
	if n.Kind == "image" {
		if raw, err := a.store.LoadImage(n.ImageFile); err == nil {
			if src, err := png.Decode(bytes.NewReader(raw)); err == nil {
				full = scaledBitmap(src, 1600)
			}
		}
	}
	if a.detailWin != nil {
		a.detailWin.Destroy() // 每次重建：位图随窗口释放
	}
	a.detailWin = mygo.NewWindow(mygo.WindowOptions{
		Title: preview(n.Text, 24), Width: 560, Height: 680, Hidden: true,
		Vibrancy: vibrancyFor(a.store.Settings().Glass), Transparent: true,
		Content: ui.View(func(c *ui.Context) { a.detailView(c, n, full) }),
	})
	if n.Kind == "image" {
		a.detailWin.SetTitle(tr("图片"))
	}
	a.detailWin.OnClose(func(*mygo.CloseEvent) {
		a.saveDetail()
		a.detailWin, a.detailID = nil, ""
	})
	a.detailWin.Show()
	a.detailWin.Focus()
}

func (a *app) saveDetail() {
	if a.detailID != "" && strings.TrimSpace(a.detailText) != "" {
		_ = a.store.Update(a.detailID, a.detailText)
	}
}

func (a *app) detailView(c *ui.Context, n store.Note, full ui.ImageSource) {
	t := c.Theme()
	if c.Vibrancy() {
		c.Root().Background(ui.Transparent)
	} else {
		c.Root().Background(t.Background)
	}
	if c.Shortcut(ui.Cmd, ui.KeyS) {
		a.saveDetail()
		c.Toast(tr("已保存"))
	}
	ui.Column(c).Fill().Padding(16).Gap(10).Children(func() {
		if full != nil {
			ui.Scroll(c).MaxHeight(360).Children(func() {
				w, h := ui.ImageSize(full)
				dw := min(w, 528)
				ui.Image(c, full).Size(dw, h*dw/max(w, 1)).Radius(8)
			})
		}
		ui.TextArea(c, &a.detailText).Grow(1).Placeholder(tr("正文"))
		meta := n.SourceApp
		if meta == "" {
			meta = "Toskr"
		}
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			ui.Text(c, meta+" · "+itoa(len([]rune(a.detailText)))+tr(" 字")).FontSize(11).TextColor(t.TextMuted).Grow(1)
			if ui.Button(c, tr("保存（⌘S）")).Clicked() {
				a.saveDetail()
				c.Toast(tr("已保存"))
			}
		})
	})
}
