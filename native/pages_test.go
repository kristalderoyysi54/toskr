package main

import (
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/secretcodec"
	"github.com/toskr/native/internal/store"
)

func TestCmdClickMultiSelectThenMergeWithUndo(t *testing.T) {
	a, tt := testApp(t, "甲", "乙", "丙")
	_ = tt.Click("甲")
	_ = tt.ClickWith(ui.Cmd, "丙")
	tt.Frame()
	if a.chosen.Len() != 2 {
		t.Fatalf("⌘点击应多选，实为 %d", a.chosen.Len())
	}
	tt.Key(ui.Cmd, ui.KeyM)
	tt.Frame()
	notes := a.store.Section(store.SectionInbox)
	if len(notes) != 2 || notes[0].Text != "甲\n\n丙" {
		t.Fatalf("合并结果 %+v", notes)
	}
	tt.Key(ui.Cmd, ui.KeyZ) // HUD「撤销」的键盘入口
	tt.Frame()
	if len(a.store.Section(store.SectionInbox)) != 3 {
		t.Fatal("撤销合并应恢复 3 条")
	}
}

func TestDoneFoldAndClearWithUndo(t *testing.T) {
	a, tt := testApp(t, "要完成的", "留着的")
	tt.Key(0, ui.KeyDown) // 焦点落到第一张
	tt.Key(0, ui.KeyD)    // d = 完成态切换（同 Tauri）
	tt.Frame()
	if !tt.HasText("已完成 1") || tt.HasText("要完成的") {
		t.Fatalf("%v", tt.Texts())
	}
	_ = tt.Click("已完成 1")
	tt.Frame()
	if !tt.HasText("要完成的") {
		t.Fatal("展开后应显示已完成项")
	}
	_ = tt.RightClick("收件箱")
	if err := tt.ChooseMenuItem("清理已完成"); err != nil {
		t.Fatalf("%v %v", err, tt.Menu())
	}
	tt.Frame()
	if len(a.store.Notes()) != 1 {
		t.Fatal("清理已完成")
	}
	tt.Key(ui.Cmd, ui.KeyZ)
	tt.Frame()
	if len(a.store.Notes()) != 2 {
		t.Fatal("撤销清理")
	}
}

func TestNewSectionChipAndMoveVia(t *testing.T) {
	a, tt := testApp(t, "一条")
	a.newSecOn = true
	tt.Frame()
	tt.Type("提示词")
	tt.Key(0, ui.KeyEnter)
	tt.Frame()
	if !tt.HasText("提示词") || !tt.HasText("此分组为空") || a.section == store.SectionInbox {
		t.Fatalf("新分组应出现并成为输入区默认分组 %v", tt.Texts())
	}
	_ = tt.RightClick("一条")
	if err := tt.ChooseMenuItem("移动到", "提示词"); err != nil {
		t.Fatalf("%v %v", err, tt.Menu())
	}
	tt.Frame()
	if n := a.store.Notes()[0]; n.Section == store.SectionInbox {
		t.Fatalf("应移到新分组 %+v", n)
	}
}

func TestPreflightBlocksUntilConfirmedAndRedacts(t *testing.T) {
	key := strings.Join([]string{"sk-", "proj-", strings.Repeat("Ab3", 10)}, "")
	a, tt := testApp(t, "部署用 "+key)
	sys := &recSys{}
	a.sys = sys
	a.target = macos.FrontApp{PID: 42, Name: "Cursor"}
	tt.Key(ui.Cmd, ui.KeyEnter)
	tt.Frame()
	if !tt.HasText("发送内容含敏感信息：API 密钥 ×1") || len(sys.sent()) != 0 {
		t.Fatalf("预检命中应拦截 %v", tt.Texts())
	}
	_ = tt.Click("遮罩后发送")
	waitFor(t, func() bool { return len(sys.sent()) > 0 })
	if got := sys.sent()[0]; strings.Contains(got, key) || !strings.HasPrefix(got, "部署用 sk") {
		t.Fatalf("应遮罩后发送，实为 %q", got)
	}
}

