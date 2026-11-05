package main

import (
	_ "embed"

	"github.com/egoist/mygo"

	"github.com/toskr/native/internal/diag"
)

//go:embed resources/trayTemplate.png
var trayPNG []byte

func (a *app) setUpTray() {
	var err error
	a.tray, err = mygo.NewTray(mygo.TrayOptions{Icon: trayPNG, IconIsTemplate: true, ToolTip: "Toskr"})
	if err != nil {
		diag.Push("托盘创建失败: %v", err)
		return
	}
	a.tray.SetMenu(mygo.NewMenu([]*mygo.MenuItem{
		{Label: "显示 / 隐藏面板", Accelerator: a.shortcut, Click: func(*mygo.MenuItem, *mygo.Window) { a.togglePanel() }},
		{Label: "设置…", Click: func(*mygo.MenuItem, *mygo.Window) { a.openSettings() }},
		mygo.Separator(),
		{Label: "开机启动", Type: mygo.MenuItemCheckbox, Checked: mygo.App.OpenAtLogin(),
			Click: func(it *mygo.MenuItem, _ *mygo.Window) {
				if err := mygo.App.SetOpenAtLogin(it.Checked); err != nil {
					diag.Push("开机启动设置失败: %v", err)
				}
			}},
		mygo.Separator(),
		{Label: "退出 Toskr Native", Role: mygo.RoleQuit},
	}))
}
