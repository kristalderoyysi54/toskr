package main

import (
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/core"
	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// 首启导览 + 安全发送演练 + 进阶课（同 Tauri WelcomeTour / SafeDeliveryRehearsal / LessonCoach）。
// 演练进度存 Settings.Onboarding；进阶课进度只在内存（a.lesson），示例卡片按来源标记清理。

// copyText 可替换（测试不碰系统剪贴板）。
var copyText = func(s string) { mygo.Clipboard.WriteText(s) }

// lessonSession：进行中的进阶课；prevAlias* 是课程改动前的化名开关，退出时还原。
type lessonSession struct {
	progress                    lessonProgress
	prevAliasOff, prevNoRestore bool
	aliasTouched, aliasCreated  bool
}

// 欢迎导览文案（同 Tauri WELCOME_TOUR_COPY）
const welcomeTourTitle = "把散落各处的文字，一次安全地交给 AI"

var welcomeTourPoints = []string{
	"选中文字，连按两次快捷键收成卡片",
	"勾选多张，⌘⏎ 合成一次粘贴",
	"邮箱、密钥等敏感信息发送前自动替换",
}

// isSafeRehearsalText：中英两版演练文本都认（切换语言前已复制的旧版本仍受安全锁保护）。
func isSafeRehearsalText(s string) bool {
	s = strings.TrimSpace(s)
	return s == store.SafeRehearsalText || s == en[store.SafeRehearsalText]
}

func (a *app) onboarding() store.OnboardingState { return a.store.Settings().Onboarding.Normalized() }

func (a *app) transitionOnboarding(ev store.OnboardingEvent) {
	st := a.store.Settings()
	st.Onboarding = store.OnboardingAfter(st.Onboarding, ev, a.now().UnixMilli())
	_ = a.store.SetSettings(st)
}

func (a *app) captureKeyLabel() string {
	return modifierLabels[max(0, slices.Index(modifierNames, a.store.Settings().TriggerModifier))]
}

// maybeOpenTour：每次唤出面板时，没看过导览就盖上导览（同 Tauri !welcomeTourSeen && open）。
func (a *app) maybeOpenTour() { a.tourOpen = !a.store.Settings().WelcomeTourSeen }

// leaveTour 同 Tauri WelcomeTour leaveTour：只有选「试一下」才启动演练状态机。
func (a *app) leaveTour(rehearse bool) {
	a.tourOpen = false
	st := a.store.Settings()
	st.WelcomeTourSeen = true
	if rehearse {
		st.Onboarding = store.OnboardingAfter(st.Onboarding, store.OnboardingEvent{Type: "start"}, a.now().UnixMilli())
	}
	_ = a.store.SetSettings(st)
	if rehearse {
		a.noteSub = subNotes
		a.switchPage(pageNotes)
	}
}

// showNotesPanel：课程与演练都在笔记页里进行（同 Tauri showNotesPanel：钉住面板免得切去文档时收起）。
func (a *app) showNotesPanel() {
	a.noteSub = subNotes
	a.switchPage(pageNotes)
	a.pinned = true
	if a.panel != nil {
		a.showPanel()
	}
}

// startRehearsal：设置 →「上手课程」开始 / 继续基础课。
func (a *app) startRehearsal(mode string) {
	a.transitionOnboarding(store.SafeRehearsalLaunchEvent(a.store.Settings().Onboarding, mode))
	a.showNotesPanel()
}

func (a *app) coachVisible() bool {
	s := a.onboarding().RehearsalStatus
	return s == store.RehearsalActive || s == store.RehearsalPaused || a.lesson != nil
}

// coachCards：笔记列表顶部（横栏为左侧一栏）的演练卡与进阶课卡。
func (a *app) coachCards(c *ui.Context, k tokens) {
	a.rehearsalCard(c, k)
	a.lessonCoach(c, k)
}

func coachBox(c *ui.Context, k tokens, key string) ui.Element {
	return ui.Column(c).Padding(12).Gap(8).Radius(12).Background(k.card).Border(1, k.inputBorder).Key(key)
}

// stepDots：三步进度（已完成打勾、当前步强调色）。
func stepDots(c *ui.Context, k tokens, labels [3]string, cur int) {
	ui.Row(c).Gap(8).Children(func() {
		for i, l := range labels {
			ui.Column(c).Grow(1).Basis(0).Gap(2).AlignItems(ui.Center).Children(func() {
				col := k.muted
				switch {
				case i < cur:
					licon(c, "circle-check", 12, k.ok)
				case i == cur:
					col = k.fg
					licon(c, "circle", 12, c.Theme().Accent)
				default:
					licon(c, "circle", 12, k.muted)
				}
				text(c, tr(l), 10, 14, 400, col).SingleLine()
			})
		}
	})
}

// linkButton：文字链样式的次要操作（同 Tauri ghost / underline 按钮）。
func linkButton(c *ui.Context, k tokens, key, label string) bool {
	b := ui.Row(c).Padding(2, 6).Radius(6).Key(key).Role(ui.RoleButton).Label(label)
	col := hoverLink(b, k)
	b.Children(func() { text(c, label, 11, 16, 500, col).SingleLine() })
	return b.Clicked()
}

func stepBody(c *ui.Context, k tokens, fn func()) {
	ui.Column(c).Padding(10).Gap(6).Radius(8).Background(k.track).Children(fn)
}

func stepTitle(c *ui.Context, k tokens, s string) { text(c, s, 12, 17, 500, k.fg).Wrap() }
func stepHint(c *ui.Context, k tokens, s string)  { text(c, s, 11, 16, 400, k.muted).Wrap() }

func sampleBox(c *ui.Context, k tokens, s string, mono bool) {
	e := text(c, s, 11, 16, 400, k.fg).Wrap().Padding(6, 8).Radius(8).Background(k.card)
	if mono {
		e.Font(fontMono)
	}
}

func (a *app) permissionStatus() string {
	installed := a.tapErr == "" && !a.tapStarted.IsZero()
	return store.PermissionRehearsalStatus(a.permAX, installed, a.tapReceiving.Load(), a.permState() == "stuck")
}

func (a *app) targetReady() bool {
	return a.target.PID != 0 && targetAlive(a.target.PID, a.targetStarted)
}

// refreshTargetFromFront：「识别粘贴位置」——采信当前前台应用（不是 Toskr 自己时）。
func (a *app) refreshTargetFromFront() {
	f, ok := a.sys.Frontmost()
	if !ok || f.PID == 0 || f.PID == a.sys.SelfPID() { // 点面板时 Toskr 在前台：用最近一次的外部前台应用
		f, ok = a.lastFront, a.lastFront.PID != 0
	}
	if ok {
		a.target, a.targetStarted = f, macos.ProcessStartMs(f.PID)
	}
}

// rehearsalCard 同 Tauri SafeDeliveryRehearsalView。
func (a *app) rehearsalCard(c *ui.Context, k tokens) {
	o := a.onboarding()
	var act func() // 按钮会改写设置：画完再执行
	defer func() {
		if act != nil {
			act()
		}
	}()
	switch o.RehearsalStatus {
	case store.RehearsalPaused:
		coachBox(c, k, "rehearsal").Children(func() {
			ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
				licon(c, "hourglass", 14, k.muted)
				text(c, tr("教程已暂停"), 13, 18, 600, k.fg)
			})
			ui.Row(c).Children(func() {
				if ui.Button(c, tr("继续教程")).Clicked() {
					act = func() { a.transitionOnboarding(store.OnboardingEvent{Type: "resume"}) }
				}
			})
		})
		return
	case store.RehearsalActive:
	default:
		return
	}
	cur := 0
	switch o.RehearsalStep {
	case store.StepTarget:
		cur = 1
	case store.StepFirewall, store.StepDelivery:
		cur = 2
	}
	coachBox(c, k, "rehearsal").Children(func() {
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			ui.Row(c).Grow(1).Basis(0).Gap(6).AlignItems(ui.Center).Children(func() {
				text(c, tr("上手教程"), 13, 18, 600, k.fg)
				noEnterBadge(c, k)
			})
			if linkButton(c, k, "rh-pause", tr("稍后继续")) {
				act = func() {
					a.transitionOnboarding(store.OnboardingEvent{Type: "pause"})
					a.showHUD("info", tr("教程已暂停，可在「设置 → 帮助与更新」继续"))
				}
			}
		})
		stepDots(c, k, [3]string{"收进内容", "选择位置", "检查并粘贴"}, cur)
		stepBody(c, k, func() { a.rehearsalStep(c, k, o, &act) })
		ui.Row(c).Children(func() {
			if linkButton(c, k, "rh-skip", tr("退出教程")) {
				act = func() {
					a.transitionOnboarding(store.OnboardingEvent{Type: "skip"})
					a.showHUD("info", tr("已退出教程，可在「设置 → 帮助与更新」重新开始"))
				}
			}
		})
	})
}

