package main

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"slices"
	"strings"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/diag"
	"github.com/toskr/native/internal/imwatch"
	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// IM 消息监听（同 Tauri message_watch.rs / message_watch_cdp.rs / SettingsView MessageWatchSection）：
// 会话级开关，重启即关；只读桥脚本在 IM 里判定 @我 / 特别关注 / 组合规则，消息先进加密账本再进「内容 → 消息」。
// 两种接入二选一：手动（本机回环接收端 + 复制脚本到 IM 的 DevTools Console）或自动（以调试端口重启 IM，经 CDP 注入）。

type imCtl struct {
	bridge     *imwatch.Bridge
	mode       string // "" | http | cdp
	busy       bool
	cancel     context.CancelFunc
	cmd        *exec.Cmd
	lastErr    string
	candidates []macos.AppInfo
	detecting  bool
	formOpen   bool
	form       [4]string // 规则名、群、发送者、关键词
	ticking    bool
	stopping   bool // 正在关闭自动接入（结束调试进程、重开 IM）
}

// redrawSettings：后台结果经 panelUpdate 回到主线程只重绘面板，设置窗要单独刷新。
func (a *app) redrawSettings() {
	if a.settingsWin != nil {
		a.settingsWin.Invalidate()
	}
}

var ( // 测试替换
	imRegularApps = macos.RegularApps
	imStartAuto   = startIMAuto
	imStopAuto    = stopIMAuto
)

func (a *app) imBridge() *imwatch.Bridge {
	if a.im.bridge == nil {
		seal, open := a.store.IMLedgerCodec()
		b := imwatch.New(a.store.Dir(), seal, open)
		b.SaveImage, b.OnProbe = a.imSaveImage, imProbe
		b.OnMsg = func(m imwatch.Message) {
			r := imwatch.Record{ReceivedAtMs: time.Now().UnixMilli(), Message: m}
			a.panelUpdate(func() {
				if a.ingestIM([]imwatch.Record{r}, false) > 0 {
					a.showHUD("added", tr("已捕获IM关注消息"))
				}
			})
		}
		a.im.bridge = b
	}
	return a.im.bridge
}

// imToStore：来源应用取用户确认的监听目标（桥脚本本身不带品牌信息）。
func imToStore(r imwatch.Record, p *store.IMProfile) store.Message {
	m := r.Message
	out := store.Message{ConversationID: m.ConversationID, MessageID: m.MessageID, ConversationName: m.ConversationName,
		SenderUID: m.SenderUID, SenderName: m.SenderName, OccurredAtMs: m.OccurredAtMs, ReceivedAtMs: cmpOrInt(r.ReceivedAtMs, m.CapturedAtMs),
		MentionedSelf: m.MentionedSelf, FollowedSender: m.FollowedSender, MatchedRuleIDs: m.MatchedRuleIDs,
		MessageType: m.MessageType, Text: m.Text}
	out.Images = imageFiles(m.Images)
	for _, c := range m.Context {
		out.Context = append(out.Context, store.MessageContext{MessageID: c.MessageID, SenderUID: c.SenderUID, SenderName: c.SenderName,
			OccurredAtMs: c.OccurredAtMs, MessageType: c.MessageType, Text: c.Text, Images: imageFiles(c.Images)})
	}
	if p != nil {
		out.SourceApp, out.SourceBundle = p.AppName, p.BundleID
	}
	return out
}

func cmpOrInt(a, b int64) int64 {
	if a > 0 {
		return a
	}
	return b
}

// ingestIM 收进消息投影，返回新增条数。
func (a *app) ingestIM(rs []imwatch.Record, replay bool) int {
	p := a.store.Settings().IMProfile
	ms := make([]store.Message, 0, len(rs))
	for _, r := range rs {
		ms = append(ms, imToStore(r, p))
	}
	added, _ := a.store.IngestMessages(ms, replay)
	return added
}

