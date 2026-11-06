package main

import (
	"slices"
	"testing"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
)

// 设置里的应用名单：选择应用… / 加入当前应用 / 移除，保存为 bundle id；显示应用名而不是 bundle id。
func TestAppListEditorExcluded(t *testing.T) {
	a, _ := testApp(t)
	origPick, origName, origIcon := pickAppBundle, appDisplayName, appIconPNG
	t.Cleanup(func() { pickAppBundle, appDisplayName, appIconPNG = origPick, origName, origIcon })
	pickAppBundle = func(*app) string { return "com.apple.Notes" }
	appDisplayName = func(b string) string {
		return map[string]string{"com.apple.Notes": "备忘录", "com.tinyspeck.slackmacgap": "Slack"}[b]
	}
	appIconPNG = func(string) []byte { return nil }
	a.target = macos.FrontApp{PID: 9, BundleID: "com.tinyspeck.slackmacgap", Name: "Slack"}
	a.openSettingsState()
	set := ui.NewTester(a.settingsView, 1040, 2400)
	a.setJump = "剪贴板"
	set.Frame()
	set.Frame()
	base := a.store.Settings().ExcludedApps // 默认已排除密码管理器
	if err := set.Click("选择应用…"); err != nil {
		t.Fatal(err)
	}
	set.Frame()
	if err := set.Click("加入当前应用"); err != nil {
		t.Fatal(err)
	}
	set.Frame()
	if got := a.store.Settings().ExcludedApps; !slices.Equal(got, append(slices.Clone(base), "com.apple.Notes", "com.tinyspeck.slackmacgap")) {
		t.Fatalf("应保存 bundle id %v", got)
	}
	if !set.HasText("备忘录") || !set.HasText("Slack") {
		t.Fatalf("应显示应用名 %v", set.Texts())
	}
	if err := set.Click("移除 备忘录"); err != nil {
		t.Fatal(err)
	}
	set.Frame()
	if got := a.store.Settings().ExcludedApps; !slices.Equal(got, append(slices.Clone(base), "com.tinyspeck.slackmacgap")) {
		t.Fatalf("移除 %v", got)
	}
}
