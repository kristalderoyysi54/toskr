package main

import "github.com/egoist/mygo/ui"

// floatEdge 给独立浮层套统一的边缘（用户 2026-11-25 定，参考 Dia 的标签悬停卡）：
// 灰填充 + 1px 外暗线 + 整圈 1px 内亮线 + 贴身影 + 环境影。亮线靠灰填充才看得见，所以填充一起给。
// 内亮线是均匀的一整圈（模糊 0、内扩 1），不是顶缘高光。圆角由调用方定。
// 主题生效时不接管（返回 false），调用方保留原来的画法。
// 与 drawer.go 的 floatSurface（弹层底，仍是旧画法）并存。用在：分组速览、图片窥视、标题栏菜单、行内工具浮条、
// 批量选择条、详情窗选区浮条及其弹层、剪贴卡操作条、秘文解锁胶囊、拖出预览小卡；HUD 气泡纸色不同，用 hudEdge 只取两条线。
func floatEdge(e ui.Element, k tokens) bool {
	if isTheme(curScheme) {
		return false
	}
	e.Background(k.floatFill).Border(1, k.floatLine).InsetShadow(0, 0, 0, 1, k.floatRim).
		Shadow(0, 1, 2, 0, k.floatCastA).Shadow(0, 4, 12, -2, k.floatCastB)
	return true
}

// lifted 按 on 在 150ms 内淡入 / 淡出列表卡的抬起态：1px 外暗线 + 与浮层同一组投影；卡面填充不变、不加内亮线
// （内缘留给选中柔光）。外暗线画成外扩 1 的投影，不占版面。只给自己没有描边的卡用；
// 带描边的常亮容器（收件箱分组框、收件箱抽屉、今日时间块）仍用 elevated，免得出两条线。
func lifted(e ui.Element, k tokens, on bool) {
	pick := func(key string, col ui.Color) ui.Color {
		if !on {
			col = col.Alpha(0)
		}
		return e.AnimateColor(key, col, tweenTw)
	}
	if k.th.Elevation(e, pick) { // 主题自己的抬升画法
		return
	}
	e.Shadow(0, 0, 0, 1, pick("e2l", k.floatLine)).Shadow(0, 1, 2, 0, pick("e2a", k.floatCastA)).Shadow(0, 4, 12, -2, pick("e2b", k.floatCastB))
}
