package main

import (
	_ "embed"
	"fmt"
	"time"

	"github.com/egoist/mygo"

	"github.com/toskr/native/internal/diag"
)

//go:embed resources/trayTemplate.png
var trayPNG []byte

var clipPauseMinutes = []int{15, 30, 60, 180, 480}

func (a *app) setUpTray() {
	var err error
	a.tray, err = mygo.NewTray(mygo.TrayOptions{Icon: trayPNG, IconIsTemplate: true, ToolTip: "Toskr"})
	if err != nil {
		diag.Push("托盘创建失败: %v", err)
		return
	}
	a.refreshTray()
}

func pauseLabel(m int) string {
	if m < 60 {
		return fmt.Sprintf(tr("暂停 %d 分钟"), m)
	}
	return fmt.Sprintf(tr("暂停 %d 小时"), m/60)
}

// pauseClipboard：暂停剪贴板收集 m 分钟（0 = 立即恢复）。
func (a *app) pauseClipboard(m int) {
	st := a.store.Settings()
	if m <= 0 {
		st.ClipPauseUntil = time.Time{}
	} else {
		st.ClipPauseUntil = a.now().Add(time.Duration(m) * time.Minute)
	}
	_ = a.store.SetSettings(st)
	a.refreshTray()
}

// trayKey：托盘菜单依赖的状态；不变就不重建菜单（菜单展开时重建会闪）。
func (a *app) trayKey() string {
	st := a.store.Settings()
	paused := ""
	if a.now().Before(st.ClipPauseUntil) {
		paused = st.ClipPauseUntil.Format("15:04")
	}
	return fmt.Sprint(a.shortcut, st.ClipboardWatch, paused, st.Stealth, st.ScreenshotOff, a.permState())
}

// refreshTray 按当前状态重建托盘菜单（同 Tauri tray.rs：显示面板、截图、暂停 / 恢复剪贴板收集、隐身模式、设置、开机启动、退出）。
func (a *app) refreshTray() {
	if a.tray == nil {
		return
	}
	key := a.trayKey()
	if key == a.trayBuilt {
		return
	}
	a.trayBuilt = key
	st := a.store.Settings()
	var items []*mygo.MenuItem
	switch a.permState() { // 权限没到位时托盘顶部给警告项（同 Tauri tray.rs fix-permission）
	case "ax":
		items = append(items, &mygo.MenuItem{Label: tr("⚠️ 需要辅助功能权限（点击设置）"), Click: func(*mygo.MenuItem, *mygo.Window) { openPrivacy("Privacy_Accessibility") }}, mygo.Separator())
	case "stuck":
		items = append(items, &mygo.MenuItem{Label: tr("⚠️ 需要输入监控权限（点击设置）"), Click: func(*mygo.MenuItem, *mygo.Window) { openPrivacy("Privacy_ListenEvent") }}, mygo.Separator())
	}
	items = append(items, &mygo.MenuItem{Label: tr("显示 / 隐藏面板"), Accelerator: a.shortcut, Click: func(*mygo.MenuItem, *mygo.Window) { a.togglePanel() }})
	if !st.ScreenshotOff { // 区域截图关闭时托盘不显示入口（同 Tauri tray.rs）
		items = append(items, &mygo.MenuItem{Label: tr("截图"), Click: func(*mygo.MenuItem, *mygo.Window) { a.screenshot() }})
	}
	items = append(items, mygo.Separator())
	if st.ClipboardWatch {
		if now := a.now(); now.Before(st.ClipPauseUntil) {
			mins := int((st.ClipPauseUntil.Sub(now) + time.Minute - 1) / time.Minute)
			items = append(items, &mygo.MenuItem{Label: fmt.Sprintf(tr("恢复剪贴板收集（约 %d 分钟后自动恢复）"), mins),
				Click: func(*mygo.MenuItem, *mygo.Window) { a.pauseClipboard(0) }})
		} else {
			var sub []*mygo.MenuItem
			for _, m := range clipPauseMinutes {
				m := m
				sub = append(sub, &mygo.MenuItem{Label: pauseLabel(m), Click: func(*mygo.MenuItem, *mygo.Window) { a.pauseClipboard(m) }})
			}
			items = append(items, &mygo.MenuItem{Label: tr("暂停剪贴板收集"), Submenu: sub})
		}
	}
	items = append(items,
		&mygo.MenuItem{Label: tr("隐身模式"), Type: mygo.MenuItemCheckbox, Checked: st.Stealth, Click: func(it *mygo.MenuItem, _ *mygo.Window) {
			cur := a.store.Settings()
			cur.Stealth = it.Checked
			_ = a.store.SetSettings(cur)
		}},
		&mygo.MenuItem{Label: tr("设置…"), Click: func(*mygo.MenuItem, *mygo.Window) { a.openSettings() }},
		mygo.Separator(),
		&mygo.MenuItem{Label: tr("开机启动"), Type: mygo.MenuItemCheckbox, Checked: mygo.App.OpenAtLogin(),
			Click: func(it *mygo.MenuItem, _ *mygo.Window) {
				if err := mygo.App.SetOpenAtLogin(it.Checked); err != nil {
					diag.Push("开机启动设置失败: %v", err)
				}
			}},
		mygo.Separator(),
		&mygo.MenuItem{Label: tr("退出 Toskr Native"), Role: mygo.RoleQuit},
	)
	a.tray.SetMenu(mygo.NewMenu(items))
}
