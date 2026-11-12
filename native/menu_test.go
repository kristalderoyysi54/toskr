package main

import (
	"slices"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// 卡片右键菜单自定义（同 Tauri 方案 A）：一级是发送区 + 常用区，「整理」「转换与导出」是二级；
// 设置里关掉的项不出现，区内排序生效；整个区都关了就不出该二级菜单；删除始终在。
func TestCardMenuConfig(t *testing.T) {
	a, tt := testApp(t, "一条笔记")
	open := func() []string {
		tt.Frame()
		_ = tt.RightClick("一条笔记")
		return tt.Menu()
	}
	m := open()
	want := []string{"发送到对话", "检查后发送…", "用模板发送", "-", "预览", "复制原文（不脱敏）", "编辑", "标记完成", "设为常用 · 发送后保留", "-", "整理", "转换与导出"}
	if !slices.Equal(m[:len(want)], want) || m[len(m)-1] != "删除" {
		t.Fatalf("默认骨架 %s", strings.Join(m, "|"))
	}
	if err := tt.ChooseMenuItem("整理", "重命名…"); err != nil || a.titleEditID == "" {
		t.Fatalf("整理二级菜单里应有重命名 %v", err)
	}
	a.titleEditID = ""

	st := a.store.Settings()
	st.ContextMenu = store.MoveMenuItem(nil, "send-template", -1)
	for i, x := range st.ContextMenu {
		switch x.ID {
		case "send-preflight", "rename", "blur", "tags", "move":
			st.ContextMenu[i].On = false
		}
	}
	_ = a.store.SetSettings(st)
	m = open()
	if !slices.Equal(m[:3], []string{"发送到对话", "用模板发送", "-"}) {
		t.Fatalf("关掉检查后发送、模板上移 %s", strings.Join(m, "|"))
	}
	if slices.Contains(m, "整理") || !slices.Contains(m, "转换与导出") || m[len(m)-1] != "删除" {
		t.Fatalf("整理区全关就不出二级菜单 %s", strings.Join(m, "|"))
	}
}

// 设置「卡片右键菜单」：开关写回、区内下移写回，分区标题齐全。
func TestCardMenuSettings(t *testing.T) {
	a, _ := testApp(t)
	a.openSettingsState()
	tt := ui.NewTester(a.settingsView, 1040, 4000)
	tt.Frame()
	for _, s := range []string{"卡片右键菜单", "一级菜单 · 发送", "一级菜单 · 常用", "整理", "转换与导出", "导出笔记包"} {
		if !tt.HasText(s) {
			t.Fatalf("缺 %q", s)
		}
	}
	if err := tt.Click("区内下移"); err != nil { // 第一个：发送区的「发送到对话」
		t.Fatal(err)
	}
	tt.Frame()
	if p := store.PartitionMenu(a.store.Settings().ContextMenu, false)["send"]; !slices.Equal(p, []string{"send-preflight", "send", "send-template"}) {
		t.Fatalf("区内下移应写回 %v", p)
	}
	r, ok := tt.Find("检查后发送")
	if !ok {
		t.Fatal("找不到行")
	}
	tt.ClickAt(r.X-30, r.Y+r.H/2) // 行首开关
	tt.Frame()
	if p := store.PartitionMenu(a.store.Settings().ContextMenu, false)["send"]; slices.Contains(p, "send-preflight") {
		t.Fatalf("关掉后不应出现 %v", p)
	}
}
