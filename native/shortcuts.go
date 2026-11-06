package main

import (
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
)

// 面板内快捷键清单（同 Tauri src/lib/shortcuts.ts，单一来源）：面板里长按 ⌥ 的速查层与设置「快捷键」页的静态表共用。
var panelShortcuts = [][2]string{
	{"⇧⇧ Shift", "捕获选中文本 / 呼出面板"},
	{"⌘← →", "切换顶部页签（⌃Tab 循环）"},
	{"↑ ↓", "移动焦点卡片"},
	{"Space", "全文预览（预览中 ↑↓ 切换）"},
	{"Enter", "编辑（预览内 ⌘⏎ 保存）"},
	{"x", "勾选 / 取消勾选"},
	{"p", "置顶剪贴卡 / 设笔记为常用"},
	{"d", "标记完成 / 取消完成"},
	{"双击卡片", "直发该卡（剪贴页优先添加进打开的编辑器）"},
	{"W", "详情窗切换选词模式（词/段点选，可发送选中片段）"},
	{"⌘A", "全选可见卡片"},
	{"⌘⏎", "发送勾选到对话"},
	{"⌘1-9", "快发第 N 张卡（按住 ⌘ 看角标）"},
	{"⌘C", "复制勾选（多条转编号列表）"},
	{"⌘⌫", "删除焦点卡片"},
	{"⇧⌘⌫", "清理当前页已完成（笔记/任务）"},
	{"⌘Z", "撤销上一步操作"},
	{"⌘F", "搜索"},
	{"⌘K", "命令面板（动作 / 搜索卡片与任务）"},
	{"Esc", "逐层退出（预览→搜索→选择→面板）"},
}

// heldMods：真实按住的修饰键（测试替换为 nil，即信任界面上下文的修饰键状态）。
var heldMods = macos.HeldModifiers

// held 判断修饰键是否真的按着：界面上下文在窗口失焦期间收不到松键，会残留 ⌘ / ⌥，再核对一次键盘实况。
func held(flag uint64) bool { return heldMods == nil || heldMods()&flag != 0 }

const altHoldDelay = 650 * time.Millisecond // 同 Tauri：按住 ⌥ 650ms 才弹，避免 ⌥ 组合键误触

// keycap 是键帽（11px、浅底细描边）。
func keycap(c *ui.Context, k tokens, label string, minW float32) {
	ui.Box(c).MinWidth(minW).Height(18).Padding(0, 6).Radius(4).Background(k.track).Border(1, k.fg.Alpha(0.1)).Center().
		Children(func() { text(c, tr(label), 11, 14, 500, k.fg).SingleLine() })
}

// shortcutHelp：只按住 ⌥ 达 650ms 时，在面板底部浮出全部快捷键；松开即收。
func (a *app) shortcutHelp(c *ui.Context, k tokens) {
	if c.Modifiers() != ui.Alt || !held(macos.FlagOption) {
		a.altSince = time.Time{}
		return
	}
	now := c.Now()
	if a.altSince.IsZero() {
		a.altSince = now
	}
	if now.Sub(a.altSince) < altHoldDelay {
		c.AnimationFrame() // 计时期间继续出帧，到点才能弹出
		return
	}
	fade := ui.ElementTransition{Duration: 120 * time.Millisecond, Ease: easeTw, Enter: &ui.Motion{Y: 4}}
	floatSurface(ui.Column(c).Absolute().Left(12).Right(12).Bottom(12).Padding(12).Gap(2).Radius(12), k).
		Key("shortcut-help").Transition(fade).Label(tr("快捷键")).Children(func() {
		text(c, tr("快捷键"), 11, 16, 600, k.muted).Margin(0, 0, 4, 0)
		for _, r := range panelShortcuts {
			ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
				keycap(c, k, r[0], 40)
				text(c, tr(r[1]), 11, 16, 400, k.muted).SingleLine().Grow(1).Basis(0)
			})
		}
	})
}

// quickBadge：按住 ⌘ 时前 9 张卡左上角显示 ⌘N 快发角标（同 Tauri quickSlot）；top 为距顶偏移（紧凑行取垂直居中）。
func (a *app) quickBadge(c *ui.Context, k tokens, idx int, top float32) {
	if idx < 0 || idx >= 9 || c.Modifiers()&ui.Cmd == 0 || !held(macos.FlagCommand) || a.editing != "" {
		return
	}
	bg, fg := ui.RGBA(0, 0, 0, 0.7), ui.RGB(255, 255, 255)
	if k.dark {
		bg, fg = ui.RGBA(255, 255, 255, 0.8), ui.RGB(0, 0, 0)
	}
	ui.Box(c).Absolute().Left(4).Top(top).Height(16).MinWidth(16).Padding(0, 4).Radius(3).Background(bg).Center().PassThrough().
		Children(func() { text(c, "⌘"+itoa(idx+1), 10, 12, 600, fg) })
}
