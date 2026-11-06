package main

import (
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

func detailTester(t *testing.T, a *app, n store.Note) *ui.Tester {
	t.Helper()
	a.detail = detailState{id: n.ID, pickAnchor: -1, pickEnd: -1, editSel: [2]int{-1, -1}}
	dt := ui.NewTester(a.detailView, 560, 540)
	dt.Frame()
	return dt
}

// 同 Tauri TextPreviewView：编辑态 Esc / ⌘⏎ 都是保存（不发送），出可撤销「已保存」；正文清空不能保存。
func TestDetailEditEscAndCmdEnterSave(t *testing.T) {
	a, _ := testApp(t, "原文")
	sys := &recSys{}
	a.sys = sys
	a.target = macos.FrontApp{PID: 42, Name: "Cursor"}
	n := a.store.Notes()[0]
	dt := detailTester(t, a, n)
	a.enterDetailEdit(n)
	dt.Frame()
	if !dt.HasText("保存 ⌘⏎") || dt.HasText("取消") {
		t.Fatalf("编辑态坞应只有「保存 ⌘⏎」%v", dt.Texts())
	}
	a.detailText = "原文改"
	dt.Key(0, ui.KeyEscape)
	dt.Frame()
	if got, _ := a.store.Note(n.ID); got.Text != "原文改" || a.detail.edit {
		t.Fatalf("Esc 应保存并退出 %q edit=%v", got.Text, a.detail.edit)
	}
	if a.hudText != "已保存" || a.hudUndo == nil {
		t.Fatalf("应有可撤销「已保存」%q", a.hudText)
	}
	a.hudUndo()
	if got, _ := a.store.Note(n.ID); got.Text != "原文" {
		t.Fatalf("撤销应还原 %q", got.Text)
	}

	n, _ = a.store.Note(n.ID)
	a.enterDetailEdit(n)
	a.detailText = "二改"
	dt.Key(ui.Cmd, ui.KeyEnter)
	dt.Frame()
	time.Sleep(50 * time.Millisecond)
	if got, _ := a.store.Note(n.ID); got.Text != "二改" || a.detail.edit || len(sys.sent()) != 0 {
		t.Fatalf("编辑态 ⌘⏎ 只保存不发送 %q sent=%v", got.Text, sys.sent())
	}

	n, _ = a.store.Note(n.ID)
	a.enterDetailEdit(n)
	a.detailText = "  "
	a.commitDetailEdit(n)
	if !a.detail.edit || a.hudKind != "warn" || a.hudText != "笔记内容不能为空" {
		t.Fatalf("空正文应 warn 并留在编辑态 %s %q", a.hudKind, a.hudText)
	}
}

// 没有目标时点发送不关窗；📌 固定不置顶由代码保证（无窗口不可测）。
func TestDetailSendWithoutTargetKeepsWindow(t *testing.T) {
	a, _ := testApp(t, "原文")
	n := a.store.Notes()[0]
	detailTester(t, a, n)
	a.target = macos.FrontApp{}
	a.sendDetail(n)
	if a.hudKind != "warn" || len(a.pending) != 0 {
		t.Fatalf("%s %q", a.hudKind, a.hudText)
	}
}

// 新建「新笔记」一字未改关窗即回收；改过或已有同名卡不动（同 Tauri note-discard-blank）。
func TestBlankNewNoteDiscarded(t *testing.T) {
	a, _ := testApp(t)
	old := openDetailFn
	openDetailFn = func(a *app, n store.Note) {
		a.detail = detailState{id: n.ID, pickAnchor: -1, pickEnd: -1, editSel: [2]int{-1, -1}}
	}
	t.Cleanup(func() { openDetailFn = old })
	inbox := a.store.Sections()[0]
	a.newNoteIn(inbox)
	if !a.detail.blank {
		t.Fatal("新建卡应标记为占位")
	}
	a.discardBlankDraft()
	if len(a.store.Notes()) != 0 {
		t.Fatal("一字未改应回收")
	}
	a.newNoteIn(inbox)
	a.detailText = "写了内容"
	a.saveDetail()
	a.discardBlankDraft()
	if len(a.store.Notes()) != 1 {
		t.Fatal("改过的卡不能删")
	}
}

// HUD：连续捕获 ×N；「已存在相同内容」可定位（说话气泡）；隐身时撤销仍挂上。
func TestHUDStreakTargetAndStealthUndo(t *testing.T) {
	a, _ := testApp(t)
	if hudTitle("added", "", 3) != "已捕获 ×3" {
		t.Fatal("连续捕获标题")
	}
	a.showHUD("duplicate", "x")
	a.hudTarget = "n1"
	if !a.hudActionable() {
		t.Fatal("带定位目标的气泡应可点")
	}
	st := a.store.Settings()
	st.Stealth = true
	_ = a.store.SetSettings(st)
	a.showHUDUndo("ok", "已删除 1 条", func() {})
	if a.hudUndo == nil {
		t.Fatal("隐身模式下 ⌘Z 仍要能撤销")
	}
}

// 预检开着时 Esc 取消预检，不收面板 / 不清勾选。
func TestEscCancelsPreflight(t *testing.T) {
	a, tt := testApp(t, "联系 demo.user@example.com")
	a.sys = &recSys{}
	a.target = macos.FrontApp{PID: 42, Name: "Cursor"}
	a.send([]store.Note{a.store.Notes()[0]})
	tt.Frame()
	if len(a.pending) == 0 {
		t.Fatal("应进预检")
	}
	tt.Key(0, ui.KeyEscape)
	tt.Frame()
	if len(a.pending) != 0 {
		t.Fatal("Esc 应取消预检")
	}
}

// 设置：清空剪贴板历史先确认、可撤销；调短保留时长先确认，取消则滑块弹回。
func TestSettingsDestructiveConfirm(t *testing.T) {
	a, _ := testApp(t)
	oAsk, oClear, oGo, oDeb := retentionAsk, clearClipAsk, pfGo, retainDebounce
	t.Cleanup(func() { retentionAsk, clearClipAsk, pfGo, retainDebounce = oAsk, oClear, oGo, oDeb })
	pfGo = func(f func()) { f() }
	retainDebounce = 0
	a.store.Add(store.Note{Section: store.SectionClipboard, Text: "剪贴一"})
	answer := false
	clearClipAsk = func() bool { return answer }
	a.confirmClearClipboard()
	if len(a.store.Notes()) != 1 {
		t.Fatal("取消不应清空")
	}
	answer = true
	a.confirmClearClipboard()
	if len(a.store.Notes()) != 0 || a.hudUndo == nil {
		t.Fatal("确认后清空且可撤销")
	}
	a.hudUndo()
	if len(a.store.Notes()) != 1 {
		t.Fatal("撤销应放回")
	}

	st := a.store.Settings()
	st.ClipRetainDays = 30
	_ = a.store.SetSettings(st)
	retentionAsk = func(string, string) bool { return false }
	a.setRetain = 7
	a.saveSettings()
	waitFor(t, func() bool { return a.setRetain == 30 })
	if a.store.Settings().ClipRetainDays != 30 {
		t.Fatal("取消后保留时长不变")
	}
	retentionAsk = func(string, string) bool { return true }
	a.setRetain = 7
	a.saveSettings()
	waitFor(t, func() bool { return a.store.Settings().ClipRetainDays == 7 })
}