func (a *app) rehearsalStep(c *ui.Context, k tokens, o store.OnboardingState, act *func()) {
	btn := func(label string, fn func()) {
		ui.Row(c).Gap(6).Children(func() {
			if ui.Button(c, label).Clicked() {
				*act = fn
			}
		})
	}
	switch o.RehearsalStep {
	case store.StepPermissions:
		switch a.permissionStatus() {
		case "accessibilityDenied":
			stepTitle(c, k, tr("允许辅助功能"))
			flow(c, k, "ax", vi("settings-2", "系统设置"), vi("shield-check", "辅助功能"), vi("check", "打开 Toskr"))
			btn(tr("打开辅助功能设置"), func() { openPrivacy("Privacy_Accessibility") })
		case "tapUnavailable":
			ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
				ui.Spinner(c).Size(12, 12)
				stepTitle(c, k, tr("快捷键准备中"))
			})
			btn(tr("检查辅助功能设置"), func() { openPrivacy("Privacy_Accessibility") })
		case "waitingForEvents":
			stepTitle(c, k, tr("按一下空格"))
			flow(c, k, "space", vk("␣", "空格"), vi("shield-check", "就绪"))
		case "inputMonitoringBlocked":
			text(c, tr("允许输入监控"), 12, 17, 500, k.danger)
			flow(c, k, "im", vi("settings-2", "系统设置"), vi("keyboard", "输入监控"), vi("check", "打开 Toskr"))
			ui.Row(c).Gap(6).Children(func() {
				if ui.Button(c, tr("重置输入监控授权")).Clicked() {
					*act = a.resetInputMonitoring
				}
				if ui.Button(c, tr("打开输入监控设置")).Clicked() {
					*act = func() { openPrivacy("Privacy_ListenEvent") }
				}
			})
		default:
			ui.Row(c).Gap(4).AlignItems(ui.Center).Children(func() {
				licon(c, "shield-check", 14, k.ok)
				text(c, tr("快捷键已准备好"), 12, 17, 500, k.ok)
			})
			btn(tr("开始收一条内容"), func() {
				if a.permissionStatus() == "ready" {
					a.transitionOnboarding(store.OnboardingEvent{Type: "permissionsReady"})
				}
			})
		}
	case store.StepCapture:
		prepared := o.ActivationStartedAtMs != nil
		label := tr("复制示例文字")
		if prepared {
			stepTitle(c, k, tr("收进示例"))
			ck := a.capKey()
			flow(c, k, "cap", vi("file-text", "空白文档"), vk("⌘V", "粘贴"), vk("⌘A", "全选"), vk(ck+" "+ck, "连按两次"))
			label = tr("重新复制示例")
		} else {
			stepTitle(c, k, tr("复制示例"))
			sampleBox(c, k, tr(store.SafeRehearsalText), false)
		}
		btn(label, func() {
			copyText(tr(store.SafeRehearsalText))
			a.transitionOnboarding(store.OnboardingEvent{Type: "samplePrepared"})
			a.showHUD("ok", tr("示例已复制，接下来打开空白文档，按 ⌘ V 粘贴"))
		})
	case store.StepTarget:
		ui.Row(c).Gap(4).AlignItems(ui.Center).Children(func() {
			licon(c, "circle-check", 14, k.ok)
			text(c, tr("示例内容已收好"), 11, 16, 400, k.ok)
		})
		stepTitle(c, k, tr("选粘贴位置"))
		flow(c, k, "tgt", vi("crosshair", "点文档"), vi("locate-fixed", "识别"), vi("circle-check", "确认"))
		ready := a.targetReady()
		ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
			if ready {
				if img := a.appIcon(a.target.BundleID); img != nil {
					ui.Image(c, img).Size(16, 16)
				}
				text(c, fmt.Sprintf(tr("将粘贴到：%s"), targetName(a.target.Name)), 12, 17, 500, k.fg)
			} else {
				licon(c, "circle", 14, k.muted)
				text(c, tr("未识别"), 12, 17, 400, k.muted)
			}
		})
		ui.Row(c).Gap(6).Children(func() {
			if ui.Button(c, tr("识别粘贴位置")).Clicked() {
				*act = a.refreshTargetFromFront
			}
			if ready && ui.Button(c, tr("就粘贴到这里")).Clicked() {
				*act = func() {
					if a.targetReady() {
						a.transitionOnboarding(store.OnboardingEvent{Type: "targetConfirmed"})
					}
				}
			}
		})
	case store.StepFirewall, store.StepDelivery:
		stepTitle(c, k, tr("检查并粘贴"))
		flow(c, k, "fw", vi("shield", "替换邮箱"), vi("eye", "看正文"), vi("clipboard-check", "安全粘贴"))
		chipSwap(c, k, "demo.user@…", "[EMAIL_01]", true)
		if !a.targetReady() { // 重启后目标丢失：先重新识别
			ui.Row(c).Gap(6).Children(func() {
				if ui.Button(c, tr("识别粘贴位置")).Clicked() {
					*act = a.refreshTargetFromFront
				}
			})
			return
		}
		label := tr("查看要粘贴的内容")
		if o.RehearsalStep == store.StepDelivery {
			label = tr("继续检查并粘贴")
		}
		btn(label, a.openSafeRehearsalPreflight)
	}
}

