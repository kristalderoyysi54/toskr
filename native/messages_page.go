package main

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/ai"
	"github.com/toskr/native/internal/diag"
	"github.com/toskr/native/internal/store"
)

// 「内容 → 消息」（同 Tauri components/messages/MessagePage.tsx）：待处理 / 等待回复 / 已处理三栏；
// 点卡选择（⌘ 切换、⇧ 范围），选择态下批量条整行接管筛选栏；卡面悬停出 发送 · 处理 · 提醒 · 定位 · 更多。

const (
	subNotes    = 0
	subSecret   = 1
	subMessages = 2
)

var msgFilters = []struct{ value, label string }{{"new", "待处理"}, {"waiting", "等待回复"}, {"done", "已处理"}}

func msgInFilter(m store.Message, f string) bool {
	if f == "done" {
		return m.Done()
	}
	return m.Status == f
}

// messageMatches 同 Tauri：群名 / 群号 / 发送者 / 正文 / 前文。
func messageMatches(m store.Message, q string) bool {
	q = strings.ToLower(strings.TrimSpace(q))
	if q == "" {
		return true
	}
	parts := []string{m.ConversationName, m.ConversationID, m.SenderName, m.SenderUID, m.Text}
	for _, c := range m.Context {
		parts = append(parts, c.SenderName, c.SenderUID, c.Text)
	}
	return strings.Contains(strings.ToLower(strings.Join(parts, "\n")), q)
}

func (a *app) visibleMessages() []store.Message {
	var out []store.Message
	for _, m := range a.messages {
		if msgInFilter(m, a.msgFilter) && messageMatches(m, a.query) {
			out = append(out, m)
		}
	}
	return out
}

func (a *app) newMessageCount() int {
	if !a.store.Settings().MessagesEnabled {
		return 0
	}
	n := 0
	for _, m := range a.messages {
		if m.Status == "new" {
			n++
		}
	}
	return n
}

// contentTabs：笔记 · 消息 · 秘文（按功能开关出现，同 Tauri ContentTabs），返回当前子视图。
func (a *app) contentTabs(c *ui.Context, k tokens) int {
	st := a.store.Settings()
	subs := []int{subNotes}
	labels := []string{"笔记"}
	if st.MessagesEnabled {
		subs, labels = append(subs, subMessages), append(labels, "消息")
	}
	if st.SecretEnabled {
		subs, labels = append(subs, subSecret), append(labels, "秘文")
	}
	if !slices.Contains(subs, a.noteSub) {
		a.noteSub = subNotes
	}
	if len(subs) > 1 {
		badges := make([]int, len(subs))
		if i := slices.Index(subs, subMessages); i >= 0 {
			badges[i] = a.newMessageCount()
		}
		if i, ok := a.textTabsBadged(c, k, labels, badges, slices.Index(subs, a.noteSub), nil); ok {
			a.noteSub = subs[i]
			a.chosen.Clear()
			a.clearMsgChosen()
		}
	}
	return a.noteSub
}

func (a *app) clearMsgChosen() { a.msgChosen, a.msgAnchor = map[string]bool{}, "" }

func (a *app) msgChosenIn(view []store.Message) []store.Message {
	var out []store.Message
	for _, m := range view {
		if a.msgChosen[m.ID] {
			out = append(out, m)
		}
	}
	return out
}

