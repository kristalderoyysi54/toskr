package main

import (
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

func openCheck(t *testing.T, texts ...string) (*app, *recSys) {
	t.Helper()
	a, _ := testApp(t, texts...)
	sys := &recSys{}
	a.sys = sys
	a.target = macos.FrontApp{PID: 42, Name: "Cursor"}
	a.checkSend(a.store.Notes())
	if len(a.pending) == 0 {
		t.Fatal("应进入预检")
	}
	a.pfScan()
	a.pf.final = a.pfAssembled()
	return a, sys
}

// 同 Tauri「最终文本」：手动编辑后按编辑后的文本原样发送（不再套格式），改过的文本重新检测。
func TestPreflightEditFinalText(t *testing.T) {
	a, sys := openCheck(t, "早上好")
	if a.pf.final != "早上好" || a.pf.edited {
		t.Fatalf("初始为自动组装 %q", a.pf.final)
	}
	mail := "bob" + "@corp.io"
	a.pf.final, a.pf.edited = "早上好，请回复 "+mail, true
	a.pfScan()
	if len(a.pf.items) != 1 || a.pf.items[0].note != finalNote {
		t.Fatalf("编辑后的文本应重新检测 %+v", a.pf.items)
	}
	a.pfReplace(func(pfItem) bool { return true })
	if !strings.Contains(a.pf.final, "[EMAIL_01]") || len(a.pf.items) != 0 {
		t.Fatalf("命中在最终文本里替换 %q", a.pf.final)
	}
	if e := a.pfEvaluate("requireRedaction"); !e.canSend {
		t.Fatalf("%+v", e)
	}
	a.pfSend(pfEval{canSend: true})
	waitFor(t, func() bool { return len(sys.sent()) > 0 })
	if got := sys.sent()[0]; got != "早上好，请回复 [EMAIL_01]" {
		t.Fatalf("应发送编辑后的文本 %q", got)
	}
}

// 「恢复自动组装」与换模板 / 换格式：丢弃手动编辑、按新条件重组；编辑成空不能发送。
func TestPreflightRebuildAndEmpty(t *testing.T) {
	a, _ := openCheck(t, "早上好")
	a.pf.final, a.pf.edited = "  ", true
	if e := a.pfEvaluate("requireRedaction"); e.canSend || e.reason != "最终文本为空" {
		t.Fatalf("空文本不能发 %+v", e)
	}
	a.pfRebuild()
	if a.pf.edited || a.pf.final != "早上好" {
		t.Fatalf("恢复自动组装 %q", a.pf.final)
	}
	a.pf.final, a.pf.edited = "改过", true
	a.pendingTmpl = "翻译成英文：{内容}"
	a.pfRebuild()
	if a.pf.final != "翻译成英文：早上好" {
		t.Fatalf("换模板重组 %q", a.pf.final)
	}
	a.sendMode = "code"
	a.pfRebuild()
	if !strings.HasPrefix(a.pf.final, "```") {
		t.Fatalf("换格式重组 %q", a.pf.final)
	}
}

// 「发送后保留面板」：本次覆盖方案设置，只作用于这一次。
func TestPreflightKeepPanelOverride(t *testing.T) {
	a, sys := openCheck(t, "早上好")
	a.pinned = false
	a.pf.keep, a.pf.keepSet = true, true
	a.pfSend(pfEval{canSend: true})
	waitFor(t, func() bool { return len(sys.sent()) > 0 })
	if a.sendKeep != nil {
		t.Fatal("覆盖应在投递时消费掉")
	}
}

// 同 Tauri「可逆化名 · 已自动替换 n 处」：逐项列出，单项「还原为原文」只影响本次，已做的占位符替换保留。
func TestPreflightAliasRevert(t *testing.T) {
	mail := "bob" + "@corp.io"
	a, _ := testApp(t)
	_ = a.addAliasEntity("USER", "张三")
	_, _, _ = a.store.Add(storeNote("请张三和张三联系 " + mail))
	a.target = macos.FrontApp{PID: 42, Name: "Cursor"}
	a.checkSend(a.store.Notes())
	a.pfScan()
	ph := a.store.Settings().AliasEntities[0].Placeholder
	if got := a.pending[0].Text; strings.Count(got, ph) != 2 {
		t.Fatalf("进预检前已按词典替换 %q", got)
	}
	hits := a.pfAliasHits()
	if len(hits) != 2 {
		t.Fatalf("应列出 2 处 %+v", hits)
	}
	a.pfReplace(func(x pfItem) bool { return x.f.Category == "email" })
	a.pfRevertAlias(hits[0])
	got := a.pending[0].Text
	if !strings.HasPrefix(got, "请张三和"+ph) || !strings.Contains(got, "[EMAIL_01]") {
		t.Fatalf("只还原第一处、保留邮箱替换 %q", got)
	}
	if len(a.pfAliasHits()) != 1 || a.store.Notes()[0].Text != "请张三和张三联系 "+mail {
		t.Fatal("原卡不动，列表少一项")
	}
}

// 同 Tauri addFindingToAliasDictionary：提示级命中可升级为词典词条，正文没手改就立即按词典替换。
func TestPreflightFindingToDictionary(t *testing.T) {
	mail := "bob" + "@corp.io"
	a, _ := openCheck(t, "请联系 "+mail)
	if len(a.pf.items) != 1 {
		t.Fatalf("%+v", a.pf.items)
	}
	a.pfAddFindingAlias(mail, "CONTACT")
	ents := a.store.Settings().AliasEntities
	if len(ents) != 1 || ents[0].OriginalText != mail {
		t.Fatalf("词典 %+v", ents)
	}
	if !strings.Contains(a.pending[0].Text, ents[0].Placeholder) || len(a.pf.items) != 0 || len(a.pfAliasHits()) != 1 {
		t.Fatalf("应立即按词典替换并消掉命中 %q %+v", a.pending[0].Text, a.pf.items)
	}
}

func storeNote(text string) store.Note { return store.Note{Section: store.SectionInbox, Text: text} }

func TestPreflightKeepPanelCheckbox(t *testing.T) {
	a, _ := testApp(t, "早上好")
	a.target = macos.FrontApp{PID: 42, Name: "ChatGPT"}
	tt := ui.NewTester(a.panelView, 380, 760)
	a.checkSend(a.store.Notes())
	tt.Frame()
	tt.Frame()
	if r, ok := tt.Find("发送后保留面板"); !ok || r.W < 14 {
		t.Fatalf("勾选框应可见 %v", r)
	}
	mustClick(t, tt, "发送后保留面板")
	r, _ := a.resolution()
	if !a.pf.keepSet || a.pf.keep == r.Profile.KeepPanel {
		t.Fatal("点击应切换本次保留面板")
	}
}
