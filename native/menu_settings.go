package main

import (
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// menuSettings：卡片右键菜单自定义（同 Tauri SettingsView ContextMenuGroup）——按四个分区列出各项，开关 + 区内上移 / 下移。
func (a *app) menuSettings(c *ui.Context, k tokens, s settingsTokens) {
	cfg := store.NormalizeMenu(a.store.Settings().ContextMenu)
	save := func(next []store.MenuItem) {
		cur := a.store.Settings()
		cur.ContextMenu = next
		_ = a.store.SetSettings(cur)
	}
	labels := map[string]string{}
	for _, r := range store.MenuRegistry {
		labels[r.ID] = r.Label
	}
	for _, g := range store.MenuGroups {
		var ids []int
		for i, x := range cfg {
			if store.MenuGroupOf(x.ID) == g.ID {
				ids = append(ids, i)
			}
		}
		text(c, tr(g.Label), 11, 16, 500, k.muted).Margin(4, 0, 0, 0)
		for pos, i := range ids {
			item := cfg[i]
			ui.Row(c).Height(28).Gap(10).AlignItems(ui.Center).Key("menu-" + item.ID).Children(func() {
				on := item.On
				if toggle(c, s, &on) {
					next := append([]store.MenuItem(nil), cfg...)
					next[i].On = on
					save(next)
				}
				col := k.fg
				if !item.On {
					col = k.muted
				}
				text(c, tr(labels[item.ID]), 13, 18, 400, col).Grow(1).Basis(0)
				if pos > 0 && a.iconButton(c, k, "arrow-up", 22, 12, tr("区内上移")) {
					save(store.MoveMenuItem(cfg, item.ID, -1))
				}
				if pos < len(ids)-1 && a.iconButton(c, k, "arrow-down", 22, 12, tr("区内下移")) {
					save(store.MoveMenuItem(cfg, item.ID, 1))
				}
			})
		}
	}
}