// openSafeRehearsalPreflight 同 Tauri openSafeRehearsalPreflight：真实隐私检查与投递链路，强制不回车、保留面板。
func (a *app) openSafeRehearsalPreflight() {
	o := a.onboarding()
	id := ""
	if o.RehearsalNoteID != nil {
		id = *o.RehearsalNoteID
	}
	n, ok := a.store.Note(id)
	if o.RehearsalStatus != store.RehearsalActive || id == "" || (o.RehearsalStep != store.StepFirewall && o.RehearsalStep != store.StepDelivery) ||
		!ok || !isSafeRehearsalText(n.Text) {
		a.showHUD("warn", tr("演练示例已变化，请从捕获步骤重新开始"))
		return
	}
	if !a.targetReady() {
		a.showHUD("warn", tr("请先重新识别并确认安全目标"))
		return
	}
	a.forceCheck = true
	a.send([]store.Note{n})
	if len(a.pending) == 1 && a.pending[0].ID == id {
		a.pfRehearsal = true
		a.transitionOnboarding(store.OnboardingEvent{Type: "preflightOpened"})
	}
}

// afterCaptured：划词捕获入库后推进演练（示例文本）与还原课（还原了化名）。
func (a *app) afterCaptured(id string, dup, rehearsalText bool, restored int) {
	if o := a.onboarding(); rehearsalText && o.RehearsalStatus == store.RehearsalActive && o.RehearsalStep == store.StepCapture {
		a.transitionOnboarding(store.OnboardingEvent{Type: "sampleCaptured", NoteID: id})
	}
	if !dup && a.lesson != nil {
		a.advanceLesson(lessonAfterCapture(a.lesson.progress, id, restored))
	}
}

// afterDelivered：投递成功后（同 Tauri executeDraft 尾部）——演练记完成；普通发送记 sent 并推进进阶课。
func (a *app) afterDelivered(ids []string, rehearsal bool) {
	if rehearsal {
		o := a.onboarding()
		n, ok := a.store.Note(ids[0])
		if len(ids) == 1 && o.RehearsalStatus == store.RehearsalActive && o.RehearsalNoteID != nil && *o.RehearsalNoteID == ids[0] && ok && isSafeRehearsalText(n.Text) {
			a.transitionOnboarding(store.OnboardingEvent{Type: "deliverySent"})
		} else {
			a.showHUD("warn", tr("演练粘贴按键已执行，但演练会话已变化，未改写上手进度"))
		}
		return
	}
	if st := a.store.Settings(); !st.Onboarding.Sent {
		st.Onboarding = st.Onboarding.Normalized()
		st.Onboarding.Sent = true
		_ = a.store.SetSettings(st)
	}
	if a.lesson != nil {
		a.advanceLesson(lessonAfterDelivery(a.lesson.progress, ids))
	}
}

// ---- 进阶课 ----

func (a *app) advanceLesson(next lessonProgress, changed bool) {
	if !changed || a.lesson == nil {
		return
	}
	a.lesson.progress = next
	if next.step != 3 {
		return
	}
	if next.id == lessonMerge {
		a.transitionOnboarding(store.OnboardingEvent{Type: "mergeTutorialCompleted"})
		a.showHUD("ok", tr("合并发送课完成"))
		return
	}
	a.transitionOnboarding(store.OnboardingEvent{Type: "recoveryTutorialCompleted"})
	a.showHUD("ok", tr("脱敏与还原课完成"))
}

func (a *app) startAdvancedLesson(id string) {
	if a.onboarding().RehearsalStatus == store.RehearsalActive {
		a.showHUD("info", tr("请先完成或暂停基础课，再开始进阶课"))
		a.showNotesPanel()
		return
	}
	a.abandonAdvancedLesson(false) // 重来时先收拾上一轮残留，保证示例卡片只有这一组
	a.lesson = &lessonSession{progress: startLesson(id)}
	a.showNotesPanel()
}

func (a *app) addLessonSample(s string) string {
	n, _, err := a.store.Add(store.Note{Section: store.SectionInbox, Text: tr(s), SourceApp: tr(lessonSampleApp), BundleID: lessonSampleBundle})
	if err != nil {
		return ""
	}
	return n.ID
}

// prepareLessonSamples：第 1 步放入示例（合并课两张卡；还原课一个化名词条 + 一张卡）。
func (a *app) prepareLessonSamples() {
	s := a.lesson
	if s == nil || s.progress.step != 0 {
		return
	}
	a.noteFilter = "" // 示例在收件箱：别让分组筛选挡住
	if s.progress.id == lessonMerge {
		var ids []string
		for _, t := range mergeLessonSamples {
			if id := a.addLessonSample(t); id != "" {
				ids = append(ids, id)
			}
		}
		a.chosen.Clear()
		s.progress, _ = lessonSamplesReady(s.progress, ids, "")
		return
	}
	st := a.store.Settings()
	name := tr(privacyLessonAlias)
	s.prevAliasOff, s.prevNoRestore, s.aliasTouched = st.AliasOff, st.AliasNoAutoRestore, true
	i := slices.IndexFunc(st.AliasEntities, func(e store.AliasEntity) bool { return e.OriginalText == name })
	var aliasID string
	if i >= 0 {
		aliasID = st.AliasEntities[i].ID
	} else {
		ph, next := core.AllocateAliasPlaceholder(core.AliasPresetCategories[0].Code, st.AliasNext)
		now := a.now().UnixMilli()
		aliasID = fmt.Sprintf("alias-%d", time.Now().UnixNano())
		st.AliasEntities = append(slices.Clone(st.AliasEntities), store.AliasEntity{ID: aliasID, Category: core.AliasPresetCategories[0].Code, OriginalText: name, Placeholder: ph, CreatedAtMs: now, UpdatedAtMs: now})
		st.AliasNext = next
		s.aliasCreated = true
	}
	st.AliasOff, st.AliasNoAutoRestore = false, false
	_ = a.store.SetSettings(st)
	var ids []string
	if id := a.addLessonSample(privacyLessonSample); id != "" {
		ids = []string{id}
	}
	s.progress, _ = lessonSamplesReady(s.progress, ids, aliasID)
}

