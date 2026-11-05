package main

import (
	"strings"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// revealFor 是秘文显现后自动回遮罩的时长。
const revealFor = 15 * time.Second

func mask(s string) string {
	n := min(len([]rune(s)), 24)
	return strings.Repeat("•", max(n, 6))
}

func (a *app) revealSecret(id string) {
	a.revealed[id] = time.Now().Add(revealFor)
	time.AfterFunc(revealFor+50*time.Millisecond, func() {
		if a.panel != nil {
			a.panel.Update(func() {}) // 触发重绘，过期的显现自动回遮罩
		}
	})
}

func (a *app) secretsPage(c *ui.Context, _ tokens) {
	t := c.Theme()
	now := time.Now()
	a.surface(c, ui.Column(c).Padding(10, 12).Gap(8).Radius(12), 0).Children(func() {
		ui.TextInput(c, &a.secTitle).Placeholder(tr("标题（如 服务器 root）"))
		ui.TextInput(c, &a.secBody).Password().Placeholder(tr("内容：只存在加密信封里，界面默认遮罩"))
		if ui.Button(c, tr("保存秘文")).Clicked() {
			if a.store.AddSecret(a.secTitle, a.secBody).ID != "" {
				a.secTitle, a.secBody = "", ""
			}
		}
	})
	ui.Scroll(c).Grow(1).Children(func() {
		ui.Column(c).Gap(6).Children(func() {
			if len(a.secrets) == 0 {
				ui.Text(c, tr("还没有秘文")).TextColor(t.TextMuted).Padding(16).Center()
			}
			for _, s := range a.secrets {
				a.secretRow(c, s, now)
			}
			a.sealTool(c)
		})
	})
}

func (a *app) secretRow(c *ui.Context, s store.Secret, now time.Time) {
	t := c.Theme()
	shown := a.revealed[s.ID].After(now)
	a.surface(c, ui.Row(c).Padding(10, 12).Gap(10).Radius(10).AlignItems(ui.Center).Key(s.ID), 0.5).Children(func() {
		ui.Icon(c, iconLock).FontSize(14).TextColor(t.TextMuted)
		ui.Column(c).Gap(2).Grow(1).Children(func() {
			ui.Text(c, s.Title).Bold().SingleLine()
			body := mask(s.Body)
			if shown {
				body = s.Body
			}
			ui.Text(c, body).FontSize(12).TextColor(t.TextMuted).Wrap().MaxLines(6)
		})
		eye := iconEye
		if shown {
			eye = iconEyeOff
		}
		if ui.Icon(c, eye).FontSize(14).TextColor(t.TextMuted).Tooltip(tr("显现 15 秒")).Clicked() {
			if shown {
				delete(a.revealed, s.ID)
			} else {
				a.revealSecret(s.ID)
			}
		}
		if ui.Icon(c, iconCopy).FontSize(14).TextColor(t.TextMuted).Tooltip(tr("复制（不进剪贴板历史）")).Clicked() {
			a.copyPrivate(s.Body)
			c.Toast(tr("已复制"))
		}
		if ui.Icon(c, iconTrash).FontSize(14).TextColor(t.TextMuted).Tooltip(tr("删除")).Clicked() {
			a.store.DeleteSecret(s.ID)
		}
	})
}

// sealTool：用口令把一段文字封成「看起来像代码」的密文发给别人，或反向解开。
func (a *app) sealTool(c *ui.Context) {
	t := c.Theme()
	a.surface(c, ui.Column(c).Padding(10, 12).Gap(8).Radius(12), 0).Children(func() {
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			ui.Text(c, tr("口令封装")).Bold().Grow(1)
			mode := 0
			if a.sealOpenOn {
				mode = 1
			}
			if ui.Segmented(c, &mode, tr("封装"), tr("解开")).Changed() {
				a.sealOpenOn, a.sealOut = mode == 1, ""
			}
		})
		ph := tr("要发给对方的内容")
		if a.sealOpenOn {
			ph = tr("粘贴收到的整段密文")
		}
		ui.TextArea(c, &a.sealIn).Lines(2, 6).Placeholder(ph)
		ui.TextInput(c, &a.sealPass).Password().Placeholder(tr("口令（通过其他渠道告诉对方）"))
		label := tr("生成密文")
		if a.sealOpenOn {
			label = tr("解开密文")
		}
		if ui.Button(c, label).Clicked() {
			var out string
			var err error
			if a.sealOpenOn {
				out, err = store.OpenWithPassphrase(a.sealIn, a.sealPass)
			} else {
				out, err = store.SealWithPassphrase(a.sealIn, a.sealPass)
			}
			if err != nil {
				a.sealOut = "⚠ " + err.Error()
			} else {
				a.sealOut = out
			}
		}
		if a.sealOut != "" {
			out := ui.Text(c, a.sealOut).FontSize(12).Wrap().Selectable().Padding(8).Radius(8).Background(t.Background.Alpha(0.5))
			if strings.HasPrefix(a.sealOut, "⚠") {
				out.TextColor(t.Danger)
			}
			if !strings.HasPrefix(a.sealOut, "⚠") && ui.Button(c, tr("复制结果")).Clicked() {
				a.copyPrivate(a.sealOut)
				c.Toast(tr("已复制"))
			}
		}
	})
}
