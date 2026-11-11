package main

import (
	"slices"
	"testing"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

func cmdLabels(items []cmdItem) []string {
	var out []string
	for _, it := range items {
		out = append(out, it.label)
	}
	return out
}

// ⌘K 命令面板：无查询词只给动作；输入后按文字过滤动作并附卡片 / 任务命中；↓↵ 执行；再按 ⌘K / Esc 关闭。
func TestCommandPalette(t *testing.T) {
	a, tt := testApp(t, "周报草稿", "另一条")
	a.store.AddTask(store.Task{Text: "周报提交"})
	_, _, _ = a.store.Add(store.Note{Section: store.SectionClipboard, Text: "剪贴里的周报链接"})
	a.reload()
	tt.Key(ui.Cmd, ui.KeyK)
	tt.Frame()
	if !a.cmdOpen || !tt.HasText("切到剪贴页") || !tt.HasText("打开设置") {
		t.Fatalf("⌘K 应打开并列出动作 %v", tt.Texts())
	}
	if got := cmdLabels(a.commandItems("")); slices.ContainsFunc(got, func(s string) bool { return s == "周报草稿" }) {
		t.Fatal("无查询词只给动作")
	}
	tt.Type("周报")
	tt.Frame()
	got := cmdLabels(a.commandItems(a.cmdQuery))
	if !slices.Equal(got, []string{"剪贴里的周报链接", "周报草稿", "周报提交", "在设置里搜索「周报」"}) {
		t.Fatalf("查询应命中卡片与任务 %v", got)
	}
	tt.Key(0, ui.KeyDown) // 第二条：笔记卡
	tt.Key(0, ui.KeyEnter)
	tt.Frame()
	if a.cmdOpen || a.page != pageNotes {
		t.Fatalf("↵ 执行并关闭，应切到内容页 open=%v page=%d", a.cmdOpen, a.page)
	}
	if cur, ok := a.current(); !ok || cur.Text != "周报草稿" || !a.focusList {
		t.Fatalf("焦点应落在命中的卡 %+v", cur)
	}
	tt.Key(ui.Cmd, ui.KeyK)
	tt.Frame()
	tt.Type("设置")
	tt.Frame()
	if got := cmdLabels(a.commandItems(a.cmdQuery)); !slices.Equal(got, []string{"打开设置", "在设置里搜索「设置」"}) {
		t.Fatalf("动作按文字过滤 %v", got)
	}
	tt.Key(0, ui.KeyEscape)
	tt.Frame()
	if a.cmdOpen || !tt.HasText("周报草稿") {
		t.Fatal("Esc 只关命令面板，不收面板")
	}
	tt.Key(ui.Cmd, ui.KeyK)
	tt.Frame()
	tt.Key(ui.Cmd, ui.KeyK)
	tt.Frame()
	if a.cmdOpen {
		t.Fatal("再按 ⌘K 关闭")
	}
}

// 命令面板收进托盘 / ☰ 菜单已有的动作，并能跳到设置页与子页签；兜底把查询词带进设置搜索。
func TestCommandSharedActions(t *testing.T) {
	a, _ := testApp(t, "一张卡")
	a.patchSettings(func(x *store.Settings) { x.ClipboardWatch = true })
	run := func(q, label string) {
		t.Helper()
		for _, it := range a.commandItems(q) {
			if it.label == label {
				it.run()
				return
			}
		}
		t.Fatalf("查「%s」没有「%s」：%v", q, label, cmdLabels(a.commandItems(q)))
	}
	run("隐身", "开启隐身模式（不弹捕获提示）")
	if !a.store.Settings().Stealth {
		t.Fatal("应开启隐身")
	}
	run("隐身", "关闭隐身模式")
	if a.store.Settings().Stealth {
		t.Fatal("应关闭隐身")
	}
	run("暂停", "暂停剪贴板收集 · 暂停 30 分钟")
	if !a.now().Before(a.store.Settings().ClipPauseUntil) {
		t.Fatal("应已暂停收集")
	}
	run("恢复", "恢复剪贴板收集")
	if a.now().Before(a.store.Settings().ClipPauseUntil) {
		t.Fatal("应已恢复收集")
	}
	run("紧凑", "切换为紧凑列表")
	if a.store.Settings().CardDensity != "compact" {
		t.Fatal("应切到紧凑")
	}
	run("深色", "主题：深色")
	if a.store.Settings().Theme != "dark" {
		t.Fatal("应切到深色")
	}
	if slices.Contains(cmdLabels(a.commandItems("主题")), "主题：深色") {
		t.Fatal("当前主题不再列出")
	}
	run("展开", "保持面板展开")
	if !a.pinned {
		t.Fatal("应钉住面板")
	}
	// 关掉截图功能后不出截图命令
	if !slices.Contains(cmdLabels(a.commandItems("")), "区域截图") {
		t.Fatal("默认应有截图命令")
	}
	a.patchSettings(func(x *store.Settings) { x.ScreenshotOff = true })
	if slices.Contains(cmdLabels(a.commandItems("")), "区域截图") {
		t.Fatal("截图关闭后不应有截图命令")
	}
	// 设置页跳转只在有查询词时出现
	if slices.Contains(cmdLabels(a.commandItems("")), "权限") {
		t.Fatal("无查询词不列设置页")
	}
	got := cmdLabels(a.commandItems("隐私"))
	if !slices.Contains(got, "粘贴与隐私") || !slices.Contains(got, "粘贴与隐私 · 隐私保护") || got[len(got)-1] != "在设置里搜索「隐私」" {
		t.Fatalf("设置跳转 %v", got)
	}
}
