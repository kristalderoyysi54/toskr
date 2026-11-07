package main

import (
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/core"
	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// keySys 记录投递时按下的键（演练安全锁：只许 ⌘V，不许回车）。
type keySys struct {
	recSys
	kmu  sync.Mutex
	keys []uint16
}

func (k *keySys) PostKey(code uint16, _ uint64) {
	k.kmu.Lock()
	k.keys = append(k.keys, code)
	k.kmu.Unlock()
}
func (k *keySys) posted() []uint16 { k.kmu.Lock(); defer k.kmu.Unlock(); return slices.Clone(k.keys) }

func stubCopy(t *testing.T) *string {
	var got string
	prev := copyText
	copyText = func(s string) { got = s }
	t.Cleanup(func() { copyText = prev })
	return &got
}

func mustClick(t *testing.T, tt *ui.Tester, label string) {
	t.Helper()
	if err := tt.Click(label); err != nil {
		t.Fatalf("点不到 %q：%v\n%v", label, err, tt.Texts())
	}
	tt.Frame()
}

func TestWelcomeTourRehearse(t *testing.T) {
	a, tt := testApp(t)
	a.maybeOpenTour() // 全新数据目录：首次唤出面板时盖上导览
	tt.Frame()
	for _, s := range append([]string{"欢迎使用 Toskr", welcomeTourTitle, "花 1 分钟试一下", "直接开始使用", "合并发送"}, welcomeTourPoints...) {
		if !tt.HasText(s) {
			t.Fatalf("导览缺 %q：%v", s, tt.Texts())
		}
	}
	mustClick(t, tt, "花 1 分钟试一下")
	st := a.store.Settings()
	if !st.WelcomeTourSeen || a.tourOpen || st.Onboarding.RehearsalStatus != store.RehearsalActive || a.page != pageNotes {
		t.Fatalf("%+v tour=%v page=%d", st.Onboarding, a.tourOpen, a.page)
	}
	if !tt.HasText("上手教程") || !tt.HasText("不会自动按回车") || tt.HasText("还没有内容") {
		t.Fatal(tt.Texts())
	}
	a.maybeOpenTour()
	if a.tourOpen {
		t.Fatal("看过导览后再唤出面板不应再弹")
	}
}

func TestWelcomeTourUseNowAndImportedSeen(t *testing.T) {
	a, tt := testApp(t)
	a.maybeOpenTour()
	tt.Frame()
	mustClick(t, tt, "直接开始使用")
	if st := a.store.Settings(); !st.WelcomeTourSeen || st.Onboarding.Normalized().RehearsalStatus != store.RehearsalNotStarted {
		t.Fatalf("直接使用只记看过、不启动演练 %+v", st.Onboarding)
	}
	if tt.HasText("上手教程") {
		t.Fatal(tt.Texts())
	}

	// 导览开着时导入了 welcomeTourSeen=true 的 Tauri 数据：下一帧即收起
	b, bt := testApp(t)
	b.maybeOpenTour()
	st := b.store.Settings()
	st.WelcomeTourSeen = true
	_ = b.store.SetSettings(st)
	bt.Frame()
	if b.tourOpen || bt.HasText("花 1 分钟试一下") {
		t.Fatal(bt.Texts())
	}
	b.maybeOpenTour()
	if b.tourOpen {
		t.Fatal("已看过导览的用户不应再看到")
	}
}

func TestSafeRehearsalFlow(t *testing.T) {
	copied := stubCopy(t)
	a, tt := testApp(t)
	sys := &keySys{}
	a.sys = sys
	a.startRehearsal("start")
	tt.Frame()
	if !tt.HasText("快捷键准备中") { // 监听还没建起来
		t.Fatal(tt.Texts())
	}
	a.tapStarted = time.Now()
	a.tapReceiving.Store(true)
	tt.Frame()
	mustClick(t, tt, "开始收一条内容")
	mustClick(t, tt, "复制示例文字")
	o := a.onboarding()
	if *copied != store.SafeRehearsalText || o.RehearsalStep != store.StepCapture || o.ActivationStartedAtMs == nil {
		t.Fatalf("%q %+v", *copied, o)
	}
	if !tt.HasText("收进示例") || !tt.HasText("⌥ ⌥") {
		t.Fatal(tt.Texts())
	}

	// 别的文字不推进；示例文本被捕获才推进
	other, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: "随便一段"})
	a.afterCaptured(other.ID, false, isSafeRehearsalText(other.Text), 0)
	if a.onboarding().RehearsalStep != store.StepCapture {
		t.Fatal("非示例文本不应推进")
	}
	sample, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: store.SafeRehearsalText})
	a.afterCaptured(sample.ID, false, isSafeRehearsalText(sample.Text), 0)
	tt.Frame()
	if o := a.onboarding(); o.RehearsalStep != store.StepTarget || *o.RehearsalNoteID != sample.ID || !o.Captured {
		t.Fatalf("%+v", o)
	}
	if !tt.HasText("示例内容已收好") || !tt.HasText("未识别") || tt.HasText("就粘贴到这里") {
		t.Fatal(tt.Texts())
	}
	sys.front = 42
	mustClick(t, tt, "识别粘贴位置")
	if !tt.HasText("将粘贴到：（未知应用）") {
		t.Fatal(tt.Texts())
	}
	mustClick(t, tt, "就粘贴到这里")
	if a.onboarding().RehearsalStep != store.StepFirewall {
		t.Fatal(a.onboarding().RehearsalStep)
	}

	// 发送方案即便允许回车，演练也强制只粘贴
	mustClick(t, tt, "查看要粘贴的内容")
	if !a.pfRehearsal || len(a.pending) != 1 || a.onboarding().RehearsalStep != store.StepDelivery {
		t.Fatalf("pf=%v pending=%d %s", a.pfRehearsal, len(a.pending), a.onboarding().RehearsalStep)
	}
	for _, s := range []string{"检查并粘贴", "演练安全锁：只粘贴，不按回车", "一键全部替换"} {
		if !tt.HasText(s) {
			t.Fatalf("缺 %q：%v", s, tt.Texts())
		}
	}
	if a.pfEvaluate(a.pfPolicy()).canSend {
		t.Fatal("邮箱未处理前不能粘贴")
	}
	mustClick(t, tt, "一键全部替换")
	if !strings.Contains(a.pending[0].Text, "[EMAIL_01]") {
		t.Fatal(a.pending[0].Text)
	}
	mustClick(t, tt, "安全粘贴")
	waitFor(t, func() bool { return len(sys.sent()) > 0 })
	if got := sys.sent()[0]; !strings.Contains(got, "[EMAIL_01]") || strings.Contains(got, "demo.user@") {
		t.Fatalf("粘贴的应是替换后的文本 %q", got)
	}
	time.Sleep(50 * time.Millisecond) // 投递在后台：等它把按键都按完
	if slices.Contains(sys.posted(), core.KeyReturn) {
		t.Fatalf("演练不许按回车 %v", sys.posted())
	}
	if a.pfRehearsal {
		t.Fatal("投递后演练标记应清掉")
	}
	a.afterDelivered([]string{sample.ID}, true) // 视图测试无主循环：手动执行投递回调
	if o := a.onboarding(); o.RehearsalStatus != store.RehearsalCompleted || !o.Done || !o.Sent {
		t.Fatalf("%+v", o)
	}
	tt.Frame()
	if tt.HasText("上手教程") {
		t.Fatal("完成后演练卡应消失")
	}
}

