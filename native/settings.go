package main

import (
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/secretcodec"
	"github.com/toskr/native/internal/store"
)

var (
	modifierNames  = []string{"shift", "control", "option"}
	modifierLabels = []string{"⇧ Shift", "⌃ Control", "⌥ Option"}
	glassNames     = []string{"glass", "clear", "none"}
	glassLabels    = []string{"液态玻璃", "清透玻璃", "关闭"}
	langNames      = []string{"system", "zh", "en"}
)

// importPreview 是待确认的备份导入（设置窗主线程读写）。
var importPreview *store.Preview

func (a *app) openSettings() {
	a.openSettingsState()
	if a.settingsWin == nil {
		a.settingsWin = mygo.NewWindow(mygo.WindowOptions{
			Title: "Toskr 设置", Width: 1040, Height: 720, MinWidth: 560, MinHeight: 420, Hidden: true,
			Vibrancy: mygo.VibrancySidebar, Transparent: true,
			Content: ui.View(a.settingsView),
		})
		diagWin.Store(a.settingsWin)                                                                 // 诊断页实时刷新用（diag.Push 可能在任意 goroutine）
		a.settingsWin.OnFocus(func() { a.refreshLocalTranslate(false); a.permPolled = time.Time{} }) // 从系统设置授权回来：权限页立即重查 // 回到窗口时重查（可能刚在系统设置里下完语言包）
		a.settingsWin.OnClose(func(e *mygo.CloseEvent) {
			if !a.quitting { // 退出时放行，否则会取消整个退出
				e.PreventDefault()
				a.settingsWin.Hide()
			}
		})
	}
	a.refreshLocalTranslate(false)
	a.settingsWin.Invalidate()
	a.settingsWin.Show()
	a.settingsWin.Focus()
}

// openSettingsState 把当前设置载入设置窗编辑态（对照测试也用它准备首屏）。
func (a *app) openSettingsState() {
	st := a.store.Settings()
	a.setModifier = max(0, slices.Index(modifierNames, st.TriggerModifier))
	a.setGap = float64(st.TriggerGapMs)
	a.setClip = st.ClipboardWatch
	a.setGlass = max(0, slices.Index(glassNames, st.Glass))
	a.setExcluded = strings.Join(st.ExcludedApps, "\n")
	a.setClipExcluded = strings.Join(st.ClipExcludedApps, "\n")
	a.setRetain = float64(st.ClipRetainDays)
	a.setLang = max(0, slices.Index(langNames, st.Language))
	a.setAIEnd, a.setAIModel, a.setAIKey = st.AIEndpoint, st.AIModel, ""
	a.setCompan = strings.Join(st.Companion, "\n")
	a.axTrusted = macos.AXTrusted(false)
	a.recovery = a.store.RecoveryPoints()
	a.openAtLogin = a.panel != nil && mygo.App.OpenAtLogin() // 无 App 运行（视图测试）时查询会阻塞
}

func lines(s string) []string {
	var out []string
	for _, line := range strings.Split(s, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			out = append(out, line)
		}
	}
	return out
}

func (a *app) saveSettings() {
	st := a.store.Settings()
	st.TriggerModifier = modifierNames[a.setModifier]
	st.TriggerGapMs = int(a.setGap)
	st.ClipboardWatch = a.setClip
	oldGlass := st.Glass
	st.Glass = glassNames[a.setGlass]
	st.ExcludedApps = lines(a.setExcluded)
	st.ClipExcludedApps = lines(a.setClipExcluded)
	if next := int(a.setRetain); next != st.ClipRetainDays {
		if next > 0 && (st.ClipRetainDays == 0 || next < st.ClipRetainDays) {
			a.askRetention(st.ClipRetainDays, next) // 调短会清理更旧记录：先确认（同 Tauri RetentionSlider commit）
		} else {
			a.retainAskGen++ // 放宽：直接生效，作废待确认的缩短
			st.ClipRetainDays = next
		}
	}
	st.Language = langNames[a.setLang]
	st.AIEndpoint, st.AIModel = strings.TrimSpace(a.setAIEnd), strings.TrimSpace(a.setAIModel)
	st.Companion = lines(a.setCompan)
	_ = a.store.SetSettings(st)
	if a.panel == nil { // 无 App 运行（视图测试）时查询系统语言会阻塞，面板也不存在
		return
	}
	setLanguage(st.Language, mygo.App.PreferredLanguages())
	if oldGlass != st.Glass {
		v := vibrancyFor(st.Glass)
		a.panel.SetVibrancy(v)
	}
	a.panel.Invalidate()
}

