package main

import (
	"slices"
	"testing"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// 提示词模板：设置里新增 → 卡片右键「用模板发送」按 {内容} 注入后发送并记最近使用；无模板时菜单给「添加模板…」；删除可撤销。
func TestPromptTemplatesAddSendAndDelete(t *testing.T) {
	a, tt := testApp(t, "早上好")
	sys := &recSys{}
	a.sys = sys
	a.target = macos.FrontApp{PID: 42, Name: "ChatGPT", BundleID: "com.openai.chat"}

	_ = tt.RightClick("早上好")
	if err := tt.ChooseMenuItem("用模板发送", "添加模板…"); err != nil {
		t.Fatalf("无模板时应给添加入口 %v %v", err, tt.Menu())
	}
	if !a.snipAdd || a.setPage != setPagePaste || a.setSub != 1 {
		t.Fatalf("应打开设置的提示词模板页 add=%v page=%d sub=%d", a.snipAdd, a.setPage, a.setSub)
	}
	st := ui.NewTester(a.settingsView, 1040, 720)
	st.Frame()
	if !st.HasText("暂无常用模板，可在“其他模板”中选择“设为常用”。") || !st.HasText("用 {内容} 标出卡片内容插入的位置；不写则把模板放在内容前面") {
		t.Fatalf("模板页 %v", st.Texts())
	}
	a.snipLabel, a.snipText = "翻译", "翻译成英文：{内容}"
	st.Frame()
	if err := st.Click("保存"); err != nil {
		t.Fatal(err)
	}
	st.Frame()
	snips := a.store.Settings().PromptSnippets
	if len(snips) != 1 || snips[0].Label != "翻译" || snips[0].GroupID != store.GeneralPromptGroup || a.snipAdd {
		t.Fatalf("应新增模板 %+v", snips)
	}
	_ = st.Click("设为常用")
	st.Frame()
	if !a.store.Settings().PromptSnippets[0].IsCommon || !st.HasText("取消常用") {
		t.Fatal("设为常用")
	}

	tt.Frame()
	_ = tt.RightClick("早上好")
	if err := tt.ChooseMenuItem("用模板发送", "翻译"); err != nil {
		t.Fatalf("%v %v", err, tt.Menu())
	}
	waitFor(t, func() bool { return len(sys.sent()) > 0 })
	if got := sys.sent()[0]; got != "翻译成英文：早上好" {
		t.Fatalf("模板应注入内容 %q", got)
	}
	if got := a.store.Settings().RecentSnippets; !slices.Equal(got, []string{snips[0].ID}) {
		t.Fatalf("应记最近使用 %v", got)
	}

	// 删除可撤销
	st.Frame()
	if err := st.Click("删除模板"); err != nil {
		t.Fatal(err)
	}
	st.Frame()
	if len(a.store.Settings().PromptSnippets) != 0 || a.hudUndo == nil {
		t.Fatal("删除并给撤销")
	}
	a.hudUndo()
	if len(a.store.Settings().PromptSnippets) != 1 {
		t.Fatal("撤销删除")
	}

	// 取消预检后不残留模板：再普通发送不套模板
	a.sendT([]store.Note{{ID: "x", Text: "sk-" + "proj-" + "Ab3Ab3Ab3Ab3Ab3Ab3Ab3Ab3Ab3Ab3"}}, "前缀")
	tt.Frame()
	_ = tt.Click("取消")
	tt.Frame()
	if a.pendingTmpl != "" {
		t.Fatal("取消后应丢弃模板")
	}
}
