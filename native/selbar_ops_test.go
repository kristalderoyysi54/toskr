package main

import (
	"fmt"
	"strings"
	"testing"

	"github.com/toskr/native/internal/macos"
)

// 同 Tauri sendDisabledReason：没有目标时「发送选中」置灰、提示原因、点了不发送；有目标恢复。
func TestSelBarSendDisabledWithoutTarget(t *testing.T) {
	a, _ := testApp(t, "contact alice today")
	sys := &recSys{}
	a.sys = sys
	n := a.store.Notes()[0]
	dt := detailTester(t, a, n)
	mustClick(t, dt, "选词")
	mustClick(t, dt, "alice")
	dt.Frame()
	blocked := "发送选中不可用：尚未识别发送目标，请先重新识别"
	if !dt.HasText(blocked) {
		t.Fatalf("无目标应置灰并给原因 %v", dt.Texts())
	}
	_ = dt.Click(blocked)
	dt.Frame()
	if len(sys.sent()) != 0 {
		t.Fatal("置灰时不应发送")
	}
	a.target = macos.FrontApp{PID: 42, Name: "Cursor"}
	dt.Frame()
	if !dt.HasText("只把选中片段发到当前目标") || dt.HasText(blocked) {
		t.Fatalf("有目标应可发送 %v", dt.Texts())
	}
}

// 同 Tauri onAddAlias：阅读 / 选词态「加入化名词典」——原文预填、类别建议、加入后写词典并清掉选区；编辑态不给。
func TestSelBarAddAlias(t *testing.T) {
	a, _ := testApp(t, "contact alice today")
	n := a.store.Notes()[0]
	dt := detailTester(t, a, n)
	mustClick(t, dt, "选词")
	mustClick(t, dt, "alice")
	mustClick(t, dt, "加入化名词典：发出自动替换，收回自动恢复")
	if a.detail.aliasText != "alice" || a.detail.aliasCat == "" || !dt.HasText("加入") {
		t.Fatalf("应预填原文与类别 %q %q %v", a.detail.aliasText, a.detail.aliasCat, dt.Texts())
	}
	mustClick(t, dt, "商户")
	mustClick(t, dt, "加入")
	ents := a.store.Settings().AliasEntities
	if len(ents) != 1 || ents[0].OriginalText != "alice" || ents[0].Category != "MERCHANT" {
		t.Fatalf("词典 %+v", ents)
	}
	if a.hudKind != "added" || !strings.Contains(a.hudText, "alice → "+ents[0].Placeholder) {
		t.Fatalf("HUD %s %q", a.hudKind, a.hudText)
	}
	if a.detail.aliasOn || a.detail.pickAnchor != -1 {
		t.Fatal("加入后应收起浮层并清掉选区")
	}
	// 同一原文再加：报重复，不新增
	mustClick(t, dt, "alice")
	mustClick(t, dt, "加入化名词典：发出自动替换，收回自动恢复")
	mustClick(t, dt, "加入")
	if len(a.store.Settings().AliasEntities) != 1 || a.hudKind != "warn" {
		t.Fatalf("重复应拒绝 %s %q", a.hudKind, a.hudText)
	}
	// 编辑态没有词典按钮
	a.enterDetailEdit(n)
	a.detail.editSel = [2]int{8, 13}
	for range 3 {
		dt.Frame()
	}
	if !dt.HasText("已选 5 字") || dt.HasText("加入化名词典：发出自动替换，收回自动恢复") {
		t.Fatalf("编辑态不应有词典按钮 %v", dt.Texts())
	}
}

// 同 Tauri 链接表单：选中文字本身是链接则预填、「应用」写入 Markdown 链接；空地址时「应用」不可用。
func TestSelBarLinkForm(t *testing.T) {
	a, _ := testApp(t, "see example.com now")
	n := a.store.Notes()[0]
	dt := detailTester(t, a, n)
	a.enterDetailEdit(n)
	dt.Frame()
	a.detail.editSel = [2]int{4, 15}
	for range 3 {
		dt.Frame()
	}
	mustClick(t, dt, "添加链接（⌘K）")
	if a.detail.linkDraft != "https://example.com" || !dt.HasText("应用") {
		t.Fatalf("应预填识别出的链接 %q %v", a.detail.linkDraft, dt.Texts())
	}
	mustClick(t, dt, "应用")
	if !strings.Contains(a.detailText, "[example.com](https://example.com)") || a.detail.linkOn {
		t.Fatalf("应写入 Markdown 链接 %q", a.detailText)
	}
	a.detail.editSel = [2]int{0, 3}
	for range 3 {
		dt.Frame()
	}
	mustClick(t, dt, "添加链接（⌘K）")
	before := a.detailText
	_ = dt.Click("应用")
	dt.Frame()
	if a.detail.linkDraft != "" || a.detailText != before || !a.detail.linkOn {
		t.Fatalf("空地址不应应用 %q", a.detailText)
	}
}

// 拖选时字数从 1 位变到 3 位，「发送选中」相对字数标签的位置不变（工具条不随位数伸缩抖动）。
func TestSelBarCountStableWidth(t *testing.T) {
	a, _ := testApp(t, strings.Repeat("测试文字内容", 200))
	n := a.store.Notes()[0]
	dt := detailTester(t, a, n)
	var offs []float32
	for _, cnt := range []int{1, 9, 10, 87, 100, 999} {
		a.enterDetailEdit(n)
		a.detail.editSel = [2]int{0, cnt}
		for range 3 {
			dt.Frame()
		}
		b, ok1 := dt.Find("发送选中")
		l, ok2 := dt.Find(fmt.Sprintf("已选 %d 字", cnt))
		if !ok1 || !ok2 {
			t.Fatalf("工具条未出现 %v", dt.Texts())
		}
		offs = append(offs, b.X-l.X)
	}
	for _, o := range offs[1:] {
		if o != offs[0] {
			t.Fatalf("字数位数变化不应挪动后面的按钮 %v", offs)
		}
	}
}

// 拖选中（按着鼠标）不出划词工具条，松手才出；按在工具条上（点它的按钮）不收起。
func TestSelBarWaitsForMouseUp(t *testing.T) {
	a, _ := testApp(t, "contact alice today")
	n := a.store.Notes()[0]
	dt := detailTester(t, a, n)
	mustClick(t, dt, "选词")
	mustClick(t, dt, "alice")
	held := true
	selDragging = func() bool { return held } // testApp 已登记还原
	a.detail.barHover = false
	dt.Frame()
	if dt.HasText("复制选中片段") {
		t.Fatal("按着鼠标时不应出工具条")
	}
	held = false
	dt.Frame()
	if !dt.HasText("复制选中片段") {
		t.Fatalf("松手后应出工具条 %v", dt.Texts())
	}
	r, _ := dt.Find("复制选中片段")
	dt.Move(r.X+r.W/2, r.Y+r.H/2) // 指针在工具条上
	dt.Frame()
	held = true
	dt.Frame()
	if !dt.HasText("复制选中片段") {
		t.Fatal("按在工具条上不应收起")
	}
}