func (a *app) settingsView(c *ui.Context) {
	registerFonts()
	k, s := tok(c), stok(c)
	st := a.store.Settings()
	changed := false
	setToggle := func(v bool, set func(*store.Settings, bool)) func() {
		return func() {
			on := v
			if toggle(c, s, &on) {
				cur := a.store.Settings()
				set(&cur, on)
				_ = a.store.SetSettings(cur)
			}
		}
	}
	retainIdx := float64(retentionIndex(int(a.setRetain)))
	retain := retentionLabel(int(a.setRetain))

	pages := []setPage{
		{label: "窗口与外观", icon: "settings-2", subs: []string{"通用", "伴随停靠"}, sections: [][]setSection{
			{
				{title: tr("常用外观"), rows: []setRow{
					{title: tr("语言"), hint: tr("跟随系统时，中文系统显示中文，其余显示英文"), control: func() {
						changed = segmented(c, k, &a.setLang, "跟随系统", "简体中文", "English") || changed
					}},
					{title: tr("配色方案"), hint: schemeHint(st.ColorScheme), control: func() {
						schemeSelect(c, k, s, st.ColorScheme, func(name string) {
							v := a.store.Settings()
							v.ColorScheme = name
							_ = a.store.SetSettings(v)
							applyAppearance(v)
							a.invalidateAll()
						})
					}},
					{title: tr("高亮颜色"), hint: tr("选中卡片与菜单高亮的颜色"), hidden: st.ColorScheme != "platinum", control: func() {
						i := max(0, slices.Index(ptHighlightNames, st.PtHighlight))
						if segmented(c, k, &i, ptHighlightLabels...) {
							cur := a.store.Settings()
							cur.PtHighlight = ptHighlightNames[i]
							_ = a.store.SetSettings(cur)
							applyAppearance(cur)
							a.invalidateAll()
						}
					}},
					{title: tr("滚动条"), hint: tr("经典款带箭头和条纹滑块"), hidden: st.ColorScheme != "platinum", control: func() {
						i := 0
						if st.PtScrollbar == "thin" {
							i = 1
						}
						if segmented(c, k, &i, "经典 Platinum", "细条") {
							cur := a.store.Settings()
							cur.PtScrollbar = []string{"classic", "thin"}[i]
							_ = a.store.SetSettings(cur)
							applyAppearance(cur)
							a.invalidateAll()
						}
					}},
					{title: tr("主题"), hidden: fixedLight(st.ColorScheme), control: func() {
						i := max(0, slices.Index(themeNames, st.Theme))
						if segmented(c, k, &i, "跟随系统", "浅色", "深色") {
							a.setTheme(themeNames[i])
						}
					}},
					{title: tr("卡片密度"), hint: tr("紧凑模式单行显示，一屏看到更多"), control: func() {
						i := 0
						if st.CardDensity == "compact" {
							i = 1
						}
						if segmented(c, k, &i, "舒适", "紧凑") {
							cur := a.store.Settings()
							cur.CardDensity = []string{"comfortable", "compact"}[i]
							_ = a.store.SetSettings(cur)
							a.invalidateAll()
						}
					}},
					{title: tr("详情窗字号"), hint: tr("详情窗内也可用 ⌘+ / ⌘− 调整，⌘0 复位"), control: func() {
						v := float64(st.DetailFontSize)
						if sliderValue(c, k, &v, 10, 24, 1, itoa(st.DetailFontSize)+"px") {
							cur := a.store.Settings()
							cur.DetailFontSize = int(v)
							_ = a.store.SetSettings(cur)
							if a.detailWin != nil {
								a.detailWin.Invalidate()
							}
						}
					}},
				}},
				{title: tr("窗口与提示"), rows: []setRow{
					{title: tr("开机启动"), hint: tr("登录后在后台待命"), control: func() {
						if toggle(c, s, &a.openAtLogin) && a.panel != nil {
							if err := mygo.App.SetOpenAtLogin(a.openAtLogin); err != nil {
								a.openAtLogin = !a.openAtLogin
								a.showHUD("warn", tr("设置失败：")+err.Error())
							}
						}
					}},
					{title: tr("面板置顶"), hint: tr("面板保持在其他窗口之上"), control: setToggle(!st.PanelNotOnTop, func(s *store.Settings, v bool) {
						s.PanelNotOnTop = !v
						if a.panel != nil {
							a.panel.SetAlwaysOnTop(v)
						}
					})},
					{title: tr("失焦自动隐藏"), hint: tr("切到其他应用时收起面板，钉住时除外"), control: setToggle(!st.KeepOnBlur, func(s *store.Settings, v bool) { s.KeepOnBlur = !v })},
					{title: tr("隐身模式"), hint: tr("不弹「已捕获」气泡，适合投屏；失败提醒仍会显示"), control: setToggle(st.Stealth, func(s *store.Settings, v bool) { s.Stealth = v })},
					{title: tr("音效"), hint: tr("捕获成功时轻响一声，隐身模式下静音"), control: setToggle(!st.SoundOff, func(s *store.Settings, v bool) { s.SoundOff = !v })},
				}},
				// Tauri 放在折叠的「更多外观与行为」里；Platinum 整窗不透明、原生模糊停用，不展示
				{title: tr("外观细节"), rows: []setRow{
					{title: tr("毛玻璃背景"), hint: tr("macOS 26 起为系统液态玻璃，更早系统回退为模糊材质"), hidden: st.ColorScheme == "platinum", control: func() {
						changed = segmented(c, k, &a.setGlass, glassLabels...) || changed
					}},
					{title: tr("窗口整体不透明度"), hint: tr("连毛玻璃层一起变透，能看穿下层窗口"), control: a.pctSlider(c, k, st.WindowAlpha(), 30, 100, 5, func(s *store.Settings, v float64) { s.WindowOpacity = v })},
					{title: tr("内容底色浓度"), hint: tr("面板底色的浓淡，毛玻璃关闭时最直观"), hidden: st.ColorScheme == "platinum",
						control: a.pctSlider(c, k, st.PanelAlpha(), 25, 100, 1, func(s *store.Settings, v float64) { s.PanelOpacity = v })},
					{title: tr("卡片彩色通栏"), hint: tr("卡片顶部按分组颜色着色；关闭则统一中性灰"), hidden: st.ColorScheme == "platinum",
						control: setToggle(!st.CardTintOff, func(s *store.Settings, v bool) { s.CardTintOff = !v })},
					{title: tr("剪贴卡模板"), hint: tr("只影响剪贴页：标准显示完整内容，浓缩只留摘要"), hidden: st.CardDensity == "compact", control: func() {
						i := 0
						if st.ClipTemplate == "condensed" {
							i = 1
						}
						if segmented(c, k, &i, "标准", "浓缩") {
							cur := a.store.Settings()
							cur.ClipTemplate = []string{"standard", "condensed"}[i]
							_ = a.store.SetSettings(cur)
							a.invalidateAll()
						}
					}},
					{title: tr("卡片底色不透明度"), hint: tr("调低可透出毛玻璃背景"), hidden: st.ColorScheme == "platinum",
						control: a.pctSlider(c, k, st.CardAlpha(), 30, 100, 5, func(s *store.Settings, v float64) { s.CardOpacity = v })},
					{title: tr("菜单栏显示下一个到期"), hint: tr("图标旁显示今天下一个任务的到期时间；图标本身会标出暂停、隐身、逾期与权限状态"),
						control: setToggle(st.TrayNextDue, func(s *store.Settings, v bool) { s.TrayNextDue = v })},
					{title: tr("提示显示时长"), hint: tr("右上角气泡停留多久；失败提醒至少 4 秒"), control: func() {
						v := st.HUDDuration().Seconds()
						if sliderValue(c, k, &v, 2, 10, 1, fmt.Sprintf(tr("%d 秒"), int(v))) {
							cur := a.store.Settings()
							cur.HUDDurationMs = int(v) * 1000
							_ = a.store.SetSettings(cur)
						}
					}},
				}},
				{title: tr("卡片右键菜单"), rows: []setRow{
					{title: tr("各区显隐与顺序"), hint: tr("「一级菜单」两区直接显示在右键菜单里，「整理」「转换与导出」各是一个二级菜单；各项只能在本区内开关和排序。剪贴卡的「移入笔记分组」显示在一级。合并、回复关联与删除始终显示。"),
						below: func() { a.menuSettings(c, k, s) }},
				}},
			},
			{
				{title: tr("伴随停靠"), rows: []setRow{
					{title: tr("与窗口的间隙"), hint: tr("面板贴在应用窗口旁时留出的距离"), control: func() {
						v := float64(st.Gap())
						if sliderValue(c, k, &v, 0, 40, 1, fmt.Sprintf("%dpx", int(v))) {
							cur := a.store.Settings()
							g := int(v)
							cur.CompanionGap = &g
							_ = a.store.SetSettings(cur)
						}
					}},
					{title: tr("伴随的应用"), hint: tr("这些应用在前台时面板自动停靠；加入当前应用前，需先在该应用中呼出过面板。"), below: func() {
						changed = a.appListEditor(c, k, s, "companion-apps", &a.setCompan, tr("加入当前应用")) || changed
					}},
				}},
			},
		}},
		{label: "快捷键", icon: "keyboard", sections: [][]setSection{{
			{title: tr("划词捕获"), rows: []setRow{
				{title: tr("双击修饰键"), hint: tr("选中文字后连按两次即捕获；无选中时开关面板"), control: func() {
					changed = segmented(c, k, &a.setModifier, modifierLabels...) || changed
				}},
				{title: tr("两击最大间隔"), hint: tr("两次按键间隔超过此值不算双击"), control: func() {
					changed = sliderValue(c, k, &a.setGap, 150, 1000, 50, itoa(int(a.setGap))+"ms") || changed
				}},
				{title: tr("双击行为"), hint: tr("「只划词」时没有选中文字的双击不做任何事"), control: func() {
					i := 0
					if st.DoubleTapCaptureOnly {
						i = 1
					}
					if segmented(c, k, &i, "划词或开关面板", "只划词") {
						cur := a.store.Settings()
						cur.DoubleTapCaptureOnly = i == 1
						_ = a.store.SetSettings(cur)
					}
				}},
				{title: tr("捕获存入"), hint: tr("划词捕获的内容进入这个分组"), control: func() {
					name := tr("收件箱")
					for _, sec := range a.noteSections() {
						if sec.ID == st.CaptureSection {
							name = sectionName(sec)
						}
					}
					ui.PopoverMenuButton(c, name, func(m *ui.Menu) {
						for _, sec := range a.noteSections() {
							id := sec.ID
							if id == store.SectionInbox {
								id = ""
							}
							if m.Item(sectionName(sec)).Checked(id == st.CaptureSection).Chosen() {
								cur := a.store.Settings()
								cur.CaptureSection = id
								_ = a.store.SetSettings(cur)
							}
						}
					})
				}},
			}},
			{title: tr("全局快捷键"), rows: []setRow{
				{title: tr("开关面板"), hint: tr("点击后按下新组合即可录制；Esc 取消，⌫ 清除"), control: func() { a.hotkeyField(c, k, hotkeySlots[0]) }},
				{title: tr("截图"), hidden: st.ScreenshotOff, control: func() { a.hotkeyField(c, k, hotkeySlots[1]) }},
				{title: tr("截图时隐藏 Toskr"), hint: tr("开启后截图画面里不出现 Toskr 的面板、钉图等窗口；默认关闭，截到的就是屏幕上看到的样子"), hidden: st.ScreenshotOff,
					control: setToggle(st.ShotHideSelf, func(s *store.Settings, v bool) { s.ShotHideSelf = v })},
				{title: tr("截图线条颜色"), hint: tr("十字线、选框和手柄的颜色"), hidden: st.ScreenshotOff, control: func() { a.crosshairControl(c, k) }},
				{title: tr("新建笔记"), hint: tr("在任意应用里唤出面板并聚焦输入区"), control: func() { a.hotkeyField(c, k, hotkeySlots[2]) }},
				{title: tr("本机翻译"), hint: a.localTranslateHint(), control: func() { a.localTranslateButton(c, s) }},
			}},
			{title: tr("捕获排除"), rows: []setRow{
				{title: tr("在这些应用中不读取选区"), hint: tr("双击只开关面板，不读取任何内容，适合密码管理器等敏感应用"), below: func() {
					changed = a.appListEditor(c, k, s, "excluded-apps", &a.setExcluded, tr("加入当前应用")) || changed
				}},
			}},
			{title: tr("面板内快捷键"), rows: []setRow{
				{title: tr("面板内快捷键"), hint: fmt.Sprintf(tr("%d 项 · 面板里长按 ⌥ 也能速查"), len(panelShortcuts)), control: func() {
					label := "展开"
					if a.setShortcutsOpen {
						label = "收起"
					}
					if button(c, s, label) {
						a.setShortcutsOpen = !a.setShortcutsOpen
					}
				}, below: func() {
					if !a.setShortcutsOpen {
						return
					}
					ui.Column(c).Gap(6).Margin(6, 0, 0, 0).Children(func() {
						for _, r := range panelShortcuts {
							ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
								text(c, tr(r[1]), 12, 17, 400, k.fg).SingleLine().Grow(1).Basis(0)
								keycap(c, k, r[0], 0)
							})
						}
					})
				}},
			}},
		}}},
		{label: "剪贴板", icon: "clipboard-list", sections: [][]setSection{{
			{title: tr("剪贴板历史"), rows: []setRow{
				{title: tr("记录剪贴板历史"), hint: tr("复制的文字、链接与图片自动进入「剪贴」页"), control: func() {
					changed = toggle(c, s, &a.setClip) || changed
				}},
				{title: tr("暂停收集"), hint: a.clipPauseHint(st), hidden: !st.ClipboardWatch, control: func() {
					if a.now().Before(st.ClipPauseUntil) {
						if button(c, s, "立即恢复") {
							a.pauseClipboard(0)
						}
						return
					}
					ui.Row(c).Gap(4).Children(func() {
						for _, m := range clipPauseMinutes {
							label := fmt.Sprintf(tr("%d 分"), m)
							if m >= 60 {
								label = fmt.Sprintf(tr("%d 小时"), m/60)
							}
							if button(c, s, label) {
								a.pauseClipboard(m)
							}
						}
					})
				}},
				{title: tr("连续复制两次自动置顶"), hint: tr("10 秒内复制两次同一内容，自动固定 ★"), hidden: !st.ClipboardWatch,
					control: setToggle(!st.ClipDoubleCopyOff, func(s *store.Settings, v bool) { s.ClipDoubleCopyOff = !v })},
				{title: tr("忽略密码管理器与隐藏内容"), hint: tr("1Password 等标记为隐藏的复制不进入历史"), hidden: !st.ClipboardWatch,
					control: setToggle(!st.ClipKeepConcealed, func(s *store.Settings, v bool) { s.ClipKeepConcealed = !v })},
				{title: tr("忽略瞬时内容"), hint: tr("应用标记为临时、自动生成的复制不进入历史"), hidden: !st.ClipboardWatch,
					control: setToggle(!st.ClipKeepTransient, func(s *store.Settings, v bool) { s.ClipKeepTransient = !v })},
				{title: tr("保留时长"), hint: tr("超期记录自动清理，置顶项除外"), control: func() {
					if sliderValue(c, k, &retainIdx, 0, float64(len(retentionSteps)-1), 1, retain) {
						a.setRetain, changed = float64(retentionSteps[int(retainIdx)]), true
					}
				}},
				{title: tr("删除历史"), hint: tr("清空未固定的记录，可在主面板撤销"), control: func() {
					if button(c, s, "清除…") {
						a.confirmClearClipboard()
					}
				}},
			}},
			{title: tr("忽略的应用"), rows: []setRow{
				{title: tr("不保存这些应用的复制"), hint: tr("与「快捷键」页的「捕获排除」分开设置"), below: func() {
					changed = a.appListEditor(c, k, s, "clip-excluded-apps", &a.setClipExcluded, tr("加入当前应用")) || changed
				}},
			}},
		}}},
		// 同 Tauri TargetSection：粘贴规则 · 隐私保护 · 提示词模板（最近发送在主面板抽屉里，不在设置）
		{label: "粘贴与隐私", icon: "crosshair", subs: pasteSubs, sections: [][]setSection{
			a.pasteRuleSections(c, k, s, st),
			a.privacySections(c, k, s, st),
			a.templateSections(c, k, s),
		}},
		{label: "更多功能", icon: "blocks", subs: featureSubs(st), sections: append([][]setSection{
			{a.featureSwitches(c, k, s, st)},
			{{title: tr("AI 智能"), rows: a.aiSettingsRows(c, k, s, st, &changed)}},
			{
				{title: tr("提醒"), rows: []setRow{
					{title: tr("任务到期与账单提醒"), hint: tr("到点提醒；账单走系统通知"), control: setToggle(st.DueReminders, func(s *store.Settings, v bool) { s.DueReminders = v })},
					{title: tr("任务提醒方式"), hint: tr("系统通知在锁屏、面板关闭时也能看到，首次使用时 macOS 会请求通知权限。气泡里可直接完成或稍后提醒。"), control: func() {
						sel := max(0, slices.Index([]string{"hud", "system", "both"}, cmpOr(st.ReminderVia, "hud")))
						if segmented(c, k, &sel, tr("气泡"), tr("系统通知"), tr("两者")) {
							cur := a.store.Settings()
							cur.ReminderVia = []string{"hud", "system", "both"}[sel]
							_ = a.store.SetSettings(cur)
						}
					}},
					{title: tr("账单默认提醒"), hint: tr("新建账单时默认勾选这些提醒；不影响已有账单"), hidden: !st.SubscriptionsEnabled, control: func() {
						cur := st.BillDefaultRemind()
						ui.Row(c).Gap(6).Children(func() {
							for _, o := range []struct {
								d     int
								label string
							}{{7, "提前 7 天"}, {3, "提前 3 天"}, {1, "提前 1 天"}, {0, "当天"}} {
								on := slices.Contains(cur, o.d)
								ch := ui.Row(c).Height(24).Padding(0, 10).Radius(12).AlignItems(ui.Center).Key("bill-remind-" + itoa(o.d)).
									Role(ui.RoleCheckBox).Label(tr(o.label)).Selected(on)
								fg := k.muted
								switch {
								case on:
									ch.Background(s.primary)
									fg = gray(0.985, 1)
								case ch.Hovered():
									ch.Background(k.track)
									fg = k.fg
								default:
									ch.Background(k.track)
								}
								ch.Children(func() { text(c, tr(o.label), 11, 16, 500, fg).SingleLine() })
								if ch.Clicked() {
									next := slices.DeleteFunc(slices.Clone(cur), func(x int) bool { return x == o.d })
									if !on {
										next = append(next, o.d)
									}
									if next == nil {
										next = []int{}
									}
									a.patchSettings(func(x *store.Settings) { x.BillRemind = next })
								}
							}
						})
					}},
					{title: tr("货币符号"), hint: tr("账单金额前缀"), control: func() {
						cur := st.Currency
						if textField(c, k, s, &cur, 64, "¥", false) {
							ns := a.store.Settings()
							ns.Currency = cur
							_ = a.store.SetSettings(ns)
						}
					}},
				}},
				{title: tr("到期快捷档"), rows: a.duePresetRows(c, k, s, st)},
			},
			{
				{title: tr("苹果日历"), rows: a.calendarSettings(c, k, s, st)},
				{title: tr("苹果提醒事项"), rows: a.remindersSettings(c, k, s, st)},
			},
		}, featureDomainSections(st, func() []setSection { return a.messageWatchSections(c, k, s, st) }, func() []setSection { return a.secretSections(c, k, s, st) })...)},
		{label: "数据与备份", icon: "database", sections: [][]setSection{a.dataSections(c, k, s)}},
		{label: "权限", icon: "shield-check", sections: [][]setSection{a.permissionSections(c, k, s, st)}},
		// 同 Tauri settingsChildSections("outcome")：使用概览 · 关于 · 诊断
		{label: "帮助与更新", icon: "info", subs: []string{"使用概览", "关于", "诊断"}, sections: [][]setSection{
			append(a.outcomeSections(c, k, s, st), a.learningSection(c, s, st)),
			a.aboutRows(c, s),
			a.diagSections(c, k, s),
		}},
	}
	a.settingsShell(c, pages)
	if changed {
		a.saveSettings()
	}
}

