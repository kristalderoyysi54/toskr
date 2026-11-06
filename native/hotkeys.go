package main

import (
	"errors"
	"fmt"
	"strings"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/diag"
	"github.com/toskr/native/internal/store"
)

// 全局快捷键录制（同 Tauri 设置「快捷键」：开关面板 / 截图 / 新建笔记可录制）：点输入框进入录制，
// 按下「修饰键 + 键」即生效；Esc 取消，⌫ 清除（不注册）。注册失败（被占用）时退回原值并提示。

type hotkeySlot struct {
	id    string // panel | shot | newnote
	get   func(store.Settings) string
	set   func(*store.Settings, string)
	run   func(a *app)
	label string
}

var hotkeySlots = []hotkeySlot{
	{"panel", func(s store.Settings) string { return s.PanelHotkey }, func(s *store.Settings, v string) { s.PanelHotkey = v }, (*app).togglePanel, "开关面板"},
	{"shot", func(s store.Settings) string { return s.ScreenshotKey }, func(s *store.Settings, v string) { s.ScreenshotKey = v }, (*app).screenshot, "截图"},
	{"newnote", func(s store.Settings) string { return s.NewNoteKey }, func(s *store.Settings, v string) { s.NewNoteKey = v }, (*app).newNoteHotkey, "新建笔记"},
}

// accelFrom 把按键组合写成 GlobalShortcut 认的加速键（Cmd+Shift+N）；必须带 ⌘ / ⌃ / ⌥ 之一，单 ⇧ 不算。
func accelFrom(mods ui.Modifiers, key ui.Key) (string, bool) {
	var name string
	switch {
	case key >= ui.KeyA && key <= ui.KeyZ:
		name = string(rune('A' + key - ui.KeyA))
	case key >= ui.Key0 && key <= ui.Key9:
		name = string(rune('0' + key - ui.Key0))
	case key >= ui.KeyF1 && key <= ui.KeyF12:
		name = fmt.Sprintf("F%d", int(key-ui.KeyF1)+1)
	case key == ui.KeySpace:
		name = "Space"
	case key == ui.KeyUp:
		name = "Up"
	case key == ui.KeyDown:
		name = "Down"
	case key == ui.KeyLeft:
		name = "Left"
	case key == ui.KeyRight:
		name = "Right"
	default:
		return "", false
	}
	isF := strings.HasPrefix(name, "F") && len(name) > 1
	if mods&(ui.Cmd|ui.Ctrl|ui.Alt) == 0 && !isF {
		return "", false
	}
	var parts []string
	for _, m := range []struct {
		mod  ui.Modifiers
		name string
	}{{ui.Ctrl, "Ctrl"}, {ui.Alt, "Alt"}, {ui.Shift, "Shift"}, {ui.Cmd, "Cmd"}} {
		if mods&m.mod != 0 {
			parts = append(parts, m.name)
		}
	}
	return strings.Join(append(parts, name), "+"), true
}

// registerHotkeys 启动时按设置注册全部全局快捷键。
func (a *app) registerHotkeys() {
	st := a.store.Settings()
	for _, s := range hotkeySlots {
		acc := s.get(st)
		if acc == "" || (s.id == "shot" && st.ScreenshotOff) {
			continue
		}
		run := s.run
		if err := mygo.GlobalShortcut.Register(acc, func() { run(a) }); err != nil {
			diag.Push("%s快捷键 %s 注册失败: %v", s.label, acc, err)
		}
	}
	a.shortcut = st.PanelHotkey
}

