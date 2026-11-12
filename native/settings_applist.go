package main

import (
	"slices"
	"strings"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/diag"
	"github.com/toskr/native/internal/macos"
)

// 应用名单编辑器（同 Tauri AppListEditor / AppListRow）：「选择应用…」从 /Applications 选 .app，「加入当前应用」加最近的目标应用；
// 每行显示图标与应用名（悬停看 bundle id），悬停显出移除钮。名单仍以换行分隔的 bundle id 存在设置编辑态里。

var (
	pickAppBundle = func(a *app) string { // 测试替换
		p := macos.PickApplication(tr("选择应用"), tr("选择")) // 专用面板：只能选 .app（mygo 扩展名过滤会把应用全部置灰）
		if p == "" {
			return ""
		}
		b := macos.BundleIDOfApp(p)
		if b == "" {
			a.showHUD("warn", tr("读不到这个应用的标识，换一个试试"))
		}
		diag.Push("选择应用: %s → %s", p, b)
		return b
	}
	appDisplayName = macos.AppDisplayName
)

// presetAppNames：预置终端的显示名——本机没装时系统查不到名称，不能把包名露给用户。
var presetAppNames = map[string]string{
	"com.apple.Terminal": "Terminal", "com.googlecode.iterm2": "iTerm", "dev.warp.Warp-Stable": "Warp",
	"com.github.wez.wezterm": "WezTerm", "net.kovidgoyal.kitty": "kitty", "io.alacritty": "Alacritty", "com.mitchellh.ghostty": "Ghostty",
}

func (a *app) appName(bundle string) string {
	if a.appNames == nil {
		a.appNames, a.appMissing = map[string]string{}, map[string]bool{}
	}
	if n, ok := a.appNames[bundle]; ok {
		return n
	}
	n := appDisplayName(bundle)
	if n == "" {
		a.appMissing[bundle] = true
		if n = presetAppNames[bundle]; n == "" {
			n = bundle
		}
	}
	a.appNames[bundle] = n
	return n
}

// appInstalled：系统能否找到这个应用（查不到 = 没装）。
func (a *app) appInstalled(bundle string) bool {
	a.appName(bundle)
	return !a.appMissing[bundle]
}

// appListEditor 编辑 list（换行分隔的 bundle id）；有改动返回 true（调用方据此保存）。
func (a *app) appListEditor(c *ui.Context, k tokens, s settingsTokens, key string, list *string, addLabel string) bool {
	apps := lines(*list)
	changed := false
	add := func(b string) {
		if b != "" && !slices.Contains(apps, b) {
			apps = append(apps, b)
			*list, changed = strings.Join(apps, "\n"), true
		}
	}
	ui.Column(c).Gap(4).Margin(6, 0, 0, 0).Key(key).Children(func() {
		ui.Row(c).Gap(6).Children(func() {
			if button(c, s, "选择应用…") {
				add(pickAppBundle(a))
			}
			if button(c, s, addLabel) {
				add(a.target.BundleID)
			}
		})
		if len(apps) == 0 {
			text(c, tr("还没有应用"), 12, 17, 400, k.muted).Padding(4, 6)
			return
		}
		for _, b := range apps {
			row := ui.Row(c).Gap(8).Padding(4, 6).Radius(rr(6)).AlignItems(ui.Center).Key(key + "-" + b)
			hov := row.Hovered()
			if hov {
				row.Background(k.track)
			}
			row.Children(func() {
				if img := a.appIcon(b); img != nil {
					ui.Image(c, img).Size(20, 20)
				} else {
					ui.Box(c).Size(20, 20).Radius(4).Background(k.track)
				}
				tipOf(c, text(c, a.appName(b), 13, 18, 400, k.fg).SingleLine().Grow(1).Basis(0), b)
				if ghostIconButton(c, k, key+"-rm-"+b, "x", tr("移除")+" "+a.appName(b), 22, 13, true, hov).Clicked() {
					apps = slices.DeleteFunc(apps, func(x string) bool { return x == b })
					*list, changed = strings.Join(apps, "\n"), true
				}
			})
		}
	})
	return changed
}