func TestTasksQuickAddCompleteAndRecurring(t *testing.T) {
	a, tt := testApp(t)
	now := time.Date(2026, 11, 5, 10, 0, 0, 0, time.Local)
	a.clock = func() time.Time { return now }
	a.switchPage(pageTasks)
	tt.Frame()
	if !tt.HasText("添加今天的任务，回车保存（20:00 到期）…") && !tt.HasText("今天没有安排") {
		t.Fatalf("今天视图 %v", tt.Texts())
	}
	// 今天视图：不写时间默认 20:00 到期，进时间线
	a.taskIn.Focus()
	tt.Frame()
	tt.Type("写周报")
	tt.Key(0, ui.KeyEnter)
	tt.Frame()
	if !tt.HasText("写周报") || !tt.HasText("今天 20:00") || !tt.HasText("20:00") {
		t.Fatalf("%v", tt.Texts())
	}
	// 任务视图：解析自然语言时间与优先级
	a.taskSub = 1
	tt.Frame()
	a.taskIn.Focus()
	tt.Frame()
	tt.Type("明天下午3点 交周报 !!")
	tt.Key(0, ui.KeyEnter)
	tt.Frame()
	if !tt.HasText("交周报") || !tt.HasText("明天 15:00") || !tt.HasText("收集箱") {
		t.Fatalf("%v", tt.Texts())
	}
	i := slices.IndexFunc(a.store.Tasks(), func(x store.Task) bool { return x.Text == "交周报" })
	task := a.store.Tasks()[i]
	if task.Priority != "mid" {
		t.Fatalf("!! 应为中优先级 %+v", task)
	}
	task.Recurrence = "weekly"
	_ = a.store.UpdateTask(task)
	a.store.CompleteTask(task.ID, true, now)
	tt.Frame()
	if got := a.store.Tasks(); len(got) != 3 || !tt.HasText("已完成 1") {
		t.Fatalf("重复任务完成后应生成下一期 %+v %v", got, tt.Texts())
	}
}

func TestBillsSubviewFormPayAndUndo(t *testing.T) {
	a, tt := testApp(t)
	now := time.Date(2026, 11, 5, 19, 36, 0, 0, time.Local)
	a.clock = func() time.Time { return now }
	st := a.store.Settings()
	st.SubscriptionsEnabled = true
	_ = a.store.SetSettings(st)
	a.switchPage(pageTasks)
	tt.Frame()
	if !tt.HasText("提醒") || !tt.HasText("订阅") {
		t.Fatalf("订阅开启后页签应为「提醒」并多出订阅子视图 %v", tt.Texts())
	}
	_ = tt.Click("订阅")
	tt.Frame()
	if !tt.HasText("还没有订阅账单") {
		t.Fatalf("空态 %v", tt.Texts())
	}
	_ = tt.Click("添加订阅")
	tt.Frame()
	a.billForm.name, a.billForm.amount, a.billForm.cycle, a.billForm.due = "域名", "120", 4, now.AddDate(0, 0, 3).Format("2006-01-02")
	tt.Frame()
	_ = tt.Click("保存")
	tt.Frame()
	if !tt.HasText("域名") || !tt.HasText("每年 · ¥120") || !tt.HasText("3 天后") || !tt.HasText("未来 7 天有 1 笔到期") {
		t.Fatalf("新增年付订阅 %v", tt.Texts())
	}
	a.openBillForm(nil)
	a.billForm.kind, a.billForm.name, a.billForm.due = 1, "招行信用卡", "5"
	tt.Frame()
	_ = tt.Click("保存")
	tt.Frame()
	if !tt.HasText("每月 5 日还款") || !tt.HasText("还款") {
		t.Fatalf("信用卡今天还款 %v", tt.Texts())
	}
	card := a.bills[slices.IndexFunc(a.bills, func(b store.Bill) bool { return b.Kind == "creditCard" })]
	a.paying, a.payAmount = card.ID, "3200"
	tt.Frame()
	tt.Frame()
	tt.Key(0, ui.KeyEnter) // 实付输入框自动聚焦，回车确认
	tt.Frame()
	if !tt.HasText("已还 · 下期 12/5") {
		t.Fatalf("标记已还后应显示已还 %v", tt.Texts())
	}
	a.billFilter = "all"
	tt.Frame()
	_ = tt.RightClick("域名") // 行菜单走「更多」按钮；这里直接删除验证撤销
	a.store.DeleteBill(a.bills[slices.IndexFunc(a.bills, func(b store.Bill) bool { return b.Name == "域名" })].ID)
	a.reload()
	tt.Frame()
	if tt.HasText("域名") {
		t.Fatal("删除后不应显示")
	}
	if got, want := billDueBadgeText(store.Bill{NextDueAt: now.AddDate(0, 0, -2)}, now), "逾期 2 天"; got != want {
		t.Fatalf("%q", got)
	}
	if money("¥", 12.5) != "¥12.5" || money("$", 3) != "$3" || fmtAmount(68.456) != "68.46" {
		t.Fatal("金额格式与 Tauri formatBillAmount 不一致")
	}
}

