package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"

	"github.com/egoist/mygo/ui"
)

// 录制全局快捷键时的冲突检测：系统快捷键（键盘设置 → 键盘快捷键）比 Toskr 先拿到按键，撞上了就「录上了但按了没反应」；
// 只按 ⌘ 加一个键的组合是各应用的通用命令（⌘C、⌘W…），设成全局会让它在所有应用里失效。两种都拒绝并提示换一个。

// 系统快捷键配置（com.apple.symbolichotkeys）里的修饰键位。
const (
	symShift = 0x20000
	symCtrl  = 0x40000
	symAlt   = 0x80000
	symCmd   = 0x100000
	symMods  = symShift | symCtrl | symAlt | symCmd
)

// symEntry 是系统快捷键配置里的一项。
type symEntry struct {
	enabled bool
	code    int    // 虚拟键码
	mods    uint64 // 修饰键位（可能带 fn 等其他位，比较时只看 symMods）
}

// sysHotkey：常见系统快捷键的默认值与名字。配置文件里没有这一项时按默认值（视为开启）判断。
type sysHotkey struct {
	id   int
	code int
	mods uint64
	name string
}

var defaultSysHotkeys = []sysHotkey{
	{28, 20, symShift | symCmd, "截屏"},
	{29, 20, symCtrl | symShift | symCmd, "将屏幕截图拷贝到剪贴板"},
	{30, 21, symShift | symCmd, "截取所选区域"},
	{31, 21, symCtrl | symShift | symCmd, "将所选区域拷贝到剪贴板"},
	{184, 23, symShift | symCmd, "截屏和录制选项"},
	{64, 49, symCmd, "聚焦搜索"},
	{65, 49, symAlt | symCmd, "访达搜索窗口"},
	{60, 49, symCtrl, "选择上一个输入法"},
	{61, 49, symCtrl | symAlt, "选择下一个输入法"},
	{32, 126, symCtrl, "调度中心"},
	{33, 125, symCtrl, "应用程序窗口"},
	{79, 123, symCtrl, "向左移动一个空间"},
	{81, 124, symCtrl, "向右移动一个空间"},
	{36, 103, 0, "显示桌面"},
	{52, 2, symAlt | symCmd, "打开 / 关闭程序坞自动隐藏"},
	{98, 44, symShift | symCmd, "显示帮助菜单"},
	{27, 50, symCmd, "切换到下一个窗口"},
}

// fixedSysHotkeys：系统写死、设置里改不了的组合。
var fixedSysHotkeys = []sysHotkey{{0, 12, symCtrl | symCmd, "锁定屏幕"}}

// keyCodes：录制框认得的键 → macOS 虚拟键码（ANSI 键位，同 mygo darwin 后端）。
var keyCodes = func() map[ui.Key]int {
	m := map[ui.Key]int{
		ui.KeySpace: 49, ui.KeyLeft: 123, ui.KeyRight: 124, ui.KeyDown: 125, ui.KeyUp: 126,
		ui.KeySemicolon: 41, ui.KeyQuote: 39, ui.KeyComma: 43, ui.KeyPeriod: 47, ui.KeySlash: 44, ui.KeyBackslash: 42,
		ui.KeyBracketLeft: 33, ui.KeyBracketRight: 30, ui.KeyMinus: 27, ui.KeyEqual: 24, ui.KeyBackquote: 50,
	}
	for i, c := range []int{0, 11, 8, 2, 14, 3, 5, 4, 34, 38, 40, 37, 46, 45, 31, 35, 12, 15, 1, 17, 32, 9, 13, 7, 16, 6} { // a–z
		m[ui.KeyA+ui.Key(i)] = c
	}
	for i, c := range []int{29, 18, 19, 20, 21, 23, 22, 26, 28, 25} { // 0–9
		m[ui.Key0+ui.Key(i)] = c
	}
	for i, c := range []int{122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111} { // F1–F12
		m[ui.KeyF1+ui.Key(i)] = c
	}
	return m
}()

func symFlags(m ui.Modifiers) uint64 {
	var f uint64
	for _, p := range []struct {
		mod ui.Modifiers
		bit uint64
	}{{ui.Shift, symShift}, {ui.Ctrl, symCtrl}, {ui.Alt, symAlt}, {ui.Cmd, symCmd}} {
		if m&p.mod != 0 {
			f |= p.bit
		}
	}
	return f
}

// hotkeyConflict：按键组合与系统快捷键或应用通用命令冲突时返回提示，否则 ""。user 是系统快捷键配置（nil = 读不到，只按默认值判断）。
func hotkeyConflict(mods ui.Modifiers, key ui.Key, user map[int]symEntry) string {
	code, ok := keyCodes[key]
	if !ok {
		return ""
	}
	f := symFlags(mods)
	label := keyLabel(func() string { acc, _ := accelFrom(mods, key); return acc }())
	taken := func(name string) string {
		return fmt.Sprintf(tr("%s 已被系统「%s」占用，请换一个"), label, tr(name))
	}
	known := map[int]bool{}
	for _, h := range defaultSysHotkeys {
		known[h.id] = true
		if e, ok := user[h.id]; ok {
			if e.enabled && e.code == code && e.mods&symMods == f {
				return taken(h.name)
			}
			continue
		}
		if h.code == code && h.mods == f {
			return taken(h.name)
		}
	}
	for id, e := range user { // 其余系统快捷键（含用户自己设的）
		if !known[id] && e.enabled && e.code == code && e.mods&symMods == f {
			return taken("键盘快捷键")
		}
	}
	for _, h := range fixedSysHotkeys {
		if h.code == code && h.mods == f {
			return taken(h.name)
		}
	}
	arrow := key == ui.KeyLeft || key == ui.KeyRight || key == ui.KeyUp || key == ui.KeyDown // ⌘← 等是文本编辑的行首行尾
	if f == symCmd && (key >= ui.KeyA && key <= ui.KeyZ || key >= ui.Key0 && key <= ui.Key9 || punctKeys[key] != "" || arrow) {
		return fmt.Sprintf(tr("%s 是各应用通用的快捷键，设成全局会让它在所有应用里失效，请加上 ⇧ / ⌥ / ⌃"), label)
	}
	return ""
}

// readSymbolicHotkeys 读当前用户的系统快捷键配置（plutil 转 JSON）；读不到返回 nil。测试可替换。
var readSymbolicHotkeys = func() map[int]symEntry {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	out, err := exec.Command("/usr/bin/plutil", "-convert", "json", "-o", "-",
		filepath.Join(home, "Library/Preferences/com.apple.symbolichotkeys.plist")).Output()
	if err != nil {
		return nil
	}
	return parseSymbolicHotkeys(out)
}

func parseSymbolicHotkeys(data []byte) map[int]symEntry {
	var doc struct {
		Keys map[string]struct {
			Enabled any `json:"enabled"` // 布尔或 0 / 1
			Value   struct {
				Parameters []float64 `json:"parameters"`
			} `json:"value"`
		} `json:"AppleSymbolicHotKeys"`
	}
	if json.Unmarshal(data, &doc) != nil {
		return nil
	}
	out := map[int]symEntry{}
	for k, v := range doc.Keys {
		id, err := strconv.Atoi(k)
		if err != nil {
			continue
		}
		e := symEntry{code: -1}
		switch x := v.Enabled.(type) {
		case bool:
			e.enabled = x
		case float64:
			e.enabled = x != 0
		}
		if p := v.Value.Parameters; len(p) >= 3 && p[1] != 65535 {
			e.code, e.mods = int(p[1]), uint64(p[2])
		}
		out[id] = e
	}
	return out
}