func TestRehearsalPauseSkip(t *testing.T) {
	a, tt := testApp(t, "已有笔记")
	a.startRehearsal("start")
	tt.Frame()
	mustClick(t, tt, "稍后继续")
	if !tt.HasText("教程已暂停") || a.onboarding().RehearsalStatus != store.RehearsalPaused {
		t.Fatal(tt.Texts())
	}
	mustClick(t, tt, "继续教程")
	mustClick(t, tt, "退出教程")
	if a.onboarding().RehearsalStatus != store.RehearsalSkipped || tt.HasText("上手教程") || !tt.HasText("已有笔记") {
		t.Fatal(tt.Texts())
	}
}

func TestMergeLesson(t *testing.T) {
	a, tt := testApp(t, "我的笔记")
	a.startRehearsal("start")
	a.startAdvancedLesson(lessonMerge)
	if a.lesson != nil {
		t.Fatal("基础课进行中不能开进阶课")
	}
	a.transitionOnboarding(store.OnboardingEvent{Type: "pause"})
	a.transitionOnboarding(store.OnboardingEvent{Type: "skip"})
	a.startAdvancedLesson(lessonMerge)
	tt.Frame()
	if !tt.HasText("进阶 · 合并发送") || !tt.HasText("放入两张示例卡片") {
		t.Fatal(tt.Texts())
	}
	a.prepareLessonSamples() // 按钮与进度第 1 步同名，Click 会点到进度文字
	tt.Frame()
	ids := a.lesson.progress.sampleIDs
	if len(ids) != 2 || a.lesson.progress.step != 1 {
		t.Fatalf("%+v", a.lesson.progress)
	}
	for _, id := range ids {
		if n, _ := a.store.Note(id); n.BundleID != lessonSampleBundle || n.SourceApp != lessonSampleApp {
			t.Fatalf("%+v", n)
		}
	}
	if !tt.HasText("勾选这两张卡片") {
		t.Fatal(tt.Texts())
	}
	mustClick(t, tt, "帮我勾选")
	tt.Frame()
	if a.lesson.progress.step != 2 || !tt.HasText("一起发送") {
		t.Fatal(tt.Texts())
	}
	a.afterDelivered(ids[:1], false) // 只发了一张：不算
	if a.lesson.progress.step != 2 {
		t.Fatal("合并课要求一次发送全部示例卡")
	}
	a.afterDelivered(ids, false)
	if o := a.onboarding(); a.lesson.progress.step != 3 || o.MergeTutorialCompletedAtMs == nil || !o.Sent {
		t.Fatalf("%+v", o)
	}
	tt.Frame()
	mustClick(t, tt, "完成并清理示例")
	if a.lesson != nil || slices.ContainsFunc(a.store.Notes(), func(n store.Note) bool { return n.BundleID == lessonSampleBundle }) {
		t.Fatal("示例卡应已清理")
	}
	if !tt.HasText("我的笔记") {
		t.Fatal("用户卡片不应被删")
	}
}