// replayIMLedger：启动时从账本恢复投影（只读本地文件，不连接 IM）。
func (a *app) replayIMLedger() {
	if !a.store.Settings().MessagesEnabled {
		return
	}
	b := a.imBridge()
	go func() {
		rs, err := b.Recent(1000)
		if err != nil {
			diag.Push("IM 账本读取失败: %v", err)
			return
		}
		if len(rs) == 0 {
			return
		}
		a.panelUpdate(func() { diag.Push("IM 账本重放 %d 条，新增 %d", len(rs), a.ingestIM(rs, true)) })
	}()
}

func imRules(rs []store.MessageRule) []imwatch.Rule {
	out := []imwatch.Rule{}
	for _, r := range rs {
		out = append(out, imwatch.Rule{ID: r.ID, Name: r.Name, Enabled: r.Enabled, GroupTerms: r.GroupTerms, SenderTerms: r.SenderTerms, Keywords: r.Keywords})
	}
	return out
}

func (a *app) setIMManual(on bool) {
	b := a.imBridge()
	if !on {
		b.Stop()
		a.im.mode = ""
		a.showHUD("info", tr("手动监听已关闭"))
		return
	}
	if _, err := b.Start(); err != nil {
		a.showHUD("warn", fmt.Sprintf(tr("切换失败：%s"), truncateRunes(err.Error(), 100)))
		return
	}
	a.im.mode = "http"
	a.showHUD("ok", tr("本地接收端已开启；请复制并手动粘贴脚本"))
}

func (a *app) copyIMScript() {
	st := a.imBridge().Status()
	if !st.Enabled {
		return
	}
	mygo.Clipboard.WriteText(imwatch.Script(st.Endpoint, "http", st.StartedAtMs, imRules(a.store.Settings().MessageRules)))
	a.showHUD("ok", tr("只读桥脚本已复制；请在 IM 软件 DevTools 的 Console 里手动粘贴执行"))
}

func (a *app) setIMAuto(on bool) {
	if a.im.busy {
		return
	}
	p := a.store.Settings().IMProfile
	if on && p == nil {
		a.detectIM()
		return
	}
	a.im.busy = true
	if !on {
		cancel, cmd, prof := a.im.cancel, a.im.cmd, *p
		a.im.mode, a.im.cancel, a.im.cmd, a.im.stopping = "", nil, nil, true
		a.showHUD("info", tr("已关闭自动接入，正在恢复 IM 软件正常启动"))
		go func() {
			imStopAuto(cancel, cmd, prof.BundleID)
			a.panelUpdate(func() { a.im.busy, a.im.stopping = false, false; a.redrawSettings() })
		}()
		return
	}
	prof, rules, b := *p, imRules(a.store.Settings().MessageRules), a.imBridge()
	a.showHUD("ok", tr("正在以调试模式重启 IM 软件并自动注入…约 10 秒内完成"))
	go func() {
		cancel, cmd, err := imStartAuto(b, prof, rules, func(err error) {
			a.panelUpdate(func() { a.im.lastErr = err.Error(); a.redrawSettings() })
		})
		a.panelUpdate(func() {
			a.im.busy = false
			defer a.redrawSettings()
			if err != nil {
				a.im.lastErr = err.Error()
				a.showHUD("warn", fmt.Sprintf(tr("切换失败：%s"), truncateRunes(err.Error(), 100)))
				return
			}
			a.im.mode, a.im.cancel, a.im.cmd, a.im.lastErr = "cdp", cancel, cmd, ""
		})
	}()
}