func (a *app) checkLessonSamples() {
	if a.lesson == nil {
		return
	}
	for _, id := range a.lesson.progress.sampleIDs {
		a.chosen.Add(id)
	}
}

// sendLessonSamples：发送示例卡；是否弹出预检、如何粘贴都走正常发送管线。
func (a *app) sendLessonSamples() {
	if a.lesson == nil {
		return
	}
	var notes []store.Note
	for _, id := range a.lesson.progress.sampleIDs {
		if n, ok := a.store.Note(id); ok {
			notes = append(notes, n)
		}
	}
	a.refreshTargetFromFront() // 课程让用户先点文档再回来发送：目标取最近外部前台应用，而不是唤出面板时的旧目标
	a.send(notes)
}

func (a *app) lessonAliasPlaceholder() string {
	if a.lesson == nil {
		return ""
	}
	for _, e := range a.store.Settings().AliasEntities {
		if e.ID == a.lesson.progress.aliasID {
			return e.Placeholder
		}
	}
	return ""
}

func (a *app) copyLessonReply() {
	ph := a.lessonAliasPlaceholder()
	if ph == "" {
		a.showHUD("warn", tr("示例化名已被删除，请重新开始这门课"))
		return
	}
	copyText(privacyLessonReply(ph))
	a.showHUD("ok", tr("模拟回复已复制：粘贴到文档后选中，再双击快捷键收进来"))
}

// removeLessonSamples：只按来源标记（及还原课收回的回复卡）删示例，用户自己的同文卡片不会被误删。
func (a *app) removeLessonSamples() int {
	extra := ""
	if a.lesson != nil {
		extra = a.lesson.progress.replyID
	}
	n := 0
	for _, note := range a.store.Notes() {
		if note.BundleID == lessonSampleBundle || (extra != "" && note.ID == extra) {
			if _, _, ok := a.store.Delete(note.ID); ok {
				n++
			}
		}
	}
	return n
}

// restoreLessonAlias：还原课程改过的化名开关；删除课程新建的化名。
func (a *app) restoreLessonAlias(s *lessonSession) {
	if !s.aliasTouched {
		return
	}
	st := a.store.Settings()
	if s.aliasCreated {
		st.AliasEntities = slices.DeleteFunc(slices.Clone(st.AliasEntities), func(e store.AliasEntity) bool { return e.ID == s.progress.aliasID })
	}
	st.AliasOff, st.AliasNoAutoRestore = s.prevAliasOff, s.prevNoRestore
	_ = a.store.SetSettings(st)
}

// finishAdvancedLesson：完成后清理示例；keepAlias=false 时删除课程新建的化名并还原开关。
func (a *app) finishAdvancedLesson(keepAlias bool) {
	s := a.lesson
	if s == nil {
		return
	}
	n := a.removeLessonSamples()
	if !keepAlias {
		a.restoreLessonAlias(s)
	}
	a.lesson = nil
	if n > 0 {
		a.showHUD("info", fmt.Sprintf(tr("已清理 %d 张教程示例卡片"), n))
	}
}

// abandonAdvancedLesson：中途退出，清理示例并还原课程改动过的设置；notify=false 用于重开前的静默清理。
func (a *app) abandonAdvancedLesson(notify bool) {
	n := a.removeLessonSamples()
	if a.lesson != nil {
		a.restoreLessonAlias(a.lesson)
	}
	a.lesson = nil
	if !notify {
		return
	}
	if n > 0 {
		a.showHUD("info", tr("已退出课程，示例卡片已清理"))
	} else {
		a.showHUD("info", tr("已退出课程"))
	}
}

// lessonCoach 同 Tauri LessonCoach：与基础课同位置同外观，每一步都落在真实操作上。
func (a *app) lessonCoach(c *ui.Context, k tokens) {
	s := a.lesson
	if s == nil {
		return
	}
	if s.progress.id == lessonMerge { // 同 Tauri useEffect(checkedIds)：两张都勾上即前进
		a.advanceLesson(lessonAfterChecked(s.progress, a.chosen.Has))
	}
	p := s.progress
	merge := p.id == lessonMerge
	done := p.step == 3
	ph := cmpOr(a.lessonAliasPlaceholder(), "[USER_01]")
	alias := tr(privacyLessonAlias)
	var act func()
	defer func() {
		if act != nil {
			act()
		}
	}()
	btn := func(label string, fn func()) {
		if ui.Button(c, label).Clicked() {
			act = fn
		}
	}
	name, icon := tr("智能脱敏与还原"), "venetian-mask"
	if merge {
		name, icon = tr("合并发送"), "layers"
	}
	coachBox(c, k, "lesson").Children(func() {
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			ui.Box(c).Size(28, 28).Radius(8).Background(k.track).Center().Children(func() { licon(c, icon, 14, k.fg) })
			ui.Column(c).Grow(1).Basis(0).Children(func() {
				text(c, fmt.Sprintf(tr("进阶 · %s"), name), 13, 18, 600, k.fg).SingleLine()
				if done {
					text(c, tr("已完成"), 10, 14, 400, k.ok)
				}
			})
			if !done && linkButton(c, k, "lesson-quit", tr("退出")) {
				act = func() { a.abandonAdvancedLesson(true) }
			}
		})
		stepDots(c, k, lessonSteps[p.id], p.step)
		stepBody(c, k, func() {
			switch {
			case merge && p.step == 0:
				stepTitle(c, k, tr("放入两张示例卡片"))
				flow(c, k, "m0", vi("inbox", "收件箱"), vi("tag", "教程标记"), vi("trash-2", "自动清理"))
				ui.Row(c).Children(func() { btn(tr("放入示例卡片"), a.prepareLessonSamples) })
			case merge && p.step == 1:
				n := 0
				for _, id := range p.sampleIDs {
					if a.chosen.Has(id) {
						n++
					}
				}
				ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
					stepTitle(c, k, tr("勾选这两张卡片"))
					for i := range 2 {
						if i < n {
							licon(c, "circle-check", 14, k.ok)
						} else {
							licon(c, "circle", 14, k.muted)
						}
					}
				})
				flow(c, k, "m1", vi("crosshair", "点圆圈"), vk("X", "或按 X"))
				ui.Row(c).Children(func() { btn(tr("帮我勾选"), a.checkLessonSamples) })
			case merge && p.step == 2:
				stepTitle(c, k, tr("一起发送"))
				flow(c, k, "m2", vi("crosshair", "点文档"), vk("⌘⏎", "发送"), vi("layers", "合成一次"))
				ui.Row(c).Children(func() { btn(tr("发送这两张"), a.sendLessonSamples) })
			case merge:
				stepTitle(c, k, tr("完成：两张卡合成了一次发送"))
				flow(c, k, "m3", vi("copy-check", "勾选多张"), vk("⌘⏎", "一起发"))
				ui.Row(c).Children(func() { btn(tr("完成并清理示例"), func() { a.finishAdvancedLesson(true) }) })
			case p.step == 0:
				stepTitle(c, k, tr("准备示例"))
				chipSwap(c, k, alias, ph, false)
				ui.Row(c).Children(func() { btn(tr("准备示例"), a.prepareLessonSamples) })
			case p.step == 1:
				stepTitle(c, k, tr("发送这张示例卡"))
				chipSwap(c, k, alias, ph, true)
				chipSwap(c, k, "demo.user@…", "[EMAIL_01]", true)
				ui.Row(c).Children(func() { btn(tr("发送示例"), a.sendLessonSamples) })
			case p.step == 2:
				stepTitle(c, k, tr("把 AI 的回复收回来"))
				ck := a.capKey()
				flow(c, k, "p2", vi("copy", "复制回复"), vk("⌘V", "粘贴"), vk("⌘A", "全选"), vk(ck+" "+ck, "连按两次"))
				sampleBox(c, k, privacyLessonReply(ph), true)
				ui.Row(c).Children(func() { btn(tr("复制模拟回复"), a.copyLessonReply) })
			default:
				stepTitle(c, k, tr("完成：收回时自动还原"))
				chipSwap(c, k, ph, alias, true)
				ui.Row(c).Gap(6).Children(func() {
					btn(tr("保留化名"), func() { a.finishAdvancedLesson(true) })
					btn(tr("删除化名"), func() { a.finishAdvancedLesson(false) })
				})
			}
		})
	})
}