func TestPrivacyLesson(t *testing.T) {
	copied := stubCopy(t)
	a, tt := testApp(t)
	st := a.store.Settings()
	st.AliasOff, st.AliasNoAutoRestore = true, true
	_ = a.store.SetSettings(st)
	a.startAdvancedLesson(lessonPrivacy)
	tt.Frame()
	a.prepareLessonSamples() // 同上：按钮与进度第 1 步同名
	tt.Frame()
	st = a.store.Settings()
	if len(st.AliasEntities) != 1 || st.AliasEntities[0].OriginalText != privacyLessonAlias || st.AliasEntities[0].Placeholder != "[USER_01]" || st.AliasOff || st.AliasNoAutoRestore {
		t.Fatalf("%+v", st)
	}
	a.sys = &recSys{}
	a.target = macos.FrontApp{PID: 42, Name: "Cursor"}
	mustClick(t, tt, "发送示例")
	if len(a.pending) != 1 || !strings.Contains(a.pending[0].Text, "[USER_01]") || strings.Contains(a.pending[0].Text, privacyLessonAlias) || len(a.pf.items) == 0 {
		t.Fatalf("发送副本应已化名、邮箱待处理：%+v %+v", a.pending, a.pf.items)
	}
	a.cancelPending()
	a.afterDelivered(a.lesson.progress.sampleIDs, false)
	tt.Frame()
	mustClick(t, tt, "复制模拟回复")
	if !strings.Contains(*copied, "[USER_01]") {
		t.Fatal(*copied)
	}
	// 收回回复：自动还原了一处化名即完成
	if got := a.captureRestoreAliases(*copied); !strings.Contains(got, privacyLessonAlias) {
		t.Fatal(got)
	}
	reply, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: a.captureRestoreAliases(*copied)})
	a.afterCaptured(reply.ID, false, false, core.AliasOccurrences(*copied, a.store.Settings().AliasEntities))
	if o := a.onboarding(); a.lesson.progress.step != 3 || o.RecoveryTutorialCompletedAtMs == nil {
		t.Fatalf("%+v", a.lesson.progress)
	}
	tt.Frame()
	if !tt.HasText("完成：收回时自动还原") {
		t.Fatal(tt.Texts())
	}
	mustClick(t, tt, "删除化名")
	st = a.store.Settings()
	if a.lesson != nil || len(st.AliasEntities) != 0 || !st.AliasOff || !st.AliasNoAutoRestore {
		t.Fatalf("删除化名应还原课程前的设置 %+v", st)
	}
	if _, ok := a.store.Note(reply.ID); ok || len(a.store.Notes()) != 0 {
		t.Fatalf("示例卡与回复卡都应清理 %+v", a.store.Notes())
	}
}

