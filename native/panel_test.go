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

func (nopSys) Frontmost() (macos.FrontApp, bool) {
	return macos.FrontApp{PID: 42, Name: "Cursor"}, true
}
func (nopSys) SelectedText() (macos.Selection, string) { return macos.SelEmpty, "" }
func (nopSys) ChangeCount() int                        { return 0 }
func (nopSys) Types() []string                         { return nil }
func (nopSys) ReadString() (string, string)            { return "", "" }
func (nopSys) Snapshot() []macos.Item                  { return nil }
func (nopSys) Write([]macos.Item, bool) int            { return 0 }
func (nopSys) PostKey(uint16, uint64)                  {}
func (nopSys) Activate(int32) bool                     { return true }
func (nopSys) Sleep(time.Duration)                     {}
func (nopSys) SelfPID() int32                          { return 1 }

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
	a.permAX = true // 视图测试默认已授权；权限横幅单独测
	st.OnChange(a.reload)
	tt := ui.NewTester(a.panelView, 360, 720)
	tt.Frame()
	return a, tt
}

func TestPanelShowsQueueAndCounts(t *testing.T) {
	_, tt := testApp(t, "第一条笔记", "第二条笔记")
	for _, s := range []string{"第一条笔记", "第二条笔记", "收件箱", "2", "剪贴", "笔记", "任务", "提示词库"[:0] + "来自 Safari"} {
		if !tt.HasText(s) {
			t.Fatalf("缺少 %q，现有 %v", s, tt.Texts())
		}
	}
}

func TestEmptyStateHint(t *testing.T) {
	_, tt := testApp(t)
	if !tt.HasText("还没有内容") || !tt.HasText("连按两次 ⇧ 捕获选中文本，也可以在下方直接记下") {
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
	tt.Key(0, ui.KeyDown)
	tt.Key(ui.Cmd, ui.KeyBackspace)
	tt.Frame()
	if slices.Contains(tt.Texts(), "要删的") || len(a.store.Notes()) != 1 {
		t.Fatalf("删除失败 %v", tt.Texts())
	}
	if a.hudUndo == nil {
		t.Fatal("应出现可撤销气泡")
	}
	tt.Key(ui.Cmd, ui.KeyZ)
	tt.Frame()
	if got := a.store.Notes(); len(got) != 2 || got[0].Text != "要删的" {
		t.Fatalf("撤销应恢复原位 %+v", got)
	}
}

func TestSearchFilters(t *testing.T) {
	a, tt := testApp(t, "apple pie", "banana")
	a.searchOpen = true
	tt.Frame()
	a.search.Focus()
	tt.Frame()
	tt.Type("ban")
	tt.Frame()
	if tt.HasText("apple pie") || !tt.HasText("banana") {
		t.Fatalf("%v", tt.Texts())
	}
}

// 同 Tauri：卡片上回车 / 菜单「编辑」开详情窗进编辑态，不在列表里就地改；⌘⏎ 保存。
func TestEditOpensDetailWindow(t *testing.T) {
	a, tt := testApp(t, "原文")
	var opened string
	old := openDetailFn
	openDetailFn = func(a *app, n store.Note) {
		opened = n.ID
		a.detail = detailState{id: n.ID, pickAnchor: -1, pickEnd: -1, editSel: [2]int{-1, -1}}
	}
	t.Cleanup(func() { openDetailFn = old })
	tt.Key(0, ui.KeyDown)
	tt.Key(0, ui.KeyEnter) // 有焦点卡、未聚焦输入框时回车
	tt.Frame()
	n := a.store.Notes()[0]
	if opened != n.ID || !a.detail.edit || a.detailText != "原文" {
		t.Fatalf("应开详情窗编辑 opened=%q edit=%v", opened, a.detail.edit)
	}
	if tt.HasText("⌘↵ 保存   esc 取消") {
		t.Fatal("列表里不应再出现就地编辑框")
	}
	dt := ui.NewTester(a.detailView, 560, 540)
	dt.Frame()
	dt.Type("，补充")
	dt.Key(ui.Cmd, ui.KeyEnter) // 同 Tauri：编辑态 ⌘⏎ 保存（⌘S 仍是别名）
	dt.Frame()
	if got := a.store.Notes()[0].Text; !strings.Contains(got, "补充") || a.detail.edit {
		t.Fatalf("⌘⏎ 应保存并退出编辑：%q edit=%v", got, a.detail.edit)
	}
}

func TestClipboardTabAndMoveToNotes(t *testing.T) {
	a, tt := testApp(t)
	a.store.Add(store.Note{Section: store.SectionClipboard, Text: "复制来的"})
	tt.Frame()
	if err := tt.Click("剪贴"); err != nil {
		t.Fatalf("%v %v", err, tt.Texts())
	}
	tt.Frame()
	if !tt.HasText("复制来的") {
		t.Fatalf("%v", tt.Texts())
	}
	if err := tt.RightClick("复制来的"); err != nil {
		t.Fatal(err)
	}
	if err := tt.ChooseMenuItem("移入笔记分组", "收件箱"); err != nil {
		t.Fatalf("%v menu=%v", err, tt.Menu())
	}
	tt.Frame()
	if len(a.store.Section(store.SectionInbox)) != 1 {
		t.Fatal("应移入收件箱")
	}
}

func TestSendWithoutTargetWarns(t *testing.T) {
	a, tt := testApp(t, "x")
	tt.Key(0, ui.KeyRight)
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