func (a *app) dataSections(c *ui.Context, k tokens, s settingsTokens) []setSection {
	backup := append(a.dataDirRows(c, k, s), []setRow{
		{title: tr("加密"), hint: tr("AES-256 加密，密钥存于钥匙串"), tip: tr("AES-256-GCM（TSK1 信封），密钥存于钥匙串；图片按内容哈希加密存放")},
		{title: tr("导出备份"), hint: tr(".toskr-backup，加密"), control: func() {
			if button(c, s, "导出…") {
				a.exportBackup(c)
			}
		}},
		a.legacyMigrationRow(c, k, s),
		{title: tr("从备份导入"), hint: tr("合并或整份恢复，导入前自动写恢复点"), tip: tr("预检后选「合并」（本机同 ID 记录优先）或「整份恢复」（用备份替换全部数据，设置保留）；都会先写恢复点。也可选 Tauri 旧 JSON 备份或迁移保险档（pre-encrypt-*.bak），只能合并"), control: func() {
			if button(c, s, "选择文件…") {
				a.inspectBackup(c)
			}
		}},
	}...)
	if p := importPreview; p != nil {
		legacy := p.Manifest.Format == store.LegacyJSONFormat
		when := p.Manifest.CreatedAt.Format("2006-01-02 15:04")
		snap := p.Manifest.Format == store.TauriSnapshotFormat
		switch {
		case snap:
			legacy = true // 同样只能合并
			when = tr("Tauri 迁移保险档（合并：同一笔记取较新一侧，分组名称以保险档为准）")
		case legacy:
			when = tr("旧 JSON 备份（只能合并，本机已有的条目跳过）")
		default:
			when = tr("备份时间 ") + when
		}
		hint := fmt.Sprintf(tr("%s · 笔记 %d（新增 %d / 已有 %d）· 任务 %d · 账单 %d · 秘文 %d"),
			when, p.Manifest.Counts["notes"], p.New, p.Overlap,
			p.Manifest.Counts["tasks"], p.Manifest.Counts["bills"], p.Manifest.Counts["secrets"])
		if p.MissingMedia > 0 {
			hint += fmt.Sprintf(tr(" · %d 张图片校验失败，将跳过"), p.MissingMedia)
		}
		backup = append(backup, setRow{title: tr("待导入的备份"), hint: hint, control: func() {
			ui.Row(c).Gap(6).Children(func() {
				if !legacy && button(c, s, "整份恢复") {
					err := a.store.ReplaceFromBackup(p)
					importPreview = nil
					if err != nil {
						a.showHUD("warn", tr("恢复失败：")+err.Error())
					} else {
						a.showHUD("ok", tr("已用备份替换全部数据（恢复前的数据存了一个恢复点）"))
						a.recovery = a.store.RecoveryPoints()
						a.reload()
					}
				}
				if button(c, s, "合并导入") {
					n, err := a.store.ImportBackup(p)
					importPreview = nil
					if err != nil {
						a.showHUD("warn", tr("导入失败：")+err.Error())
					} else {
						a.showHUD("ok", fmt.Sprintf(tr("已导入 %d 条笔记（导入前已写恢复点）"), n))
						a.recovery = a.store.RecoveryPoints()
					}
				}
				if button(c, s, "取消") {
					importPreview = nil
				}
			})
		}})
	}
	var points []setRow
	for i := len(a.recovery) - 1; i >= 0; i-- {
		p := a.recovery[i]
		points = append(points, setRow{title: recoveryLabel(p), control: func() {
			if button(c, s, "恢复到此") {
				if err := a.store.RestoreRecoveryPoint(p); err != nil {
					a.showHUD("warn", tr("恢复失败：")+err.Error())
				} else {
					a.showHUD("ok", tr("已恢复（恢复前的数据也存了一个恢复点）"))
					a.recovery = a.store.RecoveryPoints()
				}
			}
		}})
	}
	if len(points) == 0 {
		points = []setRow{{title: tr("暂无恢复点")}}
	}
	health := cmpOr(a.health, tr("只报告，不改数据"))
	return []setSection{
		{title: tr("备份与导入"), rows: backup},
		{title: tr("定期自动备份"), rows: a.autoBackupRows(c, k, s)},
		{title: fmt.Sprintf(tr("恢复点（启动 / 导入 / 恢复前自动生成，保留 %d 份）"), store.RecoveryKeep), rows: points},
		{title: tr("维护"), rows: []setRow{{title: tr("数据健康检查"), hint: health, control: func() {
			if button(c, s, "检查") {
				h := a.store.CheckHealth()
				a.health = fmt.Sprintf(tr("笔记 %d · 缺失图片 %d · 孤立图片 %d · 分组失联 %d"), h.Notes, h.MissingMedia, h.OrphanMedia, h.OrphanSectionRefs)
			}
		}}}},
	}
}

