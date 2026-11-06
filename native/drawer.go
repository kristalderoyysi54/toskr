package main

import (
	"fmt"
	"slices"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// 「最近发送」抽屉（Tauri RecentDeliveryDrawer）：面板内全高浮层，按「需处理 / 等待回复 / 已完成」分区，
// 每轮显示目标应用、时间、状态药丸、出站摘要（点开原内容）、回复入口；卡脚：手动选择 / 更换回复、重新准备、更多明细。

func deliveryStatus(d store.Delivery, hasReply bool) (string, string) {
	switch {
	case d.Status == "failed":
		return tr("发送失败"), "warning"
	case d.Status == "blocked":
		return tr("已拦截"), "warning"
	case d.Unconfirmed:
		return tr("投递结果不确定，请核对目标"), "warning"
	case hasReply:
		return tr("已收到回复"), "success"
	}
	return tr("等待回复"), "muted"
}

func timeAgoShort(t, now time.Time) string {
	d := now.Sub(t)
	switch {
	case d < time.Minute:
		return tr("刚刚")
	case d < time.Hour:
		return fmt.Sprintf(tr("%d 分钟前"), int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf(tr("%d 小时前"), int(d.Hours()))
	}
	return fmt.Sprintf(tr("%d 天前"), int(d.Hours()/24))
}

// deliverySummary：出站摘要（来源卡实时重建，首条正文首行）与可用性。
func (a *app) deliverySummary(d store.Delivery) (string, []store.Note) {
	var src []store.Note
	for _, id := range d.SourceIDs {
		if n, ok := a.store.Note(id); ok {
			src = append(src, n)
		}
	}
	switch {
	case len(src) == 0 && len(d.SourceIDs) > 0:
		return tr("原内容已删除"), nil
	case len(src) == 0:
		return tr("无正文内容"), nil
	}
	s := "“" + preview(src[0].Text, 60) + "”"
	if len(src) < len(d.SourceIDs) {
		s += " · " + tr("部分原内容已删除")
	}
	return s, src
}

func (a *app) recentDrawer(c *ui.Context, k tokens) {
	if !a.drawerOpen {
		return
	}
	now := a.now()
	all := a.store.Deliveries()
	notes := a.store.Notes()
	reply := func(d store.Delivery) (store.Note, bool) {
		if d.ResultNoteID == "" {
			return store.Note{}, false
		}
		i := slices.IndexFunc(notes, func(n store.Note) bool {
			return n.ID == d.ResultNoteID && n.Provenance != nil && n.Provenance.DeliveryID == d.ID
		})
		if i < 0 {
			return store.Note{}, false
		}
		return notes[i], true
	}
	var attention, waiting, settled []store.Delivery
	for _, d := range all {
		_, has := reply(d)
		switch {
		case d.Status == "failed" || d.Status == "blocked":
			attention = append(attention, d)
		case d.Status == "sent" && !has:
			waiting = append(waiting, d)
		default:
			settled = append(settled, d)
		}
	}
	// 遮罩：点空白处关闭
	dim := ui.Box(c).Absolute().Top(0).Left(0).Right(0).Bottom(0).Background(k.window.Alpha(0.55)).Key("drawer-dim")
	if dim.Clicked() {
		a.drawerOpen = false
	}
	sheet := ui.Column(c).Absolute().Top(8).Bottom(8).Left(8).Right(8).Padding(12).Radius(16).Key("recent-drawer").Label(tr("最近发送"))
	floatSurface(sheet, k).Children(func() {
		ui.Row(c).Padding(0, 0, 8, 0).Gap(4).AlignItems(ui.Center).BorderWidth(0, 0, 1, 0).BorderColor(k.inputBorder.Alpha(0.7)).Children(func() {
			text(c, tr("最近发送"), 13, 18, 600, k.fg).Grow(1)
			if len(all) > 0 && a.iconButton(c, k, "trash-2", 24, 14, tr("清除记录")) {
				prev := all
				a.store.ClearDeliveries()
				a.showHUDUndo("ok", tr("已清除发送记录"), func() { a.store.RestoreDeliveries(prev) })
			}
			if a.iconButton(c, k, "x", 24, 14, tr("关闭最近发送")) {
				a.drawerOpen = false
			}
		})
		if len(all) == 0 {
			ui.Column(c).Grow(1).Justify(ui.Center).AlignItems(ui.Center).Gap(4).Children(func() {
				licon(c, "clock-3", 20, k.muted.Alpha(0.5))
				text(c, tr("暂无发送记录"), 13, 18, 400, k.muted)
				text(c, tr("勾选卡片后 ⌘⏎ 发送，这里会出现你和 AI 的一问一答"), 11, 16, 400, k.muted)
			})
			return
		}
		ui.Scroll(c).Grow(1).Margin(8, 0, 0, 0).Scrollbars(false).Children(func() {
			ui.Column(c).Gap(6).Children(func() {
				for _, sec := range []struct {
					label string
					list  []store.Delivery
					hint  bool
				}{{tr("需处理"), attention, false}, {tr("等待回复"), waiting, true}, {tr("已完成"), settled, false}} {
					if len(sec.list) == 0 {
						continue
					}
					ui.Row(c).Padding(6, 2, 0, 2).Gap(8).AlignItems(ui.Center).Children(func() {
						text(c, sec.label, 10, 14, 500, k.muted)
						ui.Box(c).Height(1).Grow(1).Background(k.inputBorder.Alpha(0.6))
						if sec.hint {
							text(c, tr("在 AI 应用双击 ⇧ 划选回复"), 10, 14, 400, k.muted)
						}
					})
					for _, d := range sec.list {
						a.deliveryRow(c, k, d, notes, now, reply)
					}
				}
			})
		})
	})
}

func (a *app) deliveryRow(c *ui.Context, k tokens, d store.Delivery, notes []store.Note, now time.Time, reply func(store.Delivery) (store.Note, bool)) {
	res, hasReply := reply(d)
	summary, src := a.deliverySummary(d)
	ui.Column(c).Padding(10).Radius(12).Border(1, k.fg.Alpha(0.1)).Background(k.track.Alpha(0.5)).Key("dlv-" + d.ID).Children(func() {
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			name := d.TargetName
			if name == "" {
				name = tr("未识别目标")
			}
			text(c, name, 12, 17, 500, k.fg).SingleLine().Grow(1).Basis(0)
			text(c, timeAgoShort(d.At, now), 10, 14, 400, k.muted).FontFeatures("tnum").Tooltip(d.At.Format("2006-01-02 15:04:05"))
			label, tone := deliveryStatus(d, hasReply)
			fg, bg, icon := k.muted, k.track, "clock-3"
			switch tone {
			case "warning":
				fg, bg, icon = k.amberText, k.amberBar.Alpha(0.15), "triangle-alert"
			case "success":
				fg, bg, icon = k.ok, k.ok.Alpha(0.12), "circle-check"
			}
			ui.Row(c).Padding(1, 6).Gap(3).Radius(999).Background(bg).AlignItems(ui.Center).Children(func() {
				licon(c, icon, 10, fg)
				text(c, label, 10, 14, 500, fg).SingleLine()
			})
		})
		sb := ui.Box(c).Margin(4, 0, 0, 0).Padding(2, 4).Radius(6).Tooltip(tr("查看发送内容")).Role(ui.RoleButton).Label(tr("查看发送内容"))
		if len(src) > 0 && sb.Hovered() {
			sb.Background(k.hoverBg)
		}
		sb.Children(func() { text(c, summary, 12, 17, 400, k.fg.Alpha(0.9)).SingleLine() })
		if sb.Clicked() && len(src) > 0 {
			a.openBatchDetail(src, len(d.SourceIDs)) // 多张来源：只读合并预览（同 Tauri openNoteBatchDetail）
		}
		if hasReply {
			ui.Row(c).Margin(6, 0, 0, 0).Padding(2, 0, 2, 8).Gap(8).BorderWidth(0, 0, 0, 2).BorderColor(k.ok.Alpha(0.4)).AlignItems(ui.Center).Children(func() {
				ui.Row(c).Gap(4).AlignItems(ui.Center).Children(func() {
					licon(c, "message-square-reply", 12, k.ok)
					text(c, tr("回复已入库"), 10, 14, 400, k.muted)
				})
				if footLink(c, k, tr("打开"), "open-"+d.ID) {
					a.openDetail(res)
				}
			})
		}
		ui.Row(c).Margin(8, 0, 0, 0).Padding(6, 4, 0, 4).Gap(12).BorderWidth(1, 0, 0, 0).BorderColor(k.inputBorder.Alpha(0.5)).AlignItems(ui.Center).Children(func() {
			cands := store.ResultCandidates(d, notes)
			if d.Status == "sent" {
				label := tr("手动选择回复")
				if hasReply {
					label = tr("更换回复")
				}
				pick := ui.Box(c).Key("pick-" + d.ID)
				pick.Menu(func(m *ui.Menu) {
					if len(cands) == 0 {
						m.Item(tr("发送后 30 分钟内没有来自该应用的捕获")).Disabled(true)
					}
					for _, n := range cands {
						if m.Item(n.CreatedAt.Format("15:04") + " · " + preview(n.Text, 30)).Checked(n.ID == d.ResultNoteID).Chosen() {
							a.linkReply(d, n)
						}
					}
					if hasReply {
						m.Separator()
						if m.Item(tr("取消关联")).Chosen() {
							a.store.UnlinkResult(d.ID)
						}
					}
				})
				pick.Children(func() { text(c, label, 10, 14, 400, k.muted) })
			}
			if (d.Status == "failed" || d.Status == "blocked") && len(src) > 0 {
				if footLink(c, k, tr("重新准备"), "re-"+d.ID) {
					a.drawerOpen = false
					a.outRetry = true // 统计里的「重试次数」（同 Tauri retry-prepared）
					a.showHUD("info", tr("已按当前来源重新准备，请在预检中确认后发送"))
					a.forceCheck = true // 同 Tauri：重新准备一律进预检确认，不直接粘贴
					a.send(src)
					a.outRetry = false
				}
			}
			ui.Spacer(c)
			more := ui.Row(c).Gap(2).AlignItems(ui.Center).Key("more-" + d.ID).Tooltip(tr("更多信息")).Role(ui.RoleButton).Label(tr("更多信息"))
			open := a.drawerMore[d.ID]
			mc := k.muted
			if more.Hovered() {
				mc = k.fg
			}
			more.Children(func() {
				text(c, tr("更多"), 10, 14, 400, mc)
				chev := "chevron-down"
				if open {
					chev = "chevron-up"
				}
				licon(c, chev, 12, mc)
			})
			if more.Clicked() {
				a.drawerMore[d.ID] = !open
			}
		})
		if a.drawerMore[d.ID] {
			ui.Column(c).Padding(6, 4, 2, 4).Gap(3).Children(func() {
				kv := func(key, val string) {
					ui.Row(c).Gap(8).Children(func() {
						text(c, key, 10, 14, 400, k.muted)
						text(c, val, 10, 14, 400, k.fg).SingleLine().Grow(1).Basis(0).TextAlign(ui.End)
					})
				}
				when := tr("发送于")
				if d.Status != "sent" {
					when = tr("记录于")
				}
				kv(when, d.At.Format("2006-01-02 15:04:05"))
				payload := tr("无正文内容")
				switch {
				case d.TextChars > 0 && d.ImageCount > 0:
					payload = fmt.Sprintf(tr("%d 字文字 + %d 张图片"), d.TextChars, d.ImageCount)
				case d.TextChars > 0:
					payload = fmt.Sprintf(tr("%d 字文字"), d.TextChars)
				case d.ImageCount > 0:
					payload = fmt.Sprintf(tr("%d 张图片"), d.ImageCount)
				}
				kv(tr("原内容"), fmt.Sprintf(tr("%d 张卡片"), len(d.SourceIDs))+" · "+payload)
				privacy := tr("发送前未替换敏感内容")
				if d.Redactions > 0 {
					privacy = fmt.Sprintf(tr("发送前隐藏了 %d 项敏感内容"), d.Redactions)
				}
				kv(tr("隐私保护"), privacy)
				if d.Profile != "" {
					kv(tr("发送方案"), d.Profile)
				}
				if d.Err != "" {
					kv(tr("原因"), d.Err)
				}
			})
		}
	})
}

