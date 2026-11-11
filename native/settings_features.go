package main

import (
	"fmt"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// 设置 → 更多功能（同 Tauri settingsChildSections("features")）：功能开关 · AI 智能 · 到期提醒 · 日历与提醒事项，
// 消息监听 / 秘文默认关闭，开启后才多出对应子页签，不占侧栏一级分类。
func featureSubs(st store.Settings) []string {
	subs := []string{"功能开关", "AI 智能", "到期提醒", "日历与提醒事项"}
	if st.MessagesEnabled {
		subs = append(subs, "消息监听")
	}
	if st.SecretEnabled {
		subs = append(subs, "秘文")
	}
	return subs
}

// featureDomainSections：默认关闭的功能域（消息监听、秘文）开启后才有的子页内容，顺序同 featureSubs。
func featureDomainSections(st store.Settings, messages, secret func() []setSection) [][]setSection {
	var out [][]setSection
	if st.MessagesEnabled {
		out = append(out, messages())
	}
	if st.SecretEnabled {
		out = append(out, secret())
	}
	return out
}

// featureLink：功能行里的「设置 ›」次要入口（文字链，主操作是右侧开关）。
func featureLink(c *ui.Context, k tokens, key string) bool {
	b := ui.Row(c).Height(24).Padding(0, 4, 0, 8).Gap(2).Radius(6).AlignItems(ui.Center).Key("feat-set-" + key).Role(ui.RoleButton).Label(tr("设置") + " " + tr(key))
	col := hoverLink(b, k)
	b.Children(func() {
		text(c, tr("设置"), 11, 16, 500, col).SingleLine()
		licon(c, "chevron-right", 12, col)
	})
	return b.Clicked()
}

// featureSwitches：「功能开关」页（同 Tauri FeaturesSection）——每项一个图标格 + 标题 + 当前状态说明，开启后出现「设置 ›」。
func (a *app) featureSwitches(c *ui.Context, k tokens, s settingsTokens, st store.Settings) setSection {
	row := func(icon, title, badge, offHint, onHint, jump string, on bool, set func(bool)) setRow {
		hint := offHint
		if on {
			hint = onHint
		}
		return setRow{title: tr(title), badge: badge, icon: icon, hint: hint, control: func() {
			ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
				if (on || title == "苹果日历与提醒事项") && featureLink(c, k, title) {
					a.setJump = jump
				}
				v := on
				if toggle(c, s, &v) {
					set(v)
				}
			})
		}}
	}
	apple := st.CalendarOn || st.RemindersOn
	appleHint := tr("在「提醒」页显示日历日程，把任务同步到 iPhone 的提醒事项")
	if apple {
		appleHint = appleSummary(st)
	}
	return setSection{intro: tr("开启后，主面板会出现对应入口。"), rows: []setRow{
		row("crop", "区域截图", "", shotHint(store.Settings{ScreenshotOff: true}), shotHint(store.Settings{}), "快捷键", !st.ScreenshotOff, func(on bool) {
			a.setScreenshotEnabled(on)
			if on && !macos.ScreenCaptureAllowed() {
				a.setJump = "权限" // 未授权屏幕录制：直接带到权限页（同 Tauri）
			}
		}),
		row("messages-square", "消息监听", tr("实验"), tr("只读监听 IM 群消息，在「内容 → 消息」里处理、转任务"), tr("可设置监听应用、接入方式和收集规则"), "消息监听", st.MessagesEnabled, a.setMessagesEnabled),
		row("key-round", "秘文", "", tr("在本机把文字加密成中文、代码、日志等格式，对方自动识别解密"), tr("可管理共享密钥和默认格式"), "秘文", st.SecretEnabled, func(on bool) {
			a.patchSettings(func(x *store.Settings) { x.SecretEnabled = on })
		}),
		row("credit-card", "订阅", "", tr("管理账单与信用卡到期，在「提醒」页按时提醒"), tr("可设置新账单的默认提醒"), "到期提醒", st.SubscriptionsEnabled, func(on bool) {
			a.patchSettings(func(x *store.Settings) { x.SubscriptionsEnabled = on })
		}),
		row("calendar-days", "苹果日历与提醒事项", "", appleHint, appleHint, "日历与提醒事项", apple, func(on bool) {
			// 一个开关管两项（同 Tauri）：打开时两项都开并跳到详情页，依次弹系统授权框
			a.setCalendarEnabled(on)
			a.setRemindersEnabled(on)
			if on {
				a.setJump = "日历与提醒事项"
			}
		}),
	}}
}