func recoveryLabel(path string) string {
	base := filepath.Base(path) // pre-launch-<13位毫秒>-<tag>.bak
	parts := strings.SplitN(strings.TrimSuffix(strings.TrimPrefix(base, "pre-launch-"), ".bak"), "-", 2)
	var ms int64
	_, _ = fmt.Sscan(parts[0], &ms)
	tag := map[string]string{"launch": "启动", "pre-import": "导入前", "pre-restore": "恢复前"}
	label := time.UnixMilli(ms).Format("01-02 15:04:05")
	if len(parts) == 2 {
		label += " · " + cmpOr(tag[parts[1]], parts[1])
	}
	return label
}

func cmpOr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func (a *app) exportBackup(c *ui.Context) {
	path, err := mygo.Dialog.Save(mygo.SaveDialogOptions{Parent: a.settingsWin, Title: "导出备份",
		DefaultPath: "Toskr-" + time.Now().Format("20060102-1504") + ".toskr-backup",
		Filters:     []mygo.FileFilter{{Name: "Toskr 备份", Extensions: []string{"toskr-backup"}}}})
	if err != nil || path == "" {
		return
	}
	man, err := a.store.ExportBackup(path)
	if err != nil {
		a.showHUD("warn", "导出失败："+err.Error())
		return
	}
	a.showHUD("ok", fmt.Sprintf("已导出：笔记 %d · 图片 %d", man.Counts["notes"], len(man.Media)))
}

