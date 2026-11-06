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

// 权限引导横幅（同 Tauri PermissionBanner + permissionGuard.ts）：
// 1. 辅助功能未授权 / 键盘监听没建起来 → 「需要『辅助功能』权限」+ 打开辅助功能设置；
// 2. 输入监控被扣 → 「键盘事件被系统拦截」+ 重置授权 / 打开设置 / 重启。
// 判 2 只认铁证，不把「启动后没人打字」当故障（老逻辑 12 秒误报，重启后必现）：
// 系统授权查询连续 2 次为否；或面板自己收到过按键而监听连续 4 次（约 12 秒）没有事件。

// permState：ok | ax | stuck | wait（不打扰）。
func (a *app) permState() string {
	switch {
	case !a.permAX || a.tapErr != "":
		return "ax"
	case a.tapReceiving.Load():
		return "ok"
	case a.permNoAuth >= 2 || (a.permStuck >= 4 && a.permKeySeen):
		return "stuck"
	}
	return "wait"
}

// permTick：每 3 秒一次的跨 tick 累计（同 Tauri advancePermissionGuard）。listening 为系统输入监控授权查询结果。
func (a *app) permTick(listening bool) {
	if listening {
		a.permNoAuth = 0
	} else {
		a.permNoAuth++
	}
	installed := a.tapErr == "" && !a.tapStarted.IsZero()
	receiving := a.tapReceiving.Load()
	if listening && installed && !receiving {
		a.permStuck++
	} else {
		a.permStuck = 0
	}
	if receiving {
		a.permKeySeen = false
	}
}

// watchPermission 每 3 秒查一次授权；辅助功能授权后几秒内自动生效（必要时重建键盘监听）。
func (a *app) watchPermission() {
	a.permAX = macos.AXTrusted(false)
	go func() {
		for range time.Tick(3 * time.Second) {
			ok, listening := macos.AXTrusted(false), macos.ListenAuthorized()
			a.panel.Update(func() {
				if ok && !a.permAX {
					diag.Push("辅助功能已授权")
				}
				a.permAX = ok
				if ok && a.tapErr != "" {
					a.startTap()
				}
				a.permTick(listening)
			})
		}
	}()
}

// notePanelKeys：面板自己看到键盘活动（按住修饰键、输入区文字变了）= 键盘确凿在用的证据，监听却没事件才算被拦截。
func (a *app) notePanelKeys(c *ui.Context) {
	if c.Modifiers() != 0 || a.draft != a.permDraft {
		a.permKeySeen = true
	}
	a.permDraft = a.draft
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
	state := a.permState()
	if state == "ok" || state == "wait" {
		return
	}
	s := stok(c)
	tone, icon, title := k.amberText, "shield-alert", tr("需要「辅助功能」权限")
	body := tr("双击 ⇧ 捕获选中文本需要此权限。在系统设置里勾选 Toskr，授权后自动生效。")
	if state == "stuck" {
		tone, icon, title = k.danger, "keyboard-off", tr("键盘事件被系统拦截")
		body = tr("「输入监控」授权对当前版本未生效。点「重置授权」后在设置里重新勾选 Toskr，再重启。")
	}
	ui.Column(c).Margin(0, 12, 8, 12).Padding(12).Gap(6).Radius(12).Background(tone.Alpha(0.1)).Border(1, tone.Alpha(0.3)).
		Label(title).Key("perm-banner").Children(func() {
		ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
			licon(c, icon, 14, tone)
			text(c, title, 12, 17, 500, tone)
		})
		text(c, body, 11, 16, 400, k.muted).Wrap().MaxLines(2)
		ui.Row(c).Gap(6).Children(func() {
			if state == "stuck" {
				if bannerButton(c, s, "重置授权") {
					a.resetInputMonitoring()
				}
				if bannerButton(c, s, "打开设置") {
					openPrivacy("Privacy_ListenEvent")
				}
				if bannerButton(c, s, "重启") {
					a.restartApp()
				}
				return
			}
			if bannerButton(c, s, "打开辅助功能设置") {
				macos.AXTrusted(true) // 系统会把本应用加进列表并弹提示
				openPrivacy("Privacy_Accessibility")
			}
		})
	})
}

// bannerButton：横幅里的小按钮（24 高、文字单行不折、不被挤压）。
func bannerButton(c *ui.Context, s settingsTokens, label string) bool {
	if s.pt {
		return ptButton(c, label)
	}
	b := ui.Row(c).Height(24).Padding(0, 8).Radius(8).Border(1, s.btnBorder).AlignItems(ui.Center).Shrink(0)
	bg := s.btn
	if b.Hovered() {
		bg = s.btnHover
	}
	b.Background(bg).Shadow(0, 1, 2, 0, s.btnShadow).Children(func() { text(c, tr(label), 11, 16, 500, s.btnFg).SingleLine() })
	return b.Clicked()
}