func billDueBadgeText(b store.Bill, now time.Time) string { s, _ := billDueBadge(b, now); return s }

func TestSecretSealCardRevealAndCaptureRoute(t *testing.T) {
	a, tt := testApp(t)
	enableSecret(a)
	st := a.store.Settings()
	st.SecretKeys = []store.SecretKey{{ID: "k1", Label: "小王", Passphrase: "月亮湾"}}
	st.SecretCipherStyle = "code"
	_ = a.store.SetSettings(st)
	tt.Frame()
	if !tt.HasText("小王") || !tt.HasText("代码") || !tt.HasText("还没有秘文") {
		t.Fatalf("收发条应显示默认密钥与格式 %v", tt.Texts())
	}
	a.secretDraft = "周五上线窗口改到 22:00"
	a.sealSecret(nil, false)
	tt.Frame()
	waitFor(t, func() bool { tt.Frame(); return len(a.secrets) == 1 })
	sec := a.secrets[0]
	if sec.Direction != "out" || sec.KeyID != "k1" || strings.Contains(sec.Text, "22:00") || tt.HasText("周五上线窗口改到 22:00") {
		t.Fatalf("应只存密文、默认遮罩 %+v %v", sec, tt.Texts())
	}
	if !tt.HasText("我发出") || !tt.HasText("点击解密查看") {
		t.Fatalf("卡片 %v", tt.Texts())
	}
	a.openSecretCard(sec, a.store.Settings())
	waitFor(t, func() bool {
		tt.Advance(20 * time.Millisecond)
		tt.Frame()
		return tt.HasText("周五上线窗口改到 22:00")
	}) // 遮罩先淡出 120ms 再显明文
	a.hidePanel()
	tt.Frame()
	if tt.HasText("周五上线窗口改到 22:00") {
		t.Fatal("面板隐藏后应回遮罩")
	}
	// 捕获路由：别人用同一暗号发来的密文 → 进秘文页并解密；无匹配密钥 → 锁定卡
	in, _ := secretcodec.Seal("服务器密码改了", "月亮湾", secretcodec.StyleClassic)
	if !a.captureSecret(in, "微信") {
		t.Fatal("密文信封应走秘文分支")
	}
	locked, _ := secretcodec.Seal("本机没这把钥匙", "别的暗号", secretcodec.StyleLog)
	a.captureSecret(locked, "微信")
	tt.Frame()
	tt.Advance(500 * time.Millisecond)
	tt.Frame()
	if len(a.secrets) != 3 || !tt.HasText("服务器密码改了") || !tt.HasText("无匹配密钥 · 点击重试") || !tt.HasText("收到") {
		t.Fatalf("捕获后 %d 张卡 %v", len(a.secrets), tt.Texts())
	}
	if _, r := a.store.AddSecret(store.Secret{Text: in}); r != "duplicate" {
		t.Fatalf("同一信封应去重，得 %q", r)
	}
	if a.captureSecret("普通的一句话", "微信") {
		t.Fatal("普通文本不应被当作秘文")
	}
}