// startIMAuto：让正在运行的 IM 优雅退出 → 以调试端口直起主二进制 → CDP 注入桥脚本（后台持续收消息）。
func startIMAuto(b *imwatch.Bridge, p store.IMProfile, rules []imwatch.Rule, onErr func(error)) (context.CancelFunc, *exec.Cmd, error) {
	prof := imwatch.Profile{BundleID: p.BundleID, BinPath: p.BinPath}
	if err := prof.Validate(); err != nil {
		return nil, nil, err
	}
	for _, pid := range macos.RunningPIDs(p.BundleID) {
		macos.Terminate(pid)
	}
	for deadline := time.Now().Add(15 * time.Second); len(macos.RunningPIDs(p.BundleID)) > 0; time.Sleep(300 * time.Millisecond) {
		if time.Now().After(deadline) {
			return nil, nil, errors.New("目标 IM 未退出（可能有未保存的内容），请手动退出后重试")
		}
	}
	ws, cmd, err := imwatch.Launch(prof, 30*time.Second)
	if err != nil {
		return nil, nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	script := imwatch.Script("cdp", "cdp", time.Now().UnixMilli(), rules)
	go func() {
		if err := b.RunCDP(ctx, ws, script); err != nil {
			diag.Push("IM 自动接入中断: %v", err)
			onErr(err)
		}
	}()
	diag.Push("IM 自动接入：已以调试模式启动 %s", p.BundleID)
	return cancel, cmd, nil
}

// stopIMAuto：断开 CDP、结束调试模式的 IM，再按正常方式重新打开它。
func stopIMAuto(cancel context.CancelFunc, cmd *exec.Cmd, bundle string) {
	if cancel != nil {
		cancel()
	}
	if err := imwatch.Terminate(cmd, 8*time.Second); err != nil {
		diag.Push("IM 调试进程退出: %v", err)
	}
	if bundle != "" {
		_ = exec.Command("/usr/bin/open", "-b", bundle).Start()
	}
}

// shutdownIM：关掉监听（自动接入会把 IM 恢复为正常启动）。状态在主线程上清掉，返回真正的收尾动作
// （退出时同步跑，关功能时丢到后台）。
func (a *app) shutdownIM() func() {
	bundle := ""
	if p := a.store.Settings().IMProfile; p != nil {
		bundle = p.BundleID
	}
	b, mode, cancel, cmd := a.im.bridge, a.im.mode, a.im.cancel, a.im.cmd
	a.im.mode, a.im.cancel, a.im.cmd = "", nil, nil
	return func() {
		if b != nil {
			b.Stop()
		}
		if mode == "cdp" {
			imStopAuto(cancel, cmd, bundle)
		}
	}
}

func (a *app) detectIM() {
	if a.im.detecting {
		return
	}
	a.im.detecting = true
	go func() {
		list := imRegularApps()
		a.panelUpdate(func() {
			a.im.detecting, a.im.candidates = false, list
			if len(list) == 0 {
				a.showHUD("warn", tr("未检测到正在运行的应用；请先打开要监听的 IM 再试"))
			}
		})
	}()
}

func (a *app) setIMProfile(p *store.IMProfile) {
	cur := a.store.Settings()
	cur.IMProfile = p
	_ = a.store.SetSettings(cur)
	a.im.candidates = nil
	if p != nil {
		a.showHUD("ok", fmt.Sprintf(tr("已选择监听目标：%s"), p.AppName))
	} else {
		a.showHUD("info", tr("已清除监听目标"))
	}
}

func splitTerms(s string) []string {
	var out []string
	for _, x := range strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == '，' || r == '\n' }) {
		if x = strings.TrimSpace(x); x != "" && !slices.Contains(out, x) {
			out = append(out, x)
		}
	}
	return out
}

// ruleSummary 同 Tauri ruleSummaryText：群名/群号含「…」，且发送者是「…」，且内容含「…」。
func ruleSummary(group, sender, kw []string) string {
	q := func(ts []string) string { return "「" + strings.Join(ts, tr("」或「")) + "」" }
	var parts []string
	if len(group) > 0 {
		parts = append(parts, fmt.Sprintf(tr("群名/群号含%s"), q(group)))
	}
	if len(sender) > 0 {
		parts = append(parts, fmt.Sprintf(tr("发送者是%s"), q(sender)))
	}
	if len(kw) > 0 {
		parts = append(parts, fmt.Sprintf(tr("内容含%s"), q(kw)))
	}
	return strings.Join(parts, tr("，且"))
}

