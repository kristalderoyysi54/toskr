package main

import (
	"context"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/ai"
	"github.com/toskr/native/internal/store"
)

// 同 Tauri generatePromptTemplate：剥 ```json 围栏；缺 {内容} 补在末尾；重复 {内容} / 非 JSON 报错。
func TestGenerateTemplateParsing(t *testing.T) {
	orig := aiRewrite
	t.Cleanup(func() { aiRewrite = orig })
	reply := ""
	var gotUser string
	aiRewrite = func(_ context.Context, _ ai.Config, _, user string) (string, error) { gotUser = user; return reply, nil }

	reply = "```json\n{\"label\":\"周报\",\"text\":\"整理成周报\"}\n```"
	l, x, err := generateTemplate(context.Background(), ai.Config{}, "写周报", &[2]string{"旧", "旧内容"})
	if err != nil || l != "周报" || x != "整理成周报\n\n{内容}" || !strings.Contains(gotUser, `"current"`) {
		t.Fatalf("%q %q %v user=%s", l, x, err, gotUser)
	}
	reply = `{"label":"x","text":"{内容} 和 {内容}"}`
	if _, _, err := generateTemplate(context.Background(), ai.Config{}, "a", nil); err == nil {
		t.Fatal("重复占位符应报错")
	}
	reply = "不是 JSON"
	if _, _, err := generateTemplate(context.Background(), ai.Config{}, "a", nil); err == nil {
		t.Fatal("非 JSON 应报错")
	}
	if _, _, err := generateTemplate(context.Background(), ai.Config{}, "  ", nil); err == nil {
		t.Fatal("空想法应报错")
	}
}

func TestSnippetSource(t *testing.T) {
	if store.SnippetSource(store.PromptSnippet{ID: "translate", Label: "翻译成中文", Text: "请把以下内容翻译成中文：\n\n{内容}", GroupID: "general"}) != "内置" {
		t.Fatal("未改的预设是内置")
	}
	if store.SnippetSource(store.PromptSnippet{ID: "translate", Label: "翻译", Text: "x", GroupID: "general"}) != "内置·已修改" {
		t.Fatal("改过的预设")
	}
	if store.SnippetSource(store.PromptSnippet{ID: "snippet-1"}) != "自建" {
		t.Fatal("自建")
	}
}

// 编辑区：试用预览把示例材料套进模板；插入 {内容}；AI 助手生成后「采用到编辑区」。
func TestTemplateEditorPreviewAndAssistant(t *testing.T) {
	a, _ := testApp(t)
	orig := aiRewrite
	t.Cleanup(func() { aiRewrite = orig })
	aiRewrite = func(context.Context, ai.Config, string, string) (string, error) {
		return `{"label":"排查","text":"请排查：{内容}"}`, nil
	}
	st := a.store.Settings()
	on := true
	st.AIEnabled, st.AIModel = &on, "m"
	_ = a.store.SetSettings(st)
	a.setPage, a.setSub = setPagePaste, 1
	a.startSnippetAdd()
	v := ui.NewTester(a.settingsView, 1040, 900)
	v.Frame()
	a.snipText = "翻译："
	v.Frame()
	if err := v.Click("插入 {内容}"); err != nil {
		t.Fatal(err)
	}
	if a.snipText != "翻译：\n\n{内容}" {
		t.Fatalf("%q", a.snipText)
	}
	if err := v.Click("试用预览"); err != nil {
		t.Fatal(err)
	}
	v.Frame()
	if !v.HasText("翻译：\n\n保存设置后") {
		t.Fatalf("预览应套入示例材料 %v", v.Texts())
	}
	if err := v.Click("AI 创建"); err != nil {
		t.Fatal(err)
	}
	v.Frame()
	if err := v.Click("排查问题"); err != nil {
		t.Fatal(err)
	}
	v.Frame()
	_ = v.Click("生成调整建议")
	waitFor(t, func() bool { v.Frame(); return a.snip.cand != nil })
	v.Frame()
	if err := v.Click("采用到编辑区"); err != nil {
		t.Fatal(err, v.Texts())
	}
	if a.snipLabel != "排查" || a.snipText != "请排查：{内容}" || a.snip.aiOpen || !a.snip.previewOpen {
		t.Fatalf("采用后 label=%q text=%q", a.snipLabel, a.snipText)
	}
}