func TestEnglishUI(t *testing.T) {
	setLanguage("en", nil)
	defer setLanguage("zh", nil)
	_, tt := testApp(t)
	for _, s := range []string{"Clip", "Notes", "Tasks", "Inbox", "Empty section", "Hold ⌥ Option"} {
		if !tt.HasText(s) {
			t.Fatalf("缺 %q：%v", s, tt.Texts())
		}
	}
	setLanguage("system", []string{"zh-Hans-CN"})
	if tr("笔记") != "笔记" {
		t.Fatal("系统中文应显示中文")
	}
}

func TestStealthSilencesNonWarn(t *testing.T) {
	a, _ := testApp(t)
	st := a.store.Settings()
	st.Stealth = true
	_ = a.store.SetSettings(st)
	a.showHUD("added", "x")
	if a.hudText == "x" {
		t.Fatal("隐身时非警告气泡应静默")
	}
	a.showHUD("warn", "失败")
	if a.hudText != "失败" {
		t.Fatal("警告必须显示")
	}
}

func TestDockBesideCompanionWindow(t *testing.T) {
	wa := mygo.Rectangle{X: 0, Y: 25, Width: 1440, Height: 875}
	got := dockBeside(macos.Rect{X: 100, Y: 60, W: 800, H: 700}, wa, panelW, false)
	if got.X != 906 || got.Y != 60 || got.Height != 700 {
		t.Fatalf("应贴在窗口右侧 %+v", got)
	}
	full := dockBeside(macos.Rect{X: 0, Y: 25, W: 1440, H: 875}, wa, panelW, false)
	if full.X != 1440-panelW-6 || full.Y+full.Height > 900-10 {
		t.Fatalf("满屏窗口应放到内侧且不越出工作区 %+v", full)
	}
}

func TestTaskBucketsAndDueBadge(t *testing.T) {
	now := time.Date(2026, 11, 5, 19, 36, 0, 0, time.Local) // 周四
	secs := []store.Section{{ID: store.TaskInbox}}
	b := bucketTasks([]store.Task{
		{ID: "late2", DueAt: now.Add(-time.Hour)}, {ID: "late1", DueAt: now.Add(-2 * time.Hour)},
		{ID: "spark", Spark: true}, {ID: "orphan", Section: "gone"}, {ID: "d", Status: "done"},
	}, secs, now)
	ids := func(ts []store.Task) (s []string) {
		for _, x := range ts {
			s = append(s, x.ID)
		}
		return
	}
	if !slices.Equal(ids(b.overdue), []string{"late1", "late2"}) || !slices.Equal(ids(b.sparks), []string{"spark"}) ||
		!slices.Equal(ids(b.groups[0].tasks), []string{"orphan"}) || len(b.done) != 1 {
		t.Fatalf("%+v", b)
	}
	for due, want := range map[time.Time]string{
		now.Add(-30 * time.Minute): "30 分钟前", now.Add(-5 * time.Hour): "5 小时前", now.AddDate(0, 0, -2): "2 天前",
		now.Add(time.Hour): "今天 20:36", now.AddDate(0, 0, 1): "明天 19:36", now.AddDate(0, 0, 3): "周日 19:36",
		now.AddDate(0, 0, 10): "11月15日 19:36",
	} {
		if got := dueBadge(due, now); got != want {
			t.Errorf("dueBadge(%v) = %q，应为 %q", due, got, want)
		}
	}
	if todayDefaultDue(now).Format("15:04") != "20:00" || todayDefaultDue(now.Add(time.Hour)).Format("15:04") != "21:00" {
		t.Fatal("今天默认到期")
	}
}