func (a *app) inspectBackup(c *ui.Context) {
	paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{Parent: a.settingsWin, Title: "选择备份",
		Filters: []mygo.FileFilter{{Name: "Toskr 备份 / 旧 JSON", Extensions: []string{"toskr-backup", "json", "bak"}}}})
	if err != nil || len(paths) == 0 {
		return
	}
	if head, _ := readHead(paths[0], 8); store.Sealed(head) { // TSK1 信封：Tauri 迁移保险档，要用 Tauri 的数据密钥解
		a.inspectTauriSnapshot(paths[0])
		return
	}
	p, err := a.store.InspectBackup(paths[0])
	if err != nil {
		a.showHUD("warn", "备份无法使用："+err.Error())
		return
	}
	importPreview = p
}

// inspectTauriSnapshot：解 Tauri 迁移保险档（recovery/pre-encrypt-*.bak）。取钥匙串可能弹授权，放后台。
func (a *app) inspectTauriSnapshot(path string) {
	mediaDir := store.TauriDataDir()
	if d := filepath.Dir(path); filepath.Base(d) == "recovery" {
		mediaDir = filepath.Dir(d)
	}
	go func() {
		key, err := tauriKey()
		var p *store.Preview
		if err == nil {
			p, err = a.store.InspectTauriSnapshot(path, mediaDir, key)
			clear(key)
		}
		a.onMain(func() {
			if err != nil {
				a.showHUD("warn", tr("保险档无法使用：")+err.Error())
				return
			}
			importPreview = p
		})
	}()
}