// ---- 首启导览 ----

// tourIllustration 同 Tauri TourScene kind="welcome"：按拍循环（每拍 1.7s，共 4 拍）——
// 0 两处来源高亮 + 双击键帽 → 1 两张卡收进 Toskr → 2 勾选 + ⌘⏎ → 3 一起发给 AI，邮箱已替换为 [EMAIL_01]。
// 减少动态效果时停在最后一拍（完整结果）。
const tourBeatMs, tourBeats = 1700, 4

var tourEpoch = time.Now()

func (a *app) tourIllustration(c *ui.Context, k tokens) {
	beat := tourBeats - 1
	if !c.Preferences().ReduceMotion {
		beat = int(time.Since(tourEpoch).Milliseconds()/tourBeatMs) % tourBeats
		c.AnimationFrame()
	}
	key := map[string]string{"shift": "⇧", "control": "⌃", "option": "⌥"}[a.store.Settings().TriggerModifier]
	if key == "" {
		key = "⇧"
	}
	p := stok(c).primary
	fade := func(e ui.Element, id string, on bool) ui.Element {
		to := float32(0)
		if on {
			to = 1
		}
		return e.Opacity(e.AnimateTo(id, to, tweenTw))
	}
	win := func(title string, w float32, body func()) ui.Element {
		return ui.Column(c).Grow(1).Basis(0).Clip().Padding(6, 8).Gap(5).Radius(8).Background(k.card).Border(1, k.inputBorder).Children(func() {
			ui.Row(c).Gap(3).AlignItems(ui.Center).Children(func() {
				ui.Box(c).Size(5, 5).Radius(2.5).Background(k.inputBorder)
				ui.Box(c).Size(5, 5).Radius(2.5).Background(k.inputBorder)
				text(c, title, 9, 12, 400, k.muted).Margin(0, 0, 0, 3)
			})
			body()
		})
	}
	bar := func(w float32) { ui.Box(c).Size(w, 5).Radius(2).Background(k.track) }
	keycap := func(id, label string, show bool) {
		fade(ui.Row(c).Height(18).Padding(0, 6).Radius(4).Background(k.window).Border(1, k.inputBorder).AlignItems(ui.Center).AlignSelf(ui.Center).Key(id), id, show).
			Children(func() { text(c, label, 10, 14, 500, k.fg) })
	}
	srcLine := func(id, label string) {
		hl := ui.Row(c).Height(12).Padding(0, 3).Radius(3).AlignItems(ui.Center).Key(id)
		hl.Background(p.Alpha(0.18 * hl.AnimateTo("hl", map[bool]float32{true: 1, false: 0.35}[beat == 0], tweenTw)))
		hl.Children(func() { text(c, label, 9, 12, 400, k.fg).SingleLine() })
	}
	card := func(id, label string) {
		b := ui.Row(c).Height(22).Padding(0, 6).Gap(5).Radius(6).Background(k.window).AlignItems(ui.Center).Key(id)
		b.Border(1, b.AnimateColor("bd", map[bool]ui.Color{true: p, false: k.inputBorder}[beat == 2], tweenTw))
		fade(b, "in", beat >= 1)
		b.AnimatePose(ui.Pose{Y: map[bool]float32{true: 0, false: -14}[beat >= 1]}, springSnappy)
		b.Children(func() {
			dot := ui.Box(c).Size(9, 9).Radius(4.5).Border(1, map[bool]ui.Color{true: p, false: k.muted}[beat >= 2])
			dot.Background(dot.AnimateColor("chk", map[bool]ui.Color{true: p, false: ui.Transparent}[beat >= 2], tweenTw))
			text(c, label, 9, 12, 400, k.fg).SingleLine()
		})
	}
	sent := beat >= 3
	ui.Column(c).Padding(8).Gap(6).Radius(12).Background(k.track).Key("tour-scene").
		Label(tr("演示：从浏览器和文档各收一段文字，勾选后一起发送给 AI，邮箱自动替换")).Children(func() {
		ui.Row(c).Gap(8).Children(func() {
			win(tr("浏览器"), 150, func() { bar(110); srcLine("src-a", "TypeError: cannot read…"); bar(80) })
			win(tr("文档"), 150, func() { bar(100); srcLine("src-b", tr("联系人 demo.user@…")); bar(70) })
		})
		keycap("kc-cap", key+" "+key, beat == 0)
		ui.Row(c).Gap(8).AlignItems(ui.Start).Children(func() {
			win("Toskr", 150, func() {
				cards := ui.Column(c).Gap(5).Key("tour-cards")
				cards.Opacity(cards.AnimateTo("dim", map[bool]float32{true: 0.4, false: 1}[sent], tweenTw)).Children(func() {
					card("tc1", "TypeError: cannot read…")
					card("tc2", tr("联系人 demo.user@…"))
				})
				fade(ui.Box(c).Key("tour-sent"), "op", sent).Children(func() { text(c, tr("已一起发送 2 张 ✓"), 9, 12, 400, k.muted) })
				keycap("kc-send", "⌘ ⏎", beat == 2)
			})
			win(tr("AI 对话"), 150, func() {
				ui.Box(c).Size(100, 14).Radius(7).Background(k.track)
				msg := fade(ui.Column(c).Padding(6, 8).Gap(4).Radius(8).Background(k.window).Border(1, p).Key("tour-msg"), "op", sent)
				msg.AnimatePose(ui.Pose{Y: map[bool]float32{true: 0, false: 10}[sent]}, springSnappy)
				msg.Children(func() {
					text(c, "TypeError: cannot read…", 9, 12, 400, k.fg).SingleLine()
					ui.Row(c).Gap(3).AlignItems(ui.Center).Children(func() {
						text(c, tr("联系人"), 9, 12, 400, k.fg)
						ui.Box(c).Padding(1, 3).Radius(3).Background(k.ok.Alpha(0.18)).Children(func() {
							text(c, "[EMAIL_01]", 9, 12, 500, k.ok).Font(fontMono)
						})
					})
				})
				fade(ui.Box(c).Key("tour-note"), "op", sent).Children(func() { text(c, tr("邮箱发送前已自动替换"), 9, 12, 400, k.muted) })
			})
		})
	})
}

