package main

import (
	"slices"
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

// 到期弹层（同 Tauri DueControl）：快捷档、自定义日期时间、重复（频率 / 星期几 / 起算 / 结束）、提醒档。
func TestTaskDuePopover(t *testing.T) {
	now := time.Date(2026, 11, 6, 10, 0, 0, 0, time.Local) // 周五
	a, tt := testApp(t)
	tt.SetSize(380, 1600) // 弹层高度随窗口钳制，开大窗口让所有选项都可点
	a.clock = func() time.Time { return now }
	task := a.store.AddTask(store.Task{Text: "浇花", Recurrence: "daily", DueAt: now.Add(time.Hour)})
	a.switchPage(pageTasks)
	a.taskSub = 1
	tt.Frame()
	_ = tt.Click("浇花")
	tt.Frame()
	if err := tt.Click("修改到期时间"); err != nil {
		t.Fatal(err, tt.Texts())
	}
	tt.Frame()
	for _, s := range []string{"30 分钟后", "下个周一 9:00", "设定该时间", "清除到期", "重复", "每天", "按计划日期", "结束", "永不", "提醒我", "到期时", "提前 1 天"} {
		if !tt.HasText(s) {
			t.Fatalf("弹层缺 %q：%v", s, tt.Texts())
		}
	}
	if err := tt.Click("从完成时算起"); err != nil {
		t.Fatal("从完成时算起", err)
	}
	tt.Frame()
	if err := tt.Click("共几次"); err != nil {
		t.Fatal("共几次", err)
	}
	tt.Frame()
	if err := tt.Click("提前 15 分钟"); err != nil {
		t.Fatal("提前 15 分钟", err)
	}
	tt.Frame()
	if err := tt.Click("每周"); err != nil {
		t.Fatal("每周", err)
	}
	tt.Frame()
	if !tt.HasText("次（含本期）") || !tt.HasText("三") {
		t.Fatalf("共几次输入与星期选择 %v", tt.Texts())
	}
	tt.Click("三")
	tt.Frame()
	got, _ := a.taskByID(task.ID)
	if got.RecurBasis != "completion" || got.RecurCount != 10 || got.Recurrence != "weekly" || !slices.Equal(got.RecurWeekdays, []int{3, 5}) ||
		!slices.Equal(got.Offsets(), []int{0, 15}) {
		t.Fatalf("%+v %v", got, got.Offsets())
	}
	tt.Click("下个周一 9:00")
	tt.Frame()
	if got, _ := a.taskByID(task.ID); got.DueAt.Format("01-02 15:04") != "11-09 09:00" || a.dueOpenID != "" {
		t.Fatalf("快捷档设定并关闭 %v %q", got.DueAt, a.dueOpenID)
	}
	// 提前档：到期前 15 分钟提醒一次，到期再提醒一次；已逾期不补提前档
	got, _ = a.taskByID(task.ID)
	if hits := a.store.DueForReminder(got.DueAt.Add(-14 * time.Minute)); len(hits) != 1 {
		t.Fatal("提前 15 分钟档")
	}
	if hits := a.store.DueForReminder(got.DueAt.Add(-10 * time.Minute)); len(hits) != 0 {
		t.Fatal("同一档不重复")
	}
	if hits := a.store.DueForReminder(got.DueAt.Add(time.Minute)); len(hits) != 1 {
		t.Fatal("到期档")
	}
	if l := reminderHitLabel(got, got.DueAt.Add(-14*time.Minute), "浇花"); l != "浇花 · 14 分钟后到期" {
		t.Fatal(l)
	}
}
