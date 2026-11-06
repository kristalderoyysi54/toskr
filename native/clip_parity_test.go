package main

import (
	"testing"

	"github.com/egoist/mygo/ui"
	"github.com/toskr/native/internal/macos"

	"github.com/toskr/native/internal/store"
)

// 剪贴卡移入笔记（同 Tauri moveClipsToNotesWithUndo）：清固定 / 完成，提示「已移入笔记」，可撤销回原位。
func TestMoveClipsToNotesClearsKeepAndUndoes(t *testing.T) {
	a, _ := testApp(t)
	x, _, _ := a.store.Add(store.Note{Section: store.SectionClipboard, Text: "剪贴一"})
	y, _, _ := a.store.Add(store.Note{Section: store.SectionClipboard, Text: "剪贴二"})
	_ = a.store.SetKept(x.ID, true)
	x, _ = a.store.Note(x.ID)
	a.moveClipsTo([]store.Note{x}, store.SectionInbox)
	got, _ := a.store.Note(x.ID)
	if got.Section != store.SectionInbox || got.Kept || a.hudText != "已移入笔记" || a.hudUndo == nil {
		t.Fatalf("%+v hud=%q", got, a.hudText)
	}
	a.hudUndo()
	got, _ = a.store.Note(x.ID)
	if got.Section != store.SectionClipboard || !got.Kept {
		t.Fatalf("撤销应放回剪贴并保留固定 %+v", got)
	}
	ns := a.store.Notes()
	if ns[0].ID != y.ID || ns[1].ID != x.ID {
		t.Fatal("撤销应回原位置")
	}
}

// 悬停删除跟多选走（同 Tauri deleteSelfOrChecked），提示「已删除 n 条」。
func TestClipDeleteFollowsSelection(t *testing.T) {
	a, _ := testApp(t)
	x, _, _ := a.store.Add(store.Note{Section: store.SectionClipboard, Text: "甲"})
	y, _, _ := a.store.Add(store.Note{Section: store.SectionClipboard, Text: "乙"})
	a.page = pageClip
	a.reload()
	a.chosen.Add(x.ID)
	a.chosen.Add(y.ID)
	a.deleteSelfOrChosen(x)
	if len(a.store.Notes()) != 0 || a.hudText != "已删除 2 条" || a.chosen.Len() != 0 {
		t.Fatalf("n=%d hud=%q", len(a.store.Notes()), a.hudText)
	}
}

// 同 Tauri：没有勾选时 ⌘⏎ 什么都不做；右键勾选集合外的卡只作用于这一张。
func TestNoteSelectionParity(t *testing.T) {
	a, tt := testApp(t, "甲", "乙", "丙")
	sys := &recSys{}
	a.sys = sys
	a.target = macos.FrontApp{PID: 42, Name: "Cursor"}
	tt.Key(0, ui.KeyDown)
	tt.Key(ui.Cmd, ui.KeyEnter)
	tt.Frame()
	if len(sys.sent()) != 0 {
		t.Fatal("无勾选不应发送")
	}
	ns := a.store.Notes()
	a.chosen.Add(ns[0].ID)
	a.chosen.Add(ns[1].ID)
	if err := tt.RightClick("丙"); err != nil {
		t.Fatal(err)
	}
	if err := tt.ChooseMenuItem("删除"); err != nil {
		t.Fatal(err, tt.Menu())
	}
	if got := a.store.Notes(); len(got) != 2 || got[0].Text != "甲" || got[1].Text != "乙" {
		t.Fatalf("只应删右键的「丙」：%v", got)
	}
}
