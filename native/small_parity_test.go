package main

import (
	"testing"
	"time"

	"github.com/toskr/native/internal/store"
)

// 秘文搜索：按密钥名 / 来源应用过滤，密文不参与匹配。
func TestSearchSecrets(t *testing.T) {
	list := []store.Secret{{ID: "a", Text: "密文甲", KeyLabel: "老王", SourceApp: "微信"}, {ID: "b", Text: "密文乙", KeyLabel: "同事", SourceApp: "Slack"}}
	if got := searchSecrets(list, "slack"); len(got) != 1 || got[0].ID != "b" {
		t.Fatalf("%+v", got)
	}
	if got := searchSecrets(list, "密文"); len(got) != 0 {
		t.Fatal("密文本身不参与匹配")
	}
	if got := searchSecrets(list, " "); len(got) != 2 {
		t.Fatal("空查询返回全部")
	}
}

// 剪贴历史未开启：空状态给「开启剪贴板历史」，点了即开启。
func TestClipOffState(t *testing.T) {
	a, tt := testApp(t)
	st := a.store.Settings()
	st.ClipboardWatch = false
	_ = a.store.SetSettings(st)
	a.switchPage(pageClip)
	tt.Frame()
	if !tt.HasText("剪贴板历史未开启") {
		t.Fatalf("%v", tt.Texts())
	}
	if err := tt.Click("开启剪贴板历史"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if !a.store.Settings().ClipboardWatch {
		t.Fatal("应开启剪贴历史")
	}
}

// 往日未完成：「全部顺延」菜单里「清除到期时间」，可撤销。
func TestClearOverdueDue(t *testing.T) {
	a, tt := testApp(t)
	now := time.Date(2026, 11, 6, 13, 0, 0, 0, time.Local)
	a.clock = func() time.Time { return now }
	a.store.AddTask(store.Task{Text: "昨天的事", DueAt: now.AddDate(0, 0, -1)})
	a.switchPage(pageTasks)
	a.reload()
	tt.Frame()
	_ = tt.Click("全部顺延")
	if err := tt.ChooseMenuItem("清除到期时间"); err != nil {
		t.Fatalf("%v %v", err, tt.Menu())
	}
	if ts := a.store.Tasks(); !ts[0].DueAt.IsZero() || a.hudUndo == nil {
		t.Fatalf("应清除到期并可撤销 %+v", ts[0])
	}
	a.hudUndo()
	if a.store.Tasks()[0].DueAt.IsZero() {
		t.Fatal("撤销应恢复到期")
	}
}