func TestLearningSettings(t *testing.T) {
	a, _ := testApp(t)
	a.openSettingsState()
	set := ui.NewTester(a.settingsView, 1040, 2400)
	a.setJump = "帮助与更新"
	set.Frame()
	set.Frame()
	for _, s := range []string{"上手课程", "基础：收集并粘贴", "3 步 · 已完成 0 / 3", "进阶：合并发送", "进阶：智能脱敏与还原", "先完成基础课", "新手导览", "重看导览"} {
		if !set.HasText(s) {
			t.Fatalf("缺 %q：%v", s, set.Texts())
		}
	}
	if err := set.Click("开始"); err != nil {
		t.Fatal(err)
	}
	if a.onboarding().RehearsalStatus != store.RehearsalActive || !a.pinned {
		t.Fatal(a.onboarding())
	}
	set.Frame()
	if !set.HasText("继续") {
		t.Fatal(set.Texts())
	}
	// 发送过内容即解锁进阶课
	a.afterDelivered([]string{"x"}, false)
	a.transitionOnboarding(store.OnboardingEvent{Type: "skip"})
	set.Frame()
	if set.HasText("先完成基础课") {
		t.Fatal(set.Texts())
	}
	st := a.store.Settings()
	st.WelcomeTourSeen = true
	_ = a.store.SetSettings(st)
	if err := set.Click("重看导览"); err != nil {
		t.Fatal(err)
	}
	if a.store.Settings().WelcomeTourSeen {
		t.Fatal("重看导览应清掉已看过标记")
	}
}

// 横栏：演练卡在卡串左侧一栏，导览同样盖住整块面板。
func TestOnboardingHorizontalBar(t *testing.T) {
	a, tt := testApp(t, "横栏里的卡")
	st := a.store.Settings()
	st.SidebarEdge = "bottom"
	_ = a.store.SetSettings(st)
	tt.SetSize(1400, 320)
	a.maybeOpenTour()
	tt.Frame()
	tt.Scroll(700, 160, 0, 600) // 横栏矮：导览内容可滚动（同 Tauri overflow-y-auto）
	tt.Frame()
	mustClick(t, tt, "花 1 分钟试一下")
	if !tt.HasText("上手教程") || !tt.HasText("横栏里的卡") {
		t.Fatal(tt.Texts())
	}
}