func (a *app) messagesPage(c *ui.Context, k tokens) {
	if a.msgFilter == "" {
		a.msgFilter = "new"
	}
	if a.msgChosen == nil {
		a.clearMsgChosen()
	}
	view := a.visibleMessages()
	chosen := a.msgChosenIn(view)
	ui.Row(c).Height(30).Padding(0, 12).Gap(4).AlignItems(ui.Center).Children(func() {
		if len(chosen) > 0 { // 选择态整行接管：批量条与筛选栏互斥（并排在 380 宽内会把筛选挤到换行）
			a.msgBulkBar(c, k, chosen)
			return
		}
		counts := map[string]int{}
		for _, m := range a.messages {
			for _, f := range msgFilters {
				if msgInFilter(m, f.value) {
					counts[f.value]++
				}
			}
		}
		for _, f := range msgFilters {
			on := a.msgFilter == f.value
			b := ui.Row(c).Height(24).Padding(0, 8).Gap(4).Radius(6).AlignItems(ui.Center).Key("mf-" + f.value).Role(ui.RoleTab).Label(tr(f.label))
			if on {
				b.Background(k.track)
			} else if b.Hovered() {
				b.Background(k.hoverBg)
			}
			b.Children(func() {
				w, col := 400, k.muted
				if on {
					w, col = 600, k.fg
				}
				text(c, tr(f.label), 11, 16, w, col)
				if n := counts[f.value]; n > 0 {
					text(c, itoa(n), 10, 14, 500, k.muted).FontFeatures("tnum")
				}
			})
			if b.Clicked() && !on {
				a.msgFilter = f.value
				a.clearMsgChosen()
			}
		}
		ui.Spacer(c)
		if a.msgFilter == "done" && counts["done"] > 0 && a.iconButton(c, k, "trash-2", 22, 13, tr("清空已处理")) {
			a.clearDoneMessages()
		}
	})
	fi := slices.IndexFunc(msgFilters, func(f struct{ value, label string }) bool { return f.value == a.msgFilter })
	swapKey, swap := "msg-list-"+itoa(fi), a.swapTransition("msg-list", fi)
	rules := map[string]string{}
	for _, r := range a.store.Settings().MessageRules {
		rules[r.ID] = r.Name
	}
	if a.hbar() { // 横栏（同 Tauri MessagePage horizontal）：消息卡改横排瓷砖串
		empty := map[string]string{"new": tr("没有待处理消息"), "waiting": tr("没有等待回复的消息"), "done": tr("还没有已处理消息")}[a.msgFilter]
		if q := strings.TrimSpace(a.query); q != "" {
			empty = fmt.Sprintf(tr("没有匹配「%s」的消息"), q)
		}
		a.strip(c, k, swapKey, &a.bar.msgs, len(view), -1, nil, "", empty, func(i int, h float32) {
			ui.Scroll(c).Width(h*16/17*1.25).FillHeight().Scrollbars(false).Key("msgtile-" + view[i].ID).Children(func() {
				a.messageCard(c, k, view[i], view, reasonLabels(view[i], rules))
			})
		})
		return
	}
	ui.Column(c).Grow(1).Key(swapKey).Transition(swap).Children(func() {
		ui.Scroll(c).Grow(1).Scrollbars(false).Children(func() {
			ui.Column(c).Padding(4, 12, 12, 12).Gap(8).Children(func() {
				if len(view) == 0 {
					title := map[string]string{"new": tr("没有待处理消息"), "waiting": tr("没有等待回复的消息"), "done": tr("还没有已处理消息")}[a.msgFilter]
					if strings.TrimSpace(a.query) != "" {
						title = fmt.Sprintf(tr("没有匹配「%s」的消息"), strings.TrimSpace(a.query))
					}
					hint := ""
					if len(a.messages) == 0 {
						hint = tr("开启只读监听后，@你、关注的人或组合规则命中的群消息会出现在这里。")
					}
					a.emptyState(c, k, "messages-square", title, hint)
					return
				}
				for _, m := range view {
					a.messageCard(c, k, m, view, reasonLabels(m, rules))
				}
			})
		})
	})
}

func reasonLabels(m store.Message, rules map[string]string) []string {
	var out []string
	if m.MentionedSelf {
		out = append(out, tr("@我"))
	}
	if m.FollowedSender {
		out = append(out, tr("特别关注"))
	}
	for _, id := range m.MatchedRuleIDs {
		out = append(out, cmpOr(rules[id], tr("组合规则")))
	}
	return out
}