func (a *app) addIMRule() bool {
	f := &a.im.form
	st := a.store.Settings()
	r := store.MessageRule{ID: newRuleID(), Name: strings.TrimSpace(f[0]), Enabled: true, GroupTerms: splitTerms(f[1]), SenderTerms: splitTerms(f[2]), Keywords: splitTerms(f[3])}
	if len(r.GroupTerms)+len(r.SenderTerms)+len(r.Keywords) == 0 {
		a.showHUD("warn", tr("至少填写群、发送者或关键词中的一项"))
		return false
	}
	if r.Name == "" {
		r.Name = fmt.Sprintf(tr("关注规则 %d"), len(st.MessageRules)+1)
	}
	st.MessageRules = store.NormalizeMessageRules(append(slices.Clone(st.MessageRules), r))
	_ = a.store.SetSettings(st)
	*f = [4]string{}
	a.im.formOpen = false
	if a.im.mode != "" {
		a.showHUD("ok", tr("规则已保存；下次重开监听后生效"))
	} else {
		a.showHUD("ok", tr("组合关注规则已保存"))
	}
	return true
}

// growField：占满一行的输入框（textField 是定宽的）。
func growField(c *ui.Context, k tokens, s settingsTokens, v *string, placeholder string) {
	ui.Row(c).Grow(1).Height(32).Padding(0, 8).Radius(rr(10)).Background(s.input).Border(1, s.inputBorder).AlignItems(ui.Center).Children(func() {
		ui.TextInputBase(c, v).Grow(1).Font(fontSans).FontSize(12).FixedLineHeight(17).TextColor(k.fg).PlaceholderColor(k.muted).Placeholder(placeholder)
	})
}

func newRuleID() string { return fmt.Sprintf("rule-%x", time.Now().UnixNano()) }

// messageWatchSections：设置 → 消息监听（功能开启后才出现）。
func (a *app) messageWatchSections(c *ui.Context, k tokens, s settingsTokens, st store.Settings) []setSection {
	if a.im.mode != "" && !a.im.ticking && a.settingsWin != nil { // 运行中每秒刷新状态
		a.im.ticking = true
		time.AfterFunc(time.Second, func() {
			a.settingsWin.Update(func() { a.im.ticking = false })
		})
	}
	intro := setRow{title: tr("实验功能"), hint: tr("只读监听 IM 群消息，不主动打开会话，也不调用已读或发送接口。")}
	var target []setRow
	if p := st.IMProfile; p != nil {
		target = []setRow{{title: fmt.Sprintf(tr("当前目标：%s"), p.AppName), hint: p.BundleID, control: func() {
			if button(c, s, "更换") && a.im.mode == "" {
				a.setIMProfile(nil)
			}
		}}}
	} else {
		target = []setRow{{title: tr("先选择要监听的 IM"), hint: tr("探测正在运行的应用，选中要监听的那个。"), control: func() {
			label := "探测正在运行的应用"
			if a.im.detecting {
				label = "探测中…"
			}
			if button(c, s, label) {
				a.detectIM()
			}
		}, below: func() {
			if len(a.im.candidates) == 0 {
				return
			}
			ui.Column(c).Gap(4).Children(func() {
				for _, cand := range a.im.candidates {
					row := ui.Column(c).Padding(6, 10).Radius(rr(6)).Border(1, s.cardBorder).Key("imc-" + cand.BundleID).Role(ui.RoleButton).Label(cand.Name)
					if row.Hovered() {
						row.Background(k.track)
					}
					row.Children(func() {
						text(c, cand.Name, 11, 16, 500, k.fg)
						text(c, cand.BundleID, 10, 14, 400, k.muted)
					})
					if row.Clicked() {
						a.setIMProfile(&store.IMProfile{AppName: cand.Name, BundleID: cand.BundleID, BinPath: cand.BinPath})
					}
				}
			})
		}}}
	}
	out := []setSection{{title: tr("监听目标"), rows: append([]setRow{intro}, target...)}}
	if st.IMProfile != nil {
		out = append(out, setSection{title: tr("接入方式（二选一）"), rows: a.imTransportRows(c, k, s)})
	}
	out = append(out, setSection{title: tr("收哪些消息"), rows: a.imRuleRows(c, k, s, st)})
	ledger := []setRow{
		{title: tr("原始消息账本"), hint: tr("原始消息完整保存在本机账本（仅当前用户可读），「内容 → 消息」显示整理后的结果。账本不包含在完整备份中，需要长期保留请单独备份。"), control: func() {
			if button(c, s, "复制账本路径") {
				mygo.Clipboard.WriteText(a.imBridge().LedgerPath())
				a.showHUD("ok", tr("原始消息账本路径已复制"))
			}
		}},
	}
	return append(out, setSection{title: tr("数据存储"), rows: ledger})
}