// welcomeTour 同 Tauri WelcomeTour：盖住面板内容的首启导览。
func (a *app) welcomeTour(c *ui.Context, k tokens) {
	if !a.tourOpen || a.store.Settings().WelcomeTourSeen { // 导入了「已看过」的 Tauri 数据：立即收起
		a.tourOpen = false
		return
	}
	w, h := c.Size()
	var act func()
	defer func() {
		if act != nil {
			act()
		}
	}()
	ui.Overlay(c, func() {
		ui.Column(c).Absolute().Left(0).Top(0).Size(w, h).Radius(14).Background(c.Theme().Background).Key("welcome-tour").Role(ui.RoleDialog).Label(tr("新手导览")).Children(func() {
			ui.Scroll(c).Fill().Scrollbars(false).Children(func() {
				ui.Column(c).Padding(24, 20).Gap(20).MaxWidth(420).MinHeight(h).Justify(ui.Center).Children(func() {
					ui.Column(c).Gap(4).Children(func() {
						text(c, tr("欢迎使用 Toskr"), 11, 16, 400, k.muted)
						text(c, tr(welcomeTourTitle), 17, 24, 600, k.fg).Wrap()
					})
					a.tourIllustration(c, k)
					ck := a.capKey()
					ui.Row(c).Gap(8).Children(func() { // 要点改为图标格（用户要求少文字），原句作悬停提示与无障碍标签
						for i, pt := range []vstep{vk(ck+" "+ck, "收集"), vk("⌘⏎", "合并发送"), vi("shield-check", "自动脱敏")} {
							t := ui.Column(c).Grow(1).Basis(0).Padding(10, 4).Gap(6).Radius(10).Background(k.track).AlignItems(ui.Center).
								Key("tour-pt-" + itoa(i)).Label(tr(welcomeTourPoints[i])).Tooltip(tr(welcomeTourPoints[i]))
							t.Children(func() {
								if pt.icon != "" {
									ui.Box(c).Height(24).Center().Children(func() { licon(c, pt.icon, 20, k.ok) })
								} else {
									ui.Row(c).Height(24).Padding(0, 8).Radius(6).Background(k.window).Border(1, k.inputBorder).AlignItems(ui.Center).
										Children(func() { text(c, pt.key, 12, 16, 600, k.fg) })
								}
								text(c, tr(pt.label), 11, 16, 500, k.fg).SingleLine()
							})
						}
					})
					ui.Column(c).Gap(8).Children(func() {
						if ui.Button(c, tr("花 1 分钟试一下")).FillWidth().Clicked() {
							act = func() { a.leaveTour(true) }
						}
						ui.Row(c).Justify(ui.Center).Children(func() {
							if linkButton(c, k, "tour-skip", tr("直接开始使用")) { // 悬停见 tour-skip 提示
								act = func() { a.leaveTour(false) }
							}
						})
						// 「随时可在设置继续学习」改为跳过按钮的悬停提示，不占正文
					})
				})
			})
		})
	})
}

// ---- 设置 → 帮助与更新 →「上手课程」 ----

func (a *app) learningSection(c *ui.Context, s settingsTokens, st store.Settings) setSection {
	o := st.Onboarding.Normalized()
	basicDone := 0
	for _, ok := range []bool{o.Captured || o.Sent, o.Sent || (o.RehearsalNoteID != nil && (o.RehearsalStep == store.StepFirewall || o.RehearsalStep == store.StepDelivery)), o.Sent} {
		if ok {
			basicDone++
		}
	}
	complete := basicDone == 3
	resumable := o.RehearsalStatus == store.RehearsalPaused || o.RehearsalStatus == store.RehearsalActive
	unlocked := complete || o.Sent // 进阶课需要能真实发送：基础课完成或已经发送过内容即可解锁
	meta := fmt.Sprintf(tr("3 步 · 已完成 %d / 3"), basicDone)
	label, mode := "开始", "start"
	switch {
	case complete:
		meta, label = tr("3 步 · 已完成"), "重新练习"
	case resumable:
		label, mode = "继续", "resume"
	}
	lessonRow := func(id, title, desc, meta string, doneAt *int64) setRow {
		if doneAt != nil {
			title += " ✓"
		}
		return setRow{title: tr(title), hint: tr(desc) + " · " + tr(meta), control: func() {
			if !unlocked {
				ui.Row(c).Gap(4).AlignItems(ui.Center).Children(func() {
					licon(c, "lock-keyhole", 13, tok(c).muted)
					text(c, tr("先完成基础课"), 11, 16, 400, tok(c).muted)
				})
				return
			}
			l := "开始"
			if doneAt != nil {
				l = "再练一次"
			}
			if button(c, s, l) {
				a.startAdvancedLesson(id)
			}
		}}
	}
	basicTitle := tr("基础：收集并粘贴")
	if complete {
		basicTitle += " ✓"
	}
	return setSection{tr("上手课程"), []setRow{
		{title: basicTitle, hint: tr("收进一条内容，选好粘贴位置，检查后粘贴") + " · " + meta, control: func() {
			if button(c, s, label) {
				a.startRehearsal(mode)
			}
		}},
		lessonRow(lessonMerge, "进阶：合并发送", "勾选多张卡片，按 ⌘⏎ 合成一次粘贴", "3 步 · 使用示例卡片，结束时自动清理", o.MergeTutorialCompletedAtMs),
		lessonRow(lessonPrivacy, "进阶：智能脱敏与还原", "发送时把名字换成占位符，收回 AI 回复时自动还原", "3 步 · 使用示例化名，结束时可保留或删除", o.RecoveryTutorialCompletedAtMs),
		{title: tr("新手导览"), hint: tr("重看首次打开时的动画演示"), control: func() {
			if button(c, s, "重看导览") {
				cur := a.store.Settings()
				cur.WelcomeTourSeen = false
				_ = a.store.SetSettings(cur)
				if a.panel != nil {
					a.showPanel()
				}
				a.showHUD("ok", tr("导览已就绪，回到主面板查看"))
			}
		}},
	}}
}