func footLink(c *ui.Context, k tokens, label, key string) bool {
	b := ui.Row(c).Key("fl-" + key).Role(ui.RoleButton).Label(label)
	fg := k.muted
	if b.Hovered() {
		fg = k.fg
	}
	b.Children(func() { text(c, label, 10, 14, 400, fg) })
	return b.Clicked()
}

// linkReply：把笔记设为该次发送的回复，可撤销（换回原回复或取消关联）。
func (a *app) linkReply(d store.Delivery, n store.Note) {
	prev, ok := a.store.LinkResult(d.ID, n.ID)
	if !ok {
		return
	}
	a.store.RecordOutcome(store.OutcomeEvent{DeliveryID: d.ID, Type: store.OutResult, AtMs: n.CreatedAt.UnixMilli()})
	a.showHUDUndo("ok", fmt.Sprintf(tr("已设为发往 %s 的回复"), d.TargetName), func() {
		if prev != "" {
			a.store.LinkResult(d.ID, prev)
		} else {
			a.store.UnlinkResult(d.ID)
		}
	})
}

// floatSurface：浮层底（同卡片悬浮钮的描边与双层投影）。
func floatSurface(b ui.Element, k tokens) ui.Element {
	return b.Background(k.floatBtn).Border(1, k.floatBorder).
		Shadow(0, 1, 2, 0, k.floatShadowA).Shadow(0, 6, 16, -4, k.floatShadowB).InsetShadow(0, 1, 0, 0, k.floatInset)
}