func (a *app) imTransportRows(c *ui.Context, k tokens, s settingsTokens) []setRow {
	mode := a.im.mode
	autoHint := tr("会重启所选 IM，请先保存工作；关闭后自动恢复，失败时需手动处理")
	if mode == "http" {
		autoHint = tr("手动模式运行中；先关闭手动监听再切换")
	}
	manualHint := tr("不重启 IM；开启后复制脚本，粘贴到 IM 开发者工具的 Console 执行")
	if mode == "cdp" {
		manualHint = tr("自动接入运行中；先关闭自动接入再切换")
	}
	rows := []setRow{{title: tr("自动接入（实验功能）"), hint: autoHint, control: func() {
		on := mode == "cdp"
		if toggle(c, s, &on) && mode != "http" {
			a.setIMAuto(on)
		}
	}}}
	if mode != "http" {
		rows = append(rows, setRow{title: tr("调试端口风险"), hint: tr("自动接入期间 IM 会开放一个仅限本机、无需认证的调试端口，本机其他程序理论上可借此读取会话；关闭后会检查调试进程已退出。")})
	}
	rows = append(rows, setRow{title: tr("手动模式（备选）"), hint: manualHint, control: func() {
		on := mode == "http"
		if toggle(c, s, &on) && mode != "cdp" && !a.im.busy {
			a.setIMManual(on)
		}
	}})
	if mode == "http" {
		rows = append(rows, setRow{title: tr("安装 DevTools 只读桥"), hint: tr("IM 刷新或重启后需重新执行；打开开发者工具可能把当前会话标为已读"), control: func() {
			if button(c, s, "复制脚本") {
				a.copyIMScript()
			}
		}})
	}
	st := a.imBridge().Status()
	connected := st.Connected(time.Now().UnixMilli())
	state := tr("未开启")
	switch {
	case mode == "cdp" && connected:
		state = tr("已自动接入")
	case a.im.stopping:
		state = tr("正在断开…")
	case mode == "cdp" || a.im.busy:
		state = tr("正在接入…")
	case mode == "http" && connected:
		state = tr("手动桥已连接")
	case mode == "http":
		state = tr("等待粘贴脚本")
	}
	var meta []string
	if mode != "" {
		state += fmt.Sprintf(tr(" · 已完整落盘 %d 条"), st.Accepted)
	}
	if st.LastAcceptedAtMs > 0 {
		meta = append(meta, tr("最近捕获：")+time.UnixMilli(st.LastAcceptedAtMs).Format("2006/1/2 15:04:05"))
	}
	if e := cmpOr(st.LastError, a.im.lastErr); e != "" {
		meta = append(meta, fmt.Sprintf(tr("最近错误：%s"), e))
	}
	return append(rows, setRow{title: state, hint: strings.Join(meta, "\n"), control: func() {
		col := k.muted.Alpha(0.4)
		switch {
		case connected:
			col = k.ok
		case mode != "":
			col = k.amberBar
		}
		ui.Box(c).Size(6, 6).Radius(3).Background(col)
	}})
}