func readHead(path string, n int) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b := make([]byte, n)
	k, _ := io.ReadFull(f, b)
	return b[:k], nil
}

func keyLabel(s string) string {
	return strings.NewReplacer("Cmd+", "⌘", "CmdOrCtrl+", "⌘", "Shift+", "⇧", "Alt+", "⌥", "Ctrl+", "⌃").Replace(s)
}

// secretSections 是设置「秘文」：共享密钥增删、默认密钥、密文格式、显现时长。
func (a *app) secretSections(c *ui.Context, k tokens, s settingsTokens, st store.Settings) []setSection {
	save := func(fn func(*store.Settings)) {
		cur := a.store.Settings()
		fn(&cur)
		_ = a.store.SetSettings(cur)
	}
	var keys []setRow
	for _, key := range st.SecretKeys {
		hint := tr("创建于 ") + key.CreatedAt.Format("2006-01-02")
		if key.Note != "" {
			hint = key.Note + " · " + hint
		}
		if key.ID == st.SecretDefaultKeyID {
			hint = tr("默认 · ") + hint
		}
		keys = append(keys, setRow{title: cmpOr(key.Label, tr("未命名密钥")), hint: hint, control: func() {
			ui.Row(c).Gap(6).Children(func() {
				if key.ID != st.SecretDefaultKeyID && button(c, s, "设为默认") {
					save(func(x *store.Settings) { x.SecretDefaultKeyID = key.ID })
				}
				if button(c, s, "删除") {
					a.confirmRemoveSecretKey(key)
				}
			})
		}})
	}
	keys = append(keys, setRow{title: tr("添加共享密钥"), hint: tr("与对方约定相同的暗号（中文、字符皆可），备注写清给谁、何时设置"), below: func() {
		ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
			textField(c, k, s, &a.newKeyLabel, 120, tr("给谁 / 场景"), false)
			textField(c, k, s, &a.newKeyPass, 200, tr("共享密钥"), true)
			textField(c, k, s, &a.newKeyNote, 160, tr("备注（可选）"), false)
			if button(c, s, "添加") {
				if strings.TrimSpace(a.newKeyPass) == "" {
					a.showHUD("ok", tr("密钥不能为空"))
					return
				}
				key := store.SecretKey{ID: fmt.Sprintf("k%d", time.Now().UnixNano()), Label: strings.TrimSpace(a.newKeyLabel),
					Passphrase: a.newKeyPass, Note: strings.TrimSpace(a.newKeyNote), CreatedAt: time.Now()}
				save(func(x *store.Settings) {
					x.SecretKeys = append(x.SecretKeys, key)
					if x.SecretDefaultKeyID == "" {
						x.SecretDefaultKeyID = key.ID
					}
				})
				a.newKeyLabel, a.newKeyPass, a.newKeyNote = "", "", ""
			}
		})
	}})
	style := 0
	for i, o := range secretcodec.StyleOptions {
		if string(o.Value) == st.SecretCipherStyle {
			style = i
		}
	}
	var styleLabels []string
	for _, o := range secretcodec.StyleOptions {
		styleLabels = append(styleLabels, o.ShortLabel)
	}
	reveal := float64(st.SecretRevealMs) / 1000
	revealLabel := tr("不自动")
	if reveal > 0 {
		revealLabel = fmt.Sprintf("%ds", int(reveal))
	}
	return []setSection{
		{title: tr("共享密钥"), rows: keys},
		{title: tr("收发"), rows: []setRow{
			{title: tr("默认密文格式"), hint: tr("中文文本 / 代码（随机语言）/ 日志记录 / 英文引用；接收端自动识别"), control: func() {
				if segmented(c, k, &style, styleLabels...) {
					save(func(x *store.Settings) { x.SecretCipherStyle = string(secretcodec.StyleOptions[style].Value) })
				}
			}},
			{title: tr("显现时长"), hint: tr("点击解密后自动回遮罩；面板隐藏或失焦时立即回遮罩"), control: func() {
				if sliderValue(c, k, &reveal, 0, 60, 1, revealLabel) {
					save(func(x *store.Settings) { x.SecretRevealMs = int(reveal) * 1000 })
				}
			}},
			{title: tr("安全边界"), hint: tr("防 IM / 网络 / 肩窥：密文用 AES-GCM，密钥经 PBKDF2 派生；不防本机取证（密钥随本地加密数据保存）")},
		}},
	}
}