func (a *app) msgBulkBar(c *ui.Context, k tokens, chosen []store.Message) {
	s := stok(c)
	ids := make([]string, len(chosen))
	for i, m := range chosen {
		ids[i] = m.ID
	}
	text(c, fmt.Sprintf(tr("已选 %d"), len(chosen)), 11, 16, 600, k.fg).FontFeatures("tnum")
	ui.Spacer(c)
	if a.msgFilter == "done" {
		if button(c, s, "恢复") {
			a.store.SetMessagesStatus(ids, "new")
			a.clearMsgChosen()
			a.showHUDUndo("ok", fmt.Sprintf(tr("已恢复 %d 条为待处理"), len(ids)), func() { a.store.SetMessagesStatus(ids, "done") })
		}
	} else if button(c, s, "已处理") {
		prev := a.msgFilter
		a.store.SetMessagesStatus(ids, "done")
		a.clearMsgChosen()
		a.showHUDUndo("ok", fmt.Sprintf(tr("已处理 %d 条消息"), len(ids)), func() { a.store.SetMessagesStatus(ids, prev) })
	}
	if a.iconButton(c, k, "trash-2", 22, 13, tr("删除所选消息")) {
		removed := a.store.RemoveMessages(ids)
		a.clearMsgChosen()
		a.showHUDUndo("ok", fmt.Sprintf(tr("已删除 %d 条消息"), len(removed)), func() { a.store.RestoreMessages(removed) })
	}
	if a.iconButton(c, k, "x", 22, 13, tr("取消选择")) {
		a.clearMsgChosen()
	}
}

func (a *app) clearDoneMessages() {
	var ids []string
	for _, m := range a.messages {
		if m.Done() {
			ids = append(ids, m.ID)
		}
	}
	if len(ids) == 0 {
		return
	}
	removed := a.store.RemoveMessages(ids)
	a.showHUDUndo("ok", fmt.Sprintf(tr("已清空 %d 条已处理消息"), len(removed)), func() { a.store.RestoreMessages(removed) })
}

// msgClick：点卡选择（同 Tauri handleCardClick）——⇧ 范围并入、⌘ 切换、单选再点取消。
func (a *app) msgClick(id string, mods ui.Modifiers, view []store.Message) {
	if mods&ui.Shift != 0 && a.msgAnchor != "" && a.msgAnchor != id {
		from := slices.IndexFunc(view, func(m store.Message) bool { return m.ID == a.msgAnchor })
		to := slices.IndexFunc(view, func(m store.Message) bool { return m.ID == id })
		if from >= 0 && to >= 0 {
			for i := min(from, to); i <= max(from, to); i++ {
				a.msgChosen[view[i].ID] = true
			}
			return
		}
	}
	a.msgAnchor = id
	if mods&ui.Cmd != 0 {
		if a.msgChosen[id] {
			delete(a.msgChosen, id)
		} else {
			a.msgChosen[id] = true
		}
		return
	}
	if len(a.msgChosen) == 1 && a.msgChosen[id] {
		a.msgChosen = map[string]bool{}
		return
	}
	a.msgChosen = map[string]bool{id: true}
}