// appleSummary：同 Tauri appleIntegrationSummary。
func appleSummary(st store.Settings) string {
	var on []string
	if st.CalendarOn {
		on = append(on, tr("日历"))
	}
	if st.RemindersOn {
		on = append(on, tr("提醒事项"))
	}
	switch len(on) {
	case 0:
		return tr("未开启")
	case 1:
		return fmt.Sprintf(tr("已开启：%s"), on[0])
	}
	return fmt.Sprintf(tr("已开启：%s"), on[0]+" · "+on[1])
}

// pollPermissions：停在权限页时每 2 秒刷新一次（同 Tauri PermissionsSection 的 2s 轮询）；切回设置窗立即刷新（OnFocus 清零 permPolled）。
// 辅助功能 / 输入监控 / 屏幕录制每帧现查，这里只需定时重画；日历 / 提醒事项的授权状态异步重取。
func (a *app) pollPermissions() {
	st := a.store.Settings()
	if time.Since(a.permPolled) >= 2*time.Second {
		a.permPolled = time.Now()
		if st.CalendarOn {
			calAsync(func() {
				v := calStatus()
				a.onMain(func() {
					if v != a.calStatus {
						a.calStatus, a.calendars = v, nil
					}
				})
			})
		}
		if st.RemindersOn {
			calAsync(func() {
				v := remStatus()
				a.onMain(func() { a.rem.statusStr = v })
			})
		}
	}
	if a.permTicking || a.settingsWin == nil {
		return
	}
	a.permTicking = true
	time.AfterFunc(2*time.Second, func() { // 只在本页渲染时续约：离开权限页或窗口不再重画，轮询自然停止
		a.onMain(func() {
			a.permTicking = false
			if a.settingsWin != nil {
				a.settingsWin.Invalidate()
			}
		})
	})
}

// permAsked：本次会话点过「授权」的权限（输入监控 / 屏幕录制授权后要重启才生效，据此提示重启）。
var permAsked = map[string]bool{}

type permItem struct {
	key, label, why, icon, pane string
	restart                     bool // 授权后需重启应用才生效
}

