package main

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
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
	submitPending(a)
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

// 检查后发送：无敏感项也先在面板里展示将发送的原样内容（已套模板），确认后才发；剪贴卡一级菜单没有「导出笔记包…」。
func TestCheckSendShowsPayloadFirst(t *testing.T) {
	a, tt := testApp(t, "第一行\n第二行")
	sys := &recSys{}
	a.sys = sys
	a.target = macos.FrontApp{PID: 42, Name: "ChatGPT"}
	_ = tt.RightClick("第一行\n第二行")
	if m := strings.Join(tt.Menu(), "|"); !strings.Contains(m, "转换与导出") || strings.Contains(m, "导出笔记包…") {
		t.Fatalf("笔记卡的导出在「转换与导出」二级菜单里（默认关闭，同 Tauri 低频项）%s", m)
	}
	if err := tt.ChooseMenuItem("检查后发送…"); err != nil {
		t.Fatalf("%v %v", err, tt.Menu())
	}
	tt.Frame()
	if !tt.HasText("发送前检查：发往 ChatGPT · 稳妥发送") || !tt.HasText("第一行\n第二行") || len(sys.sent()) != 0 {
		t.Fatalf("应先展示内容不发送 %v", tt.Texts())
	}
	_ = tt.Click("发送")
	waitFor(t, func() bool { return len(sys.sent()) == 1 })
	if sys.sent()[0] != "第一行\n第二行" {
		t.Fatalf("%q", sys.sent()[0])
	}
	a.store.Add(store.Note{Section: store.SectionClipboard, Text: "剪贴的"})
	a.switchPage(pageClip)
	tt.Frame()
	_ = tt.RightClick("剪贴的")
	if m := strings.Join(tt.Menu(), "|"); strings.Contains(m, "导出笔记包…") {
		t.Fatalf("剪贴卡不应有导出 %s", m)
	}
}

// 按住 ⌥ 选模板：先过检查条（展示将发送的内容），不直接发。
func TestTemplateOptionClickChecksFirst(t *testing.T) {
	a, tt := testApp(t, "早上好")
	sys := &recSys{}
	a.sys = sys
	a.target = macos.FrontApp{PID: 42, Name: "ChatGPT", BundleID: "com.openai.chat"}
	st := a.store.Settings()
	st.PromptSnippets = []store.PromptSnippet{{ID: "t1", Label: "翻译", Text: "翻译成英文：{内容}", GroupID: store.GeneralPromptGroup}}
	_ = a.store.SetSettings(st)
	orig := heldMods
	t.Cleanup(func() { heldMods = orig })
	heldMods = func() uint64 { return macos.FlagOption }
	tt.Frame()
	_ = tt.RightClick("早上好")
	if err := tt.ChooseMenuItem("用模板发送", "翻译"); err != nil {
		t.Fatalf("%v %v", err, tt.Menu())
	}
	tt.Frame()
	if len(sys.sent()) != 0 || len(a.pending) != 1 || !tt.HasText("翻译成英文：早上好") {
		t.Fatalf("应先显示检查条 sent=%v %v", sys.sent(), tt.Texts())
	}
	if a.forceCheck {
		t.Fatal("forceCheck 应只作用于这一次")
	}
}

func TestExportTemplatesFromSettings(t *testing.T) {
	a, _ := testApp(t)
	st := a.store.Settings()
	st.PromptSnippets = []store.PromptSnippet{{ID: "t1", Label: "翻译", Text: "翻译：{内容}", GroupID: store.GeneralPromptGroup}}
	_ = a.store.SetSettings(st)
	out := filepath.Join(t.TempDir(), "x.json")
	orig := saveTemplatesPath
	t.Cleanup(func() { saveTemplatesPath = orig })
	saveTemplatesPath = func(*app) (string, error) { return out, nil }
	a.openSettingsAt(setPagePaste, 1)
	set := ui.NewTester(a.settingsView, 1040, 2000)
	set.Frame()
	if err := set.Click("导出"); err != nil {
		t.Fatalf("%v %v", err, set.Texts())
	}
	raw, err := os.ReadFile(out)
	if err != nil || !strings.Contains(string(raw), `"format": "toskr-prompt-templates"`) || !strings.Contains(string(raw), `"label": "翻译"`) {
		t.Fatalf("%s %v", raw, err)
	}
}
