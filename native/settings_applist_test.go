package main

import (
	"slices"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
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
	base := a.store.Settings().ClipExcludedApps // 剪贴板页编辑的是剪贴忽略名单；默认已含密码管理器
	if err := set.Click("选择应用…"); err != nil {
		t.Fatal(err)
	}
	set.Frame()
	if err := set.Click("加入当前应用"); err != nil {
		t.Fatal(err)
	}
	set.Frame()
	if got := a.store.Settings().ClipExcludedApps; !slices.Equal(got, append(slices.Clone(base), "com.apple.Notes", "com.tinyspeck.slackmacgap")) {
		t.Fatalf("应保存 bundle id %v", got)
	}
	if !set.HasText("备忘录") || !set.HasText("Slack") {
		t.Fatalf("应显示应用名 %v", set.Texts())
	}
	if err := set.Click("移除 备忘录"); err != nil {
		t.Fatal(err)
	}
	set.Frame()
	if got := a.store.Settings().ClipExcludedApps; !slices.Equal(got, append(slices.Clone(base), "com.tinyspeck.slackmacgap")) {
		t.Fatalf("移除 %v", got)
	}
}

// 更多功能对照 Tauri：消息监听 / 秘文是默认关闭的开关行，不占侧栏一级分类；开启后在「更多功能」下多出子页签。
// 权限页逐项带图标，只列已开启功能需要的权限。
func TestFeatureSwitchesAndPermissions(t *testing.T) {
	a, _ := testApp(t)
	a.openSettingsState()
	set := ui.NewTester(a.settingsView, 1040, 2000)
	a.setJump = "更多功能"
	set.Frame()
	set.Frame()
	for _, s := range []string{"功能开关", "AI 智能", "到期提醒", "日历与提醒事项", "开启后，主面板会出现对应入口。", "消息监听", "实验", "秘文", "订阅", "苹果日历与提醒事项"} {
		if !set.HasText(s) {
			t.Fatalf("缺 %q：%v", s, set.Texts())
		}
	}
	if set.HasText("共享密钥") {
		t.Fatal("秘文未开启时不应有入口与子页")
	}
	a.patchSettings(func(x *store.Settings) { x.SecretEnabled, x.MessagesEnabled = true, true })
	set.Frame()
	if subs := featureSubs(a.store.Settings()); len(subs) != 6 || subs[4] != "消息监听" || subs[5] != "秘文" {
		t.Fatalf("开启后应多出子页签 %v", subs)
	}
	a.setJump = "秘文"
	set.Frame()
	set.Frame()
	if a.setSub != 5 || !set.HasText("共享密钥") {
		t.Fatalf("应跳到秘文子页 sub=%d %v", a.setSub, set.Texts())
	}
	a.setJump = "权限"
	set.Frame()
	set.Frame()
	for _, s := range []string{"系统权限", "辅助功能", "输入监控", "屏幕录制"} {
		if !set.HasText(s) {
			t.Fatalf("权限页缺 %q：%v", s, set.Texts())
		}
	}
	if set.HasText("日历") {
		t.Fatal("日历未开启时不列日历权限")
	}
}

// 权限页轮询：停在本页时日历授权状态变化会被重取（同 Tauri 2s 轮询；这里把间隔归零直接触发）。
func TestPermissionPagePollsCalendar(t *testing.T) {
	a, _ := testApp(t)
	oldS, oldA := calStatus, calAsync
	t.Cleanup(func() { calStatus, calAsync = oldS, oldA })
	status := "notDetermined"
	calStatus = func() string { return status }
	calAsync = func(f func()) { f() }
	a.patchSettings(func(x *store.Settings) { x.CalendarOn = true })
	a.calStatus = "notDetermined"
	a.openSettingsState()
	set := ui.NewTester(a.settingsView, 1040, 2000)
	a.setJump = "权限"
	set.Frame()
	set.Frame()
	if !set.HasText("日历") || set.HasText("✓ 都已就绪") {
		t.Fatalf("应列出待授权的日历 %v", set.Texts())
	}
	status = "granted"
	a.permPolled = time.Time{}
	set.Frame()
	set.Frame()
	if a.calStatus != "granted" {
		t.Fatalf("应重取到已授权 %q", a.calStatus)
	}
}

// 粘贴规则应用列表：没装的预置终端不露包名，收成一行「另有 N 个未安装的终端」，点开后用预置显示名逐个列出。
func TestPasteRuleListHidesMissingTerminals(t *testing.T) {
	a, _ := testApp(t)
	origName, origIcon := appDisplayName, appIconPNG
	t.Cleanup(func() { appDisplayName, appIconPNG = origName, origIcon })
	appDisplayName = func(b string) string { // 只装了 Terminal 与 iTerm
		return map[string]string{"com.apple.Terminal": "终端", "com.googlecode.iterm2": "iTerm"}[b]
	}
	appIconPNG = func(string) []byte { return nil }
	a.openSettingsState()
	set := ui.NewTester(a.settingsView, 1040, 1400)
	a.setJump = "粘贴规则"
	set.Frame()
	set.Frame()
	if !set.HasText("终端") || !set.HasText("iTerm") || !set.HasText("另有 5 个未安装的终端") {
		t.Fatalf("应列出已装终端并收起未装的 %v", set.Texts())
	}
	for _, s := range set.Texts() {
		if s == "net.kovidgoyal.kitty" || s == "io.alacritty" || s == "kitty" {
			t.Fatalf("收起时不应出现 %q", s)
		}
	}
	if err := set.Click("另有 5 个未安装的终端"); err != nil {
		t.Fatal(err)
	}
	set.Frame()
	for _, want := range []string{"WezTerm", "kitty", "Alacritty", "Ghostty", "Warp"} {
		if !set.HasText(want) {
			t.Fatalf("展开后应显示 %s：%v", want, set.Texts())
		}
	}
	if set.HasText("net.kovidgoyal.kitty") || set.HasText("另有 5 个未安装的终端") {
		t.Fatalf("展开后不应再有包名 / 收起行 %v", set.Texts())
	}
	// 搜索时照常能搜到未装的预置项
	a.paste.showMissing, a.paste.query = false, "kitty"
	set.Frame()
	if !set.HasText("kitty") {
		t.Fatal("搜索应命中未安装的预置终端")
	}
}
