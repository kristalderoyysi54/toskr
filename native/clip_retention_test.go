package main

import (
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/core"
	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// 按来源分组头右键：保留时长（会清掉记录时先确认、取消不改）、全选、删除可撤销、不再收集。
func TestClipSourceRetentionMenu(t *testing.T) {
	a, tt := testApp(t)
	now := time.Now()
	a.clock = func() time.Time { return now }
	src := macos.FrontApp{Name: "Safari", BundleID: "com.apple.Safari"}
	old, _ := a.addClip(core.ClipEvent{Text: "十天前的", Source: src})
	_ = a.store.SetCreatedAt(old.ID, now.Add(-10*24*time.Hour))
	if _, err := a.addClip(core.ClipEvent{Text: "刚复制的", Source: src}); err != nil {
		t.Fatal(err)
	}
	if _, err := a.addClip(core.ClipEvent{Text: "别的应用", Source: macos.FrontApp{Name: "Notes", BundleID: "com.apple.Notes"}}); err != nil {
		t.Fatal(err)
	}
	a.switchPage(pageClip)
	a.clipView = "source"
	a.reload()
	tt.Frame()

	origAsk, origGo := retentionAsk, pfGo
	t.Cleanup(func() { retentionAsk, pfGo = origAsk, origGo })
	pfGo = func(f func()) { f() }
	asked := ""
	answer := false
	retentionAsk = func(title, msg string) bool { asked = title; return answer }

	_ = tt.RightClick("Safari")
	if err := tt.ChooseMenuItem("保留时长", "1 周"); err != nil {
		t.Fatalf("%v %v", err, tt.Menu())
	}
	tt.Frame()
	if asked != "确定把「Safari」的保留时长调整为「1 周」吗？" || a.store.Settings().ClipAppRetention != nil {
		t.Fatalf("会清理记录时应先确认，取消不改 asked=%q %v", asked, a.store.Settings().ClipAppRetention)
	}
	answer = true
	_ = tt.RightClick("Safari")
	_ = tt.ChooseMenuItem("保留时长", "1 周")
	tt.Frame()
	if got := a.store.Settings().ClipAppRetention["com.apple.Safari"]; got != 7 {
		t.Fatalf("应写入 7 天 %v", a.store.Settings().ClipAppRetention)
	}
	if noteByText(a, "十天前的").ID != "" || noteByText(a, "刚复制的").ID == "" || noteByText(a, "别的应用").ID == "" {
		t.Fatal("只清掉 Safari 超期的那条")
	}
	if !tt.HasText("· 保留 1 周") {
		t.Fatalf("分组头应显示单独保留时长 %v", tt.Texts())
	}

	_ = tt.RightClick("Safari")
	if err := tt.ChooseMenuItem("全选这 1 条"); err != nil {
		t.Fatalf("%v %v", err, tt.Menu())
	}
	if a.chosen.Len() != 1 {
		t.Fatal("应全选该来源")
	}
	_ = tt.RightClick("Safari")
	_ = tt.ChooseMenuItem("不再收集来自「Safari」")
	if st := a.store.Settings(); len(st.ExcludedApps) == 0 || st.ExcludedApps[len(st.ExcludedApps)-1] != "com.apple.Safari" {
		t.Fatalf("应加入排除 %v", st.ExcludedApps)
	}
	_ = tt.RightClick("Safari")
	_ = tt.ChooseMenuItem("删除这 1 条")
	tt.Frame()
	if noteByText(a, "刚复制的").ID != "" {
		t.Fatal("应删除")
	}
	tt.Key(ui.Cmd, ui.KeyZ) // HUD「撤销」
	if noteByText(a, "刚复制的").ID == "" {
		t.Fatal("撤销应恢复")
	}
	_ = store.SectionClipboard
}
