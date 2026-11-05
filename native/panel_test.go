package main

import (
	"bytes"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

type nopSys struct{}

func (nopSys) Frontmost() (macos.FrontApp, bool)            { return macos.FrontApp{PID: 42, Name: "Cursor"}, true }
func (nopSys) SelectedText() (macos.Selection, string)      { return macos.SelEmpty, "" }
func (nopSys) ChangeCount() int                             { return 0 }
func (nopSys) Types() []string                              { return nil }
func (nopSys) ReadString() (string, string)                 { return "", "" }
func (nopSys) Snapshot() []macos.Item                       { return nil }
func (nopSys) Write([]macos.Item, bool) int                 { return 0 }
func (nopSys) PostKey(uint16, uint64)                       {}
func (nopSys) Activate(int32) bool                          { return true }
func (nopSys) Sleep(time.Duration)                          {}
func (nopSys) SelfPID() int32                               { return 1 }

func testApp(t *testing.T, texts ...string) (*app, *ui.Tester) {
	t.Helper()
	st, err := store.OpenDir(t.TempDir(), bytes.Repeat([]byte{1}, 32))
	if err != nil {
		t.Fatal(err)
	}
	for i := len(texts) - 1; i >= 0; i-- {
		st.Add(store.Note{Section: store.SectionInbox, Text: texts[i], SourceApp: "Safari"})
	}
	a := newApp(nopSys{}, st)
	st.OnChange(a.reload)
	tt := ui.NewTester(a.panelView, 360, 720)
	tt.Frame()
	return a, tt
}

func TestPanelShowsQueueAndCounts(t *testing.T) {
	_, tt := testApp(t, "第一条笔记", "第二条笔记")
	for _, s := range []string{"第一条笔记", "第二条笔记", "笔记 2", "剪贴板 0"} {
		if !tt.HasText(s) {
			t.Fatalf("缺少 %q，现有 %v", s, tt.Texts())
		}
	}
}

func TestEmptyStateHint(t *testing.T) {
	_, tt := testApp(t)
	if !tt.HasText("队列为空\n在任意应用选中文字，双击 ⇧ 收进来") {
		t.Fatalf("%v", tt.Texts())
	}
}

func TestComposerEnterAddsNote(t *testing.T) {
	a, tt := testApp(t, "旧笔记")
	a.draftIn.Focus()
	tt.Frame()
	tt.Type("新写的笔记")
	tt.Key(0, ui.KeyEnter)
	tt.Frame()
	if got := a.store.Section(store.SectionInbox); len(got) != 2 || got[0].Text != "新写的笔记" {
		t.Fatalf("%+v", got)
	}
	if a.draft != "" {
		t.Fatalf("加入后草稿应清空，实为 %q", a.draft)
	}
	if !tt.HasText("新写的笔记") {
		t.Fatal("列表应立即显示新笔记")
	}
}

func TestComposerIMECompositionDoesNotSubmit(t *testing.T) {
	a, tt := testApp(t)
	a.draftIn.Focus()
	tt.Frame()
	tt.Compose("zhong", 5)
	tt.Key(0, ui.KeyEnter)
	tt.Frame()
	if n := len(a.store.Section(store.SectionInbox)); n != 0 {
		t.Fatalf("输入法组字中的回车不得提交，实际入库 %d 条", n)
	}
}

func TestDeleteWithUndo(t *testing.T) {
	a, tt := testApp(t, "要删的", "留下的")
	tt.Key(ui.Cmd, ui.KeyBackspace)
	tt.Frame()
	if slices.Contains(tt.Texts(), "要删的") || len(a.store.Notes()) != 1 {
		t.Fatalf("删除失败 %v", tt.Texts())
	}
	if err := tt.Click("撤销"); err != nil {
		t.Fatalf("应出现撤销：%v %v", err, tt.Texts())
	}
	tt.Frame()
	if got := a.store.Notes(); len(got) != 2 || got[0].Text != "要删的" {
		t.Fatalf("撤销应恢复原位 %+v", got)
	}
}

func TestSearchFilters(t *testing.T) {
	a, tt := testApp(t, "apple pie", "banana")
	a.search.Focus()
	tt.Frame()
	tt.Type("ban")
	tt.Frame()
	if tt.HasText("apple pie") || !tt.HasText("banana") {
		t.Fatalf("%v", tt.Texts())
	}
}

func TestEditCommitWithCmdEnter(t *testing.T) {
	a, tt := testApp(t, "原文")
	tt.Key(0, ui.KeyEnter) // 未聚焦输入框时回车进入编辑
	tt.Frame()
	if a.editing == "" {
		t.Fatal("回车应进入编辑")
	}
	tt.Type("，补充")
	tt.Key(ui.Cmd, ui.KeyEnter)
	tt.Frame()
	if got := a.store.Notes()[0].Text; !strings.HasPrefix(got, "原文") || !strings.Contains(got, "补充") {
		t.Fatalf("编辑未保存：%q", got)
	}
	if a.editing != "" {
		t.Fatal("保存后退出编辑")
	}
}

func TestClipboardTabAndMoveToNotes(t *testing.T) {
	a, tt := testApp(t)
	a.store.Add(store.Note{Section: store.SectionClipboard, Text: "复制来的"})
	tt.Key(ui.Cmd, ui.Key2)
	tt.Frame()
	if !tt.HasText("复制来的") || !tt.HasText("剪贴板 1") {
		t.Fatalf("%v", tt.Texts())
	}
	if err := tt.RightClick("复制来的"); err != nil {
		t.Fatal(err)
	}
	if err := tt.ChooseMenuItem("转为笔记"); err != nil {
		t.Fatalf("%v menu=%v", err, tt.Menu())
	}
	tt.Frame()
	if len(a.store.Section(store.SectionInbox)) != 1 {
		t.Fatal("应转入笔记分组")
	}
}

func TestSendWithoutTargetWarns(t *testing.T) {
	a, tt := testApp(t, "x")
	tt.Key(ui.Cmd, ui.KeyEnter)
	tt.Frame()
	if a.hudKind != "warn" || !strings.Contains(a.hudText, "没有发送目标") {
		t.Fatalf("hud=%s %s", a.hudKind, a.hudText)
	}
}

func TestReorderMovesWithinSection(t *testing.T) {
	a, _ := testApp(t, "A", "B", "C")
	a.reorder([]int{2}, 0)
	got := a.store.Section(store.SectionInbox)
	if got[0].Text != "C" || got[1].Text != "A" || got[2].Text != "B" {
		t.Fatalf("%v %v %v", got[0].Text, got[1].Text, got[2].Text)
	}
}

func TestHelpers(t *testing.T) {
	now := time.Unix(10_000, 0)
	if ago(now.Add(-30*time.Second), now) != "刚刚" || ago(now.Add(-5*time.Minute), now) != "5 分钟前" {
		t.Fatal("ago")
	}
	if preview("第一行很长很长\n第二行", 4) != "第一行很…" || itoa(1234) != "999+" || itoa(0) != "0" || itoa(42) != "42" {
		t.Fatal("preview/itoa")
	}
}