func (a *app) imRuleRows(c *ui.Context, k tokens, s settingsTokens, st store.Settings) []setRow {
	rows := []setRow{{title: tr("始终收下 @我 和特别关注"), hint: tr("@我 和特别关注的消息始终会收进「内容 → 消息」；下面的规则用来额外盯住特定的群、人或关键词，任一规则命中即收。")}}
	for _, r := range st.MessageRules {
		rows = append(rows, setRow{title: r.Name, hint: fmt.Sprintf(tr("收下 %s 的消息"), ruleSummary(r.GroupTerms, r.SenderTerms, r.Keywords)), control: func() {
			ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
				on := r.Enabled
				if toggle(c, s, &on) {
					cur := a.store.Settings()
					for i := range cur.MessageRules {
						if cur.MessageRules[i].ID == r.ID {
							cur.MessageRules[i].Enabled = on
						}
					}
					_ = a.store.SetSettings(cur)
				}
				if a.iconButton(c, k, "trash-2", 22, 13, fmt.Sprintf(tr("删除%s"), r.Name)) {
					cur := a.store.Settings()
					cur.MessageRules = slices.DeleteFunc(slices.Clone(cur.MessageRules), func(x store.MessageRule) bool { return x.ID == r.ID })
					_ = a.store.SetSettings(cur)
				}
			})
		}})
	}
	if !a.im.formOpen {
		rows = append(rows, setRow{title: tr("额外规则"), hint: fmt.Sprintf(tr("已有 %d 条"), len(st.MessageRules)), control: func() {
			if button(c, s, "添加规则") {
				a.im.formOpen = true
			}
		}})
	} else {
		f := &a.im.form
		preview := ruleSummary(splitTerms(f[1]), splitTerms(f[2]), splitTerms(f[3]))
		hint := tr("至少填一栏。同一栏内多个值任一匹配即可；填了多栏则需同时满足。")
		if preview != "" {
			hint = fmt.Sprintf(tr("将收下 %s 的消息"), preview)
		}
		rows = append(rows, setRow{title: tr("新规则"), hint: hint, below: func() {
			ui.Column(c).Gap(6).Children(func() {
				growField(c, k, s, &f[0], tr("规则名称（可选）"))
				ui.Row(c).Gap(6).Children(func() {
					ui.Column(c).Grow(1).Basis(0).Children(func() { growField(c, k, s, &f[1], tr("群名或群号，逗号分隔")) })
					ui.Column(c).Grow(1).Basis(0).Children(func() { growField(c, k, s, &f[2], tr("发送者或 UID，逗号分隔")) })
				})
				growField(c, k, s, &f[3], tr("关键词，逗号分隔"))
				ui.Row(c).Gap(6).Children(func() {
					if button(c, s, "保存规则") {
						a.addIMRule()
					}
					if button(c, s, "取消") {
						a.im.formOpen = false
					}
				})
			})
		}})
	}
	if a.im.mode != "" {
		rows = append(rows, setRow{title: tr("规则改动下次生效"), hint: tr("监听运行中；为避免无提示重启 IM 软件，规则改动将在下次重开监听时生效。")})
	}
	return rows
}

// setMessagesEnabled：功能开关（同 Tauri 更多功能 → 消息监听）。关闭时停掉监听；打开时从账本恢复投影。
func (a *app) setMessagesEnabled(on bool) {
	cur := a.store.Settings()
	cur.MessagesEnabled = on
	_ = a.store.SetSettings(cur)
	if on {
		a.replayIMLedger()
		return
	}
	if a.im.mode != "" {
		go a.shutdownIM()()
	}
	if a.noteSub == subMessages {
		a.noteSub = subNotes
	}
}

func imageFiles(ims []imwatch.Image) []string {
	var out []string
	for _, im := range ims {
		if im.File != "" {
			out = append(out, im.File)
		}
	}
	return out
}
