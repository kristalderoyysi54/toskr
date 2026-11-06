package main

import (
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// 任务：状态点三态循环；点标题展开改标题 / 备注 / 检查项（勾选、改字、删、添加）；分组改名 / 移动 / 删除可撤销；右键发送到对话。
func TestTaskRowEditStatusAndGroups(t *testing.T) {
	a, tt := testApp(t)
	now := time.Date(2026, 11, 6, 10, 0, 0, 0, time.Local)
	a.clock = func() time.Time { return now }
	work := a.store.AddTaskSection("工作")
	a.store.AddTaskSection("生活")
	task := a.store.AddTask(store.Task{Text: "写周报", Section: work, Status: "todo"})
	a.switchPage(pageTasks)
	a.taskSub = 1
	tt.Frame()

	get := func() store.Task { x, _ := a.taskByID(task.ID); return x }
	_ = tt.Click("状态：待办（点击切换）")
	tt.Frame()
	if get().Status != "doing" {
		t.Fatalf("待办 → 进行中 %+v", get())
	}
	_ = tt.Click("状态：进行中（点击切换）")
	tt.Frame()
	if get().Status != "done" {
		t.Fatal("进行中 → 完成")
	}
	a.setTaskStatus(get(), "todo")
	tt.Frame()

	// 展开编辑
	if err := tt.Click("写周报"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if a.taskOpen != task.ID || !tt.HasText("添加检查项…") {
		t.Fatalf("点标题应展开 %v", tt.Texts())
	}
	a.taskTitle, a.taskNote = "写周报（周五前）", "附上数据"
	a.ckDraft = ""
	_ = tt.Click("添加检查项…")
	tt.Type("收集数据")
	tt.Key(0, ui.KeyEnter)
	tt.Type("写结论")
	tt.Key(0, ui.KeyEnter)
	tt.Frame()
	if ck := get().Checklist; len(ck) != 2 || ck[0].Text != "收集数据" || ck[1].Text != "写结论" {
		t.Fatalf("回车连续添加检查项 %+v", ck)
	}
	_ = tt.Click("勾选")
	tt.Frame()
	if !get().Checklist[0].Done {
		t.Fatal("勾选检查项")
	}
	*a.taskCk[get().Checklist[1].ID] = "" // 清空文字即删除
	tt.Key(0, ui.KeyEscape)
	tt.Frame()
	got := get()
	if a.taskOpen != "" || got.Text != "写周报（周五前）" || got.Note != "附上数据" || len(got.Checklist) != 1 {
		t.Fatalf("收起时保存 %+v open=%q", got, a.taskOpen)
	}
	if !tt.HasText("1/1") {
		t.Fatalf("行上显示检查进度 %v", tt.Texts())
	}

	// 右键发送到对话：标题 + 备注 + 检查项
	sys := &recSys{}
	a.sys = sys
	a.target = macos.FrontApp{PID: 42, Name: "ChatGPT"}
	_ = tt.RightClick("写周报（周五前）")
	if err := tt.ChooseMenuItem("发送到对话"); err != nil {
		t.Fatalf("%v %v", err, tt.Menu())
	}
	waitFor(t, func() bool { return len(sys.sent()) > 0 })
	if w := sys.sent()[0]; w != "写周报（周五前）\n\n附上数据\n\n- [x] 收集数据" {
		t.Fatalf("任务发送内容 %q", w)
	}

	// 分组：双击改名、下移、删除可撤销
	tt.Frame()
	// 改名走「···」菜单的「重命名」（双击同效，但连点两次在 -race 高负载下可能超出双击间隔，测试里不依赖它）
	if err := tt.Click("工作 分组操作"); err != nil {
		t.Fatal(err)
	}
	if err := tt.ChooseMenuItem("重命名"); err != nil {
		t.Fatalf("%v %v", err, tt.Menu())
	}
	tt.Frame()
	if a.taskSecRename != work {
		t.Fatal("右键重命名进入改名")
	}
	tt.Key(ui.Cmd, ui.KeyA)
	tt.Type("项目")
	tt.Key(0, ui.KeyEnter)
	tt.Frame()
	if !tt.HasText("项目") || tt.HasText("工作") {
		t.Fatalf("改名 %v", tt.Texts())
	}
	_ = tt.RightClick("项目")
	a.taskSecRename = ""
	secs := a.store.TaskSections()
	_ = a.store.MoveTaskSection(work, 1)
	if s2 := a.store.TaskSections(); s2[len(s2)-1].ID != work || len(s2) != len(secs) {
		t.Fatalf("下移 %+v", s2)
	}
	undo, ok := a.store.DeleteTaskSection(work)
	if !ok || get().Section != store.TaskInbox {
		t.Fatal("删除分组任务回收集箱")
	}
	undo()
	if get().Section != work || !strings.Contains(strings.Join(tt.Texts(), " "), "写周报") {
		t.Fatal("撤销删除分组")
	}
}

// 到期自定义：自然语言或日期格式，回车设定；重复：从完成时算起、结束于共几次。
func TestTaskDueAndRecurrenceEditor(t *testing.T) {
	now := time.Date(2026, 11, 6, 10, 0, 0, 0, time.Local) // 周五
	for in, want := range map[string]string{
		"明天下午3点":           "2026-11-07 15:00",
		"2026-11-20 15:30": "2026-11-20 15:30",
		"2026-12-01":       "2026-12-01 09:00",
		"11-08 08:15":      "2026-11-08 08:15",
	} {
		d, ok := parseDue(in, now)
		if !ok || d.Format("2006-01-02 15:04") != want {
			t.Errorf("parseDue(%q) = %v %v，应为 %s", in, d, ok, want)
		}
	}
	if _, ok := parseDue("随便写写", now); ok {
		t.Error("看不懂的不应设定")
	}

	a, tt := testApp(t)
	a.clock = func() time.Time { return now }
	task := a.store.AddTask(store.Task{Text: "浇花", Recurrence: "daily", DueAt: now.Add(time.Hour)})
	a.switchPage(pageTasks)
	a.taskSub = 1
	tt.Frame()
	_ = tt.Click("浇花")
	tt.Frame()
	for _, s := range []string{"到期", "重复", "每天", "按计划日期", "结束", "永不"} {
		if !tt.HasText(s) {
			t.Fatalf("展开态缺 %q：%v", s, tt.Texts())
		}
	}
	_ = tt.Click("修改到期时间")
	tt.Type("明天下午3点")
	tt.Key(0, ui.KeyEnter)
	tt.Frame()
	if got, _ := a.taskByID(task.ID); got.DueAt.Format("01-02 15:04") != "11-07 15:00" {
		t.Fatalf("到期应改为明天 15:00 %v", got.DueAt)
	}
	if err := tt.Click("按计划日期"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if err := tt.Click("从完成时算起"); err != nil { // PopoverMenuButton 的菜单画在窗口里
		t.Fatalf("%v %v", err, tt.Texts())
	}
	tt.Frame()
	_ = tt.Click("永不")
	tt.Frame()
	if err := tt.Click("共几次"); err != nil {
		t.Fatalf("%v %v", err, tt.Texts())
	}
	tt.Frame()
	if got, _ := a.taskByID(task.ID); got.RecurBasis != "completion" || got.RecurCount != 5 || !tt.HasText("次（含本期）") {
		t.Fatalf("重复设置 %+v %v", got, tt.Texts())
	}
}
