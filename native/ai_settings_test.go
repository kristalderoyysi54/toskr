package main

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/ai"
	"github.com/toskr/native/internal/store"
)

func waitUpd(a *app, cond func() bool) {
	for i := 0; i < 100 && !cond(); i++ {
		time.Sleep(5 * time.Millisecond)
		a.drainUpdates()
	}
}

// 设置 → AI：总开关、提供商预设、获取模型列表并选择、连接测试、删除密钥。
func TestAISettings(t *testing.T) {
	a, _ := testApp(t)
	oldKey, oldList, oldTest, oldDel := aiKey, aiListModels, aiTest, aiDeleteKey
	t.Cleanup(func() { aiKey, aiListModels, aiTest, aiDeleteKey = oldKey, oldList, oldTest, oldDel })
	key := "sk-test"
	aiKey = func() string { return key }
	var gotCfg ai.Config
	aiListModels = func(_ context.Context, cfg ai.Config) ([]string, error) {
		gotCfg = cfg
		return []string{"deepseek-chat", "deepseek-reasoner"}, nil
	}
	aiTest = func(_ context.Context, cfg ai.Config) error { return errors.New("AI 返回 401") }
	aiDeleteKey = func() error { key = ""; return nil }

	a.openSettingsState()
	set := ui.NewTester(a.settingsView, 1040, 4000)
	a.setJump = "AI 智能"
	set.Frame()
	set.Frame()
	for _, s := range []string{"AI 智能", "关闭后所有 AI 入口都不会发起请求", "DeepSeek", "通义", "Base URL", "API Key", "已配置", "模型名", "连接测试"} {
		if !set.HasText(s) {
			t.Fatalf("缺 %q：%v", s, set.Texts())
		}
	}
	if err := set.Click("DeepSeek"); err != nil {
		t.Fatal(err)
	}
	set.Frame()
	if a.setAIEnd != "https://api.deepseek.com" {
		t.Fatalf("预设应填入 Base URL：%q", a.setAIEnd)
	}
	if st := a.store.Settings(); st.AIEndpoint != "https://api.deepseek.com" {
		t.Fatalf("改动应保存 %q", st.AIEndpoint)
	}
	set.Click("获取列表")
	waitUpd(a, func() bool { return !a.aiUI.fetching })
	set.Frame()
	if gotCfg.Endpoint != "https://api.deepseek.com" || gotCfg.Key != "sk-test" || !set.HasText("已获取 2 个模型") {
		t.Fatalf("%+v %v", gotCfg, set.Texts())
	}
	set.Click("测试连接")
	waitUpd(a, func() bool { return !a.aiUI.testing })
	if !strings.Contains(a.hudText, "连接失败：AI 返回 401") {
		t.Fatalf("%q", a.hudText)
	}
	a.deleteAIKey()
	set.Frame()
	if key != "" || a.hudText != tr("AI 密钥已删除") || !set.HasText("未配置；保存后只能覆盖或删除，不会回显") {
		t.Fatalf("%q", a.hudText)
	}
}

// 「AI 智能」关掉后所有入口不发请求；旧数据没有这个字段时按开启；新装默认关闭（同 Tauri aiEnabled: false）。
func TestAIEnabledGate(t *testing.T) {
	if (store.Settings{}).AIOn() != true || store.DefaultSettings().AIOn() {
		t.Fatal("旧数据按开启，新装默认关闭")
	}
	a, _ := testApp(t)
	off := false
	st := a.store.Settings()
	st.AIEnabled = &off
	_ = a.store.SetSettings(st)
	if !a.aiConfig().Off {
		t.Fatal("关掉后 aiConfig 应带 Off")
	}
	if _, err := ai.Rewrite(context.Background(), a.aiConfig(), "", "x"); !errors.Is(err, ai.ErrDisabled) {
		t.Fatal(err)
	}
}

func TestSplitSubtasks(t *testing.T) {
	a, _ := testApp(t)
	old := aiJSON
	t.Cleanup(func() { aiJSON = old })
	var gotUser string
	aiJSON = func(_ ai.Config, system, user string, v any) error {
		gotUser = user
		r := v.(*struct {
			Items []string `json:"items"`
		})
		r.Items = []string{" 列出要点 ", "", "写初稿", "发给老板"}
		return nil
	}
	on := true
	st := a.store.Settings()
	st.AIEnabled = &on
	_ = a.store.SetSettings(st)
	task := a.store.AddTask(store.Task{Text: "写周报", Note: "周五前", Checklist: []store.ChecklistItem{{ID: "c0", Text: "收集数据"}}})
	a.splitSubtasks(task)
	waitUpd(a, func() bool { return a.hudText != tr("AI 正在拆解子任务…") })
	got := a.store.Tasks()[0]
	if len(got.Checklist) != 4 || got.Checklist[1].Text != "列出要点" || !strings.Contains(gotUser, "备注：周五前") || !strings.Contains(gotUser, "已有检查项：收集数据") {
		t.Fatalf("%+v %q", got.Checklist, gotUser)
	}
	a.hudUndo()
	if len(a.store.Tasks()[0].Checklist) != 1 {
		t.Fatal("撤销应整体还原")
	}
}
