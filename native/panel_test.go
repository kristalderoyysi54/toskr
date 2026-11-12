package main

import (
	"bytes"
	"os"
	"path/filepath"
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
	oldDrag := selDragging
	selDragging = func() bool { return false } // 不读真实鼠标：跑测试时手动点击不应影响结果
	t.Cleanup(func() { selDragging = oldDrag })
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
	for _, s := range []string{"第一条笔记", "第二条笔记", "收件箱", "2", "剪贴", "笔记", "任务", "Safari"} { // 来源应用在通栏上
		if !tt.HasText(s) {
			t.Fatalf("缺少 %q，现有 %v", s, tt.Texts())
		}
	}
}

type clipTextSys struct {
	nopSys
	text string
}

func (s clipTextSys) ReadString() (string, string) { return s.text, "" }

// 空队列：键帽画出实际触发键（跟随设置），主按钮把剪贴板文字收成第一张卡（可撤销）；剪贴板没文字只提示。
func TestEmptyStateHint(t *testing.T) {
	a, tt := testApp(t)
	if !tt.HasText("选中文字，连按两次 Option") || !tt.HasText("在任何应用里都可以") || !tt.HasText("把剪贴板内容收成第一张卡") {
		t.Fatalf("%v", tt.Texts())
	}
	a.patchSettings(func(x *store.Settings) { x.TriggerModifier = "shift" })
	tt.Frame()
	if !tt.HasText("选中文字，连按两次 Shift") || !tt.HasText("连按两次 ⇧ Shift") {
		t.Fatalf("键帽应跟随触发键 %v", tt.Texts())
	}
	if err := tt.Click("把剪贴板内容收成第一张卡"); err != nil {
		t.Fatal(err)
	}
	if len(a.store.Notes()) != 0 || a.hudText != "剪贴板里没有文字" {
		t.Fatalf("空剪贴板不应建卡 %q", a.hudText)
	}
	a.sys = clipTextSys{text: "剪贴板里的一段话"}
	if err := tt.Click("把剪贴板内容收成第一张卡"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if ns := a.store.Notes(); len(ns) != 1 || ns[0].Text != "剪贴板里的一段话" || a.hudUndo == nil || tt.HasText("在任何应用里都可以") {
		t.Fatalf("应建一张卡并可撤销 %+v", ns)
	}
	a.hudUndo()
	tt.Frame()
	if len(a.store.Notes()) != 0 || !tt.HasText("在任何应用里都可以") {
		t.Fatal("撤销后回到空态")
	}
}

// 空分组：一行「此分组为空」（同 Tauri）；「设为捕获目标」在分组右键菜单里（见 tasks_keys_test）。
func TestEmptySectionCaptureLink(t *testing.T) {
	a, tt := testApp(t, "收件箱的卡")
	id := a.store.AddSection("资料")
	a.reload()
	tt.Frame()
	_ = id
	if !tt.HasText("此分组为空") || tt.HasText("把卡片拖到这里") || tt.HasText("设为捕获目标") {
		t.Fatalf("%v", tt.Texts())
	}
	if dir := os.Getenv("TOSKR_SHOT_DIR"); dir != "" {
		b, _ := testApp(t)
		for _, dark := range []bool{false, true} {
			mode := map[bool]string{false: "light", true: "dark"}[dark]
			for name, app := range map[string]*app{"empty-section": a, "empty-queue": b} {
				v := ui.NewTester(app.panelView, 320, 560)
				v.SetDark(dark)
				v.Frame()
				v.Frame()
				save(t, filepath.Join(dir, name+"-"+mode+".png"), v.Image())
			}
		}
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

// 底部键位提示随状态变化：多选给 ⌘M 合并、聚焦给 d 完成、行内改名给保存 / 取消；☰ 菜单可整行关掉。
func TestKeyHintsFollowState(t *testing.T) {
	a, tt := testApp(t, "卡一", "卡二")
	keys := func() []string {
		var out []string
		for _, h := range a.keyHints() {
			out = append(out, h[0])
		}
		return out
	}
	tt.Frame()
	if got := keys(); !slices.Contains(got, "↑↓") || slices.Contains(got, "⌘M") {
		t.Fatalf("默认 %v", got)
	}
	tt.Key(0, ui.KeyDown)
	tt.Frame()
	if got := keys(); !slices.Contains(got, "d") || !slices.Contains(got, "Space") {
		t.Fatalf("聚焦 %v", got)
	}
	tt.Key(ui.Cmd, ui.KeyA)
	tt.Frame()
	if got := keys(); a.chosen.Len() != 2 || !slices.Contains(got, "⌘M") || !tt.HasText("合并") {
		t.Fatalf("多选 %d %v", a.chosen.Len(), got)
	}
	a.chosen.Clear()
	a.titleEditID = a.store.Notes()[0].ID
	if got := keys(); !slices.Equal(got, []string{"⏎", "Esc"}) {
		t.Fatalf("行内改名 %v", got)
	}
	a.titleEditID = ""
	tt.Frame()
	if !tt.HasText("勾选") {
		t.Fatalf("默认应显示提示行 %v", tt.Texts())
	}
	a.menuOpen = true
	tt.Frame()
	if err := tt.Click("底部键位提示"); err != nil {
		t.Fatalf("%v %v", err, tt.Texts())
	}
	tt.Frame()
	tt.Frame()
	if !a.store.Settings().KeyHintsOff || tt.HasText("勾选") {
		t.Fatalf("关闭后不应再有提示行 off=%v %v", a.store.Settings().KeyHintsOff, tt.Texts())
	}
}