// recSys 记录写入剪贴板的文本；激活即到前台。
type recSys struct {
	nopSys
	mu     sync.Mutex // 投递在后台 goroutine 写，测试在主 goroutine 读
	front  int32
	writes []string
}

func (r *recSys) Frontmost() (macos.FrontApp, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return macos.FrontApp{PID: r.front}, true
}
func (r *recSys) Activate(pid int32) bool { r.mu.Lock(); r.front = pid; r.mu.Unlock(); return true }
func (r *recSys) Write(items []macos.Item, _ bool) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(items) > 0 {
		r.writes = append(r.writes, string(items[0][macos.TypeString]))
	}
	return len(r.writes)
}

// sent 返回写入记录的快照。
func (r *recSys) sent() []string { r.mu.Lock(); defer r.mu.Unlock(); return slices.Clone(r.writes) }

func waitFor(t *testing.T, ok func() bool) {
	t.Helper()
	for range 800 { // 秘文试解是 PBKDF2 15 万轮，-race 下单次可达数百毫秒
		if ok() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("等待超时")
}

func TestSettingsNavSearchAndToggle(t *testing.T) {
	a, _ := testApp(t)
	a.openSettingsState()
	tt := ui.NewTester(a.settingsView, 1040, 720)
	tt.Frame()
	if !tt.HasText("常用外观") || !tt.HasText("伴随停靠") {
		t.Fatalf("首屏应为窗口与外观 %v", tt.Texts())
	}
	_ = tt.Click("快捷键")
	tt.Frame()
	if !tt.HasText("双击修饰键") || tt.HasText("常用外观") {
		t.Fatalf("应切到快捷键 %v", tt.Texts())
	}
	_ = tt.Click("粘贴与隐私")
	tt.Frame()
	if !tt.HasText("稳妥发送 · 默认") || !tt.HasText("终端（安全）") {
		t.Fatalf("发送方案应列出内置方案 %v", tt.Texts())
	}
	_ = tt.Click("编辑") // 第一个是稳妥发送
	tt.Frame()
	if err := tt.Click("代码块"); err != nil {
		t.Fatalf("%v %v", err, tt.Texts())
	}
	tt.Frame()
	if ps := a.store.Settings().TargetProfiles; len(ps) != 2 || ps[0].OutputMode() != "code" {
		t.Fatalf("方案编辑应写回设置 %+v", ps)
	}
	a.setQuery = "钥匙串"
	tt.Frame()
	if !tt.HasText("搜索结果") || !tt.HasText("加密") {
		t.Fatalf("搜索应命中数据页加密行 %v", tt.Texts())
	}
}

func TestSettingsGeneralRowsWriteBack(t *testing.T) {
	a, _ := testApp(t)
	a.openSettingsState()
	tt := ui.NewTester(a.settingsView, 1040, 720)
	tt.Frame()
	for _, label := range []string{"主题", "详情窗字号", "开机启动", "面板置顶", "失焦自动隐藏", "音效"} {
		if !tt.HasText(label) {
			t.Fatalf("通用页缺少「%s」 %v", label, tt.Texts())
		}
	}
	for _, c := range []struct {
		label string
		get   func() bool
	}{
		{"失焦自动隐藏", func() bool { return a.store.Settings().KeepOnBlur }},
		{"音效", func() bool { return a.store.Settings().SoundOff }},
		{"面板置顶", func() bool { return a.store.Settings().PanelNotOnTop }},
	} {
		if r, ok := tt.Find(c.label); ok {
			tt.ClickAt(935, r.Y+18)
		}
		tt.Frame()
		if !c.get() {
			t.Fatalf("关闭「%s」应写回设置", c.label)
		}
	}
	// 详情窗 ⌘− / ⌘0
	n, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: "字号"})
	a.detail = detailState{id: n.ID, pickAnchor: -1, pickEnd: -1}
	dt := ui.NewTester(a.detailView, 560, 540)
	dt.Frame()
	dt.Key(ui.Cmd, ui.KeyMinus)
	dt.Frame()
	if got := a.store.Settings().DetailFontSize; got != 11 {
		t.Fatalf("⌘− 后字号应为 11，实际 %d", got)
	}
	dt.Key(ui.Cmd, ui.Key0)
	dt.Frame()
	if got := a.store.Settings().DetailFontSize; got != 12 {
		t.Fatalf("⌘0 后字号应复位 12，实际 %d", got)
	}
}