// permissionSections：设置 → 权限（同 Tauri PermissionsSection）：只列当前开启的功能需要的权限，
// 逐项显示是否就绪；未授权点「授权」先弹系统框，没通过再打开对应隐私面板。
func (a *app) permissionSections(c *ui.Context, k tokens, s settingsTokens, st store.Settings) []setSection {
	items := []permItem{
		{"ax", "辅助功能", "读取你选中的文字（双击触发键捕获），并把内容粘贴回目标应用。", "accessibility", "Privacy_Accessibility", false},
		{"listen", "输入监控", "识别双击触发键等全局快捷操作；只判断按键时机，不记录输入内容。", "keyboard", "Privacy_ListenEvent", true},
	}
	if !st.ScreenshotOff {
		items = append(items, permItem{"screen", "屏幕录制", "区域截图、长截屏和图内识别需要读取屏幕画面；画面只在本机处理。", "monitor", "Privacy_ScreenCapture", true})
	}
	if st.CalendarOn {
		items = append(items, permItem{"calendar", "日历", "在「提醒」页显示日历日程，只读。", "calendar-days", "Privacy_Calendars", false})
	}
	if st.RemindersOn {
		items = append(items, permItem{"reminders", "提醒事项", "把任务同步到「提醒事项」，在 iPhone 上也能看到。", "list-checks", "Privacy_Reminders", false})
		if a.rem.statusStr == "" && !a.remStatusAsked {
			a.remStatusAsked = true
			calAsync(func() {
				v := remStatus()
				a.onMain(func() { a.rem.statusStr = v })
			})
		}
	}
	a.axTrusted = macos.AXTrusted(false)
	// granted：是否已授权；known 为假表示还在查询（日历 / 提醒事项异步取状态）
	granted := func(key string) (ok, known bool) {
		switch key {
		case "ax":
			return a.axTrusted, true
		case "listen":
			return macos.ListenAuthorized(), true
		case "screen":
			return screenAllowed(), true
		case "calendar":
			return a.calStatus == "granted", a.calStatus != ""
		case "reminders":
			return a.rem.statusStr == "granted", a.rem.statusStr != ""
		}
		return false, false
	}
	// request：弹系统授权框；未通过时打开对应隐私面板，返回是否已授权
	request := func(it permItem) bool {
		permAsked[it.key] = true
		ok := false
		switch it.key {
		case "ax":
			ok = macos.AXTrusted(true)
			a.axTrusted = ok
		case "listen":
			ok = macos.RequestListen()
		case "screen":
			ok = macos.RequestScreenCapture()
		case "calendar":
			a.setCalendarEnabled(true) // 内部按状态弹框或打开隐私面板
			return false
		case "reminders":
			a.setRemindersEnabled(true)
			return false
		}
		if !ok {
			openPrivacy(it.pane)
		}
		return ok
	}
	var pending []permItem
	restartPending := 0
	for _, it := range items {
		ok, known := granted(it.key)
		if known && !ok {
			pending = append(pending, it)
			if it.restart && permAsked[it.key] {
				restartPending++
			}
		}
	}
	var rows []setRow
	if len(pending) > 1 {
		rows = append(rows, setRow{title: tr("全部授权"), hint: tr("按顺序逐项请求；需要在系统设置里手动打开的项会停下，打开后回到这里再点一次继续"), control: func() {
			if button(c, s, fmt.Sprintf(tr("全部授权（%d 项）"), len(pending))) {
				for _, it := range pending {
					if !request(it) {
						break
					}
				}
			}
		}})
	}
	for _, it := range items {
		ok, known := granted(it.key)
		needRestart := !ok && it.restart && permAsked[it.key]
		hint := tr(it.why)
		var warn []string
		if needRestart {
			warn = append(warn, tr("已在系统设置里允许？重启 Toskr 后生效"))
		}
		if it.key == "listen" && a.tapErr != "" {
			warn = append(warn, tr("键盘监听：")+a.tapErr)
		}
		it := it
		rows = append(rows, setRow{title: tr(it.label), icon: it.icon, hint: hint, below: warnLines(c, k, warn), control: func() {
			ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
				switch {
				case !known:
					text(c, tr("检查中…"), 11, 16, 400, k.muted)
				case needRestart:
					if it.key == "listen" && linkButton(c, k, "perm-reset", tr("重置授权")) {
						a.resetInputMonitoring()
					}
					if button(c, s, "重启 Toskr") {
						a.restartApp()
					}
				case ok:
					grantedPill(c, k, tr("已授权"))
				default:
					if it.key == "listen" && linkButton(c, k, "perm-reset", tr("重置授权")) {
						a.resetInputMonitoring()
					}
					if button(c, s, "授权") {
						request(it)
					}
				}
			})
		}})
	}
	footer, warnFoot := tr("✓ 都已就绪"), false
	switch {
	case len(pending) > 0 && restartPending == len(pending):
		footer, warnFoot = tr("授权后需重启 Toskr 才生效"), true
	case len(pending) > 0:
		footer, warnFoot = fmt.Sprintf(tr("还有 %d 项需要授权"), len(pending)), true
	}
	return []setSection{{
		title: tr("系统权限"), rows: rows, footer: footer, footerWarn: warnFoot,
		intro: tr("Toskr 在这台 Mac 上需要的系统权限。点「授权」会弹出系统授权框或打开对应的系统设置页，在那里允许 Toskr 即可；每一项都可以随时在系统设置里更改，内容只留在你的电脑上。"),
	}}
}

// warnLines：行说明下方的琥珀色提示（需重启、监听失败）；没有提示时返回 nil，不占位。
func warnLines(c *ui.Context, k tokens, lines []string) func() {
	if len(lines) == 0 {
		return nil
	}
	return func() {
		for _, l := range lines {
			ui.Row(c).Gap(4).AlignItems(ui.Center).Children(func() {
				licon(c, "triangle-alert", 12, k.amberText)
				text(c, l, 11, 16, 400, k.amberText).Wrap()
			})
		}
	}
}
