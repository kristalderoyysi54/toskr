package main

import (
	"slices"
	"strings"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
)

var (
	modifierNames  = []string{"shift", "control", "option"}
	modifierLabels = []string{"⇧ Shift", "⌃ Control", "⌥ Option"}
	glassNames     = []string{"glass", "clear", "none"}
	glassLabels    = []string{"液态玻璃", "清透玻璃", "关闭"}
)

func (a *app) openSettings() {
	st := a.store.Settings()
	a.setModifier = max(0, slices.Index(modifierNames, st.TriggerModifier))
	a.setGap = float64(st.TriggerGapMs)
	a.setClip = st.ClipboardWatch
	a.setGlass = max(0, slices.Index(glassNames, st.Glass))
	a.setExcluded = strings.Join(st.ExcludedApps, "\n")
	a.axTrusted = macos.AXTrusted(false)
	if a.settingsWin == nil {
		a.settingsWin = mygo.NewWindow(mygo.WindowOptions{
			Title: "Toskr 设置", Width: 560, Height: 600, Hidden: true,
			Vibrancy: mygo.VibrancySidebar, Transparent: true,
			Content: ui.View(a.settingsView),
		})
		a.settingsWin.OnClose(func(e *mygo.CloseEvent) {
			e.PreventDefault()
			a.settingsWin.Hide()
		})
	}
	a.settingsWin.Invalidate()
	a.settingsWin.Show()
	a.settingsWin.Focus()
}

func (a *app) saveSettings() {
	st := a.store.Settings()
	st.TriggerModifier = modifierNames[a.setModifier]
	st.TriggerGapMs = int(a.setGap)
	st.ClipboardWatch = a.setClip
	oldGlass := st.Glass
	st.Glass = glassNames[a.setGlass]
	st.ExcludedApps = nil
	for _, line := range strings.Split(a.setExcluded, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			st.ExcludedApps = append(st.ExcludedApps, line)
		}
	}
	_ = a.store.SetSettings(st)
	if oldGlass != st.Glass {
		v := vibrancyFor(st.Glass)
		a.panel.SetVibrancy(v)
		a.hud.SetVibrancy(v)
		a.panel.Invalidate()
	}
}

func (a *app) settingsView(c *ui.Context) {
	t := c.Theme()
	if c.Vibrancy() {
		c.Root().Background(ui.Transparent)
	} else {
		c.Root().Background(t.Background)
	}
	section := func(title string, body func()) {
		ui.Column(c).Padding(14, 16).Gap(10).Radius(12).Background(t.Surface.Alpha(0.7)).Children(func() {
			ui.Text(c, title).Bold()
			body()
		})
	}
	row := func(label string, control func()) {
		ui.Row(c).Gap(12).AlignItems(ui.Center).Children(func() {
			ui.Text(c, label).Grow(1)
			control()
		})
	}
	changed := false
	ui.Scroll(c).Fill().Children(func() {
		ui.Column(c).Padding(24, 20).Gap(14).Children(func() {
			section("触发", func() {
				row("双击修饰键", func() { changed = ui.Segmented(c, &a.setModifier, modifierLabels...).Changed() || changed })
				row("两击最大间隔（毫秒）", func() { changed = ui.NumberInput(c, &a.setGap, 150, 1000, 50).Width(110).Changed() || changed })
				ui.Text(c, "面板快捷键："+keyLabel(a.shortcut)).FontSize(12).TextColor(t.TextMuted)
			})
			section("剪贴板", func() {
				row("记录剪贴板历史", func() { changed = ui.Switch(c, &a.setClip).Changed() || changed })
				ui.Text(c, "排除这些应用（每行一个 bundle id，不捕获、不记录）").FontSize(12).TextColor(t.TextMuted)
				changed = ui.TextArea(c, &a.setExcluded).Lines(3, 8).Changed() || changed
			})
			section("外观", func() {
				row("面板材质", func() { changed = ui.Segmented(c, &a.setGlass, glassLabels...).Changed() || changed })
				ui.Text(c, "macOS 26 起为系统液态玻璃；更早系统回退为模糊材质，卡片使用 mygo 绘制的窗内玻璃").FontSize(12).TextColor(t.TextMuted).Wrap()
			})
			section("权限", func() {
				status := "未授权"
				if a.axTrusted {
					status = "已授权"
				}
				row("辅助功能（读取选区、合成粘贴）："+status, func() {
					if ui.Button(c, "打开授权").Clicked() {
						a.axTrusted = macos.AXTrusted(true)
					}
				})
				if a.tapErr != "" {
					ui.Text(c, "键盘监听："+a.tapErr).FontSize(12).TextColor(t.Danger).Wrap()
				} else {
					ui.Text(c, "键盘监听：正常").FontSize(12).TextColor(t.TextMuted)
				}
			})
			section("数据", func() {
				ui.Text(c, "目录："+dataDir()).FontSize(12).TextColor(t.TextMuted).Wrap()
				ui.Text(c, "加密：AES-256-GCM（TSK1 信封），密钥存于钥匙串").FontSize(12).TextColor(t.TextMuted)
				row("清空剪贴板分组（保留项除外）", func() {
					if ui.Button(c, "清空").Clicked() {
						n := a.store.ClearSection("clipboard")
						c.Toast("已清空 " + itoa(n) + " 条")
					}
				})
			})
			ui.Text(c, "Toskr Native "+mygo.App.Version()+" · mygo").FontSize(11).TextColor(t.TextMuted).Center()
		})
	})
	if changed {
		a.saveSettings()
	}
}

func keyLabel(s string) string {
	return strings.NewReplacer("Cmd+", "⌘", "CmdOrCtrl+", "⌘", "Shift+", "⇧", "Alt+", "⌥", "Ctrl+", "⌃").Replace(s)
}