// replyPicks：可把该笔记设为回复的发送——30 分钟内发往其来源应用的在前，再补最近的成功发送，最多 8 条。
func (a *app) replyPicks(n store.Note) []store.Delivery {
	all := a.store.Deliveries()
	out := store.DeliveryCandidates(n, all)
	for _, d := range all {
		if len(out) >= 8 {
			break
		}
		if d.Status == "sent" && !slices.ContainsFunc(out, func(x store.Delivery) bool { return x.ID == d.ID }) {
			out = append(out, d)
		}
	}
	return out
}

// replyMenu：卡片右键的回复关联（同 Tauri：无溯源 →「保存为某次回复…」；有溯源 →「回复关联」小窗）。
func (a *app) replyMenu(m *ui.Menu, n store.Note) {
	picks := func(sm *ui.Menu) {
		ds := a.replyPicks(n)
		if len(ds) == 0 {
			sm.Item(tr("还没有发送记录")).Disabled(true)
		}
		for _, d := range ds {
			if sm.Item(d.TargetName + " · " + timeAgoShort(d.At, a.now())).Checked(n.Provenance != nil && n.Provenance.DeliveryID == d.ID).Chosen() {
				a.linkReply(d, n)
			}
		}
	}
	if n.Provenance == nil {
		m.Submenu(tr("保存为某次回复…"), picks)
		return
	}
	m.Submenu(tr("回复关联"), func(sm *ui.Menu) {
		if sm.Item(tr("查看发送内容")).Chosen() {
			a.drawerOpen = true
		}
		if sm.Item(tr("检查回复…")).Chosen() {
			a.openVerify(n)
		}
		restore := sm.Item(tr("恢复占位符"))
		if a.redactionMap(n.Provenance.DeliveryID) == nil {
			restore.Disabled(true)
		}
		if restore.Chosen() {
			a.restoreReplyPlaceholders(n)
		}
		sm.Submenu(tr("更换对应发送…"), picks)
		if sm.Item(tr("这不是对应回复…")).Chosen() {
			id := a.store.UnlinkNote(n.ID)
			a.showHUDUndo("ok", tr("已取消回复关联"), func() { a.store.LinkResult(id, n.ID) })
		}
	})
}

// 面板内拖拽的值类型（ui.Drag / ui.Drop）。
type (
	noteDrag struct{ id string }
	taskDrag struct{ id string }
)
