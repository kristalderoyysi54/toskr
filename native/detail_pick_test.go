package main

import (
	"testing"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
)

// 用户实机反馈「详情选词默认页缺失、点了不生效」：单行卡片的键帽在顶部渐变条下面，渐变条吃掉了点击；
// 汉字逐字切、标点被丢、没有操作提示。全部对齐 Tauri（Intl.Segmenter 词粒度 + 提示行 + onPickToken）。
func TestDetailPickSingleLine(t *testing.T) {
	a, _ := testApp(t, "复现测试 一段文字 demo.user@example.com我·w")
	n := a.store.Notes()[0]
	a.detail = detailState{id: n.ID, pickAnchor: -1, pickEnd: -1, editSel: [2]int{-1, -1}, enter: true}
	tt := ui.NewTester(a.detailView, 560, 540)
	for range 20 {
		tt.Frame()
	}
	mustClick(t, tt, "选词")
	for _, s := range []string{"点词块选中 · 再点另一块扩展范围 · 选好后底部工具条可发送或复制", "复现", "测试", "文字", "demo.user", "example.com", "@", "·"} {
		if !tt.HasText(s) {
			t.Fatalf("缺 %q：%v", s, tt.Texts())
		}
	}
	if segs := a.segments(n.Text); segs[0].text != "复现" || segs[1].text != "测试" {
		t.Fatalf("汉字应按词切分，不应逐字：%+v", segs[:2])
	}
	mustClick(t, tt, "复现") // 首行键帽：曾被渐变条挡住
	if got := a.pickedText(n.Text); got != "复现" {
		t.Fatalf("首行键帽点不动：%q", got)
	}
	if tt.HasText("点词块选中 · 再点另一块扩展范围 · 选好后底部工具条可发送或复制") {
		t.Fatal("选中后提示应收起")
	}
	mustClick(t, tt, "demo.user")
	if got := a.pickedText(n.Text); got != "复现测试 一段文字 demo.user" {
		t.Fatalf("应从锚点扩展到 demo.user：%q", got)
	}
	mustClick(t, tt, "文字") // 锚点不动，终点回缩
	if got := a.pickedText(n.Text); got != "复现测试 一段文字" {
		t.Fatalf("%q", got)
	}
	tt.Frame()
	if !tt.HasText("已选 9 字") || !tt.HasText("发送选中") { // 同 Tauri：选词也驱动选中工具条
		t.Fatalf("选词后应出现选中工具条 %v", tt.Texts())
	}
}

func TestPickClick(t *testing.T) {
	for _, c := range []struct{ a, e, i, wa, we int }{
		{-1, -1, 3, 3, 3}, // 未选 → 选这一块
		{3, 3, 3, -1, -1}, // 再点唯一选中的 → 取消
		{3, 3, 5, 3, 5},   // 扩展
		{3, 5, 1, 3, 1},   // 锚点不动
	} {
		if a, e := pickClick(c.a, c.e, c.i); a != c.wa || e != c.we {
			t.Fatalf("%+v → %d,%d", c, a, e)
		}
	}
}

// 实机发现：目标名长（Telegram）+ 选词模式多出词/段切换时，坞按钮被挤成竖排（选/词、原/文）。按钮不收缩，只截断发送钮的目标名。
func TestDetailDockNoWrapInPick(t *testing.T) {
	a, _ := testApp(t, "一段文字")
	n := a.store.Notes()[0]
	a.target = macos.FrontApp{PID: 42, Name: "Telegram Desktop Long Name"}
	a.detail = detailState{id: n.ID, pickAnchor: -1, pickEnd: -1, editSel: [2]int{-1, -1}, pick: true}
	tt := ui.NewTester(a.detailView, 560, 540)
	tt.Frame()
	tt.Frame()
	for _, s := range []string{"选词", "原文", "复制", "编辑"} {
		r, ok := tt.Find(s)
		if !ok || r.H > 20 {
			t.Fatalf("%q 应单行（高 %.1f）：%+v", s, r.H, r)
		}
	}
}
