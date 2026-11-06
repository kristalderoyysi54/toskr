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
	if err := st.Click("开关面板快捷键：⌃⌥Space，点击录制"); err != nil {
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
