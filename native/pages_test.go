package main

import (
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
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
	if err := tt.Click("撤销"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if len(a.store.Section(store.SectionInbox)) != 3 {
		t.Fatal("撤销合并应恢复 3 条")
	}
}

func TestDoneFoldAndClearWithUndo(t *testing.T) {
	a, tt := testApp(t, "要完成的", "留着的")
	tt.Key(ui.Cmd, ui.KeyD)
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
	_ = tt.Click("撤销")
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
	if !tt.HasText("发送内容含敏感信息：API 密钥 ×1") || len(sys.writes) != 0 {
		t.Fatalf("预检命中应拦截 %v", tt.Texts())
	}
	_ = tt.Click("遮罩后发送")
	waitFor(t, func() bool { return len(sys.writes) > 0 })
	if got := sys.writes[0]; strings.Contains(got, key) || !strings.HasPrefix(got, "部署用 sk") {
		t.Fatalf("应遮罩后发送，实为 %q", got)
	}
}

func TestTasksQuickAddCompleteAndRecurring(t *testing.T) {
	a, tt := testApp(t)
	now := time.Date(2026, 11, 5, 10, 0, 0, 0, time.Local)
	a.clock = func() time.Time { return now }
	tt.Key(ui.Cmd, ui.Key3)
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

func TestBillsFormAndSummary(t *testing.T) {
	a, tt := testApp(t)
	a.switchPage(pageBills)
	tt.Frame()
	a.billForm = billForm{open: true, cycle: 3, name: "域名", amount: 120, due: time.Now().AddDate(0, 0, 10).Format("2006-01-02")}
	tt.Frame()
	_ = tt.Click("保存")
	tt.Frame()
	if !tt.HasText("域名") || !tt.HasText("¥10") || !tt.HasText("10 天后") {
		t.Fatalf("年付 120 月均应为 10：%v", tt.Texts())
	}
	a.billForm = billForm{open: true, due: "明天"}
	tt.Frame()
	_ = tt.Click("保存")
	tt.Frame()
	if !tt.HasText("日期格式应为 YYYY-MM-DD") {
		t.Fatal("非法日期应提示")
	}
}

func TestSecretsMaskedUntilRevealed(t *testing.T) {
	a, tt := testApp(t)
	a.store.AddSecret("服务器", "root-pass-123")
	a.switchPage(pageSecrets)
	tt.Frame()
	if tt.HasText("root-pass-123") || !tt.HasText("服务器") {
		t.Fatalf("默认必须遮罩 %v", tt.Texts())
	}
	a.revealed[a.secrets[0].ID] = time.Now().Add(time.Minute)
	tt.Frame()
	if !tt.HasText("root-pass-123") {
		t.Fatal("显现后应可见")
	}
	a.revealed[a.secrets[0].ID] = time.Now().Add(-time.Second)
	tt.Frame()
	if tt.HasText("root-pass-123") {
		t.Fatal("过期后应自动回遮罩")
	}
}

func TestSealToolRoundTripInPanel(t *testing.T) {
	a, tt := testApp(t)
	a.switchPage(pageSecrets)
	a.sealIn, a.sealPass = "卡号在这", "pw"
	tt.Frame()
	_ = tt.Click("生成密文")
	tt.Frame()
	if !strings.HasPrefix(a.sealOut, "const cacheSnapshot") {
		t.Fatalf("%q", a.sealOut)
	}
	a.sealOpenOn, a.sealIn = true, a.sealOut
	tt.Frame()
	_ = tt.Click("解开密文")
	tt.Frame()
	if a.sealOut != "卡号在这" {
		t.Fatalf("%q", a.sealOut)
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
	got := dockBeside(macos.Rect{X: 100, Y: 60, W: 800, H: 700}, wa)
	if got.X != 906 || got.Y != 60 || got.Height != 700 {
		t.Fatalf("应贴在窗口右侧 %+v", got)
	}
	full := dockBeside(macos.Rect{X: 0, Y: 25, W: 1440, H: 875}, wa)
	if full.X != 1440-360-6 || full.Y+full.Height > 900-10 {
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
	if money("¥", 12.5) != "¥12.50" || money("$", 3) != "$3" {
		t.Fatal("格式化")
	}
}

// recSys 记录写入剪贴板的文本；激活即到前台。
type recSys struct {
	nopSys
	front  int32
	writes []string
}

func (r *recSys) Frontmost() (macos.FrontApp, bool) { return macos.FrontApp{PID: r.front}, true }
func (r *recSys) Activate(pid int32) bool           { r.front = pid; return true }
func (r *recSys) Write(items []macos.Item, _ bool) int {
	if len(items) > 0 {
		r.writes = append(r.writes, string(items[0][macos.TypeString]))
	}
	return len(r.writes)
}

func waitFor(t *testing.T, ok func() bool) {
	t.Helper()
	for range 200 {
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
	before := a.store.Settings().PasteThenEnter
	if r, ok := tt.Find("粘贴后回车"); ok {
		tt.ClickAt(935, r.Y+18) // 行右侧开关中心（标题 18 + 说明 16 + 间距 2，开关垂直居中）
	}
	tt.Frame()
	if a.store.Settings().PasteThenEnter == before {
		t.Fatal("开关应写回设置")
	}
	a.setQuery = "钥匙串"
	tt.Frame()
	if !tt.HasText("搜索结果") || !tt.HasText("加密") {
		t.Fatalf("搜索应命中数据页加密行 %v", tt.Texts())
	}
}