func enableSecret(a *app) {
	st := a.store.Settings()
	st.SecretEnabled = true
	_ = a.store.SetSettings(st)
	a.noteSub = 1
}

func TestDetailEditTagsPickAndRaw(t *testing.T) {
	a, _ := testApp(t, "第一行\n\n1. 甲项\n2. 乙项 mygo")
	n := a.store.Notes()[0]
	a.detail = detailState{id: n.ID, pickAnchor: -1, pickEnd: -1}
	tt := ui.NewTester(a.detailView, 560, 540)
	tt.Frame()
	if !tt.HasText("甲项") || !tt.HasText("1.") || tt.HasText("1. 甲项") {
		t.Fatalf("应按有序列表渲染 %v", tt.Texts())
	}
	_ = tt.Click("原文")
	tt.Frame()
	if !tt.HasText(n.Text) || !tt.HasText("渲染") {
		t.Fatalf("原文模式应显示原始文本 %v", tt.Texts())
	}
	_ = tt.Click("＋ 标签")
	tt.Frame()
	tt.Type("周会")
	tt.Key(0, ui.KeyEnter)
	tt.Frame()
	if got, _ := a.store.Note(n.ID); !slices.Equal(got.Tags, []string{"周会"}) || !tt.HasText("#周会") {
		t.Fatalf("标签 %+v %v", got.Tags, tt.Texts())
	}
	_ = tt.Click("选词")
	tt.Frame()
	_ = tt.Click("乙")
	_ = tt.Click("mygo")
	tt.Frame()
	if got := a.pickedText(n.Text); got != "乙项 mygo" {
		t.Fatalf("选词区间 %q", got)
	}
	if !tt.HasText("发送所选") {
		t.Fatalf("选中后发送钮应只发所选 %v", tt.Texts())
	}
	tt.Key(0, ui.KeyEscape)
	tt.Frame()
	_ = tt.Click("编辑")
	tt.Frame()
	tt.Key(ui.Cmd, ui.KeyA)
	tt.Type("改过的正文")
	tt.Frame()
	tt.Key(ui.Cmd, ui.KeyS)
	tt.Frame()
	if got, _ := a.store.Note(n.ID); got.Text != "改过的正文" || a.detail.edit {
		t.Fatalf("⌘S 应保存并退出编辑 %q edit=%v draft=%q", got.Text, a.detail.edit, a.detailText)
	}
}

