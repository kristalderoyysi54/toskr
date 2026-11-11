package main

import (
	"bytes"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/diag"
	"github.com/toskr/native/internal/imwatch"
	"github.com/toskr/native/internal/store"
)

// IM 消息放大阅读与消息图片（用户 2026-11-09）：
//   - 消息卡在面板里只有 12pt、4 行截断，长告警读起来吃力：悬停「放大阅读」/ 双击卡片，用详情窗只读打开（同剪贴卡预览，
//     字号可 ⌘+ / ⌘− 调，图片可点开看大图）；
//   - 图文混合消息：桥在 IM 页面里用其登录态取回图片，Accept 时存进媒体库，消息只记文件名；卡面正文下方一排缩略图。

func init() {
	for k, v := range map[string]string{
		"放大阅读（空格 / 双击卡片）": "Read enlarged (Space or double-click)", "%s · 群消息": "%s · group message",
		"IM 消息图片: 已存 %d 张": "IM message images: saved %d", "%d 张图片": "%d images",
	} {
		if _, ok := en[k]; !ok {
			en[k] = v
		}
	}
}

// imSaveImage：桥收到的图片转 PNG（推推等多为 JPEG / WebP）后存进媒体库；与粘贴入库同一路径（按像素哈希去重）。
func (a *app) imSaveImage(raw []byte) (string, error) {
	if !bytes.HasPrefix(raw, []byte("\x89PNG")) {
		raw = toPNG(raw)
	}
	im, ok := a.savePNG(raw)
	if !ok {
		return "", errBadImage
	}
	return im.file, nil
}

type imageErr struct{}

func (imageErr) Error() string { return "图片无法解码" }

var errBadImage error = imageErr{}

// imProbe：桥没认出图片时的字段形状写进诊断，实机拿到后据此补识别规则。
func imProbe(m imwatch.Message) {
	diag.Push("IM 消息图片: 正文像图片但没认出（%s）字段=%s", m.MessageType, strings.Join(m.ImageProbe, " "))
}

// openMessageDetail：消息正文放大阅读（详情窗只读预览）。
func (a *app) openMessageDetail(m store.Message) {
	sender := cmpOr(cmpOr(m.SenderName, m.SenderUID), tr("未知发送者"))
	conv := cmpOr(m.ConversationName, m.ConversationID)
	body := m.Text
	if strings.TrimSpace(body) == "" && len(m.Images) == 0 {
		body = "[" + cmpOr(m.MessageType, tr("非文本消息")) + "]"
	}
	v := store.Note{ID: msgViewPrefix + m.ID, Title: sender, Text: body, SourceApp: m.SourceApp, BundleID: m.SourceBundle,
		CreatedAt: time.UnixMilli(m.At())}
	imgs := slices.Clone(m.Images)
	for _, x := range m.Context { // 前文里的图也放进来，放大阅读时一起翻看
		for _, f := range x.Images {
			if !slices.Contains(imgs, f) {
				imgs = append(imgs, f)
			}
		}
	}
	switch {
	case strings.TrimSpace(body) == "" && len(imgs) > 0:
		v.Kind, v.ImageFile, v.Attachments = "image", imgs[0], imgs[1:]
	default:
		v.Attachments = imgs
	}
	openDetailFn(a, v)
	sub := msgTime(m.At(), a.now()) // 标题栏已显示发送者：副标题只给群名与时间
	if conv != "" && conv != sender {
		sub = conv + " · " + sub
	}
	a.detail.virt, a.detail.subtitle = &v, sub
}

// messageThumbs：消息卡正文下方的图片缩略（最多 4 张 + N），点开放大阅读。
func (a *app) messageThumbs(c *ui.Context, k tokens, m store.Message) {
	if len(m.Images) == 0 {
		return
	}
	ui.Row(c).Margin(6, 0, 0, 0).Label(fmt.Sprintf(tr("%d 张图片"), len(m.Images))).Children(func() { a.cardThumbStrip(c, k, m.Images) })
}

// msgView：当前详情窗是消息放大阅读。
func (a *app) msgView() bool {
	return a.detail.virt != nil && strings.HasPrefix(a.detail.virt.ID, msgViewPrefix)
}

const msgViewPrefix = "msg-view-"

// detailFS：详情窗正文字号（消息放大阅读用消息字号）。
func (a *app) detailFS() float32 {
	st := a.store.Settings()
	if a.msgView() {
		return float32(max(st.MessageFontSize, 10)) + 1
	}
	return float32(st.DetailFontSize) + 1
}

// msgKeys：消息列表键盘——↑↓ 逐条单选，空格快速查看（同笔记 / 剪贴列表：再按一次收起）。
func (a *app) msgKeys(c *ui.Context) {
	view := a.visibleMessages()
	if len(view) == 0 {
		return
	}
	i := slices.IndexFunc(view, func(m store.Message) bool { return m.ID == a.msgAnchor })
	step := 0
	switch {
	case c.Shortcut(0, ui.KeyDown):
		step = 1
	case c.Shortcut(0, ui.KeyUp):
		step = -1
	}
	if step != 0 {
		j := 0
		if i >= 0 {
			j = min(max(i+step, 0), len(view)-1)
		}
		a.msgAnchor, a.msgChosen = view[j].ID, map[string]bool{view[j].ID: true}
		a.msgScrollTo = view[j].ID
		return
	}
	if !c.Shortcut(0, ui.KeySpace) {
		return
	}
	if i < 0 {
		i = 0
		a.msgAnchor, a.msgChosen = view[0].ID, map[string]bool{view[0].ID: true}
	}
	m := view[i]
	if a.detailWin != nil && a.detailWin.IsVisible() && a.detail.id == msgViewPrefix+m.ID {
		a.detailWin.Hide()
		return
	}
	a.openMessageDetail(m)
}