// setHotkey 换绑：先注销旧键，注册新键失败则恢复旧键。
func (a *app) setHotkey(slot hotkeySlot, acc string) error {
	st := a.store.Settings()
	old := slot.get(st)
	if acc == old {
		return nil
	}
	for _, o := range hotkeySlots {
		if o.id != slot.id && acc != "" && o.get(st) == acc {
			return fmt.Errorf(tr("已被「%s」使用"), tr(o.label))
		}
	}
	if a.panel != nil { // 无 App 运行（视图测试）时只写设置
		run := slot.run
		if old != "" {
			mygo.GlobalShortcut.Unregister(old)
		}
		if acc != "" {
			if err := mygo.GlobalShortcut.Register(acc, func() { run(a) }); err != nil {
				if old != "" {
					_ = mygo.GlobalShortcut.Register(old, func() { run(a) })
				}
				return errors.New(tr("可能已被其他应用占用"))
			}
		}
	}
	slot.set(&st, acc)
	if err := a.store.SetSettings(st); err != nil {
		return err
	}
	if slot.id == "panel" {
		a.shortcut = acc
	}
	return nil
}

// newNoteHotkey：全局「新建笔记」——唤出面板，切到笔记页并聚焦输入区。
func (a *app) newNoteHotkey() {
	if a.page != pageNotes {
		a.switchPage(pageNotes)
	}
	a.noteSub = 0
	a.showPanel()
	a.draftIn.Focus()
}

// hotkeyField：设置里的录制框。
func (a *app) hotkeyField(c *ui.Context, k tokens, slot hotkeySlot) {
	cur := slot.get(a.store.Settings())
	recording := a.recordingKey == slot.id
	label := keyLabel(cur)
	switch {
	case recording:
		label = tr("按下新的快捷键…")
	case cur == "":
		label = tr("未设置")
	}
	box := ui.Row(c).Height(28).Padding(0, 10).Radius(10).Background(k.track).AlignItems(ui.Center).Gap(6).
		Role(ui.RoleButton).Label(fmt.Sprintf(tr("%s快捷键：%s，点击录制"), tr(slot.label), label)).Focusable()
	if recording {
		box.Border(1, stok(c).primary).Focus()
		box.HandleInput(func(ev ui.InputEvent) bool {
			if ev.Kind != ui.InputKeyDown {
				return false
			}
			switch ev.Key {
			case ui.KeyEscape:
				a.recordingKey = ""
				return true
			case ui.KeyBackspace, ui.KeyDelete:
				a.recordingKey = ""
				if err := a.setHotkey(slot, ""); err != nil {
					a.showHUD("warn", err.Error())
				}
				return true
			}
			acc, ok := accelFrom(ev.Mods, ev.Key)
			if !ok {
				return true // 只按了修饰键或缺 ⌘⌃⌥：继续等
			}
			a.recordingKey = ""
			if err := a.setHotkey(slot, acc); err != nil {
				a.showHUD("warn", fmt.Sprintf(tr("%s 设置失败：%s"), keyLabel(acc), err.Error()))
			} else {
				a.showHUD("ok", fmt.Sprintf(tr("%s快捷键已改为 %s"), tr(slot.label), keyLabel(acc)))
			}
			return true
		})
	}
	box.Children(func() {
		fg := k.fg
		if cur == "" && !recording {
			fg = k.muted
		}
		text(c, label, 12, 17, 500, fg).Font(fontMono)
		if recording {
			text(c, tr("Esc 取消 · ⌫ 清除"), 10, 14, 400, k.muted)
		}
	})
	if box.Clicked() {
		if recording {
			a.recordingKey = ""
		} else {
			a.recordingKey = slot.id
		}
	}
}

// setScreenshotEnabled：区域截图总开关（同 Tauri）。关闭时注销截图快捷键，把组合键让给其他应用；开启时重新注册。
func (a *app) setScreenshotEnabled(on bool) {
	st := a.store.Settings()
	if st.ScreenshotOff == !on {
		return
	}
	st.ScreenshotOff = !on
	if err := a.store.SetSettings(st); err != nil {
		a.showHUD("warn", err.Error())
		return
	}
	if a.panel == nil || st.ScreenshotKey == "" {
		return
	}
	if on {
		if err := mygo.GlobalShortcut.Register(st.ScreenshotKey, func() { a.screenshot() }); err != nil {
			diag.Push("截图快捷键 %s 注册失败: %v", st.ScreenshotKey, err)
		}
	} else {
		mygo.GlobalShortcut.Unregister(st.ScreenshotKey)
	}
}
