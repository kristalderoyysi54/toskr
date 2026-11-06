package store

import (
	"slices"
	"testing"
)

func TestMenuConfig(t *testing.T) {
	def := DefaultMenu()
	if len(def) != 18 || def[6].ID != "export" || def[6].On || !def[0].On {
		t.Fatalf("默认配置：注册顺序、低频项关闭 %+v", def)
	}
	norm := NormalizeMenu([]MenuItem{{"tags", false}, {"bogus", true}, {"tags", true}, {"send", true}})
	if len(norm) != 18 || norm[0] != (MenuItem{"tags", false}) || norm[1].ID != "send" {
		t.Fatalf("去未知 / 去重 / 补齐 %+v", norm[:3])
	}
	p := PartitionMenu(norm, false)
	if slices.Contains(p["organize"], "tags") || !slices.Contains(p["organize"], "move") || p["send"][0] != "send" {
		t.Fatalf("关掉的项不出现、分区正确 %+v", p)
	}
	clip := PartitionMenu(nil, true)
	if !slices.Contains(clip["main"], "move") || !slices.Contains(clip["organize"], "edit") || slices.Contains(clip["main"], "done") {
		t.Fatalf("剪贴卡：移入笔记分组在一级，编辑与完成进整理 %+v", clip)
	}
	moved := MoveMenuItem(nil, "send-template", -1)
	p = PartitionMenu(moved, false)
	if !slices.Equal(p["send"], []string{"send", "send-template", "send-preflight"}) {
		t.Fatalf("区内上移 %+v", p["send"])
	}
	if got := MoveMenuItem(nil, "send", -1); !slices.Equal(got, DefaultMenu()) {
		t.Fatal("区首上移不动")
	}
	if got := applyTauriSettings(Settings{}, tauriSettings{ContextMenu: []MenuItem{{"blur", false}}}); len(got.ContextMenu) != 18 || got.ContextMenu[0] != (MenuItem{"blur", false}) {
		t.Fatalf("Tauri 导入应带上右键菜单配置 %+v", got.ContextMenu)
	}
}