func (a *app) messageCard(c *ui.Context, k tokens, m store.Message, view []store.Message, reasons []string) {
	body := m.Text
	if body == "" {
		body = "[" + cmpOr(m.MessageType, tr("非文本消息")) + "]"
	}
	sender := cmpOr(cmpOr(m.SenderName, m.SenderUID), tr("未知发送者"))
	conv := cmpOr(m.ConversationName, m.ConversationID)
	checked := a.msgChosen[m.ID]
	box := ui.Column(c).Padding(10, 12).Radius(12).Background(k.card).Key("msg-" + m.ID).Label(sender)
	hovered := box.Hovered()
	elevated(box, k, hovered || checked)
	if box.Clicked() {
		a.msgClick(m.ID, box.ClickModifiers(), view)
	}
	box.ContextMenu(func(menu *ui.Menu) { a.messageMenu(menu, m) })
	box.Children(func() {
		ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
			text(c, sender, 13, 18, 600, k.fg).SingleLine().Shrink(1)
			for _, r := range reasons {
				col := k.muted
				if r == tr("@我") || r == tr("特别关注") { // 个人触达信号比规则命中更值得一眼看到
					col = k.fg
				}
				text(c, r, 10, 14, 500, col).SingleLine().MaxWidth(112).Padding(1, 4).Radius(4).Background(k.track)
			}
			ui.Spacer(c)
			text(c, msgTime(m.At(), a.now()), 10, 14, 400, k.muted).FontFeatures("tnum")
		})
		if (conv != "" && conv != sender) || m.LinkedTaskID != "" {
			ui.Row(c).Margin(1, 0, 0, 0).Gap(8).AlignItems(ui.Center).Children(func() {
				if conv != sender {
					text(c, conv, 10, 14, 400, k.muted).SingleLine().Grow(1).Basis(0)
				} else {
					ui.Spacer(c)
				}
				if m.LinkedTaskID != "" {
					text(c, tr("已转任务"), 10, 14, 400, k.muted)
				}
			})
		}
		open := a.msgOpen["x:"+m.ID]
		// 正文不设可选中：mygo 的可选文字会吃掉点击，整卡点选（Tauri 的主交互）就失效了；前文与草稿仍可选中复制
		t := text(c, body, 12, 19.5, 400, k.fg).Wrap().Margin(6, 0, 0, 0)
		if !open {
			t.MaxLines(4)
		}
		if utf8.RuneCountInString(body) > 120 {
			l := fmt.Sprintf(tr("展开全文 · %d 字"), utf8.RuneCountInString(body))
			if open {
				l = tr("收起全文")
			}
			if a.textLink(c, k, "mx-"+m.ID, l) {
				a.msgOpen["x:"+m.ID] = !open
			}
		}
		if len(m.Context) > 0 {
			ctxOpen := a.msgOpen["c:"+m.ID]
			arrow := "chevron-right"
			if ctxOpen {
				arrow = "chevron-down"
			}
			row := ui.Row(c).Margin(6, 0, 0, 0).Gap(4).AlignItems(ui.Center).Key("mc-" + m.ID).Role(ui.RoleButton).Label(tr("前文"))
			rc := k.muted
			if row.Hovered() {
				rc = k.fg
			}
			row.Children(func() {
				licon(c, arrow, 12, rc)
				text(c, fmt.Sprintf(tr("前文 · %d"), len(m.Context)), 11, 16, 400, rc)
			})
			if row.Clicked() {
				a.msgOpen["c:"+m.ID] = !ctxOpen
			}
			if ctxOpen {
				ui.Column(c).Margin(6, 0, 0, 0).Padding(8).Gap(6).Radius(8).Background(k.track).Children(func() {
					for _, x := range m.Context {
						who := cmpOr(cmpOr(x.SenderName, x.SenderUID), tr("未知发送者"))
						what := cmpOr(x.Text, "["+cmpOr(x.MessageType, tr("非文本消息"))+"]")
						ui.Row(c).Gap(0).AlignItems(ui.Start).Children(func() {
							text(c, who, 11, 17, 500, k.fg)
							text(c, "："+what, 11, 17, 400, k.muted).Wrap().Selectable().Grow(1).Basis(0)
						})
					}
					text(c, tr("仅来自捕获时客户端内存，不会补拉历史或改变已读。"), 10, 14, 400, k.muted).Wrap()
				})
			}
		}
		if m.AIDraft != "" {
			ui.Column(c).Margin(8, 0, 0, 0).Padding(8).Gap(4).Radius(8).Background(k.track).Children(func() {
				ui.Row(c).Gap(4).AlignItems(ui.Center).Children(func() {
					licon(c, "sparkles", 12, k.muted)
					text(c, tr("AI 草稿"), 10, 14, 500, k.muted)
				})
				text(c, m.AIDraft, 12, 19.5, 400, k.fg).Wrap().Selectable()
				ui.Row(c).Gap(8).Children(func() {
					if a.textLink(c, k, "mdc-"+m.ID, tr("复制")) {
						mygo.Clipboard.WriteText(m.AIDraft)
						a.showHUD("ok", tr("草稿已复制"))
					}
					if a.textLink(c, k, "mdn-"+m.ID, tr("存为笔记")) {
						_, _, _ = a.store.Add(store.Note{Section: store.SectionInbox, Text: m.AIDraft, SourceApp: m.SourceApp, BundleID: m.SourceBundle})
						a.showHUD("ok", tr("草稿已保存为笔记"))
					}
				})
			})
		}
		if checked {
			ui.Box(c).Absolute().Top(0).Left(0).Right(0).Bottom(0).Radius(12).PassThrough().
				InsetShadow(0, 0, 8, 1, k.selRim).InsetShadow(0, 0, 24, 2, k.selHalo)
		}
		if hovered || a.msgDraftBusy == m.ID {
			a.messageActions(c, k, m)
		}
	})
}