func init() { // 首启导览 / 安全发送演练 / 进阶课（onboarding.go、lessons.go）
	for k, v := range map[string]string{
		"3 步 · 使用示例化名，结束时可保留或删除": "3 steps · uses sample aliases; keep or delete them at the end",
		"3 步 · 使用示例卡片，结束时自动清理":   "3 steps · uses sample cards, cleaned up at the end",
		"3 步 · 已完成":        "3 steps · Done",
		"3 步 · 已完成 %d / 3": "3 steps · %d / 3 done",
		"AI 只看到占位符，你收回的内容自动变回原文。示例化名要保留吗？": "AI only sees the placeholder, and what you capture back is restored automatically. Keep the sample alias?",
		"Toskr 教程": "Toskr Tutorial",
		"Toskr 正在重试。如果一直停在这里，请检查辅助功能中的 Toskr 开关。": "Toskr is retrying. If this persists, check Toskr's Accessibility switch.",
		"一步一步试用 · 不会自动按回车":                        "Step by step · never presses Return",
		"一起发送": "Send Together",
		"上手教程": "Tutorial",
		"上手课程": "Getting started lessons",
		"下一页会标出示例里的邮箱。选择替换后，检查正文，再点「安全粘贴」。": "The next page flags the email in the sample. Replace it, check the text, then click \"Safe Paste\".",
		"以后勾选多张卡片，按 ⌘⏎ 就能一起发。":              "From now on, select several cards and press ⌘⏎ to send them together.",
		"会放进收件箱，带「Toskr 教程」标记，完成后自动清理。":     "They go into Inbox tagged “Toskr Tutorial” and are removed when you finish.",
		"会添加化名「%s」和一张示例卡片，并打开「捕获时自动还原」。":    "Adds the alias “%s” and a sample card, and turns on “Restore on capture”.",
		"保留化名":              "Keep Alias",
		"先允许 Toskr 读取选中的文字": "First, let Toskr read selected text",
		"先复制这段示例":           "First, copy this sample",
		"先完成基础课":            "Finish basics first",
		"先点一下文档或 AI 输入框的空白处，再回来发送；两张卡会合成一次粘贴。": "Click an empty spot in a document or AI input box first, then come back and send. Both cards are pasted as one.",
		"再练一次": "Practice Again",
		"准备示例": "Prepare Sample",
		"删除化名": "Delete Alias",
		"勾选两张": "Select Both",
		"勾选多张卡片，按 ⌘⏎ 合成一次粘贴": "Select several cards and press ⌘⏎ to paste them together",
		"勾选多张，⌘⏎ 合成一次粘贴":     "Select several cards and press ⌘⏎ to paste them together",
		"勾选这两张卡片":            "Select both cards",
		"卡片 1":               "Card 1",
		"卡片 2":               "Card 2",
		"发送并替换":              "Send & Replace",
		"发送时「%s」会换成 %s，邮箱会被隐私检查发现并替换。先点一下文档空白处，再发送。": "When sent, “%s” becomes %s, and the privacy check finds and replaces the email. Click an empty spot in a document first, then send.",
		"发送时把名字换成占位符，收回 AI 回复时自动还原":                  "Replace names with placeholders when sending; restore them when capturing AI replies",
		"发送示例":    "Send Sample",
		"发送这两张":   "Send Both",
		"发送这张示例卡": "Send the sample card",
		"合并发送":    "Merge Send",
		"合并发送课完成": "Merge-send lesson complete",
		"回到 Toskr，点「识别粘贴位置」，再确认应用名称。": "Return to Toskr, click \"Detect Target\", then confirm the app name.",
		"回到刚才的空白文档，点击一处空白，让光标停在那里。":   "Go back to the blank document and click an empty spot to place the cursor.",
		"在系统设置中找到 Toskr，打开开关，然后回到这里。": "Find Toskr in System Settings, turn it on, then come back.",
		"基础：收集并粘贴": "Basics: Capture and Paste",
		"复制下面这段模拟回复，粘贴到文档后选中，再连按两次 %s 收进来": "Copy the sample reply below, paste it into a document, select it, then double-tap %s to capture it",
		"复制模拟回复": "Copy Sample Reply",
		"复制示例文字": "Copy Sample",
		"复现：修改标题 → 点保存 → 刷新页面，改动消失": "Repro: edit the title → click Save → refresh; the change is gone",
		"好的，已把会议纪要发给 %s。":           "Done. I sent the meeting notes to %s.",
		"安全粘贴": "Safe Paste",
		"完成后，文字会出现在刚才的文档中。教程不会自动按回车。": "The text will then appear in that document. The tutorial never presses Return.",
		"完成并清理示例":        "Finish & Clean Up",
		"完成：%s 已还原成「%s」": "Done: %s was restored to “%s”",
		"完成：两张卡合成了一次发送":  "Done: two cards went out as one send",
		"导览已就绪，回到主面板查看":  "Tour ready. Switch to the main panel to view it",
		"将粘贴到：%s":        "Will paste into: %s",
		"就粘贴到这里":         "Paste Here",
		"已完成":            "Completed",
		"已清理 %d 张教程示例卡片": "Cleaned up %d tutorial sample cards",
		"已退出教程，可在「设置 → 帮助与更新」重新开始": "Tutorial exited. Restart in Settings → Help & Updates",
		"已退出课程":         "Lesson exited",
		"已退出课程，示例卡片已清理": "Lesson exited; sample cards cleaned up",
		"帮我勾选":          "Select for Me",
		"开始":            "Start",
		"开始收一条内容":       "Capture Something",
		"张三":            "Alex Chen",
		"快捷键已准备好":       "Shortcut is ready",
		"快捷键还没准备好":      "Shortcut isn't ready yet",
		"打开「文本编辑」等空白文档，按 ⌘ V 粘贴。":                   "Open a blank document (e.g. TextEdit) and press ⌘ V to paste.",
		"打开「输入监控」，开启 Toskr。如果已经开启但仍无反应，可重置授权后重新开启。": "Open Input Monitoring and turn on Toskr. If it's on but nothing happens, reset the permission and turn it on again.",
		"打开辅助功能设置":                                  "Open Accessibility",
		"打开输入监控设置":                                  "Open Input Monitoring",
		"把 AI 的回复收回来":                               "Capture the AI's reply",
		"把散落各处的文字，一次安全地交给 AI":                       "Gather text from anywhere and hand it to AI safely, in one go",
		"把示例文字收进 Toskr":                             "Capture the sample text into Toskr",
		"报错：点击保存后控制台出现 TypeError: cannot read 'id'": "Bug: clicking Save logs TypeError: cannot read 'id' in the console",
		"按 ⌘ ⏎ 一起发送":                                "Press ⌘ ⏎ to send together",
		"按一下键盘，确认快捷键可用":                             "Press a key to confirm the shortcut works",
		"收回并还原":                                     "Capture & Restore",
		"收好后，Toskr 会自动进入下一步。":                       "Once captured, Toskr moves to the next step.",
		"收进一条内容，选好粘贴位置，检查后粘贴":                       "Capture an item, choose where to paste, review, then paste",
		"收进内容":                                      "Capture",
		"放入两张示例卡片":                                  "Add two sample cards",
		"放入示例卡片":                                    "Add Sample Cards",
		"教程已暂停":                                     "Tutorial paused",
		"教程已暂停，可在「设置 → 帮助与更新」继续":                    "Tutorial paused. Resume in Settings → Help & Updates",
		"文档":      "Docs",
		"新手导览":    "Welcome Tour",
		"智能脱敏与还原": "Smart Masking & Restore",
		"最后，检查一下要粘贴的内容": "Finally, check what will be pasted",
		"查看要粘贴的内容":      "Review Content",
		"检查并粘贴":         "Review and paste",
		"检查辅助功能设置":      "Check Accessibility Settings",
		"模拟回复已复制：粘贴到文档后选中，再双击快捷键收进来": "Sample reply copied. Paste it into a document, select it, then double-tap the shortcut to capture it",
		"欢迎使用 Toskr": "Welcome to Toskr",
		"浏览器":        "Browser",
		"演示：从浏览器和文档各收一段文字，勾选后一起发送给 AI，邮箱自动替换": "Demo: capture text from a browser and a document, select both, and send them to AI together with the email replaced",
		"演练安全锁：只粘贴，不按回车":                      "Practice lock: paste only, no Return",
		"演练示例已变化，请从捕获步骤重新开始":                  "The rehearsal sample changed; start again from the capture step",
		"演练粘贴按键已执行，但演练会话已变化，未改写上手进度":          "Practice paste was sent, but the session changed; tutorial progress not updated",
		"点卡片左侧的圆圈，或选中后按 X。已勾选 %d / 2。":        "Click the circle on the left of each card, or select it and press X. %d / 2 selected.",
		"用这段示例试着收进第一张卡片。":                     "Use this sample to capture your first card.",
		"直接开始使用": "Start Using Toskr",
		"确认正文后，点下方「安全粘贴」。教程不会自动按回车。": "After checking the text, click \"Safe Paste\" below. The tutorial never presses Return.",
		"示例内容已收好":                  "Sample captured",
		"示例化名已被删除，请重新开始这门课":        "The sample alias was deleted. Restart this lesson.",
		"示例已复制，接下来打开空白文档，按 ⌘ V 粘贴": "Sample copied. Now open a blank document and press ⌘ V",
		"稍后继续": "Later",
		"第 %d 步，共 3 步 · 不会自动按回车": "Step %d of 3 · Never presses Enter",
		"继续":        "Continue",
		"继续教程":      "Resume",
		"继续检查并粘贴":   "Continue Review",
		"脱敏与还原课完成":  "Masking & restore lesson complete",
		"花 1 分钟试一下": "Try It in 1 Minute",
		"识别粘贴位置":    "Detect Target",
		"请先完成或暂停基础课，再开始进阶课":                        "Finish or pause the basic lesson before starting an advanced one",
		"请先重新识别并确认安全目标":                            "Re-detect and confirm a safe target first",
		"请把会议纪要发给张三，抄送 demo.user@example.com。":     "Please send the meeting notes to Alex Chen, cc demo.user@example.com.",
		"请把这段内容概括成一句话。示例邮箱 demo.user@example.com。": "Summarize this in one sentence. Sample email: demo.user@example.com.",
		"请按一下空格键。显示准备好后，点击按钮继续。":                   "Press Space once. When it shows ready, click the button to continue.",
		"还没有可用的粘贴位置":                               "No paste target yet",
		"还需要允许 Toskr 接收按键":                         "Toskr still needs to receive key presses",
		"这段内容要粘贴到哪里？":                              "Where should this be pasted?",
		"进度已保存在本机，可在「设置 → 帮助与更新」继续。":               "Progress is saved on this Mac. Resume in Settings → Help & Updates.",
		"进阶 · %s":    "Advanced · %s",
		"进阶：合并发送":    "Advanced: Merge and Send",
		"进阶：智能脱敏与还原": "Advanced: Smart Masking and Restore",
		"连按两次 %s 键：按下、松开，再按一下。": "Double-tap %s: press, release, press again.",
		"退出":          "Exit",
		"退出教程":        "Exit tutorial",
		"选中刚粘贴的整段文字。": "Select all the text you just pasted.",
		"选中文字，连按两次快捷键收成卡片": "Select text and double-tap the shortcut to capture it as a card",
		"选择位置": "Choose Target",
		"邮箱、密钥等敏感信息发送前自动替换": "Emails, keys, and other sensitive data are replaced before sending",
		"重新复制示例":       "Copy Again",
		"重新练习":         "Practice Again",
		"重看导览":         "Replay Tour",
		"重看首次打开时的动画演示": "Replay the first-launch animated tour",
		"重置输入监控授权":     "Reset Input Monitoring",
		"随时可在「设置 → 帮助与更新」继续学习": "Continue anytime in Settings → Help & Updates",
	} {
		if _, ok := en[k]; !ok {
			en[k] = v
		}
	}
}
