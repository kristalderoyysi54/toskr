package main

import (
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// fakeReminders 是内存里的「Toskr Native」列表。
type fakeReminders struct {
	items  map[string]macos.Reminder
	n      int
	writes int
}

func installFakeReminders(t *testing.T) *fakeReminders {
	f := &fakeReminders{items: map[string]macos.Reminder{}}
	oS, oF, oW, oWatch, oA := remStatus, remFetch, remWrite, remWatch, calAsync
	t.Cleanup(func() { remStatus, remFetch, remWrite, remWatch, calAsync = oS, oF, oW, oWatch, oA })
	remStatus = func() string { return "granted" }
	remWatch = func(func()) {}
	calAsync = func(fn func()) { fn() }
	remFetch = func(listID, title string) (string, []macos.Reminder, error) {
		if title != "Toskr Native" {
			t.Fatalf("应推到独立列表：%q", title)
		}
		var out []macos.Reminder
		for _, it := range f.items {
			out = append(out, it)
		}
		return "list-1", out, nil
	}
	remWrite = func(listID string, ops []macos.ReminderOp) error {
		f.writes++
		for _, op := range ops {
			switch op.Kind {
			case "create":
				f.n++
				it := op.Want
				it.ItemID, it.URL = "item-"+itoa(f.n), op.URL
				f.items[it.ItemID] = it
			case "update", "adopt":
				it := op.Want
				it.ItemID, it.URL = op.ItemID, f.items[op.ItemID].URL
				if op.URL != "" {
					it.URL = op.URL
				}
				f.items[op.ItemID] = it
			case "delete":
				delete(f.items, op.ItemID)
			}
		}
		return nil
	}
	return f
}

func (f *fakeReminders) byTitle(title string) (macos.Reminder, bool) {
	for _, it := range f.items {
		if it.Title == title {
			return it, true
		}
	}
	return macos.Reminder{}, false
}

func TestRemindersSyncFlow(t *testing.T) {
	f := installFakeReminders(t)
	a, _ := testApp(t)
	task := a.store.AddTask(store.Task{Text: "交周报", Priority: "high"})
	a.store.AddTask(store.Task{Text: "闪念不推", Spark: true})
	enableReminders(a)
	a.runReminderSync()
	it, ok := f.byTitle("交周报")
	if !ok || it.Priority != 1 || !strings.HasSuffix(it.URL, task.ID) || len(f.items) != 1 {
		t.Fatalf("应新建一条带 URL 的提醒：%+v", f.items)
	}
	if st := a.store.Settings(); st.RemindersListID != "list-1" || st.RemindersSyncAt.IsZero() {
		t.Fatalf("%+v", st)
	}
	// 稳态：不新建
	a.runReminderSync()
	if len(f.items) != 1 {
		t.Fatal(f.items)
	}
	// iPhone 上：勾完成 + 新建一条
	it.Completed = true
	f.items[it.ItemID] = it
	f.items["phone"] = macos.Reminder{ItemID: "phone", Title: "买牛奶"}
	a.runReminderSync()
	if got, _ := a.taskByID(task.ID); got.Status != "done" {
		t.Fatal("对端完成应回流", got.Status)
	}
	found := false
	for _, x := range a.store.Tasks() {
		if x.Text == "买牛奶" {
			found = true
		}
	}
	if !found {
		t.Fatal("手机上新建的应导入")
	}
	a.runReminderSync() // 认领：补写 URL
	if !strings.HasPrefix(f.items["phone"].URL, store.ReminderURLPrefix) {
		t.Fatalf("导入后应补写 URL：%+v", f.items["phone"])
	}
	// 两边都改标题 → 冲突，Toskr 为准，撤销可改用对端
	milk, _ := f.byTitle("买牛奶")
	var milkTask store.Task
	for _, x := range a.store.Tasks() {
		if x.Text == "买牛奶" {
			milkTask = x
		}
	}
	milkTask.Text = "买酸奶"
	_ = a.store.UpdateTask(milkTask)
	milk.Title = "买豆奶"
	f.items[milk.ItemID] = milk
	a.runReminderSync()
	if f.items[milk.ItemID].Title != "买酸奶" || !strings.Contains(a.hudText, "买豆奶") || a.hudUndo == nil {
		t.Fatalf("冲突以 Toskr 为准并提示：%q %+v", a.hudText, f.items[milk.ItemID])
	}
	a.hudUndo()
	if got, _ := a.taskByID(milkTask.ID); got.Text != "买豆奶" {
		t.Fatal("撤销应改用提醒事项版本", got.Text)
	}
	// Toskr 删任务 → 对端删
	a.store.DeleteTask(milkTask.ID)
	a.runReminderSync()
	if _, ok := f.items[milk.ItemID]; ok {
		t.Fatal("Toskr 删了的任务应删对端")
	}
}

func TestRemindersSettingsRows(t *testing.T) {
	installFakeReminders(t)
	a, _ := testApp(t)
	a.openSettingsState()
	set := ui.NewTester(a.settingsView, 1040, 4000)
	a.setJump = "日历与提醒事项"
	set.Frame()
	set.Frame()
	if !set.HasText("同步任务到提醒事项") {
		t.Fatal(set.Texts())
	}
	enableReminders(a)
	a.runReminderSync()
	set.Frame()
	set.Frame()
	for _, s := range []string{"立即同步", "导入到分组", "在提醒事项里响铃", "同步规则", "收集箱"} {
		if !set.HasText(s) {
			t.Fatalf("缺 %q：%v", s, set.Texts())
		}
	}
	if set.HasText("不推送") {
		t.Fatal("同步规则默认收起")
	}
	if err := set.Click("同步规则 查看"); err != nil {
		t.Fatal(err)
	}
	set.Frame()
	if !set.HasText("不推送") || !set.HasText("在提醒事项里删掉的任务不再同步，Toskr 里的任务保留") || !set.HasText("收起") {
		t.Fatalf("展开后分条列出：%v", set.Texts())
	}
	// 同步失败：行上换成「重试」，说明写失败原因
	cur := a.store.Settings()
	cur.RemindersError = "列表不可写"
	_ = a.store.SetSettings(cur)
	set.Frame()
	if !set.HasText("重试") || set.HasText("立即同步") || !set.HasText("同步失败：列表不可写") {
		t.Fatalf("失败态：%v", set.Texts())
	}
}

// enableReminders 直接打开设置（setRemindersEnabled 会另排一轮后台同步，与测试里手动跑的那轮并发）。
func enableReminders(a *app) {
	st := a.store.Settings()
	st.RemindersOn = true
	_ = a.store.SetSettings(st)
}
