package main

import (
	"os/exec"
	"strings"
	"sync/atomic"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/diag"
	"github.com/toskr/native/internal/macos"
)

// 设置 → 诊断（同 Tauri DiagnosticsSection）：最近 50 条事件，实时刷新（diag.OnPush 让设置窗重绘）；
// 原生版多了「捕获 / 发送」筛选，对应 Tauri 设置搜索里的「捕获诊断」「发送诊断」。

var diagCaptureKeys = []string{"双击", "捕获", "触发", "选区", "键盘", "剪贴板", "辅助功能", "截图"}
var diagDeliveryKeys = []string{"发送", "粘贴", "目标", "预检"}

func diagMatch(msg, filter string) bool {
	keys := diagCaptureKeys
	switch filter {
	case "capture":
	case "delivery":
		keys = diagDeliveryKeys
	default:
		return true
	}
	for _, k := range keys {
		if strings.Contains(msg, k) {
			return true
		}
	}
	return false
}

func (a *app) diagSections(c *ui.Context, k tokens, s settingsTokens) []setSection {
	f := cmpOr(a.diagFilter, "all")
	var list []diag.Entry
	for _, e := range diag.Recent(200) {
		if len(list) < 50 && diagMatch(e.Msg, f) {
			list = append(list, e)
		}
	}
	rows := []setRow{{title: tr("最近 50 条事件，自动刷新：触发、捕获与发送的结果。"), control: func() {
		ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
			if v, ok := miniSegmented(c, k, f, [][2]string{{"all", "全部"}, {"capture", "捕获"}, {"delivery", "发送"}}); ok {
				a.diagFilter = v
			}
			if button(c, s, "打开日志文件") {
				_ = exec.Command("/usr/bin/open", "-R", diag.Path()).Start()
			}
		})
	}, below: func() {
		ui.Column(c).Padding(8).Radius(12).Background(s.card).Border(1, s.cardBorder).Key("diag-list").Children(func() {
			if len(list) == 0 {
				text(c, tr("暂无记录 —— 双击一次触发键就有了"), 12, 17, 400, k.muted).Padding(4, 6)
				return
			}
			for i, e := range list {
				ui.RichText(c, ui.Span{Text: e.At.Format("15:04:05") + " ", Color: k.muted.Alpha(0.7)}, ui.Span{Text: e.Msg, Color: k.muted}).
					Font(fontMono).FontSize(11).FixedLineHeight(16).Wrap().Padding(1, 6).Key("dg-" + itoa(i))
			}
		})
	}}}
	return []setSection{{tr("诊断"), rows}}
}

var screenAllowed = macos.ScreenCaptureAllowed // 测试替换

var diagWin atomic.Pointer[mygo.Window]
