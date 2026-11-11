package main

import (
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/diag"
	"github.com/toskr/native/internal/store"
)

// 分组颜色弹层（同 Tauri SectionGroup 菜单里的色点行）：原生菜单只能放文字，色板单独做成贴着分组头 / 侧栏胶囊的弹层——
// 标题行（分组颜色 · 当前色名）→ 9 个色点 + 「无颜色」，当前色带外环与对勾，悬停放大并提示色名；点选即生效并收起。

var sectionColorNames = map[string]string{
	"#ef4444": "红", "#f97316": "橙", "#eab308": "黄", "#22c55e": "绿", "#14b8a6": "青",
	"#3b82f6": "蓝", "#8b5cf6": "紫", "#ec4899": "粉", "#94a3b8": "灰",
}

// openSectionColor：菜单「分组颜色…」——在打开菜单的那个位置（分组头 / 侧栏 / 横栏）弹出色板。
func (a *app) openSectionColor(id string) {
	a.secColorPick, a.secColorSrc = id, a.secMenuSrc
}

// sectionColorPopover：src 与打开菜单的位置一致时，在 anchor 下方弹出色板。
func (a *app) sectionColorPopover(c *ui.Context, k tokens, s store.Section, anchor ui.Element, src string) {
	if a.secColorPick != s.ID || a.secColorSrc != src {
		return
	}
	open := true
	ui.Popover(c, anchor, &open, func() {
		ui.Column(c).Gap(10).Padding(2).Key("seccolor-" + s.ID).Children(func() {
			ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
				text(c, tr("分组颜色"), 12, 17, 600, k.fg)
				cur := tr("无")
				if name, ok := sectionColorNames[s.Color]; ok {
					cur = tr(name)
				}
				text(c, sectionName(s)+" · "+cur, 11, 16, 400, k.muted).SingleLine().Shrink(1)
			})
			ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
				for _, col := range sectionColors {
					if a.colorDot(c, k, s.ID, col, s.Color == col) {
						a.setSectionColor(s, col)
					}
				}
				ui.Box(c).Width(1).Height(14).Margin(0, 2).Background(k.fg.Alpha(0.12))
				if a.colorDot(c, k, s.ID, "", s.Color == "") {
					a.setSectionColor(s, "")
				}
			})
		})
	})
	if !open {
		a.secColorPick = ""
	}
}

// colorDot：18pt 色点；col 为空是「无颜色」（细描边空心圆 + 斜线）。
func (a *app) colorDot(c *ui.Context, k tokens, id, col string, on bool) bool {
	label := tr("无颜色")
	if name, ok := sectionColorNames[col]; ok {
		label = tr(name)
	}
	tip := label
	if on {
		tip += tr("（当前）")
	}
	b := ui.Box(c).Size(24, 24).Center().Key("secdot-" + id + col).Role(ui.RoleButton).Label(label).Tooltip(tip) // 不用 Selected：主题会给选中元素铺方形强调底
	s := float32(1)
	if b.Hovered() {
		s = 1.15
	}
	b.Children(func() {
		if on { // 当前色：与色点隔 2.5pt 的外环
			ring := k.fg.Alpha(0.4)
			if col != "" {
				ring = hexColor(col)
			}
			ui.Box(c).Absolute().Top(0).Left(0).Size(24, 24).Radius(12).Border(1.5, ring).PassThrough()
		}
		dot := ui.Box(c).Size(16, 16).Radius(8).Center().AnimatePose(ui.Pose{Scale: s}, tweenTw)
		if col == "" {
			dot.Border(1, k.muted.Alpha(0.7)).Children(func() {
				ui.Box(c).Size(1.2, 14).Background(k.muted.Alpha(0.7)).Rotate(45)
			})
			return
		}
		dot.Background(hexColor(col))
		if on {
			dot.Children(func() { licon(c, "check", 10, ui.RGB(255, 255, 255)) })
		}
	})
	return b.Clicked()
}

func (a *app) setSectionColor(s store.Section, col string) {
	a.secColorPick = ""
	if s.Color == col {
		return
	}
	s.Color = col
	_ = a.store.UpdateSection(s)
	st := a.store.Settings()
	diag.Push("分组颜色: %s → %q（卡片彩色通栏=%v 方案=%s）", s.ID, col, !st.CardTintOff, cmpOr(st.ColorScheme, "default"))
	if col != "" && st.CardTintOff { // 通栏不跟分组色：告诉用户在哪打开
		a.showHUD("info", tr("「卡片彩色通栏」已关闭，卡片通栏不随分组色变化：设置 → 窗口与外观里打开"))
	}
}

func init() {
	for k, v := range map[string]string{
		"分组颜色…": "Group color…", "分组颜色": "Group color", "无颜色": "No color", "无": "None",
		"红": "Red", "橙": "Orange", "黄": "Yellow", "绿": "Green", "青": "Teal", "蓝": "Blue", "紫": "Purple", "粉": "Pink", "灰": "Gray", "（当前）": " (current)",
		"「卡片彩色通栏」已关闭，卡片通栏不随分组色变化：设置 → 窗口与外观里打开": "Colored card bands are off, so cards won't follow the group color. Turn them on in Settings → Window & appearance",
	} {
		if _, ok := en[k]; !ok {
			en[k] = v
		}
	}
}