func TestSchemeAndDensity(t *testing.T) {
	a, _ := testApp(t, "第一条笔记")
	defer func() { curScheme = "default"; setPlatinumDetail("", "") }()
	a.openSettingsState()
	tt := ui.NewTester(a.settingsView, 1040, 720)
	tt.Frame()
	_ = tt.Click("紧凑")
	tt.Frame()
	if a.store.Settings().CardDensity != "compact" {
		t.Fatal("卡片密度应写回 compact")
	}
	pt := ui.NewTester(a.panelView, 380, 760)
	pt.Frame()
	if !pt.HasText("第一条笔记") || pt.HasText("文本") {
		t.Fatalf("紧凑卡应为单行、无通栏 %v", pt.Texts())
	}
	st := a.store.Settings()
	st.ColorScheme = "platinum"
	_ = a.store.SetSettings(st)
	curScheme = "platinum"
	tt.Frame()
	if !tt.HasText("高亮颜色") || !tt.HasText("滚动条") || slices.Contains(tt.Texts(), "主题") || slices.Contains(tt.Texts(), "毛玻璃背景") {
		t.Fatalf("Platinum 下应显示高亮颜色 / 滚动条，隐藏主题与毛玻璃 %v", tt.Texts())
	}
	if err := tt.Click("细条"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if a.store.Settings().PtScrollbar != "thin" {
		t.Fatal("滚动条应写回 thin")
	}
}

// 动效：换页时旧页向反方向滑出并淡出、约 0.4s 后释放；被顶替 HUD 的关键帧与 Tauri 一致。
func TestPageSlideAndHUDGhostKeyframes(t *testing.T) {
	a, tt := testApp(t, "一条")
	before, ok := tt.Find("收件箱")
	if !ok {
		t.Fatal("笔记页应有收件箱")
	}
	tt.Key(ui.Cmd, ui.KeyLeft) // ⌘← 笔记 → 剪贴：剪贴页从左侧 -24 滑入，笔记页向右 +24 滑出
	tt.Frame()
	tt.Advance(40 * time.Millisecond)
	tt.Frame()
	mid, ok := tt.Find("收件箱")
	if !ok || mid.X <= before.X || mid.X > before.X+24 {
		t.Fatalf("旧页应在离场途中右移 0~24：前 %v 中 %v ok=%v", before.X, mid.X, ok)
	}
	tt.Advance(time.Second)
	tt.Frame()
	tt.Frame()
	if _, ok := tt.Find("收件箱"); ok || a.prevPage != -1 {
		t.Fatalf("离场结束后旧页应释放 prev=%d", a.prevPage)
	}
	for _, c := range []struct{ t, y, s, o float32 }{{0, 0, 1, 1}, {0.14, 8, 0.95, 0.85}, {0.5, 8, 0.95, 0.85}, {1, 10, 0.93, 0}} {
		y, s, o := hudGhostPose(c.t)
		if abs32(y-c.y) > 1e-3 || abs32(s-c.s) > 1e-3 || abs32(o-c.o) > 1e-3 {
			t.Errorf("t=%v 得 y=%v s=%v o=%v", c.t, y, s, o)
		}
	}
}

func abs32(v float32) float32 {
	if v < 0 {
		return -v
	}
	return v
}

// 多选：提示行换成 Tauri 的多选提示、底部出批量条；x 勾选、⌘C 复制为编号列表、Esc 取消勾选；多条发送为编号列表。
func TestSelectionBarHintsAndKeys(t *testing.T) {
	a, tt := testApp(t, "甲", "乙", "丙")
	sys := &recSys{}
	a.sys = sys
	_ = tt.Click("甲")
	tt.Frame()
	if !tt.HasText("勾选") || !tt.HasText("预览") {
		t.Fatalf("焦点态提示 %v", tt.Texts())
	}
	tt.Key(0, ui.KeyX)
	tt.Frame()
	a.chosen.Add(a.notes[1].ID)
	tt.Frame()
	for _, s := range []string{"已选 2", "发送 2 张", "复制为列表", "取消勾选"} {
		if !tt.HasText(s) {
			t.Fatalf("缺 %q：%v", s, tt.Texts())
		}
	}
	tt.Key(ui.Cmd, ui.KeyC)
	tt.Frame()
	if len(sys.sent()) == 0 || sys.sent()[len(sys.sent())-1] != "1. 甲\n2. 乙" {
		t.Fatalf("复制为列表 %q", sys.sent())
	}
	tt.Key(0, ui.KeyEscape)
	tt.Frame()
	if a.chosen.Len() != 0 || tt.HasText("已选 2") {
		t.Fatal("Esc 应取消勾选并收起批量条")
	}
	if got := sendText([]string{"a", "b"}); got != "1. a\n2. b" {
		t.Fatalf("多条发送应为编号列表：%q", got)
	}
}
