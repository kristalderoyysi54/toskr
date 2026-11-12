package main

import (
	"testing"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

func TestAccelFrom(t *testing.T) {
	for _, c := range []struct {
		mods ui.Modifiers
		key  ui.Key
		want string
		ok   bool
	}{
		{ui.Cmd | ui.Shift, ui.KeyN, "Shift+Cmd+N", true},
		{ui.Ctrl | ui.Alt, ui.KeySpace, "Ctrl+Alt+Space", true},
		{0, ui.KeyF5, "F5", true},
		{ui.Shift, ui.KeyA, "", false}, // 单 ⇧ 不算全局快捷键
		{ui.Cmd, ui.KeyEscape, "", false},
		{ui.Cmd | ui.Shift, ui.KeySemicolon, "Shift+Cmd+;", true}, // 符号键（用户 2026-11-12 录 ⇧⌘; 被静默忽略）
		{ui.Ctrl, ui.KeyBackslash, "Ctrl+\\", true},
	} {
		if got, ok := accelFrom(c.mods, c.key); got != c.want || ok != c.ok {
			t.Errorf("accelFrom(%v,%v) = %q %v，应为 %q %v", c.mods, c.key, got, ok, c.want, c.ok)
		}
	}
	if got := store.TauriAccel("Cmd+Shift+KeyN"); got != "Cmd+Shift+N" {
		t.Errorf("Tauri 写法转换 %q", got)
	}
	if keyLabel("Shift+Cmd+N") != "⇧⌘N" {
		t.Errorf("显示 %q", keyLabel("Shift+Cmd+N"))
	}
}

// 设置「快捷键」：点击录制、按组合生效、与其他快捷键冲突时拒绝、⌫ 清除；双击行为与捕获存入分组写回。
func TestHotkeyRecorderAndCaptureSettings(t *testing.T) {
	a, _ := testApp(t)
	a.openSettingsState()
	a.setPage = 1 // 快捷键
	st := ui.NewTester(a.settingsView, 1040, 720)
	st.Frame()
	if err := st.Click("开关面板快捷键：⇧⌘C，点击录制"); err != nil {
		t.Fatalf("%v %v", err, st.Texts())
	}
	st.Frame()
	if a.recordingKey != "panel" || !st.HasText("按下新的快捷键…") {
		t.Fatalf("应进入录制 %q", a.recordingKey)
	}
	st.Key(ui.Shift, ui.KeyA) // 缺 ⌘⌃⌥：继续等
	st.Key(ui.Cmd|ui.Shift, ui.KeyK)
	st.Frame()
	if got := a.store.Settings().PanelHotkey; got != "Shift+Cmd+K" || a.recordingKey != "" || a.shortcut != got {
		t.Fatalf("面板快捷键 %q recording=%q", got, a.recordingKey)
	}
	// 截图录成同一组合 → 冲突拒绝
	_ = st.Click("截图快捷键：⌃⌥A，点击录制")
	st.Frame()
	st.Key(ui.Cmd|ui.Shift, ui.KeyK)
	st.Frame()
	if a.store.Settings().ScreenshotKey != "Ctrl+Alt+A" || a.hudKind != "warn" {
		t.Fatalf("冲突应拒绝 %q hud=%s %s", a.store.Settings().ScreenshotKey, a.hudKind, a.hudText)
	}
	// 新建笔记：录制后 ⌫ 清除
	_ = st.Click("新建笔记快捷键：未设置，点击录制")
	st.Frame()
	st.Key(ui.Cmd|ui.Alt, ui.KeyN)
	st.Frame()
	if a.store.Settings().NewNoteKey != "Alt+Cmd+N" {
		t.Fatalf("新建笔记 %q", a.store.Settings().NewNoteKey)
	}
	_ = st.Click("新建笔记快捷键：⌥⌘N，点击录制")
	st.Frame()
	st.Key(0, ui.KeyBackspace)
	st.Frame()
	if a.store.Settings().NewNoteKey != "" {
		t.Fatal("⌫ 应清除")
	}

	_ = st.Click("只划词")
	st.Frame()
	if !a.store.Settings().DoubleTapCaptureOnly {
		t.Fatal("双击行为应写回")
	}
	sec := a.store.AddSection("摘录")
	cur := a.store.Settings()
	cur.CaptureSection = sec
	_ = a.store.SetSettings(cur)
	if a.captureSection() != sec {
		t.Fatal("捕获应存入设定分组")
	}
	a.store.DeleteSection(sec)
	if a.captureSection() != store.SectionInbox {
		t.Fatal("分组删掉后回收件箱")
	}
}

// 录制冲突检测：系统快捷键（按用户配置，缺省按默认值）、写死的锁屏、只按 ⌘ 的应用通用命令都拒绝；配置里关掉的放行。
func TestHotkeyConflict(t *testing.T) {
	user := parseSymbolicHotkeys([]byte(`{"AppleSymbolicHotKeys":{
		"30":{"enabled":true,"value":{"type":"standard","parameters":[52,21,1179648]}},
		"64":{"enabled":false,"value":{"type":"standard","parameters":[65535,49,1048576]}},
		"61":{"enabled":1,"value":{"type":"standard","parameters":[32,49,786432]}},
		"32":{"enabled":true,"value":{"type":"standard","parameters":[65535,126,8650752]}},
		"500":{"enabled":true,"value":{"type":"standard","parameters":[106,38,1310720]}}}}`))
	for _, c := range []struct {
		mods ui.Modifiers
		key  ui.Key
		bad  bool
	}{
		{ui.Cmd | ui.Shift, ui.Key4, true},    // 截取所选区域（配置）
		{ui.Cmd | ui.Shift, ui.Key3, true},    // 截屏（配置里没有：按默认值）
		{ui.Cmd, ui.KeySpace, false},          // 聚焦搜索已在设置里关掉
		{ui.Ctrl | ui.Alt, ui.KeySpace, true}, // 下一个输入法（enabled 为数字 1）
		{ui.Ctrl, ui.KeyUp, true},             // 调度中心：配置带 fn 位也要认出
		{ui.Cmd | ui.Ctrl, ui.KeyJ, true},     // 不认识的编号：用户自定义系统快捷键
		{ui.Cmd | ui.Ctrl, ui.KeyQ, true},     // 锁定屏幕（写死）
		{ui.Cmd, ui.KeyC, true},               // 应用通用 ⌘C
		{ui.Cmd, ui.KeySemicolon, true},       // ⌘;
		{ui.Cmd | ui.Shift, ui.KeySemicolon, false},
		{ui.Cmd | ui.Shift, ui.KeyC, false},
		{ui.Cmd, ui.KeyF5, false},
	} {
		if got := hotkeyConflict(c.mods, c.key, user) != ""; got != c.bad {
			t.Errorf("%v+%v 冲突=%v，应为 %v", c.mods, c.key, got, c.bad)
		}
	}
}

// 录到冲突组合：不保存、留在录制态，换一个可用组合后照常生效。
func TestHotkeyRecorderRejectsConflict(t *testing.T) {
	orig := readSymbolicHotkeys
	t.Cleanup(func() { readSymbolicHotkeys = orig })
	readSymbolicHotkeys = func() map[int]symEntry { return nil } // 只按默认值，不读本机配置
	a, _ := testApp(t)
	a.openSettingsState()
	a.setPage = 1
	st := ui.NewTester(a.settingsView, 1040, 720)
	st.Frame()
	if err := st.Click("开关面板快捷键：⇧⌘C，点击录制"); err != nil {
		t.Fatalf("%v %v", err, st.Texts())
	}
	st.Frame()
	st.Key(ui.Cmd|ui.Shift, ui.Key4)
	st.Frame()
	if a.store.Settings().PanelHotkey != "Shift+Cmd+C" || a.recordingKey != "panel" || a.hudKind != "warn" {
		t.Fatalf("冲突应拒绝并继续录制 %q rec=%q hud=%s", a.store.Settings().PanelHotkey, a.recordingKey, a.hudKind)
	}
	st.Key(ui.Cmd|ui.Shift, ui.KeySemicolon)
	st.Frame()
	if got := a.store.Settings().PanelHotkey; got != "Shift+Cmd+;" || a.recordingKey != "" {
		t.Fatalf("换成可用组合应生效 %q", got)
	}
}