var themeNames = []string{"system", "light", "dark"}

// playCaptureSound 捕获成功的提示音（系统 Tink；音效关闭或隐身时不响）。
func (a *app) playCaptureSound() {
	if st := a.store.Settings(); st.SoundOff || st.Stealth || a.panel == nil {
		return
	}
	_ = exec.Command("/usr/bin/afplay", "-v", "0.4", "/System/Library/Sounds/Tink.aiff").Start()
}

func schemeHint(scheme string) string {
	switch scheme {
	case "platinum":
		return tr("固定浅色、整窗不透明；切回琉璃恢复原主题与毛玻璃")
	case "paper", "matcha", "sakura":
		return tr("固定浅色；切回琉璃恢复深浅色设置")
	case "fog":
		return tr("跟随下方主题设置切换浅色 / 深色")
	}
	return tr("Platinum 为 Mac OS 9 经典外观")
}

// invalidateAll 让所有已开窗口按新外观重绘（配色方案 / 卡片密度）。
func (a *app) invalidateAll() {
	for _, w := range []*mygo.Window{a.panel, a.hud, a.detailWin, a.settingsWin} {
		if w != nil {
			w.Invalidate()
		}
	}
}

func (a *app) clipPauseHint(st store.Settings) string {
	if a.now().Before(st.ClipPauseUntil) {
		return fmt.Sprintf(tr("已暂停，%s 恢复"), st.ClipPauseUntil.Format("15:04"))
	}
	return tr("临时停止，到点自动恢复")
}