// textLink：灰色文字按钮（悬停变前景色）。
func (a *app) textLink(c *ui.Context, k tokens, key, label string) bool {
	b := ui.Box(c).Margin(4, 0, 0, 0).Key(key).Role(ui.RoleButton).Label(label)
	col := k.muted
	if b.Hovered() {
		col = k.fg
	}
	b.Children(func() { text(c, label, 11, 16, 400, col) })
	return b.Clicked()
}

func msgTime(ms int64, now time.Time) string {
	t := time.UnixMilli(ms)
	if sameDay(t, now) {
		return t.Format("15:04")
	}
	return fmt.Sprintf("%d/%d %s", int(t.Month()), t.Day(), t.Format("15:04"))
}

// messageActions：悬停浮钮（同 Tauri 卡面右下）。
func (a *app) messageActions(c *ui.Context, k tokens, m store.Message) {
	done := m.Done()
	fade := ui.ElementTransition{Duration: 100 * time.Millisecond, Ease: easeTw, Enter: &ui.Motion{}, Exit: &ui.Motion{}}
	ui.Row(c).Absolute().Right(6).Bottom(6).Gap(2).Key("macts").Transition(fade).Children(func() {
		btn := func(icon, tip string) ui.Element {
			return floatIconButton(c, k, "ma-"+icon, icon, tip, icon == "trash-2", false)
		}
		if strings.TrimSpace(m.Text) != "" && btn("send", tr("发送到对话")).Clicked() {
			a.send([]store.Note{{ID: m.ID, Text: m.Text}})
		}
		if done {
			if btn("rotate-ccw", tr("恢复为待处理")).Clicked() {
				a.store.SetMessagesStatus([]string{m.ID}, "new")
				a.showHUD("ok", tr("已恢复为待处理"))
			}
		} else if btn("check", tr("标记已处理")).Clicked() {
			prev := m.Status
			a.store.SetMessagesStatus([]string{m.ID}, "done")
			a.showHUDUndo("ok", tr("已标记处理"), func() { a.store.SetMessagesStatus([]string{m.ID}, prev) })
		}
		btn("alarm-clock", tr("提醒我")).Menu(func(menu *ui.Menu) {
			a.presetMenu(menu, func(at time.Time) { a.messageToTask(m, "reminder", at) })
		})
		if btn("crosshair", tr("定位原会话")).Clicked() {
			a.locateMessage(m)
		}
		btn("ellipsis", tr("更多消息操作")).Menu(func(menu *ui.Menu) {
			if m.Status != "waiting" && menu.Item(tr("等待回复")).Chosen() {
				a.messageToTask(m, "waiting", time.Time{})
			}
			if menu.Item(tr("转为任务")).Chosen() {
				a.messageToTask(m, "task", time.Time{})
			}
			label := tr("生成 AI 回复草稿")
			if a.msgDraftBusy == m.ID {
				label = tr("AI 草稿生成中…")
			}
			if menu.Item(label).Disabled(a.msgDraftBusy != "").Chosen() {
				a.draftReply(m)
			}
			if done {
				menu.Separator()
				if menu.Item(tr("删除消息")).Chosen() {
					removed := a.store.RemoveMessages([]string{m.ID})
					a.showHUDUndo("ok", tr("已删除这条消息"), func() { a.store.RestoreMessages(removed) })
				}
			}
		})
	})
}

func (a *app) messageToTask(m store.Message, mode string, due time.Time) {
	switch res, _ := a.store.MessageToTask(m.ID, mode, due); res {
	case "existing":
		a.showHUD("warn", tr("这条消息已经关联任务"))
	case "added":
		msg := map[string]string{"waiting": tr("已加入等待回复"), "reminder": tr("已创建提醒"), "task": tr("已转为任务")}[mode]
		a.showHUD("ok", msg)
	}
}

const msgDraftSystem = "你是工作沟通回复助手。基于用户给出的有限上下文，写一条简洁、可编辑的中文回复草稿。不得编造事实；信息不足时用澄清问题。只输出草稿，不要解释。"
const msgDraftSystemEn = "You help reply to work messages. Based on the limited context the user gives, write one concise, editable reply draft in English. Do not invent facts; when information is missing, ask a clarifying question. Output only the draft, no explanation."