func TestLessonStateMachine(t *testing.T) {
	m, _ := lessonSamplesReady(startLesson(lessonMerge), []string{"a", "b"}, "")
	if _, ok := lessonSamplesReady(m, []string{"c"}, ""); ok {
		t.Fatal("只在第 0 步放示例")
	}
	has := func(ids ...string) func(string) bool { return func(id string) bool { return slices.Contains(ids, id) } }
	for _, c := range []struct {
		name    string
		checked []string
		want    int
	}{{"只勾一张不前进", []string{"a"}, 1}, {"两张都勾前进", []string{"a", "b", "x"}, 2}} {
		if got, _ := lessonAfterChecked(m, has(c.checked...)); got.step != c.want {
			t.Fatalf("%s：%d", c.name, got.step)
		}
	}
	p, _ := lessonSamplesReady(startLesson(lessonPrivacy), []string{"s"}, "alias")
	for _, c := range []struct {
		name string
		p    lessonProgress
		sent []string
		want int
	}{
		{"合并课少发一张不算", m, []string{"a"}, 1},
		{"合并课第 1 步直接一起发也完成", m, []string{"b", "a"}, 3},
		{"还原课发了示例卡", p, []string{"s"}, 2},
		{"还原课发了别的卡", p, []string{"x"}, 1},
	} {
		if got, _ := lessonAfterDelivery(c.p, c.sent); got.step != c.want {
			t.Fatalf("%s：%d", c.name, got.step)
		}
	}
	p2, _ := lessonAfterDelivery(p, []string{"s"})
	if _, ok := lessonAfterCapture(p2, "r", 0); ok {
		t.Fatal("没还原化名不算完成")
	}
	if got, ok := lessonAfterCapture(p2, "r", 1); !ok || got.step != 3 || got.replyID != "r" {
		t.Fatalf("%+v", got)
	}
	if _, ok := lessonAfterCapture(m, "r", 1); ok {
		t.Fatal("合并课不看捕获")
	}
}

// 导览示意按拍循环：减少动态效果时停在最后一拍（发送完成、邮箱已替换）。
func TestTourSceneFinalBeat(t *testing.T) {
	a, _ := testApp(t)
	v := ui.NewTester(func(c *ui.Context) { a.tourIllustration(c, tok(c)) }, 380, 300)
	v.SetPreferences(ui.Preferences{ReduceMotion: true})
	v.Frame()
	v.Frame()
	for _, s := range []string{"浏览器", "文档", "Toskr", "AI 对话", "[EMAIL_01]", "已一起发送 2 张 ✓", "邮箱发送前已自动替换"} {
		if !v.HasText(s) {
			t.Fatalf("缺 %q %v", s, v.Texts())
		}
	}
}

// 同 Tauri focus.rs 激活观察：点面板时 Toskr 在前台，「识别粘贴位置」用最近一次的外部前台应用。
func TestRefreshTargetUsesLastExternalFront(t *testing.T) {
	a, _ := testApp(t)
	sys := &recSys{}
	a.sys = sys
	a.target = macos.FrontApp{PID: 7, Name: "Arc"}
	sys.front = 42
	a.observeFront() // 用户在文本编辑里放好光标
	sys.front = sys.SelfPID()
	a.observeFront() // 回到 Toskr 点按钮
	a.refreshTargetFromFront()
	if a.target.PID != 42 {
		t.Fatalf("应识别为刚才的外部应用，得到 %d", a.target.PID)
	}
}

// Codex 实机发现：合并课清理示例后底部仍显示「已选 2」——删掉的卡要从勾选里移除。
func TestDeletedNotesLeaveSelection(t *testing.T) {
	a, _ := testApp(t, "甲", "乙")
	for _, n := range a.store.Notes() {
		a.chosen.Add(n.ID)
	}
	a.store.Delete(a.store.Notes()[0].ID)
	a.reload()
	if a.chosen.Len() != 1 {
		t.Fatalf("勾选应只剩 1 张，得到 %d", a.chosen.Len())
	}
}

// Codex 实机发现：脱敏课「先点文档再发送」却发往唤出面板时的旧目标——发送前按最近外部前台应用重新识别。
func TestLessonSendUsesLastExternalFront(t *testing.T) {
	a, _ := testApp(t)
	sys := &recSys{}
	a.sys = sys
	a.target = macos.FrontApp{PID: 7, Name: "ChatGPT"}
	a.lesson = &lessonSession{progress: startLesson(lessonPrivacy)}
	sys.front = 42
	a.observeFront()
	sys.front = sys.SelfPID()
	a.observeFront()
	a.sendLessonSamples()
	if a.target.PID != 42 {
		t.Fatalf("应发往刚才点过的应用，得到 %d", a.target.PID)
	}
}
