package main

import (
	"slices"
	"strings"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
)

// 应用名单编辑器（同 Tauri AppListEditor / AppListRow）：「选择应用…」从 /Applications 选 .app，「加入当前应用」加最近的目标应用；
// 每行显示图标与应用名（悬停看 bundle id），悬停显出移除钮。名单仍以换行分隔的 bundle id 存在设置编辑态里。

var (
	pickAppBundle = func(a *app) string { // 测试替换
		paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{Parent: a.settingsWin, Title: tr("选择应用"), DefaultPath: "/Applications",
			Filters: []mygo.FileFilter{{Name: tr("应用程序"), Extensions: []string{"app"}}}})
		if err != nil || len(paths) == 0 {
			return ""
		}
		return macos.BundleIDOfApp(paths[0])
	}
	appDisplayName = macos.AppDisplayName
)

func (a *app) appName(bundle string) string {
	if a.appNames == nil {
		a.appNames = map[string]string{}
	}
	if n, ok := a.appNames[bundle]; ok {
		return n
	}
	n := appDisplayName(bundle)
	if n == "" {
		n = bundle
	}
	a.appNames[bundle] = n
	return n
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
			row := ui.Row(c).Gap(8).Padding(4, 6).Radius(6).AlignItems(ui.Center).Key(key + "-" + b)
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
				text(c, a.appName(b), 13, 18, 400, k.fg).SingleLine().Grow(1).Basis(0).Tooltip(b)
				if ghostIconButton(c, k, key+"-rm-"+b, "x", tr("移除")+" "+a.appName(b), 22, 13, true, hov).Clicked() {
					apps = slices.DeleteFunc(apps, func(x string) bool { return x == b })
					*list, changed = strings.Join(apps, "\n"), true
				}
			})
		}
	})
	return changed
}