// msgDraftInput 同 Tauri aiInput：群、发送者、捕获时已加载的前文、要回复的消息。
func msgDraftInput(m store.Message, en bool) string {
	unknown, none, nonText := "未知发送者", "（没有可用前文；不要自行补造背景）", "非文本消息"
	if en {
		unknown, none, nonText = "Unknown sender", "(No earlier messages available; do not make up background.)", "non-text message"
	}
	sep := "："
	if en {
		sep = ": "
	}
	var ctx []string
	for _, x := range m.Context {
		ctx = append(ctx, cmpOr(cmpOr(x.SenderName, x.SenderUID), unknown)+sep+cmpOr(x.Text, "["+cmpOr(x.MessageType, nonText)+"]"))
	}
	context := none
	if len(ctx) > 0 {
		context = strings.Join(ctx, "\n")
	}
	body := cmpOr(m.Text, "["+cmpOr(m.MessageType, nonText)+"]")
	conv := cmpOr(m.ConversationName, m.ConversationID)
	if en {
		return fmt.Sprintf("Group: %s\nSender: %s\n\nEarlier messages loaded at capture:\n%s\n\nMessage to reply to:\n%s", conv, cmpOr(cmpOr(m.SenderName, m.SenderUID), "Unknown"), context, body)
	}
	return fmt.Sprintf("群：%s\n发送者：%s\n\n捕获时已加载的前文：\n%s\n\n需要回复的消息：\n%s", conv, cmpOr(cmpOr(m.SenderName, m.SenderUID), "未知"), context, body)
}

var msgAIRewrite = ai.Rewrite // 测试替换

func (a *app) draftReply(m store.Message) {
	if a.msgDraftBusy != "" {
		return
	}
	a.msgDraftBusy = m.ID
	cfg, en := a.aiConfig(), langEN.Load()
	sys := msgDraftSystem
	if en {
		sys = msgDraftSystemEn
	}
	go func() {
		out, err := msgAIRewrite(context.Background(), cfg, sys, msgDraftInput(m, en))
		diag.Push("AI: 消息回复草稿 %d 字 err=%v", utf8.RuneCountInString(out), err != nil)
		a.panelUpdate(func() {
			a.msgDraftBusy = ""
			if err != nil {
				a.aiFailed(err)
				return
			}
			a.store.SaveMessageDraft(m.ID, out)
			a.showHUD("ok", tr("回复草稿已生成；不会自动发送到IM"))
		})
	}()
}

