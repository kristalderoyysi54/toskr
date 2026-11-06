package main

import (
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// 可逆化名：设置里加词条（自动取号）、发送前替换（先于隐私检查，原卡不动）、卡片「恢复化名」、编辑与删除确认。
func TestAliasDictionaryFlow(t *testing.T) {
	a, tt := testApp(t, "请联系张三处理商户 12345 的退款")
	a.openSettingsState()
	set := ui.NewTester(a.settingsView, 1040, 2400)
	a.setJump = "粘贴与隐私"
	set.Frame()
	set.Frame()
	if !set.HasText("启用可逆化名") || !set.HasText("捕获时自动恢复化名") {
		t.Fatal(set.Texts())
	}
	_ = set.Click("暂无条目")
	set.Frame()
	if !set.HasText("暂无词典条目。添加后，发送内容里出现的原文会自动换成占位符。") {
		t.Fatal(set.Texts())
	}
	a.aliasUI.input = "张三"
	set.Frame()
	if !set.HasText("将分配占位符：[USER_01]") {
		t.Fatal(set.Texts())
	}
	if msg := a.addAliasEntity(a.aliasUI.category, a.aliasUI.input); msg != "" {
		t.Fatal(msg)
	}
	set.Frame()
	if msg := a.addAliasEntity("MERCHANT", "商户 12345"); msg != "" {
		t.Fatal(msg)
	}
	if msg := a.addAliasEntity("USER", "张三"); msg != "该原文已存在于词典" {
		t.Fatal(msg)
	}
	st := a.store.Settings()
	if len(st.AliasEntities) != 2 || st.AliasEntities[0].Placeholder != "[USER_01]" || st.AliasNext["USER"] != 2 {
		t.Fatalf("%+v %v", st.AliasEntities, st.AliasNext)
	}

	sys := &recSys{}
	a.sys = sys
	a.target = macos.FrontApp{PID: 42, Name: "Cursor"}
	src := a.store.Notes()[0]
	a.send([]store.Note{src})
	waitFor(t, func() bool { tt.Frame(); return len(sys.sent()) > 0 })
	if got := sys.sent()[0]; got != "请联系[USER_01]处理[MERCHANT_01] 的退款" {
		t.Fatalf("发送应已化名 %q", got)
	}
	if n, _ := a.store.Note(src.ID); !strings.Contains(n.Text, "张三") {
		t.Fatal("原卡不应被改")
	}

	reply, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: "已通知 [USER_01]，[MERCHANT_01] 退款完成"})
	a.reload()
	tt.Frame()
	a.restoreCardAliases(reply)
	if n, _ := a.store.Note(reply.ID); n.Text != "已通知 张三，商户 12345 退款完成" {
		t.Fatalf("%q", n.Text)
	}
	if got := a.captureRestoreAliases("捕获 [USER_01]"); got != "捕获 张三" {
		t.Fatal(got)
	}

	// 删除需确认；编号不复用
	id := a.store.Settings().AliasEntities[0].ID
	set.Frame()
	if err := set.Click("删除词典条目"); err != nil {
		t.Fatal(err)
	}
	set.Frame()
	if !set.HasText("删除后 [USER_01] 将无法再恢复为「张三」，编号也不会复用。确定删除？") {
		t.Fatal(set.Texts())
	}
	_ = set.Click("删除条目")
	set.Frame()
	for _, e := range a.store.Settings().AliasEntities {
		if e.ID == id {
			t.Fatal("应已删除")
		}
	}
	_ = a.addAliasEntity("USER", "李四")
	if es := a.store.Settings().AliasEntities; es[len(es)-1].Placeholder != "[USER_02]" {
		t.Fatalf("编号不复用 %+v", es)
	}
}