// pctSlider：0–1 的比例设置用百分比滑块编辑；改卡片不透明度后重新应用外观。
func (a *app) pctSlider(c *ui.Context, k tokens, cur float64, lo, hi, step float64, set func(*store.Settings, float64)) func() {
	return func() {
		v := math.Round(cur * 100)
		if sliderValue(c, k, &v, lo, hi, step, fmt.Sprintf("%d%%", int(v))) {
			st := a.store.Settings()
			set(&st, v/100)
			_ = a.store.SetSettings(st)
			applyAppearance(st)
			a.invalidateAll()
		}
	}
}

func shotHint(st store.Settings) string {
	if st.ScreenshotOff {
		return tr("截取屏幕任意区域，可标注、钉在屏幕上、长截屏、识别文字")
	}
	return tr("菜单栏图标或快捷键截图；需要「屏幕录制」权限")
}

var secretKeyAsk = func(title, msg string) bool { // 测试替换；Dialog.Message 阻塞，调用方在后台 goroutine
	r, err := mygo.Dialog.Message(mygo.MessageOptions{Title: title, Message: msg, Buttons: []string{tr("删除"), tr("取消")}, DefaultButton: 1})
	return err == nil && r.Button == 0
}

// confirmRemoveSecretKey 同 Tauri removeKey：先说明会锁住几条秘文，确认后删；默认密钥被删则改用剩下的第一把。
func (a *app) confirmRemoveSecretKey(key store.SecretKey) {
	n := 0
	for _, x := range a.store.Secrets() {
		if x.KeyID == key.ID {
			n++
		}
	}
	name := cmpOr(key.Label, tr("未命名"))
	msg := fmt.Sprintf(tr("确定删除密钥「%s」？"), name)
	if n > 0 {
		msg = fmt.Sprintf(tr("有 %d 条秘文用「%s」加解密，删除后这些卡片将变为锁定态（用相同密钥文本重新添加可救回）。确定删除？"), n, name)
	}
	go func() {
		if !secretKeyAsk(tr("删除秘文密钥"), msg) {
			return
		}
		do := func() {
			cur := a.store.Settings()
			cur.SecretKeys = slices.DeleteFunc(cur.SecretKeys, func(y store.SecretKey) bool { return y.ID == key.ID })
			if cur.SecretDefaultKeyID == key.ID {
				cur.SecretDefaultKeyID = ""
				if len(cur.SecretKeys) > 0 {
					cur.SecretDefaultKeyID = cur.SecretKeys[0].ID
				}
			}
			_ = a.store.SetSettings(cur)
		}
		if a.settingsWin != nil {
			a.settingsWin.Update(do)
		} else {
			a.onMain(do)
		}
	}()
}

// pasteStepRow：图文 / 多图卡逐段粘贴时，段与段之间等多久。网页版对话框（ChatGPT、Claude 网页）上传图片较慢，
// 间隔太短会把下一段粘进上一张图之前，调到「慢」或「很慢」即可。
func (a *app) pasteStepRow(c *ui.Context, k tokens, st store.Settings) setRow {
	return setRow{title: tr("多段粘贴间隔"), hint: tr("图文卡逐段粘贴；网页贴图慢就调大"),
		tip: tr("文字与每张图分别粘贴，段与段之间等待这段时间让目标应用接收上一段。图片在目标里顺序错乱或缺图时，换成更慢的一档。"),
		control: func() {
			sel := max(0, slices.Index(store.PasteStepOptions, int(st.PasteStep()/time.Millisecond)))
			labels := []string{tr("快 0.2 秒"), tr("标准 0.35 秒"), tr("慢 0.6 秒"), tr("很慢 1 秒")}
			if segmented(c, k, &sel, labels...) {
				ms := store.PasteStepOptions[sel]
				a.patchSettings(func(x *store.Settings) { x.PasteStepMs = ms })
			}
		}}
}