func init() {
	for zh, e := range map[string]string{
		"消息": "Messages", "待处理": "To do", "等待回复": "Awaiting reply", "已处理": "Done", "恢复": "Restore",
		"没有待处理消息": "No messages to handle", "没有等待回复的消息": "No messages awaiting reply", "还没有已处理消息": "No handled messages yet",
		"没有匹配「%s」的消息": "No messages match “%s”", "开启只读监听后，@你、关注的人或组合规则命中的群消息会出现在这里。": "Once read-only watching is on, group messages that @you, come from people you follow, or match your rules show up here.",
		"@我": "@me", "特别关注": "Following", "组合规则": "Rule", "已选 %d": "%d selected", "删除所选消息": "Delete selected messages", "取消选择": "Clear selection",
		"已恢复 %d 条为待处理": "Restored %d to to-do", "已处理 %d 条消息": "Handled %d messages", "已删除 %d 条消息": "Deleted %d messages",
		"清空已处理": "Clear handled", "已清空 %d 条已处理消息": "Cleared %d handled messages", "未知发送者": "Unknown sender", "非文本消息": "Non-text message",
		"已转任务": "Linked to task", "展开全文 · %d 字": "Show all · %d chars", "收起全文": "Show less", "前文": "Earlier", "前文 · %d": "Earlier · %d",
		"仅来自捕获时客户端内存，不会补拉历史或改变已读。": "Only from client memory at capture; never fetches history or changes read state.",
		"AI 草稿": "AI draft", "复制": "Copy", "存为笔记": "Save as note", "草稿已复制": "Draft copied", "草稿已保存为笔记": "Draft saved as note",
		"发送到对话": "Send to chat", "恢复为待处理": "Restore to to-do", "已恢复为待处理": "Restored to to-do", "标记已处理": "Mark handled", "已标记处理": "Marked handled",
		"提醒我": "Remind me", "定位原会话": "Locate conversation", "更多消息操作": "More actions", "转为任务": "Convert to task",
		"生成 AI 回复草稿": "Draft AI reply", "AI 草稿生成中…": "Drafting…", "删除消息": "Delete message", "已删除这条消息": "Message deleted",
		"这条消息已经关联任务": "This message already has a task", "已加入等待回复": "Added to awaiting reply", "已创建提醒": "Reminder created", "已转为任务": "Converted to task",
		"回复草稿已生成；不会自动发送到IM": "Reply draft ready; it won't be sent automatically", "已捕获IM关注消息": "Captured a watched IM message",
		"消息监听（实验）": "Message watch (experimental)", "只读监听 IM 群消息，在「内容 → 消息」里处理、转任务": "Read-only watch of IM group messages; handle them or turn them into tasks under Content → Messages",
		"消息监听": "Message watch", "监听目标": "Watch target", "接入方式（二选一）": "Connection (pick one)", "收哪些消息": "Which messages", "数据存储": "Storage",
		"先选择要监听的 IM": "Pick the IM to watch first", "探测正在运行的应用，选中要监听的那个。": "Detect running apps and pick the one to watch.",
		"自动接入（实验功能）": "Auto connect (experimental)", "手动模式（备选）": "Manual mode (fallback)", "安装 DevTools 只读桥": "Install DevTools read-only bridge",
		"未开启": "Off", "已自动接入": "Auto-connected", "正在接入…": "Connecting…", "手动桥已连接": "Manual bridge connected", "等待粘贴脚本": "Waiting for the script",
		"添加规则": "Add rule", "新规则": "New rule", "保存规则": "Save rule",
	} {
		if _, ok := en[zh]; !ok {
			en[zh] = e
		}
	}
}

// messageMenu：卡片右键菜单，与悬停浮钮同一组操作（悬停浮钮只露常用的，右键全列）。
func (a *app) messageMenu(menu *ui.Menu, m store.Message) {
	if strings.TrimSpace(m.Text) != "" {
		if menu.Item(tr("发送到对话")).Chosen() {
			a.send([]store.Note{{ID: m.ID, Text: m.Text}})
		}
		if menu.Item(tr("复制正文")).Chosen() {
			a.copyPrivate(m.Text)
			a.showHUD("ok", tr("已复制"))
		}
		menu.Separator()
	}
	if m.Done() {
		if menu.Item(tr("恢复为待处理")).Chosen() {
			a.store.SetMessagesStatus([]string{m.ID}, "new")
			a.showHUD("ok", tr("已恢复为待处理"))
		}
	} else if menu.Item(tr("标记已处理")).Chosen() {
		prev := m.Status
		a.store.SetMessagesStatus([]string{m.ID}, "done")
		a.showHUDUndo("ok", tr("已标记处理"), func() { a.store.SetMessagesStatus([]string{m.ID}, prev) })
	}
	menu.Submenu(tr("提醒我"), func(sm *ui.Menu) {
		a.presetMenu(sm, func(at time.Time) { a.messageToTask(m, "reminder", at) })
	})
	if m.Status != "waiting" && menu.Item(tr("等待回复")).Chosen() {
		a.messageToTask(m, "waiting", time.Time{})
	}
	if menu.Item(tr("转为任务")).Chosen() {
		a.messageToTask(m, "task", time.Time{})
	}
	if menu.Item(tr("定位原会话")).Chosen() {
		a.locateMessage(m)
	}
	label := tr("生成 AI 回复草稿")
	if a.msgDraftBusy == m.ID {
		label = tr("AI 草稿生成中…")
	}
	if menu.Item(label).Disabled(a.msgDraftBusy != "").Chosen() {
		a.draftReply(m)
	}
	if m.Status == "done" { // 同 Tauri：只有已处理的消息能删
		menu.Separator()
	}
	if m.Status == "done" && menu.Item(tr("删除消息")).Chosen() {
		removed := a.store.RemoveMessages([]string{m.ID})
		a.showHUDUndo("ok", tr("已删除这条消息"), func() { a.store.RestoreMessages(removed) })
	}
}
