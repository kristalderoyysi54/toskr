package main

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"image/png"
	"strings"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/diag"
	"github.com/toskr/native/internal/linkmeta"
	"github.com/toskr/native/internal/store"
)

// 链接预览（同 Tauri enrichLinkMeta）：新增或改了 URL 的链接卡自动补抓标题与图标，只访问公网；
// 右键「确认获取链接预览…」征得同意后可放行该地址的内网访问。已有标题的不自动重抓。

// linkFetch 是抓取函数（测试替换）。
var linkFetch = linkmeta.Fetch

// sweepLinks：store 每次变化后调用。首轮只把现有链接记为已见；之后出现的新卡 / 新 URL 才抓，
// 且只抓一小时内创建或刚改过 URL 的——导入的大批旧链接不会在后台挨个联网。
func (a *app) sweepLinks(all []store.Note) {
	first := a.linkSeen == nil
	if first {
		a.linkSeen = map[string]string{}
	}
	now := a.now()
	for _, n := range all {
		if n.Kind != "link" || n.URL == "" {
			continue
		}
		prev, seen := a.linkSeen[n.ID]
		if prev == n.URL {
			continue
		}
		a.linkSeen[n.ID] = n.URL
		if first || n.LinkTitle != "" || !seen && now.Sub(n.CreatedAt) > time.Hour {
			continue
		}
		a.fetchLink(n, false)
	}
}

// fetchLink 后台抓取；最多两路并发，结果按 URL 校验后写回。
func (a *app) fetchLink(n store.Note, manual bool) {
	allow := ""
	if manual {
		allow = linkmeta.Origin(n.URL)
	}
	go func() {
		a.linkSem <- struct{}{}
		defer func() { <-a.linkSem }()
		m, err := linkFetch(context.Background(), n.URL, allow)
		if err == nil && m.Title == "" && m.Icon == "" {
			err = errors.New("页面没有标题与图标")
		}
		if err != nil {
			diag.Push("链接预览失败 %s：%v", linkmeta.Origin(n.URL), err)
			if manual {
				a.onMain(func() { a.showHUD("info", tr("未获取预览（取消、网络失败或地址受限）")) })
			}
			return
		}
		if a.store.SetLinkMeta(n.ID, n.URL, m.Title, m.Icon) && manual {
			a.onMain(func() { a.showHUD("ok", tr("已更新链接预览")) })
		}
	}()
}

// confirmFetchLink：右键手动获取——先说明会访问哪个地址并放行其内网访问，同意后才抓（同 Tauri fetch_link_meta manual）。
func (a *app) confirmFetchLink(n store.Note) {
	origin := linkmeta.Origin(n.URL)
	go func() { // Dialog.Message 阻塞到用户选择，不能卡在渲染帧里
		r, err := mygo.Dialog.Message(mygo.MessageOptions{
			Title:   tr("确认获取链接预览"),
			Message: fmt.Sprintf(tr("本次将访问 %s 获取标题和图标，允许此地址访问内网。不会发送应用中的其他内容；授权不覆盖其他内网地址的重定向。"), origin),
			Buttons: []string{tr("仅本次允许"), tr("取消")}, DefaultButton: 0,
		})
		if err == nil && r.Button == 0 {
			a.fetchLink(n, true)
		}
	}()
}

// favicon 解码 Tauri 同格式的 data:image/png;base64 图标（≤64KB，按内容缓存，失败也缓存 nil）。
func (a *app) favicon(src string) ui.ImageSource {
	const prefix = "data:image/png;base64,"
	if !strings.HasPrefix(src, prefix) || len(src) > 65536 {
		return nil
	}
	if img, ok := a.thumbs[src]; ok {
		return img
	}
	var out ui.ImageSource
	if raw, err := base64.StdEncoding.DecodeString(src[len(prefix):]); err == nil {
		if img, err := png.Decode(strings.NewReader(string(raw))); err == nil {
			out = scaledBitmap(img, 64)
		}
	}
	a.thumbs[src] = out
	return out
}

// linkFavicon 画 16px 圆角图标；没有图标时什么也不画。
func (a *app) linkFavicon(c *ui.Context, n store.Note, size float32) {
	if img := a.favicon(n.LinkIcon); img != nil {
		ui.Image(c, img).Size(size, size).Radius(3)
	}
}

// linkBlock 是笔记卡里的链接正文（同 Tauri NoteCard 链接票据）：图标 + 标题（无标题时用域名），下一行域名 + 路径。
func (a *app) linkBlock(c *ui.Context, k tokens, n store.Note) {
	host := linkHost(n.URL)
	title := n.LinkTitle
	if title == "" {
		title = host
	}
	ui.Column(c).Gap(2).Children(func() {
		ui.Row(c).Gap(6).AlignItems(ui.Start).Children(func() {
			if img := a.favicon(n.LinkIcon); img != nil {
				ui.Image(c, img).Size(16, 16).Radius(3).Margin(1, 0, 0, 0)
			}
			text(c, title, 13, 16.25, 600, k.fg).Wrap().MaxLines(2).Grow(1).Basis(0)
		})
		if n.LinkTitle != "" {
			text(c, host, 11, 13.75, 400, k.muted).SingleLine()
		}
	})
}
