package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/diag"
	"github.com/toskr/native/internal/macos"
)

// 权限引导横幅（同 Tauri PermissionBanner）：
// 1. 辅助功能未授权 / 键盘监听没建起来 → 「需要『辅助功能』权限」+ 打开辅助功能设置；
// 2. 监听建了但 12 秒内一个按键都没收到（输入监控授权对当前签名没生效）→ 「键盘事件被系统拦截」+ 一键重置授权 / 打开输入监控设置 / 重启。

const permStuckAfter = 12 * time.Second

// permState：ok | ax | stuck | wait（建好监听后的观察期，不打扰）。
func (a *app) permState(now time.Time) string {
	switch {
	case !a.permAX || a.tapErr != "":
		return "ax"
	case a.tapReceiving.Load():
		return "ok"
	case !a.tapStarted.IsZero() && now.Sub(a.tapStarted) >= permStuckAfter:
		return "stuck"
	}
	return "wait"
}

// watchPermission 每 3 秒查一次辅助功能授权；授权后几秒内自动生效（必要时重建键盘监听）。
func (a *app) watchPermission() {
	a.permAX = macos.AXTrusted(false)
	go func() {
		for range time.Tick(3 * time.Second) {
			ok := macos.AXTrusted(false)
			a.panel.Update(func() {
				if ok && !a.permAX {
					diag.Push("辅助功能已授权")
				}
				a.permAX = ok
				if ok && a.tapErr != "" {
					a.startTap()
				}
			})
		}
	}()
}

func openPrivacy(pane string) {
	_ = exec.Command("open", "x-apple.systempreferences:com.apple.preference.security?"+pane).Start()
}

// resetInputMonitoring：删掉本应用的输入监控旧条目（签名变了旧条目不生效），再打开设置让用户重新勾选。
func (a *app) resetInputMonitoring() {
	out, err := exec.Command("/usr/bin/tccutil", "reset", "ListenEvent", "com.toskr.native").CombinedOutput()
	if err != nil {
		a.showHUD("warn", tr("重置失败：")+strings.TrimSpace(string(out)))
		return
	}
	diag.Push("已重置输入监控授权")
	openPrivacy("Privacy_ListenEvent")
	a.showHUD("ok", tr("已重置，请在设置里重新勾选 Toskr，然后点「重启」"))
}

// restartApp：退出后由 shell 重新打开本 .app。
func (a *app) restartApp() {
	exe, err := os.Executable()
	if err != nil {
		return
	}
	bundle := filepath.Dir(filepath.Dir(filepath.Dir(exe))) // …/Toskr Native.app/Contents/MacOS/Toskr Native
	if !strings.HasSuffix(bundle, ".app") {
		a.showHUD("warn", tr("当前不是从 .app 运行，无法自动重启"))
		return
	}
	if err := exec.Command("/bin/sh", "-c", `sleep 1; /usr/bin/open "$0"`, bundle).Start(); err != nil {
		a.showHUD("warn", tr("重启失败：")+err.Error())
		return
	}
	mygo.App.Quit()
}

func (a *app) permissionBanner(c *ui.Context, k tokens) {
	state := a.permState(a.now())
	if state == "ok" || state == "wait" {
		return
	}
	s := stok(c)
	tone, icon, title := k.amberText, "shield-alert", tr("需要「辅助功能」权限")
	body := tr("Toskr 依赖辅助功能权限监听双击 ⇧ Shift 并读取选中文本。请在系统设置中勾选 Toskr（若列表已有旧条目请先删除再重新添加），授权后几秒内自动生效。")
	if state == "stuck" {
		tone, icon, title = k.danger, "keyboard-off", tr("键盘事件被系统拦截")
		body = tr("监听已创建但收不到按键——通常是「输入监控」授权条目未对当前签名生效（即使开关已打开也会如此）。点「一键重置授权」自动删除旧条目，在打开的设置里重新勾选 / 添加 Toskr，再点「重启」即可恢复。")
	}
	ui.Column(c).Margin(0, 12, 8, 12).Padding(12).Gap(6).Radius(12).Background(tone.Alpha(0.1)).Border(1, tone.Alpha(0.3)).
		Label(title).Key("perm-banner").Children(func() {
		ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
			licon(c, icon, 14, tone)
			text(c, title, 12, 17, 500, tone)
		})
		text(c, body, 11, 16, 400, k.muted).Wrap()
		ui.Row(c).Gap(6).Children(func() {
			if state == "stuck" {
				if button(c, s, "一键重置授权") {
					a.resetInputMonitoring()
				}
				if button(c, s, "打开输入监控设置") {
					openPrivacy("Privacy_ListenEvent")
				}
				if button(c, s, "重启 Toskr") {
					a.restartApp()
				}
				return
			}
			if button(c, s, "打开辅助功能设置") {
				macos.AXTrusted(true) // 系统会把本应用加进列表并弹提示
				openPrivacy("Privacy_Accessibility")
			}
		})
	})
}
