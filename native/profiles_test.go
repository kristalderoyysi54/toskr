package main

import (
	"slices"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// 发送方案：终端自动命中「终端（安全）」按代码块发送；快速切换临时方案、绑定为以后都用；规则本次覆盖；每次确认回车；要求逐项处理时保留原文需二次确认。
func TestSendProfilesQuickSwitchAndPolicies(t *testing.T) {
	a, tt := testApp(t, "ls -la")
	sys := &recSys{}
	a.sys = sys
	a.target = macos.FrontApp{PID: 42, Name: "Terminal", BundleID: "com.apple.Terminal"}
	sent := func(n store.Note) string {
		t.Helper()
		before := len(sys.sent())
		a.send([]store.Note{n})
		tt.Frame()
		waitFor(t, func() bool { return len(sys.sent()) > before })
		w := sys.sent()
		return w[len(w)-1]
	}
	note := a.store.Notes()[0]
	if got := sent(note); got != "```\nls -la\n```" {
		t.Fatalf("终端应按代码块发送 %q", got)
	}

	// 展开发送详情 → 方案行
	if err := tt.Click("展开发送详情"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	for _, s := range []string{"方案", "终端（安全）", "自动匹配"} {
		if !tt.HasText(s) {
			t.Fatalf("缺 %q：%v", s, tt.Texts())
		}
	}
	if err := tt.Click("本次发送方案：终端（安全），点击查看与切换"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	for _, s := range []string{"发送到 Terminal", "已为 Terminal 指定", "稳妥发送", "输出改为原文", "当前", "本次生效规则", "代码块", "恢复自动匹配", "编辑方案"} {
		if !tt.HasText(s) {
			t.Fatalf("快速切换缺 %q：%v", s, tt.Texts())
		}
	}
	_ = tt.Click("稳妥发送")
	tt.Frame()
	if r, _ := a.resolution(); r.Source != "temporary" || r.Profile.ID != store.SafetyProfileID || !tt.HasText("临时指定") {
		t.Fatalf("应临时指定稳妥发送 %+v %v", r, tt.Texts())
	}
	if got := sent(note); got != "ls -la" {
		t.Fatalf("临时方案按原文发送 %q", got)
	}
	// 换目标：临时方案暂停，可一键沿用
	a.quickOpen = false
	a.target.PID = 43
	tt.Frame()
	if !tt.HasText("原临时发送方案已暂停，当前已按目标重新选择") || !tt.HasText("将 稳妥发送 用于当前目标") {
		t.Fatalf("换目标后应暂停临时方案 %v", tt.Texts())
	}
	if err := tt.Click("将 稳妥发送 用于当前目标"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	a.quickOpen = true
	tt.Frame()
	if err := tt.Click("以后发给 Terminal 都使用此方案"); err != nil {
		t.Fatalf("%v %v", err, tt.Texts())
	}
	tt.Frame()
	_, ps, _ := a.store.Settings().ProfileConfig()
	if !slices.Contains(ps[0].BundleIDs, "com.apple.Terminal") || slices.Contains(ps[1].BundleIDs, "com.apple.Terminal") || a.tempProfile != "" {
		t.Fatalf("应改绑到稳妥发送并清掉临时方案 %+v", ps)
	}
	if r, _ := a.resolution(); r.Source != "exact" || r.Profile.ID != store.SafetyProfileID {
		t.Fatalf("改绑后精确命中 %+v", r)
	}

	// 规则本次覆盖：输出改为无 Markdown
	a.quickOpen = true
	tt.Frame()
	if err := tt.Click("原文"); err != nil {
		t.Fatalf("%v %v", err, tt.Texts())
	}
	if err := tt.ChooseMenuItem("无 Markdown"); err != nil {
		t.Fatalf("%v %v", err, tt.Menu())
	}
	tt.Frame()
	if !tt.HasText("本次") || !tt.HasText("恢复方案默认规则") {
		t.Fatalf("覆盖后应标「本次」%v", tt.Texts())
	}
	md, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: "**加粗** 与 [链接](https://x.dev)"})
	if got := sent(md); got != "加粗 与 链接（https://x.dev）" {
		t.Fatalf("无 Markdown %q", got)
	}

	// 每次发送前确认回车
	a.setRule(func(o *store.RuleOverrides) { o.EnterPolicy = "confirm" })
	a.quickOpen = false
	a.send([]store.Note{note})
	tt.Frame()
	if !tt.HasText("粘贴到 Terminal 后按回车发送？") {
		t.Fatalf("应先问是否回车 %v", tt.Texts())
	}
	before := len(sys.sent())
	_ = tt.Click("仅粘贴")
	waitFor(t, func() bool { return len(sys.sent()) > before })
	tt.Frame()
	if len(a.enterAsk) != 0 {
		t.Fatal("选择后收起确认条")
	}

	// 要求逐项处理：保留原文需二次确认
	key := strings.Join([]string{"sk-", "proj-", strings.Repeat("Ab3", 10)}, "")
	sec, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: "用 " + key})
	a.send([]store.Note{sec})
	tt.Frame()
	if !tt.HasText("1 项处理完才能发送") {
		t.Fatalf("要求逐项处理不应一键发原文 %v", tt.Texts())
	}
	_ = tt.Click("一键保留原文")
	tt.Frame()
	before = len(sys.sent())
	if err := tt.Click("发送"); err != nil {
		t.Fatalf("%v %v", err, tt.Texts())
	}
	waitFor(t, func() bool { return len(sys.sent()) > before })
	if w := sys.sent(); !strings.Contains(w[len(w)-1], key) || len(a.enterAsk) != 0 {
		t.Fatalf("确认后发原文且不再问回车 %q", w[len(w)-1])
	}
	tt.Key(0, ui.KeyEscape)
}

// 设置里的弹出菜单按钮（默认方案、按预设新建）能打开并写回（PopoverMenuButton 上不能再挂 .Key，否则菜单打不开）。
func TestSettingsProfilePopoverMenus(t *testing.T) {
	a, _ := testApp(t)
	a.openSettingsAt(setPagePaste, 0)
	st := ui.NewTester(a.settingsView, 1040, 720)
	st.Frame()
	if err := st.Click("新建"); err != nil {
		t.Fatal(err)
	}
	st.Frame()
	if err := st.Click("AI 对话"); err != nil {
		t.Fatalf("新建菜单应列出预设 %v %v", err, st.Texts())
	}
	st.Frame()
	_, ps, _ := a.store.Settings().ProfileConfig()
	if len(ps) != 3 || ps[2].Name != "AI 对话" || ps[2].EnterPolicy != "confirm" || a.editProfileID != ps[2].ID {
		t.Fatalf("按预设新建 %+v", ps)
	}
	if err := st.Click("稳妥发送"); err != nil { // 默认方案按钮
		t.Fatal(err)
	}
	st.Frame()
	for _, key := range []ui.Key{ui.KeyDown, ui.KeyDown, ui.KeyEnter} { // 菜单项与方案列表同名，用键盘选第二项
		st.Key(0, key)
		st.Frame()
	}
	if _, _, def := a.store.Settings().ProfileConfig(); def != store.TerminalProfileID {
		t.Fatalf("默认方案应改为终端 %q", def)
	}
}
