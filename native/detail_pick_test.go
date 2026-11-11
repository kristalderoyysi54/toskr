package main

import (
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
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
	for _, s := range []string{"选词", "复制", "编辑"} { // 「原文」只给 Markdown 正文且不在选词时（同 Tauri isMd && !pickMode）
		r, ok := tt.Find(s)
		if !ok || r.H > 20 {
			t.Fatalf("%q 应单行（高 %.1f）：%+v", s, r.H, r)
		}
	}
}

// 差距清单 #1/#2：只读合并预览的选中工具条只能复制，不给发送 / 处理（处理会改写一个不在库里的 id）。
func TestDetailReadOnlySelectionBar(t *testing.T) {
	a, _ := testApp(t)
	v := store.Note{ID: "virt", Text: "甲乙 丙丁"}
	a.detail = detailState{id: "virt", virt: &v, pickAnchor: 0, pickEnd: 0, pick: true, editSel: [2]int{-1, -1}}
	tt := ui.NewTester(a.detailView, 560, 540)
	tt.Frame()
	tt.Frame()
	if !tt.HasText("已选 2 字") || tt.HasText("发送选中") || tt.HasText("发送整卡") {
		t.Fatalf("只读预览工具条只能复制：%v", tt.Texts())
	}
}

func TestSendDetailFragmentKeepsSource(t *testing.T) {
	a, _ := testApp(t, "甲乙 丙丁")
	n := a.store.Notes()[0]
	sys := &recSys{}
	a.sys = sys
	a.detail = detailState{id: n.ID, pickAnchor: -1, pickEnd: -1, editSel: [2]int{-1, -1}}
	a.sendDetailFragment(n, "") // 空片段不发
	a.target = macos.FrontApp{}
	a.sendDetailFragment(n, "丙丁") // 没有目标：不发
	if len(a.pending) != 0 || len(sys.sent()) != 0 {
		t.Fatal("无目标不应发送")
	}
}

func TestWordCountCJK(t *testing.T) {
	for s, want := range map[string]int{"复现测试 一段": 6, "hello world": 2, "demo_user 我": 2, "": 0, "a-b's c": 2} {
		if got := wordCount(s); got != want {
			t.Fatalf("%q：%d，应 %d", s, got, want)
		}
	}
}

func TestDetailImageOnlyDraftNotEmpty(t *testing.T) {
	a, _ := testApp(t)
	a.detailText = "  "
	if !a.detailDraftEmpty(store.Note{}) {
		t.Fatal("无字无图应为空")
	}
	if a.detailDraftEmpty(store.Note{Attachments: []string{"x.png"}}) {
		t.Fatal("只留附件图不算空（同 Tauri）")
	}
}

// 实机发现：长文选词时「，」「。」单独落到行首。收尾标点并入前一键帽、开括号并入后一键帽（同浏览器避头尾）。
func TestPickGroupsKinsoku(t *testing.T) {
	segs := pickSegments("测试，项目：（甲）乙 丙")
	var got []string
	for _, g := range pickGroups(segs, false) {
		var b strings.Builder
		for _, i := range g {
			b.WriteString(segs[i].text)
		}
		got = append(got, b.String())
	}
	want := []string{"测试，", "项目：", "（甲）", "乙", " ", "丙"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("%q", got)
	}
}

// 同 Tauri：「原文 / 渲染」只在像 Markdown 的正文出现；没有文字时不给「选词」「处理」。
func TestDetailDockGating(t *testing.T) {
	a, _ := testApp(t, "普通一句话")
	n := a.store.Notes()[0]
	dt := detailTester(t, a, n)
	if dt.HasText("原文") || !dt.HasText("选词") || !dt.HasText("处理") {
		t.Fatalf("纯文本不给原文切换 %v", dt.Texts())
	}
	md, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: "# 标题\n- 列表"})
	dt2 := detailTester(t, a, md)
	if !dt2.HasText("原文") {
		t.Fatalf("Markdown 正文应可切原文 %v", dt2.Texts())
	}
	if !looksLikeMarkdown("**粗体**") || !looksLikeMarkdown("看 [链接](https://a.b)") || looksLikeMarkdown("a*b 普通") {
		t.Fatal("Markdown 识别")
	}
}
